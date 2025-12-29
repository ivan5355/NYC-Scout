const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
  timeout: 30000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const NYC_PERMITTED_EVENTS_URL = 'https://data.cityofnewyork.us/resource/tvpp-9vvx.json';
const NYC_PARKS_EVENTS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.json';

// Ticket source trust hints
const SOURCE_HINTS = {
  'dice': { name: 'DICE', hint: 'Ticket policy: check before buying' },
  'ra': { name: 'Resident Advisor', hint: 'Ticket policy: check before buying' },
  'eventbrite': { name: 'Eventbrite', hint: 'Ticket policy: check before buying' },
  'fever': { name: 'Fever', hint: 'Double-check refund policy before purchasing' },
  'luma': { name: 'Luma', hint: 'Ticket policy: check before buying' },
  'meetup': { name: 'Meetup', hint: 'Usually free or low cost' }
};

// Convert 12-hour time to 24-hour format
function parseTime12h(timeStr) {
  if (!timeStr) return '00:00:00';
  try {
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (!match) return '00:00:00';
    let [, hours, minutes, period] = match;
    hours = parseInt(hours, 10);
    if (period.toLowerCase() === 'pm' && hours !== 12) hours += 12;
    if (period.toLowerCase() === 'am' && hours === 12) hours = 0;
    return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
  } catch {
    return '00:00:00';
  }
}

// Fetch NYC permitted events
async function fetchPermittedEvents() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const response = await axios.get(NYC_PERMITTED_EVENTS_URL, {
      params: {
        '$where': `start_date_time >= '${today}'`,
        '$order': 'start_date_time',
        '$limit': 500
      },
      timeout: 10000
    });

    return response.data.map(event => ({
      event_id: event.event_id,
      event_name: event.event_name,
      start_date_time: event.start_date_time,
      end_date_time: event.end_date_time,
      event_agency: event.event_agency,
      event_type: event.event_type,
      event_borough: event.event_borough,
      event_location: event.event_location,
      price: 'Check source',
      source: 'NYC Open Data'
    }));
  } catch (err) {
    console.error('Permitted events failed:', err.message);
    return [];
  }
}

// Fetch NYC Parks events
async function fetchParksEvents() {
  try {
    const response = await axios.get(NYC_PARKS_EVENTS_URL, { timeout: 10000 });
    const boroughMap = { M: 'Manhattan', B: 'Brooklyn', Q: 'Queens', X: 'Bronx', R: 'Staten Island' };

    return response.data.map(event => {
      const startDate = event.startdate || '';
      const parkId = event.parkids || '';
      const borough = boroughMap[parkId[0]?.toUpperCase()] || null;

      return {
        event_id: event.guid,
        event_name: event.title,
        start_date_time: startDate ? `${startDate}T${parseTime12h(event.starttime)}` : null,
        end_date_time: event.enddate ? `${event.enddate}T${parseTime12h(event.endtime)}` : null,
        event_agency: 'NYC Parks',
        event_type: event.categories,
        event_borough: borough,
        event_location: event.location,
        price: 'Free',
        source: 'NYC Parks'
      };
    });
  } catch (err) {
    console.error('Parks events failed:', err.message);
    return [];
  }
}

// Combine both event sources
async function fetchAllEvents() {
  const [permitted, parks] = await Promise.all([
    fetchPermittedEvents(),
    fetchParksEvents()
  ]);
  console.log(`Fetched ${permitted.length} permitted + ${parks.length} parks events`);
  return [...permitted, ...parks];
}


// Check if event query is too vague
function isVagueEventQuery(query, filters) {
  const lowerQuery = query.toLowerCase();
  
  const hasDate = filters.date || 
    ['today', 'tonight', 'tomorrow', 'weekend', 'this week'].some(d => lowerQuery.includes(d));
  
  const hasPrice = filters.priceFilter || 
    ['free', 'cheap', 'under'].some(p => lowerQuery.includes(p));
  
  const hasCategory = filters.category || filters.searchTerm;
  
  // Vague if no date AND no price hint
  return !hasDate && !hasPrice && hasCategory;
}

// Extract event filters (heuristic)
function extractEventFiltersHeuristic(query) {
  const filters = {};
  const lowerQuery = query.toLowerCase();

  // Boroughs
  const boroughs = {
    'manhattan': 'Manhattan', 'manhatten': 'Manhattan', 'brooklyn': 'Brooklyn', 
    'queens': 'Queens', 'bronx': 'Bronx', 'staten island': 'Staten Island'
  };
  for (const [key, val] of Object.entries(boroughs)) {
    if (lowerQuery.includes(key)) {
      filters.borough = val;
      break;
    }
  }

  // Date filters
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  if (lowerQuery.includes('today') || lowerQuery.includes('tonight')) {
    filters.date = { type: 'specific', date: todayStr };
  } else if (lowerQuery.includes('tomorrow')) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    filters.date = { type: 'specific', date: tomorrow.toISOString().split('T')[0] };
  } else if (lowerQuery.includes('weekend') || lowerQuery.includes('this weekend')) {
    const dayOfWeek = today.getDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const friday = new Date(today);
    friday.setDate(today.getDate() + daysUntilFriday);
    const sunday = new Date(friday);
    sunday.setDate(friday.getDate() + 2);
    filters.date = { 
      type: 'range', 
      start_date: friday.toISOString().split('T')[0],
      end_date: sunday.toISOString().split('T')[0]
    };
  } else if (lowerQuery.includes('this week')) {
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + 7);
    filters.date = {
      type: 'range',
      start_date: todayStr,
      end_date: endOfWeek.toISOString().split('T')[0]
    };
  }

  // Price filter
  if (lowerQuery.includes('free')) {
    filters.priceFilter = 'free';
  } else if (lowerQuery.includes('under $30') || lowerQuery.includes('cheap')) {
    filters.priceFilter = 'budget';
  }

  // Indoor/outdoor
  if (lowerQuery.includes('indoor')) {
    filters.indoor = true;
  } else if (lowerQuery.includes('outdoor')) {
    filters.outdoor = true;
  }

  // Categories
  const categories = ['concert', 'comedy', 'music', 'art', 'theater', 'festival', 'sports', 'food', 'market', 'tour', 'yoga', 'fitness'];
  for (const cat of categories) {
    if (lowerQuery.includes(cat)) {
      filters.category = cat;
      break;
    }
  }

  // Search term fallback
  if (!filters.category) {
    const stopWords = new Set(['event', 'events', 'in', 'on', 'at', 'the', 'a', 'find', 'me', 'things', 'to', 'do', 'what', 'is', 'are', 'happening']);
    const words = lowerQuery.split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
    if (words.length > 0) {
      filters.searchTerm = words.join(' ');
    }
  }

  return filters;
}

// Apply filters to event list
function applyFilters(events, filters) {
  let results = [...events];

  if (filters.date) {
    results = results.filter(event => {
      const startDt = event.start_date_time;
      if (!startDt) return false;
      const eventDate = startDt.split('T')[0];

      if (filters.date.type === 'specific') return eventDate === filters.date.date;
      if (filters.date.type === 'range') {
        return eventDate >= filters.date.start_date && eventDate <= filters.date.end_date;
      }
      return true;
    });
  }

  if (filters.priceFilter === 'free') {
    results = results.filter(e => e.price === 'Free' || e.source === 'NYC Parks');
  }

  if (filters.category || filters.searchTerm) {
    const cat = (filters.category || '').toLowerCase();
    const term = (filters.searchTerm || '').toLowerCase();

    results = results.filter(event => {
      const eventType = (event.event_type || '').toLowerCase();
      const eventName = (event.event_name || '').toLowerCase();
      const eventLocation = (event.event_location || '').toLowerCase();

      return (cat && eventType.includes(cat)) ||
             (term && (eventType.includes(term) || eventName.includes(term) || eventLocation.includes(term)));
    });
  }

  if (filters.borough) {
    results = results.filter(e => (e.event_borough || '').toLowerCase() === filters.borough.toLowerCase());
  }

  return results;
}


// Main search function
async function searchEvents(userId, query, context = null) {
  const filters = extractEventFiltersHeuristic(query);
  
  // Check for follow-up
  const lowerQuery = query.toLowerCase();
  const followUpPatterns = ['more', 'other', 'different', 'another', 'next'];
  const isFollowUp = followUpPatterns.some(p => lowerQuery.includes(p)) && lowerQuery.split(' ').length <= 5;
  
  if (isFollowUp && context?.lastFilters && context?.lastCategory === 'EVENT') {
    Object.assign(filters, context.lastFilters);
  }

  // Check if query is too vague
  const needsConstraints = isVagueEventQuery(query, filters);
  if (needsConstraints && !isFollowUp) {
    return {
      query,
      filters,
      results: [],
      count: 0,
      needsConstraints: true,
      constraintQuestion: {
        text: "Quick question to find the best events:",
        replies: [
          { title: "Free 🆓", payload: "EVENT_FREE" },
          { title: "Under $30 💵", payload: "EVENT_BUDGET" },
          { title: "Any price 🤷", payload: "EVENT_ANY_PRICE" }
        ]
      }
    };
  }

  const events = await fetchAllEvents();
  let results = applyFilters(events, filters);

  // Exclude already shown events
  const shownIds = context?.shownEventIds || [];
  if (shownIds.length > 0) {
    results = results.filter(e => !shownIds.includes(e.event_id));
  }

  // Limit to 5 results
  results = results.slice(0, 5);

  console.log(`Event search complete. Found ${results.length} events`);

  // Fallback to web search if no results
  if (results.length === 0 && GEMINI_API_KEY) {
    const webResults = await searchEventsWithGeminiWebSearch(userId, query, filters);
    if (webResults) {
      return { query, filters, results: [], count: 0, webSearchResponse: webResults };
    }
  }

  return { query, filters, results, count: results.length, needsConstraints: false };
}

// Gemini web search fallback
async function searchEventsWithGeminiWebSearch(userId, query, filters) {
  const { checkAndIncrementSearch } = require('./rate_limiter');

  if (!GEMINI_API_KEY || !await checkAndIncrementSearch(userId)) return null;

  try {
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Find 5 UPCOMING NYC events matching: "${query}"
Today: ${today}. Only include events on or after today.
Format each as: Event Name | Date | Venue | Price | Source`;

    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 800, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    const text = response.data.candidates?.[0]?.content?.parts
      ?.map(p => p.text)
      .filter(Boolean)
      .join('\n')
      .trim();

    return text || null;
  } catch (err) {
    console.error('Gemini web search failed:', err.message);
    return null;
  }
}

// Format event results (premium IG DM format)
function formatEventResults(searchResult) {
  if (searchResult.needsConstraints) {
    return {
      text: searchResult.constraintQuestion.text,
      replies: searchResult.constraintQuestion.replies,
      isQuestion: true
    };
  }

  if (searchResult.webSearchResponse) {
    return { text: searchResult.webSearchResponse, isQuestion: false };
  }

  if (searchResult.count === 0) {
    return { 
      text: "Couldn't find events matching that. Try a different date or category?",
      isQuestion: false
    };
  }

  const events = searchResult.results;
  let response = '';

  events.forEach((e, i) => {
    const name = e.event_name || 'Unnamed Event';
    const date = e.start_date_time ? formatEventDate(e.start_date_time) : 'TBD';
    const location = e.event_location || e.event_borough || 'NYC';
    const price = e.price || 'Check source';
    const category = e.event_type || '';
    const source = e.source || '';

    response += `${i + 1}. ${name}\n`;
    response += `🕓 ${date}\n`;
    response += `📍 ${location.length > 40 ? location.substring(0, 37) + '...' : location}\n`;
    response += `💰 ${price}\n`;
    
    if (category) {
      response += `🏷️ ${category}\n`;
    }
    
    if (source) {
      response += `📌 Source: ${source}\n`;
    }

    response += '\n';
  });

  response += "Say \"more\" for different events.";

  return { text: response.trim(), isQuestion: false };
}

// Format event date nicely
function formatEventDate(dateTimeStr) {
  try {
    const date = new Date(dateTimeStr);
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    const dateStr = date.toLocaleDateString('en-US', options);
    const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${dateStr} · ${timeStr}`;
  } catch {
    return dateTimeStr.split('T')[0];
  }
}

module.exports = {
  fetchAllEvents,
  searchEvents,
  formatEventResults,
  extractEventFiltersHeuristic
};