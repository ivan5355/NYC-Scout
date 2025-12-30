const axios = require('axios');
const https = require('https');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const geminiClient = axios.create({
  timeout: 30000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   MONGODB CONNECTION
===================== */

let mongoClient = null;
let eventsCollection = null;

async function connectToEvents() {
  if (mongoClient && eventsCollection) return eventsCollection;
  if (!MONGODB_URI) {
    console.error('No MONGODB_URI found for events');
    return null;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('goodrec');
    eventsCollection = db.collection('events');
    console.log('Connected to events collection');
    return eventsCollection;
  } catch (err) {
    console.error('Failed to connect to events collection:', err.message);
    return null;
  }
}

/* =====================
   FETCH FROM MONGODB
===================== */

async function fetchAllEvents() {
  const collection = await connectToEvents();
  if (!collection) {
    console.log('No DB connection, returning empty events');
    return [];
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    
    const events = await collection.find({
      isActive: true,
      date: { $gte: today }
    })
    .sort({ date: 1 })
    .limit(500)
    .toArray();

    console.log(`Fetched ${events.length} events from MongoDB`);
    return events.map(mapEventToFormat);
  } catch (err) {
    console.error('Failed to fetch events from MongoDB:', err.message);
    return [];
  }
}

/* =====================
   HELPERS
===================== */

function mapEventToFormat(e) {
  return {
    event_id: e._id.toString(),
    event_name: e.name,
    start_date_time: e.date && e.time ? `${e.date}T${convertTimeTo24h(e.time)}` : e.date,
    event_type: e.description,
    event_borough: extractBoroughFromLocation(e.location),
    event_location: e.location,
    price: e.price || 'Check source',
    source: e.platform || e.source,
    link: e.link
  };
}

function convertTimeTo24h(timeStr) {
  if (!timeStr) return '12:00:00';
  try {
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return '12:00:00';
    let [, hours, minutes, period] = match;
    hours = parseInt(hours, 10);
    if (period.toUpperCase() === 'PM' && hours !== 12) hours += 12;
    if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
    return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
  } catch {
    return '12:00:00';
  }
}

function extractBoroughFromLocation(location) {
  if (!location) return null;
  const boroughs = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
  for (const b of boroughs) {
    if (location.includes(b)) return b;
  }
  return null;
}

/* =====================
   BUILD DATE QUERY FROM GEMINI FILTER
===================== */

function buildDateQuery(dateFilter) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  if (!dateFilter || !dateFilter.type) {
    // Default: today onwards
    return { $gte: todayStr };
  }

  switch (dateFilter.type) {
    case 'any':
      return { $gte: todayStr };

    case 'today':
      return todayStr;
      
    case 'tomorrow': {
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      return tomorrow.toISOString().split('T')[0];
    }
    
    case 'weekend': {
      const dayOfWeek = today.getDay();
      // Find next Friday (or today if it's Fri-Sun)
      let daysUntilFriday = (5 - dayOfWeek + 7) % 7;
      if (dayOfWeek >= 5) daysUntilFriday = 0; // Already weekend
      const friday = new Date(today);
      friday.setDate(today.getDate() + daysUntilFriday);
      const sunday = new Date(friday);
      sunday.setDate(friday.getDate() + 2);
      return { 
        $gte: friday.toISOString().split('T')[0], 
        $lte: sunday.toISOString().split('T')[0] 
      };
    }
    
    case 'this_week': {
      const endOfWeek = new Date(today);
      endOfWeek.setDate(today.getDate() + 7);
      return { 
        $gte: todayStr, 
        $lte: endOfWeek.toISOString().split('T')[0] 
      };
    }
    
    case 'next_week': {
      const startOfNextWeek = new Date(today);
      startOfNextWeek.setDate(today.getDate() + 7);
      const endOfNextWeek = new Date(today);
      endOfNextWeek.setDate(today.getDate() + 14);
      return { 
        $gte: startOfNextWeek.toISOString().split('T')[0], 
        $lte: endOfNextWeek.toISOString().split('T')[0] 
      };
    }
    
    case 'specific':
      if (dateFilter.date) {
        return dateFilter.date;
      }
      return { $gte: todayStr };
      
    default:
      return { $gte: todayStr };
  }
}

/* =====================
   MONGODB QUERY
===================== */

async function searchEventsDB(filters, limit = 20) {
  const collection = await connectToEvents();
  if (!collection) return [];

  const query = { isActive: true };

  // 1. DATE FILTER (from Gemini)
  query.date = buildDateQuery(filters.date);
  console.log(`[EVENTS DB] Date filter:`, JSON.stringify(query.date));

  // 2. PRICE FILTER (from Gemini)
  if (filters.price === 'free') {
    query.price = 'Free';
  }

  // 2b. BOROUGH FILTER
  if (filters.borough && filters.borough !== 'Any' && filters.borough !== 'Anywhere') {
    query.location = { $regex: new RegExp(filters.borough, 'i') };
  }

  // 3. CATEGORY/SEARCH TERM (from Gemini)
  const { loadEventCategories } = require('./query_router');
  const categoryKeywordsMap = loadEventCategories();

  try {
    let results = [];
    const searchTerm = filters.searchTerm;
    const category = filters.category;

    console.log(`[EVENTS DB] Searching - term: "${searchTerm}", category: "${category}"`);

    // PRIMARY: Search by the specific search term
    if (searchTerm) {
      // Try text search first
      results = await collection.find({
        ...query,
        $text: { $search: searchTerm }
      })
      .sort({ date: 1 })
      .limit(limit)
      .toArray();
      
      // Fallback to regex if text search returns nothing
      if (results.length === 0) {
        // Flexible regex: handle plurals (festivals -> festival) 
        // by matching the stem of the word
        const stem = (searchTerm.toLowerCase().endsWith('s') && searchTerm.length > 3)
          ? searchTerm.substring(0, searchTerm.length - 1)
          : searchTerm;
        const flexibleRegex = new RegExp(stem, 'i');

        console.log(`[EVENTS DB] Trying flexible regex for "${stem}"`);
        results = await collection.find({
          ...query,
          $or: [
            { name: { $regex: flexibleRegex } },
            { description: { $regex: flexibleRegex } }
          ]
        })
        .sort({ date: 1 })
        .limit(limit)
        .toArray();
      }
      
      console.log(`[EVENTS DB] Search term "${searchTerm}" found ${results.length} events`);
    }
    
    // FALLBACK: If no results from search term, try category keywords
    if (results.length === 0 && category) {
      let keywords = categoryKeywordsMap[category];
      
      // If the category returned by Gemini isn't in our map, 
      // treat the category name itself as a search keyword
      if (!keywords) {
        console.log(`[EVENTS DB] Category "${category}" not in map, using as keyword`);
        keywords = [category];
      } else {
        console.log(`[EVENTS DB] Fallback to category "${category}" keywords: ${keywords.slice(0, 5).join(', ')}...`);
      }
      
      const orConditions = keywords.flatMap(term => [
        { name: { $regex: new RegExp(term, 'i') } },
        { description: { $regex: new RegExp(term, 'i') } }
      ]);
      
      results = await collection.find({
        ...query,
        $or: orConditions
      })
      .sort({ date: 1 })
      .limit(limit)
      .toArray();
      
      console.log(`[EVENTS DB] Category fallback found ${results.length} events`);
    }
    
    // FINAL FALLBACK: If still nothing, return any events matching date/price
    if (results.length === 0) {
      console.log(`[EVENTS DB] No matches, returning general events`);
      results = await collection.find(query)
        .sort({ date: 1 })
        .limit(limit)
        .toArray();
    }

    console.log(`[EVENTS DB] Final: ${results.length} events`);
    return results.map(mapEventToFormat);
    
  } catch (err) {
    console.error('MongoDB event search failed:', err.message);
    return [];
  }
}

/* =====================
   MAIN SEARCH FUNCTION
===================== */

async function searchEvents(userId, query, context = null) {
  // 1. Get NEW filters from Gemini (passed via context.eventFilters)
  const newFilters = context?.eventFilters || {};
  const filters = { ...newFilters };
  
  // 2. Detect if this is a completely new search topic
  const isFreshSearch = !!(newFilters.searchTerm || newFilters.category);
  const isDifferentTopic = isFreshSearch && 
    (newFilters.searchTerm !== context?.lastFilters?.searchTerm ||
     newFilters.category !== context?.lastFilters?.category);
  
  // 3. Merge with lastFilters ONLY if same topic (for continuation)
  if (context?.lastFilters && !isDifferentTopic) {
    for (const [key, value] of Object.entries(context.lastFilters)) {
      // Never override new values
      if (filters[key] === undefined || filters[key] === null) {
        filters[key] = value;
      }
    }
  }
  
  // 4. If different topic, start fresh - clear shown history
  if (isDifferentTopic) {
    console.log(`[EVENTS] New search topic "${newFilters.searchTerm || newFilters.category}", starting fresh`);
    if (context) {
      context.shownEventIds = [];
    }
  }

  // Support both 'price' and 'priceFilter' naming
  if (filters.priceFilter && !filters.price) {
    filters.price = filters.priceFilter;
  }

  console.log(`[EVENTS] Searching for: "${query}"`);
  console.log(`[EVENTS] Filters used:`, JSON.stringify(filters, null, 2));
  
  // Check for follow-up
  const lowerQuery = query.toLowerCase();
  const followUpPatterns = ['more', 'other', 'different', 'another', 'next'];
  const isFollowUp = followUpPatterns.some(p => lowerQuery.includes(p)) && lowerQuery.split(' ').length <= 5;
  
  // --- CONSTRAINT GATE ---
  // If this is a fresh search (not a follow-up), check what info we're missing
  if (!isFollowUp) {
    console.log(`[EVENTS] Constraint Check - SearchTerm: ${!!filters.searchTerm}, Category: ${!!filters.category}, Date: ${!!filters.date}, Price: ${filters.price}`);

    // 1. Check for missing category/search term
    if (!filters.category && !filters.searchTerm) {
      console.log(`[EVENTS] Missing category/searchTerm, asking...`);
      return {
        query, filters, results: [], count: 0, needsConstraints: true,
        constraintType: 'event_category',
        question: "What kind of events are you looking for?",
        replies: [
          { title: '🎵 Music', payload: 'EVENT_CAT_music' },
          { title: '🎭 Theater', payload: 'EVENT_CAT_theater' },
          { title: '🏀 Sports', payload: 'EVENT_CAT_sports' },
          { title: '🎨 Art', payload: 'EVENT_CAT_art' },
          { title: '🥳 Party', payload: 'EVENT_CAT_nightlife' },
          { title: '🛒 Markets', payload: 'EVENT_CAT_market' }
        ]
      };
    }

    // 2. Check for missing date (only if this is a fresh search OR we don't have date from prior)
    if (!filters.date && (isFreshSearch || !context?.lastFilters?.date)) {
      console.log(`[EVENTS] Missing date, asking...`);
      return {
        query, filters, results: [], count: 0, needsConstraints: true,
        constraintType: 'event_date',
        question: `When are you looking for ${filters.searchTerm || filters.category || ''} events?`,
        replies: [
          { title: 'Today 📅', payload: 'EVENT_DATE_today' },
          { title: 'Tomorrow 🌅', payload: 'EVENT_DATE_tomorrow' },
          { title: 'This Weekend ✨', payload: 'EVENT_DATE_weekend' },
          { title: 'This Week 🗓️', payload: 'EVENT_DATE_this_week' },
          { title: 'Anytime 🕒', payload: 'EVENT_DATE_any' }
        ]
      };
    }

    // 3. Check for missing borough
    if (!filters.borough && (isFreshSearch || !context?.lastFilters?.borough)) {
      console.log(`[EVENTS] Missing borough, asking...`);
      return {
        query, filters, results: [], count: 0, needsConstraints: true,
        constraintType: 'event_borough',
        question: `Where in NYC are you looking for ${filters.searchTerm || filters.category || ''} events?`,
        replies: [
          { title: 'Manhattan 🏙️', payload: 'EVENT_BOROUGH_Manhattan' },
          { title: 'Brooklyn 🌉', payload: 'EVENT_BOROUGH_Brooklyn' },
          { title: 'Queens 🚇', payload: 'EVENT_BOROUGH_Queens' },
          { title: 'Bronx 🏢', payload: 'EVENT_BOROUGH_Bronx' },
          { title: 'Staten Island 🗽', payload: 'EVENT_BOROUGH_Staten Island' },
          { title: 'Anywhere 🌍', payload: 'EVENT_BOROUGH_any' }
        ]
      };
    }

    // 4. Check for missing price (optional, but requested)
    if ((filters.price === undefined || filters.price === null) && (isFreshSearch || (context?.lastFilters?.price === undefined))) {
      console.log(`[EVENTS] Missing price, asking...`);
      return {
        query, filters, results: [], count: 0, needsConstraints: true,
        constraintType: 'event_price',
        question: "Any preference on price?",
        replies: [
          { title: 'Free 💎', payload: 'EVENT_PRICE_free' },
          { title: 'Budget 💸', payload: 'EVENT_PRICE_budget' },
          { title: 'Any 🤷', payload: 'EVENT_PRICE_any' }
        ]
      };
    }
  }

  // Search events with filters
  let results = await searchEventsDB(filters, 20);

  // Exclude already shown events
  const shownIds = context?.shownEventIds || [];
  if (shownIds.length > 0) {
    results = results.filter(e => !shownIds.includes(e.event_id));
  }

  // Limit to 5 results
  results = results.slice(0, 5);

  console.log(`[EVENTS] Returning ${results.length} events`);

  // Fallback to web search if no results
  if (results.length === 0 && GEMINI_API_KEY) {
    const webResults = await searchEventsWithWebSearch(userId, query, filters);
    if (webResults) {
      return { query, filters, results: [], count: 0, webSearchResponse: webResults };
    }
  }

  return { query, filters, results, count: results.length, needsConstraints: false };
}

/* =====================
   WEB SEARCH FALLBACK
===================== */

async function searchEventsWithWebSearch(userId, query, filters) {
  const { checkAndIncrementSearch } = require('./rate_limiter');

  if (!GEMINI_API_KEY || !await checkAndIncrementSearch(userId)) return null;

  try {
    const today = new Date().toISOString().split('T')[0];
    
    let dateHint = '';
    if (filters.date?.type && filters.date.type !== 'any') {
      dateHint = ` (${filters.date.type.replace('_', ' ')})`;
    }
    
    let priceHint = '';
    if (filters.price === 'free') {
      priceHint = ' free';
    }

    const prompt = `Find 5 UPCOMING${priceHint} NYC events matching: "${query}"${dateHint}
Today: ${today}. Only include events on or after today.
Format each as:
1. Event Name
🕓 Date and time
📍 Venue
💰 Price
🔗 Source Name: Link`;

    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.1 }
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

/* =====================
   FORMAT RESULTS
===================== */

function formatEventResults(searchResult) {
  if (searchResult.webSearchResponse) {
    return { text: searchResult.webSearchResponse, isQuestion: false };
  }

  if (searchResult.count === 0) {
    const searchTerm = searchResult.filters?.searchTerm || 'that';
    return { 
      text: `Couldn't find ${searchTerm} events in our database. Try a different date or category?`,
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
    const description = e.event_type || '';
    const link = e.link || '';
    const source = e.source || 'Link';

    response += `${i + 1}. ${name}\n`;
    response += `🕓 ${date}\n`;
    response += `📍 ${location.length > 40 ? location.substring(0, 37) + '...' : location}\n`;
    response += `💰 ${price}\n`;
    
    if (description && description.length < 100) {
      response += `🏷️ ${description.substring(0, 60)}${description.length > 60 ? '...' : ''}\n`;
    }
    
    if (link) {
      response += `🔗 ${source}: ${link}\n`;
    }

    response += '\n';
  });

  response += "Say \"more\" for different events.";

  return { text: response.trim(), isQuestion: false };
}

function formatEventDate(dateTimeStr) {
  try {
    const date = new Date(dateTimeStr);
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    const dateStr = date.toLocaleDateString('en-US', options);
    const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${dateStr} · ${timeStr}`;
  } catch {
    return dateTimeStr?.split('T')[0] || 'TBD';
  }
}

/* =====================
   EXPORTS
===================== */

module.exports = {
  fetchAllEvents,
  searchEvents,
  searchEventsDB,
  formatEventResults
};
