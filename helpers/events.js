const axios = require('axios');
const https = require('https');

const {
  isRestaurantQuery,
  searchRestaurants,
  formatRestaurantResults,
} = require('./restaurants');

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
   WEBHOOK DM ENTRYPOINT
===================== */
async function handleDM(body) {
  console.log(' POST /instagram hit');

  const entry = body?.entry?.[0];
  const messaging = entry?.messaging?.[0];

  if (!messaging || messaging.message?.is_echo) {
    console.log('No message or echo, skipping');
    return;
  }

  const senderId = messaging.sender?.id;
  const text = messaging.message?.text;

  if (!senderId || !text) return;

  await processDM(senderId, text);
}

/* =====================
   DM PROCESSING
===================== */
async function processDM(senderId, messageText) {
  console.log(`Incoming DM from ${senderId}: ${messageText}`);

  const lowerMsg = messageText.toLowerCase();
  let reply = null;

  // 1) Restaurants
  if (isRestaurantQuery(messageText)) {
    try {
      console.log('Processing as restaurant query...');
      const searchResult = await searchRestaurants(messageText);
      reply = formatRestaurantResults(searchResult);
    } catch (err) {
      console.error('Restaurant search failed:', err.message);
      reply = await safeGeminiFallback(messageText);
    }

    await sendInstagramMessage(senderId, reply);
    return;
  }

  // 2) Events (keyword heuristic)
  const eventKeywords = [
    'event', 'concert', 'festival', 'parade', 'fair', 'show', 'happening',
    "what's on", 'things to do'
  ];
  const boroughKeywords = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten'];

  const isEventQuery =
    eventKeywords.some(k => lowerMsg.includes(k)) ||
    boroughKeywords.some(b => lowerMsg.includes(b));

  if (isEventQuery) {
    try {
      console.log('Processing as event query...');
      const searchResult = await searchEvents(messageText);
      reply = formatEventResults(searchResult);
    } catch (err) {
      console.error('Event search failed:', err.message);
      reply = await safeGeminiFallback(messageText);
    }

    await sendInstagramMessage(senderId, reply);
    return;
  }

  // 3) General Gemini
  try {
    console.log('Calling Gemini for general response...');
    reply = await getGeminiResponse(messageText);
  } catch (err) {
    console.error('Gemini failed, using fallback');
    reply = "Thanks for your message! We'll get back to you shortly.";
  }

  await sendInstagramMessage(senderId, reply);
}

async function safeGeminiFallback(messageText) {
  try {
    return await getGeminiResponse(messageText);
  } catch {
    return "Sorry — something went wrong. Try again!";
  }
}

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

// Extract filters from natural language queries
function extractFiltersFromQuery(query) {
  console.log('🔍 Executing extractFiltersFromQuery (Heuristic fallback)...');
  const queryLower = query.toLowerCase();
  const filters = {};
  const today = new Date();

  // Date handling
  if (queryLower.includes('today')) {
    filters.date = { type: 'specific', date: today.toISOString().split('T')[0] };
  } else if (queryLower.includes('tomorrow')) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    filters.date = { type: 'specific', date: tomorrow.toISOString().split('T')[0] };
  } else if (queryLower.includes('weekend')) {
    const daysUntilSat = (6 - today.getDay()) % 7;
    const saturday = new Date(today);
    saturday.setDate(today.getDate() + daysUntilSat);
    const sunday = new Date(saturday);
    sunday.setDate(saturday.getDate() + 1);
    filters.date = {
      type: 'range',
      start_date: saturday.toISOString().split('T')[0],
      end_date: sunday.toISOString().split('T')[0]
    };
  }

  // Month handling
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  for (const [name, num] of Object.entries(months)) {
    if (queryLower.includes(name)) {
      let year = today.getFullYear();
      if (num < today.getMonth() + 1) year++;
      filters.date = { type: 'month', month: num, year };
      break;
    }
  }

  // Category handling
  const categories = {
    concert: ['concert', 'music', 'performance', 'show'],
    festival: ['festival', 'fest', 'celebration'],
    sports: ['sports', 'game', 'match', 'race', 'marathon'],
    parade: ['parade', 'march'],
    fair: ['fair', 'street fair', 'block party'],
    movie: ['movie', 'film', 'screening'],
    art: ['art', 'exhibition', 'gallery'],
    fitness: ['fitness', 'yoga', 'workout'],
    kids: ['kids', 'children', 'family'],
    theater: ['theater', 'theatre', 'play', 'broadway']
  };

  for (const [cat, keywords] of Object.entries(categories)) {
    if (keywords.some(k => queryLower.includes(k))) {
      filters.category = cat;
      break;
    }
  }

  // Borough handling
  const boroughs = {
    Manhattan: ['manhattan', 'midtown', 'downtown', 'uptown', 'central park'],
    Brooklyn: ['brooklyn', 'bk', 'prospect park'],
    Queens: ['queens', 'flushing', 'astoria'],
    Bronx: ['bronx'],
    'Staten Island': ['staten island', 'staten']
  };

  for (const [borough, keywords] of Object.entries(boroughs)) {
    if (keywords.some(k => queryLower.includes(k))) {
      filters.borough = borough;
      break;
    }
  }

  return filters;
}

// Apply filters to event list
function applyFilters(events, filters) {
  console.log('🛠️ Applying filters to event list:', JSON.stringify(filters, null, 2));
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

  if (filters.category) {
    const categoryKeywords = {
      concert: ['concert', 'music', 'performance', 'live'],
      festival: ['festival', 'fest', 'celebration'],
      sports: ['sports', 'athletic', 'race', 'marathon', 'run'],
      parade: ['parade', 'march', 'procession'],
      fair: ['fair', 'street fair', 'block party', 'market'],
      movie: ['movie', 'film', 'screening', 'cinema'],
      art: ['art', 'exhibition', 'gallery', 'museum'],
      fitness: ['fitness', 'yoga', 'workout', 'exercise', 'health'],
      kids: ['kids', 'children', 'family', 'youth'],
      theater: ['theater', 'theatre', 'play', 'broadway', 'drama']
    };
    const keywords = categoryKeywords[filters.category] || [filters.category];

    results = results.filter(event => {
      const eventType = (event.event_type || '').toLowerCase();
      const eventName = (event.event_name || '').toLowerCase();
      return keywords.some(k => eventType.includes(k) || eventName.includes(k));
    });
  }

  if (filters.borough) {
    results = results.filter(event => (event.event_borough || '').toLowerCase() === filters.borough.toLowerCase());
  }

  return results;
}

// Use Gemini AI to parse complex queries
async function extractFiltersWithGemini(query) {
  if (!GEMINI_API_KEY) {
    console.log('⚠️ GEMINI_API_KEY missing, falling back to heuristic extraction.');
    return extractFiltersFromQuery(query);
  }

  console.log('🤖 Executing extractFiltersWithGemini...');

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Extract event search filters from this query. Today's date is ${today}.
Query: "${query}"
Return a JSON object with these fields (only include fields that are mentioned):
- date: object with "type" (specific/range/month) and relevant date fields
- category: one of [concert, festival, sports, parade, fair, movie, art, fitness, kids, theater]
- borough: one of [Manhattan, Brooklyn, Queens, Bronx, Staten Island]
Only return valid JSON, no explanation.`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
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
    return extractFiltersFromQuery(query);
  }
}

// Generate conversational responses
async function getGeminiResponse(userMessage) {
  if (!GEMINI_API_KEY) return 'Thanks for reaching out!';

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: `You are a helpful NYC assistant on Instagram. Keep replies short (1-2 sentences max).\nUser: ${userMessage}` }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.7 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Thanks for reaching out!';
  } catch (err) {
    console.error('Gemini error:', err.message);
    throw err;
  }
}

// Main search function
async function searchEvents(query) {
  const [filters, events] = await Promise.all([
    extractFiltersWithGemini(query),
    fetchAllEvents()
  ]);

  const results = applyFilters(events, filters);
  console.log(`✅ Event search complete. Found ${results.length} events matching query.`);
  return { query, filters, results, count: results.length };
}

// Format event results for Instagram
function formatEventResults(searchResult) {
  if (searchResult.count === 0) {
    return "I couldn't find any events matching your search. Try a different date, category, or borough!";
  }

  const events = searchResult.results.slice(0, 5);
  let response = `Found ${searchResult.count} event${searchResult.count > 1 ? 's' : ''}! Here are the top results:\n\n`;

  events.forEach((e, i) => {
    response += `${i + 1}. ${e.event_name || 'Unnamed Event'}\n`;
    if (e.start_date_time) response += `   📅 ${e.start_date_time.split('T')[0]}\n`;
    if (e.event_location) response += `   📍 ${e.event_location}\n`;
    if (e.event_borough) response += `   🏙️ ${e.event_borough}\n`;
  });

  return response;
}

// Send Instagram message
async function sendInstagramMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('PAGE_ACCESS_TOKEN missing');
    return;
  }

  try {
    await graphClient.post(
      'https://graph.facebook.com/v18.0/me/messages',
      { recipient: { id: recipientId }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );
    console.log(`Reply sent to ${recipientId}`);
  } catch (err) {
    console.error('Send failed:', err.response?.data || err.message);
  }
}

module.exports = {
  // webhook
  handleDM,

  // events API
  fetchAllEvents,
  searchEvents,
  formatEventResults,
};
