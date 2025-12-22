const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const {
  searchRestaurants,
  formatRestaurantResults,
} = require('./restaurants');
const { classifyQuery } = require('./query_router');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const geminiClient = axios.create({
  timeout: 30000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const graphClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const NYC_PERMITTED_EVENTS_URL = 'https://data.cityofnewyork.us/resource/tvpp-9vvx.json';
const NYC_PARKS_EVENTS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.json';

/* =====================
   EVENT HELPERS
===================== */

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
    street_closure_type: event.street_closure_type
  }));
}

// Fetch NYC Parks events (NOTE: this assumes the URL returns JSON-like data; if it's truly RSS XML,
// you'll need a parser like xml2js. Keeping your existing behavior here.)
async function fetchParksEvents() {
  const response = await axios.get(NYC_PARKS_EVENTS_URL, { timeout: 10000 });
  const boroughMap = { M: 'Manhattan', B: 'Brooklyn', Q: 'Queens', X: 'Bronx', R: 'Staten Island' };

  return response.data.map(event => {
    const startDate = event.startdate || '';
    const endDate = event.enddate || startDate;
    const parkId = event.parkids || '';
    const borough = boroughMap[parkId[0]?.toUpperCase()] || null;

    return {
      event_id: event.guid,
      event_name: event.title,
      start_date_time: startDate ? `${startDate}T${parseTime12h(event.starttime)}` : null,
      end_date_time: endDate ? `${endDate}T${parseTime12h(event.endtime)}` : null,
      event_agency: 'NYC Parks',
      event_type: event.categories,
      event_borough: borough,
      event_location: event.location,
      street_closure_type: null
    };
  });
}

// Combine both event sources
async function fetchAllEvents() {
  try {
    const [permitted, parks] = await Promise.all([
      fetchPermittedEvents().catch(err => {
        console.error('Permitted events failed:', err.message);
        return [];
      }),
      fetchParksEvents().catch(err => {
        console.error('Parks events failed:', err.message);
        return [];
      })
    ]);

    console.log(`Fetched ${permitted.length} permitted + ${parks.length} parks events`);
    return [...permitted, ...parks];
  } catch (err) {
    console.error('Failed to fetch events:', err.message);
    return [];
  }
}


// Apply filters to event list
function applyFilters(events, filters) {
  console.log('Applying filters to event list:', JSON.stringify(filters, null, 2));
  let results = [...events];

  if (filters.date) {
    results = results.filter(event => {
      const startDt = event.start_date_time;
      if (!startDt) return false;
      const eventDate = startDt.split('T')[0];

      if (filters.date.type === 'specific') return eventDate === filters.date.date;
      if (filters.date.type === 'range') return eventDate >= filters.date.start_date && eventDate <= filters.date.end_date;
      if (filters.date.type === 'month') {
        const dt = new Date(eventDate);
        return dt.getMonth() + 1 === filters.date.month && dt.getFullYear() === filters.date.year;
      }
      return true;
    });
  }

  if (filters.category || filters.searchTerm) {
    const cat = (filters.category || '').toLowerCase();
    const term = (filters.searchTerm || '').toLowerCase();

    results = results.filter(event => {
      const eventType = (event.event_type || '').toLowerCase();
      const eventName = (event.event_name || '').toLowerCase();
      const eventLocation = (event.event_location || '').toLowerCase();

      // Match the specific category (from the official list)
      const matchCategory = cat && eventType.includes(cat);

      // Match the user's raw search term across name, type, and location
      const matchSearchToken = term && (
        eventType.includes(term) ||
        eventName.includes(term) ||
        eventLocation.includes(term)
      );

      return matchCategory || matchSearchToken;
    });
  }

  if (filters.borough) {
    results = results.filter(event => (event.event_borough || '').toLowerCase() === filters.borough.toLowerCase());
  }

  return results;
}

// Use Gemini AI to parse complex queries
async function extractFiltersWithGemini(userId, query) {
  const { checkAndIncrementGemini } = require('./rate_limiter');

  if (!GEMINI_API_KEY) {
    console.log('⚠️ GEMINI_API_KEY missing, returning empty filters.');
    return {};
  }

  if (!checkAndIncrementGemini(userId)) {
    console.log(`⚠️ User ${userId} exceeded Gemini limit in extractFiltersWithGemini. Returning empty filters.`);
    return {};
  }

  console.log('Executing extractFiltersWithGemini...');

  let categories = [];
  let boroughs = [];

  try {
    const filtersPath = path.join(__dirname, '../data/event_filters.json');
    if (fs.existsSync(filtersPath)) {
      const filtersData = JSON.parse(fs.readFileSync(filtersPath, 'utf8'));
      const combinedCats = [
        ...filtersData.parks_events.categories,
        ...filtersData.permitted_events.event_type
      ];
      categories = [...new Set(combinedCats)].sort();
      boroughs = filtersData.permitted_events.event_borough;
    }
  } catch (err) {
    console.error('Failed to load dynamic filters:', err.message);
  }

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Extract event search filters from this query. Today's date is ${today}.
Query: "${query}"
Return a JSON object with these fields (only include fields that are mentioned):
- date: object with "type" (specific/range/month) and relevant date fields
- category: pick the best fit from [${categories.join(', ')}]
- borough: one of " "Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"
- searchTerm: any specific keyword the user mentioned (e.g. "concert", "music", "yoga", "art")
Only return valid JSON, no explanation.`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 200, temperature: 0.1 } },
      { params: { key: GEMINI_API_KEY } }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text.startsWith('```')) {
      text = text.split('\n').slice(1).join('\n').replace(/```$/, '').trim();
    }
    return JSON.parse(text);
  } catch (err) {
    console.error('Gemini filter extraction failed:', err.message);
    return {};
  }
}

// Use Gemini Web Search to find events
async function searchEventsWithGeminiWebSearch(userId, query, filters) {
  const { checkAndIncrementSearch } = require('./rate_limiter');

  if (!GEMINI_API_KEY) return null;

  if (!checkAndIncrementSearch(userId)) {
    console.log(`⚠️ User ${userId} exceeded Gemini Web Search limit.`);
    return null;
  }

  try {
    console.log(`Starting Gemini Web Search for: "${query}"...`);

    const today = new Date().toISOString().split('T')[0];
    const prompt = `Find 5 UPCOMING real-time NYC events matching this request: "${query}"
Context filters: ${JSON.stringify(filters)}
TODAY'S DATE: ${today} (YYYY-MM-DD)

CRITICAL VALIDATION STEP:
1. Use Google Search to find events.
2. For EACH event you consider, look at its specific date.
3. EXPLICITLY COMPARE the event's date against TODAY'S DATE (${today}).
4. ONLY include the event if it takes place on or after ${today}.
5. If an event is from earlier this week, yesterday, or any past date, DISCARD IT. Even if it is a major event, if it has passed, it is useless.

Output Layout:
- Start directly with the results.
- No conversational filler (no "I found...", no "Here are...").
- For each event: [Event Name] | [Date] | [Location]
- If no future events are found, say "I couldn't find any upcoming events matching your search."`;

    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    const candidates = response.data.candidates?.[0];
    const parts = candidates?.content?.parts || [];

    // Log for debugging (the user will see this in their console/logs)
    console.log(`Gemini response received. Parts: ${parts.length}`);

    // Combine all text parts. Grounding can return multiple parts.
    const text = parts
      .map(p => p.text)
      .filter(t => typeof t === 'string' && t.length > 0)
      .join('\n')
      .trim();

    if (text) {
      console.log(`Web search successful. Response length: ${text.length}`);
      return text;
    }

    console.log('Gemini web search returned no text content.');
    return null;
  } catch (err) {
    console.error('Gemini web search failed:', err.response?.data || err.message);
    return null;
  }
}

// Main search function
async function searchEvents(userId, query) {
  const [filters, events] = await Promise.all([
    extractFiltersWithGemini(userId, query),
    fetchAllEvents()
  ]);

  const results = applyFilters(events, filters);
  console.log(`Event search complete. Found ${results.length} events matching query.`);

  // FALLBACK: If no results found in local APIs, use Gemini Web Search
  if (results.length === 0 && GEMINI_API_KEY) {
    console.log('No local events found. Falling back to Gemini Web Search...');
    const webSearchResults = await searchEventsWithGeminiWebSearch(userId, query, filters);
    if (webSearchResults) {
      return { query, filters, results: [], count: 0, webSearchResponse: webSearchResults };
    }
  }

  return { query, filters, results, count: results.length };
}

// Format event results for Instagram
function formatEventResults(searchResult) {
  // If we have a web search fallback result, return it directly
  if (searchResult.webSearchResponse) {
    return searchResult.webSearchResponse;
  }

  if (searchResult.count === 0) {
    return "I couldn't find any events matching your search in our local records. Try a different date, category, or borough!";
  }

  const events = searchResult.results.slice(0, 4);
  let response = `Found ${searchResult.count} event${searchResult.count > 1 ? 's' : ''}! Here are the top results:\n\n`;

  events.forEach((e, i) => {
    const name = e.event_name?.length > 70 ? e.event_name.substring(0, 67) + '...' : (e.event_name || 'Unnamed Event');
    response += `${i + 1}. ${name}\n`;

    if (e.start_date_time) response += `   Date: ${e.start_date_time.split('T')[0]}\n`;

    if (e.event_location) {
      const loc = e.event_location.length > 70 ? e.event_location.substring(0, 67) + '...' : e.event_location;
      response += `   Loc: ${loc}\n`;
    }

    if (e.event_borough) response += `   Borough: ${e.event_borough}\n`;
  });

  return response;
}

module.exports = {
  // events API
  fetchAllEvents,
  searchEvents,
  formatEventResults,
};
