const axios = require('axios');
const https = require('https');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

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
      return { $regex: new RegExp(`^${todayStr}`) };

    case 'tomorrow': {
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      return { $regex: new RegExp(`^${tomorrowStr}`) };
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
  if (filters.borough && !['any', 'Any', 'Anywhere', 'Anywhere 🌍'].includes(filters.borough)) {
    query.location = { $regex: new RegExp(filters.borough, 'i') };
  }

  // 3. CATEGORY/SEARCH TERM (from Gemini)
  const { loadEventCategories } = require('../messaging/query_router');
  const categoryKeywordsMap = loadEventCategories();

  try {
    let results = [];
    const searchTerm = filters.searchTerm;
    const category = filters.category;

    console.log(`[EVENTS DB] Searching - term: "${searchTerm}", category: "${category}"`);

    // PRIMARY: Search by the specific search term
    if (searchTerm) {
      // Clean the search term: remove generic words like "show", "event" that cause false positives
      const genericWords = /\b(shows?|events?|things?|to do|activities|nyc|in|the|a|an)\b/gi;
      const cleanTerm = searchTerm.replace(genericWords, '').replace(/\s+/g, ' ').trim();

      console.log(`[EVENTS DB] Cleaned search term: "${cleanTerm}"`);

      if (cleanTerm && cleanTerm.length >= 2) {
        // Try text search with the cleaned term
        const textResults = await collection.find({
          ...query,
          $text: { $search: cleanTerm }
        })
          .sort({ date: 1 })
          .limit(limit)
          .toArray();

        results = [...textResults];

        // Fallback to regex if text search returns few results
        if (results.length < 5) {
          const flexibleRegex = new RegExp(cleanTerm, 'i');

          console.log(`[EVENTS DB] Trying regex for "${cleanTerm}"`);
          const regexResults = await collection.find({
            ...query,
            $or: [
              { name: { $regex: flexibleRegex } },
              { description: { $regex: flexibleRegex } }
            ],
            _id: { $nin: results.map(r => r._id) }
          })
            .sort({ date: 1 })
            .limit(limit - results.length)
            .toArray();

          results = [...results, ...regexResults];
        }

        console.log(`[EVENTS DB] Search term "${cleanTerm}" found ${results.length} events`);
      }
    }

    // FALLBACK/SUPPLEMENT: If few results from search term, try category keywords
    if (results.length < 5 && category) {
      let keywords = categoryKeywordsMap[category];

      // If the category returned by Gemini isn't in our map, 
      // treat the category name itself as a search keyword
      if (!keywords) {
        console.log(`[EVENTS DB] Category "${category}" not in map, using as keyword`);
        keywords = [category];
      } else {
        console.log(`[EVENTS DB] Supplementing with category "${category}" keywords`);
      }

      const orConditions = keywords.flatMap(term => [
        { name: { $regex: new RegExp(term, 'i') } },
        { description: { $regex: new RegExp(term, 'i') } }
      ]);

      const catResults = await collection.find({
        ...query,
        $or: orConditions,
        _id: { $nin: results.map(r => r._id) } // Don't duplicate
      })
        .sort({ date: 1 })
        .limit(limit - results.length)
        .toArray();

      results = [...results, ...catResults];

      console.log(`[EVENTS DB] After category supplement: ${results.length} events`);
    }

    // NO GENERAL FALLBACK: If we found nothing relevant, don't add random events.
    // This prevents "Art Show" appearing for "Comedy Show" - better to go to web search.

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

  // Set defaults for missing filters instead of asking
  if (!filters.date) {
    filters.date = { type: 'any' }; // Default to any date (today onwards)
  }
  if (!filters.borough) {
    filters.borough = 'any'; // Default to all boroughs
  }
  if (!filters.price) {
    filters.price = 'any'; // Default to any price
  }

  // Search events with filters
  let results = await searchEventsDB(filters, 20);
  const dbFoundCount = results.length; // Track how many DB actually found

  // Exclude already shown events ONLY if this is a "more/next" follow-up
  const shownIds = context?.shownEventIds || [];
  if (isFollowUp && shownIds.length > 0) {
    results = results.filter(e => !shownIds.includes(e.event_id));
  }

  // Limit to 5 results
  results = results.slice(0, 5);

  console.log(`[EVENTS] DB found ${dbFoundCount}, after filtering shown: ${results.length}`);

  // Only fallback to web search if DB truly found nothing (not just filtered out)
  if (dbFoundCount === 0 && results.length === 0 && GEMINI_API_KEY) {
    console.log(`[EVENTS] No DB results, falling back to Gemini Web Search...`);
    const webResults = await searchEventsWithWebSearch(userId, query, filters);
    if (webResults) {
      return { query, filters, results: [], count: 0, webSearchResponse: webResults, isWebSearch: true };
    }
  }

  // If DB found events but all were filtered out (already shown)
  if (dbFoundCount > 0 && results.length === 0) {
    console.log(`[EVENTS] All ${dbFoundCount} DB results were already shown`);
    return {
      query,
      filters,
      results: [],
      count: 0,
      needsConstraints: false,
      isWebSearch: false,
      allShown: true,
      message: `You've seen all the ${filters.searchTerm || filters.category || ''} events I found. Try a different date or category?`
    };
  }

  return { query, filters, results, count: results.length, needsConstraints: false, isWebSearch: false };
}

/* =====================
   WEB SEARCH FALLBACK
===================== */

async function searchEventsWithWebSearch(userId, query, filters) {
  const { checkAndIncrementSearch } = require('../utils/rate_limiter');

  if (!GEMINI_API_KEY || !await checkAndIncrementSearch(userId)) return null;

  try {
    const today = new Date().toISOString().split('T')[0];

    let dateHint = '';
    if (filters.date?.type && filters.date.type !== 'any') {
      dateHint = ` for ${filters.date.type.replace('_', ' ')}`;
    }

    let priceHint = '';
    if (filters.price === 'free') {
      priceHint = ' free';
    }

    const prompt = `Find 5-7 UPCOMING${priceHint} NYC events matching: "${query}"${dateHint}.
Today is ${today}. Only include events on or after today.

CRITICAL LINK REQUIREMENT:
- You MUST provide the ORIGINAL source URL (, eventbrite.com, timeout.com, nycparks.gov).
- NEVER use links starting with "https://vertexaisearch.cloud.google.com" or "https://www.google.com/search". These are internal redirect links and do not work for users.
- If you only have a Google redirect link, keep searching until you find the direct website of the event or the publisher.
- No direct link = No event.

SEARCH INSTRUCTIONS:
Search across the entire web for NYC events, prioritizing these top sources:
- Time Out New York, Gothamist, The Skint, DoNYC, NYC Parks (Official), BrooklynVegan, Secret NYC, Ohmyrockness, Resident Advisor, NYC For Free, NYC Tourism (nyctourism.com), Thrillist NYC, Nifty NYC, Guest of a Guest, PureWow NYC, Mommy Poppins (family/kids), Fever Up, Dice.fm, Bandsintown, Eventful, Patch NYC, and New York Magazine (Vulture).
Skip Eventbrite as we already have that data in our database.
Provide 5-7 high-quality results with direct links. If specific matches are few, include popular upcoming NYC events.

IMPORTANT RULES:
- DO NOT include Eventbrite events.
- Return ONLY the list of events. DO NOT include any introductory or concluding text (e.g., "Okay, I will search...", "Here are the results...").
- START your response directly with "1. [Event Name]".
- Each event MUST follow this exact format:

[Number]. [Event Name]
🕓 [Date and Time]
📍 [Venue/Location]
💰 [Price]
🔗 [Source Name]: [Direct URL]

Double-check: Are any links "vertexaisearch" or "google.com/search"? If YES, replace them with the actual website URL or remove the event.
Ensure NO introductory text is present. Avoid phrases like "I found these events" or "I will search for you".
Reply with "Say 'more' for other options." at the end.`;

    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    const text = response.data.candidates?.[0]?.content?.parts
      ?.map(p => p.text)
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) return null;

    // Programmatic cleanup: remove any introductory text before the first event (e.g., "1. Event Name")
    let cleanedText = text;
    const firstEventIndex = cleanedText.search(/\d+\.\s/);
    if (firstEventIndex > 0) {
      cleanedText = cleanedText.substring(firstEventIndex).trim();
    } else if (firstEventIndex === -1) {
      // If NO numbered list was found, the model likely returned ONLY conversational filler
      console.log('[EVENTS] No numbered list found in Gemini response, treating as failure.');
      return null;
    }

    // Programmatic cleanup: remove any Google Search / Vertex AI redirect links that leaked through
    if (cleanedText && (cleanedText.includes('vertexaisearch.cloud.google.com') || cleanedText.includes('google.com/search'))) {
      console.log('[EVENTS] Detected redirect links, filtering response...');

      // Split by numbered list (e.g., "1. ", "2. ")
      const parts = cleanedText.split(/\n(?=\d+\.\s)/);
      const filteredParts = parts.filter(part =>
        !part.includes('vertexaisearch.cloud.google.com') &&
        !part.includes('google.com/search')
      );

      if (filteredParts.length === 0) return null;

      // Re-number and join
      cleanedText = filteredParts.map((part, i) => {
        return part.replace(/^\d+\./, `${i + 1}.`);
      }).join('\n');
    }

    return cleanedText || null;
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
    return {
      text: `🌐 I found these events on the web:\n\n${searchResult.webSearchResponse}`,
      isQuestion: false
    };
  }

  // Handle case where all DB results were already shown
  if (searchResult.allShown) {
    return {
      text: searchResult.message || "You've seen all the events I found. Try a different date or category?",
      isQuestion: false
    };
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
  searchEvents,
  searchEventsDB,
  formatEventResults
};
