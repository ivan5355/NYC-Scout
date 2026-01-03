/**
 * Unified NYC Events → MongoDB Sync
 * 
 * Sources:
 * 1. NYC Open Data (Permitted Events)
 * 2. NYC Parks Events
 * 3. Eventbrite NYC
 * 4. Ticketmaster
 * 5. Time Out NYC
 * 
 * Runs periodically (cron or manual) to keep events fresh.
 * Deletes old events and inserts new ones.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit");
const { MongoClient } = require("mongodb");
const path = require("path");
const https = require("https");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

// Create axios instance that bypasses SSL issues for Eventbrite scraping
const axiosNoSSL = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

/* =====================
   CONFIG
===================== */

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "goodrec";
const COLLECTION_NAME = "events";
const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;

// NYC Open Data
const NYC_PERMITTED_EVENTS_URL = 'https://data.cityofnewyork.us/resource/tvpp-9vvx.json';
const NYC_PARKS_EVENTS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.json';

// Eventbrite
const EVENTBRITE_BASE_URL = "https://www.eventbrite.com/d/ny--new-york/events/";
const EVENTBRITE_MAX_PAGES = 10;
const CONCURRENCY = 2;

// Time Out NYC
const TIMEOUT_BASE_URL = "https://www.timeout.com";
const TIMEOUT_PAGES = [
  "/newyork/things-to-do/things-to-do-in-nyc-this-weekend",
  "/newyork/things-to-do",
  "/newyork/music",
  "/newyork/comedy",
  "/newyork/theater",
  "/newyork/nightlife"
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/* =====================
   DATE HELPERS
===================== */

function isWithinNext14Days(dateStr) {
  if (!dateStr) return false;

  const eventDate = new Date(dateStr);
  if (isNaN(eventDate)) return false;

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const maxDate = new Date(now);
  maxDate.setDate(now.getDate() + 14);
  maxDate.setHours(23, 59, 59, 999);

  return eventDate >= now && eventDate <= maxDate;
}

function formatDate(isoString) {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    return d.toISOString().split("T")[0]; // YYYY-MM-DD
  } catch {
    return null;
  }
}

function formatTime(isoString) {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  } catch {
    return null;
  }
}

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

/* =====================
   BOROUGH MAPPING
===================== */

const BOROUGH_MAP = {
  'M': 'Manhattan',
  'B': 'Brooklyn',
  'Q': 'Queens',
  'X': 'Bronx',
  'R': 'Staten Island',
  'MANHATTAN': 'Manhattan',
  'BROOKLYN': 'Brooklyn',
  'QUEENS': 'Queens',
  'BRONX': 'Bronx',
  'STATEN ISLAND': 'Staten Island',
};

function normalizeBorough(raw) {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();
  return BOROUGH_MAP[upper] || BOROUGH_MAP[upper[0]] || raw;
}

/* =====================
   CATEGORY DETECTION
===================== */

const GROUPED_CATEGORIES = {
  sports: ['soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'running', 'marathon', 'cycling', 'fitness', 'yoga', 'golf', 'boxing', 'wrestling', 'skating', 'swimming'],
  music: ['concert', 'music', 'jazz', 'rock', 'hiphop', 'classical', 'orchestra', 'dj', 'band', 'singer', 'karaoke', 'opera', 'symphony', 'choir'],
  comedy: ['comedy', 'standup', 'improv', 'openmic'],
  theater: ['theater', 'theatre', 'play', 'musical', 'broadway', 'drama', 'performance'],
  art: ['art', 'gallery', 'museum', 'exhibition', 'painting', 'sculpture', 'photography'],
  film: ['film', 'movie', 'screening', 'documentary', 'cinema'],
  dance: ['dance', 'ballet', 'contemporary', 'salsa', 'swing'],
  food: ['food', 'tasting', 'wine', 'beer', 'cocktail', 'brunch', 'cooking', 'culinary', 'restaurant'],
  market: ['market', 'fair', 'festival', 'flea', 'farmers', 'craft', 'vintage'],
  education: ['workshop', 'class', 'seminar', 'lecture', 'talk', 'panel', 'conference'],
  networking: ['networking', 'meetup', 'social', 'mixer', 'singles'],
  family: ['kids', 'children', 'family', 'storytime', 'puppet'],
  outdoor: ['outdoor', 'park', 'garden', 'nature', 'hike', 'walk', 'tour', 'boat'],
  nightlife: ['party', 'club', 'nightlife', 'trivia', 'bingo', 'gamenight'],
  wellness: ['wellness', 'meditation', 'mindfulness', 'healing', 'spa'],
  special: ['parade', 'celebration', 'holiday', 'ceremony', 'gala', 'fundraiser', 'charity']
};

function detectCategory(name, description) {
  const text = `${name} ${description}`.toLowerCase();
  
  for (const [category, keywords] of Object.entries(GROUPED_CATEGORIES)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return category;
      }
    }
  }
  
  return 'special'; // Default category
}

/* =====================
   SOURCE 1: NYC PERMITTED EVENTS
===================== */

async function fetchPermittedEvents() {
  const today = new Date().toISOString().split('T')[0];
  try {
    console.log('Fetching NYC Permitted Events...');
    const response = await axiosNoSSL.get(NYC_PERMITTED_EVENTS_URL, {
      params: {
        '$where': `start_date_time >= '${today}'`,
        '$order': 'start_date_time',
        '$limit': 1000
      },
      timeout: 15000
    });

    const events = response.data
      .filter(e => isWithinNext14Days(e.start_date_time))
      .map(event => {
        const borough = normalizeBorough(event.event_borough);
        const location = event.event_location
          ? `${event.event_location}${borough ? ` — ${borough}` : ''}`
          : borough || 'New York City';

        return {
          name: event.event_name || 'NYC Event',
          date: formatDate(event.start_date_time),
          time: formatTime(event.start_date_time),
          location: location,
          description: event.event_type
            ? `${event.event_type} event in NYC. Check source for details.`
            : 'Public event in New York City.',
          link: `https://www.nyc.gov/events`,
          price: 'Check source',
          category: detectCategory(event.event_name || '', event.event_type || ''),
          source: 'GoodRec',
          platform: 'NYC Open Data',
          isActive: true,
          _sourceId: event.event_id,
        };
      });

    console.log(`NYC Permitted: ${events.length} events found`);
    return events;
  } catch (err) {
    console.error('NYC Permitted Events failed:', err.message);
    return [];
  }
}

/* =====================
   SOURCE 2: NYC PARKS EVENTS
===================== */

async function fetchParksEvents() {
  try {
    console.log('Fetching NYC Parks Events...');
    const response = await axiosNoSSL.get(NYC_PARKS_EVENTS_URL, { timeout: 15000 });

    const events = response.data
      .filter(event => {
        const startDate = event.startdate;
        if (!startDate) return false;
        const dateStr = `${startDate}T${parseTime12h(event.starttime)}`;
        return isWithinNext14Days(dateStr);
      })
      .map(event => {
        const parkId = event.parkids || '';
        const borough = BOROUGH_MAP[parkId[0]?.toUpperCase()] || null;
        const startDate = event.startdate;
        const startTime = event.starttime;

        const location = event.location
          ? `${event.location}${borough ? ` — ${borough}` : ''}`
          : borough || 'NYC Park';

        // Format time from "7:00 am" to "7:00 AM"
        let time = null;
        if (startTime) {
          time = startTime.replace(/\s*(am|pm)$/i, (m) => ' ' + m.toUpperCase());
        }

        return {
          name: event.title || 'NYC Parks Event',
          date: startDate, // Already YYYY-MM-DD
          time: time,
          location: location,
          description: event.categories
            ? `${event.categories}. Free event at NYC Parks.`
            : 'Free event at NYC Parks. Check site for details.',
          link: event.link || 'https://www.nycgovparks.org/events',
          price: 'Free',
          category: detectCategory(event.title || '', event.categories || ''),
          source: 'GoodRec',
          platform: 'NYC Parks',
          isActive: true,
          _sourceId: event.guid,
        };
      });

    console.log(`NYC Parks: ${events.length} events found`);
    return events;
  } catch (err) {
    console.error('NYC Parks Events failed:', err.message);
    return [];
  }
}

/* =====================
   SOURCE 3: EVENTBRITE
===================== */

const limit = pLimit(CONCURRENCY);

function extractEventbriteEvents(jsonData) {
  const events = [];

  if (!jsonData || typeof jsonData !== 'object') return events;

  // New format: itemListElement array with ListItem objects
  if (jsonData.itemListElement && Array.isArray(jsonData.itemListElement)) {
    jsonData.itemListElement.forEach(listItem => {
      if (listItem["@type"] === "ListItem" && listItem.item) {
        // The event data is nested inside "item"
        events.push({
          name: listItem.item.name || extractNameFromUrl(listItem.item.url),
          startDate: listItem.item.startDate,
          endDate: listItem.item.endDate,
          description: listItem.item.description,
          url: listItem.item.url,
          image: listItem.item.image,
          location: listItem.item.location,
          offers: listItem.item.offers
        });
      }
    });
  }

  // Also check old format: direct Event objects
  if (jsonData["@type"] === "Event") {
    events.push(jsonData);
  }

  // Recursively check arrays
  if (Array.isArray(jsonData)) {
    jsonData.forEach(item => {
      events.push(...extractEventbriteEvents(item));
    });
  }

  return events;
}

function extractNameFromUrl(url) {
  if (!url) return 'Eventbrite Event';
  // Extract event name from URL like: .../e/event-name-tickets-123456
  const match = url.match(/\/e\/([^\/]+)-tickets/);
  if (match) {
    return match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  return 'Eventbrite Event';
}

async function fetchEventbritePage(page) {
  const url = `${EVENTBRITE_BASE_URL}?page=${page}`;
  try {
    console.log(`Fetching Eventbrite page ${page}...`);
    const { data } = await axiosNoSSL.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

    const events = [];

    const scripts = $('script[type="application/ld+json"]');

    scripts.each((i, el) => {
      try {
        const content = $(el).text();
        if (!content || !content.trim()) return;

        const json = JSON.parse(content);
        const extracted = extractEventbriteEvents(json);
        events.push(...extracted);
      } catch (e) {
        // Skip invalid JSON
      }
    });

    // Deduplicate by name+date
    const pageUnique = [];
    const seen = new Set();
    events.forEach(e => {
      const key = `${e.name}|${e.startDate}`;
      if (!seen.has(key)) {
        pageUnique.push(e);
        seen.add(key);
      }
    });

    console.log(`Eventbrite page ${page}: ${pageUnique.length} events`);
    return pageUnique;
  } catch (err) {
    console.error(`Eventbrite page ${page} failed: ${err.message}`);
    return [];
  }
}

async function fetchEventbriteEvents() {
  console.log('Fetching Eventbrite NYC...');
  const allRawEvents = [];

  for (let i = 1; i <= EVENTBRITE_MAX_PAGES; i++) {
    const pageEvents = await limit(() => fetchEventbritePage(i));
    if (pageEvents.length === 0) {
      console.log(`No events on Eventbrite page ${i}. Stopping.`);
      break;
    }

    allRawEvents.push(...pageEvents);

    // Delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  // Filter and normalize
  const events = allRawEvents
    .filter(e => isWithinNext14Days(e.startDate))
    .map(event => {
      // Extract price from offers
      let price = "Check site";
      if (event.offers) {
        const offers = Array.isArray(event.offers) ? event.offers : [event.offers];
        const firstOffer = offers[0];
        if (firstOffer?.price === "0.00" || firstOffer?.lowPrice === "0.00" || firstOffer?.price === 0) {
          price = "Free";
        } else if (firstOffer?.price) {
          price = `$${firstOffer.price}`;
        } else if (firstOffer?.lowPrice) {
          price = `$${firstOffer.lowPrice}`;
        }
      }

      // Format Location: "Venue Name — Neighborhood, Borough"
      const venueName = event.location?.name || "New York City";
      const neighborhood = event.location?.address?.addressLocality || "";
      const borough = event.location?.address?.addressRegion || "";

      let locationDisplay = venueName;
      if (neighborhood) {
        locationDisplay += ` — ${neighborhood}`;
        if (borough && borough !== "NY" && borough !== "New York") {
          locationDisplay += `, ${borough}`;
        }
      }

      // description: 1–2 lines max
      let description = event.description || "";
      if (description) {
        description = description.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
        if (description.length > 150) {
          description = description.substring(0, 147) + "...";
        }
      } else {
        description = `${event.name}. Check Eventbrite for full details.`;
      }

      return {
        name: event.name || 'Eventbrite Event',
        date: formatDate(event.startDate),
        time: formatTime(event.startDate),
        location: locationDisplay,
        description: description,
        link: event.url || 'https://www.eventbrite.com',
        price: price,
        category: detectCategory(event.name || '', description),
        source: 'GoodRec',
        platform: 'Eventbrite',
        isActive: true,
        _sourceId: event.url, // Use URL as unique identifier
      };
    });

  console.log(`Eventbrite: ${events.length} events found`);
  return events;
}

/* =====================
   SOURCE 4: TICKETMASTER
   ===================== */

async function fetchTicketmasterPage(page, startDateTime, endDateTime) {
  const url = 'https://app.ticketmaster.com/discovery/v2/events.json';
  try {
    const response = await axiosNoSSL.get(url, {
      params: {
        apikey: TICKETMASTER_API_KEY,
        city: 'New York',
        stateCode: 'NY',
        startDateTime: startDateTime,
        endDateTime: endDateTime,
        size: 100,
        page: page,
        sort: 'date,asc'
      },
      timeout: 15000
    });

    const events = response.data?._embedded?.events || [];
    const totalPages = response.data?.page?.totalPages || 0;

    const normalized = events.map(event => {
      // Pricing
      let price = "Check source";
      if (event.priceRanges?.[0]) {
        const p = event.priceRanges[0];
        price = p.min === p.max ? `$${p.min}` : `$${p.min} - $${p.max}`;
      }

      // Location: "Venue — Neighborhood"
      const venue = event._embedded?.venues?.[0]?.name || "New York City";
      const neighborhood = event._embedded?.venues?.[0]?.neighborhood?.name || "";
      const location = neighborhood ? `${venue} — ${neighborhood}` : venue;

      // Description
      let description = event.classifications?.[0]?.segment?.name || "Event";
      if (event.classifications?.[0]?.genre?.name) {
        description += ` (${event.classifications[0].genre.name})`;
      }
      description += ". Official Ticketmaster event.";

      const dateTime = event.dates?.start?.dateTime;

      return {
        name: event.name || 'Ticketmaster Event',
        date: dateTime ? formatDate(dateTime) : event.dates?.start?.localDate,
        time: dateTime ? formatTime(dateTime) : (event.dates?.start?.localTime ? formatTime(`${event.dates.start.localDate}T${event.dates.start.localTime}`) : null),
        location: location,
        description: description,
        link: event.url,
        price: price,
        category: detectCategory(event.name || '', description),
        source: 'GoodRec',
        platform: 'Ticketmaster',
        isActive: true,
        _sourceId: event.id
      };
    });

    return { events: normalized, totalPages };
  } catch (err) {
    console.error(`Ticketmaster page ${page} failed: ${err.message}`);
    return { events: [], totalPages: 0 };
  }
}

async function fetchTicketmasterEvents() {
  if (!TICKETMASTER_API_KEY) {
    console.log('Skipping Ticketmaster: TICKETMASTER_API_KEY not found');
    return [];
  }

  console.log('Fetching Ticketmaster NYC...');

  const now = new Date();
  const twoWeeksLater = new Date();
  twoWeeksLater.setDate(now.getDate() + 14);

  const startDateTime = now.toISOString().split('.')[0] + 'Z';
  const endDateTime = twoWeeksLater.toISOString().split('.')[0] + 'Z';

  let allEvents = [];
  let page = 0;
  let totalPages = 1;

  // Fetch up to 3 pages (300 events) to keep it fast
  while (page < totalPages && page < 3) {
    const result = await limit(() => fetchTicketmasterPage(page, startDateTime, endDateTime));
    allEvents = allEvents.concat(result.events);
    totalPages = result.totalPages;
    console.log(`Ticketmaster page ${page + 1}/${totalPages}: ${result.events.length} events`);
    page++;

    // TM Rate limit is tight
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Ticketmaster: ${allEvents.length} events found`);
  return allEvents;
}

/* =====================
   SOURCE 5: TIME OUT NYC
===================== */

function parseTimeoutDate(text) {
  if (!text) return null;
  
  const cleaned = text.replace(/^(Through|Until|Now until)\s*/i, '').trim();
  
  const parsed = new Date(cleaned);
  if (!isNaN(parsed)) {
    return parsed.toISOString().split("T")[0];
  }
  
  const monthDayMatch = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const now = new Date();
    const year = now.getFullYear();
    const withYear = `${monthDayMatch[1]} ${monthDayMatch[2]}, ${year}`;
    const d = new Date(withYear);
    if (!isNaN(d)) {
      if (d < now) d.setFullYear(year + 1);
      return d.toISOString().split("T")[0];
    }
  }
  
  return null;
}

async function fetchTimeoutPage(pagePath) {
  const url = `${TIMEOUT_BASE_URL}${pagePath}`;
  console.log(`Fetching Time Out: ${pagePath}...`);
  
  try {
    const { data } = await axiosNoSSL.get(url, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(data);
    const events = [];
    
    // Extract JSON-LD structured data
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        if (json["@type"] === "Event" || (Array.isArray(json) && json[0]?.["@type"] === "Event")) {
          const items = Array.isArray(json) ? json : [json];
          items.forEach(item => {
            if (item["@type"] === "Event") {
              events.push({
                name: item.name,
                date: formatDate(item.startDate),
                location: item.location?.name || item.location?.address?.addressLocality || "New York City",
                description: item.description,
                link: item.url,
                price: item.offers?.price ? `$${item.offers.price}` : "Check site"
              });
            }
          });
        }
      } catch (e) { /* Skip invalid JSON */ }
    });
    
    // Scrape article cards
    $('article, [data-testid="tile"], .tile, .card').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h2, h3, .title, [data-testid="tile-title"]').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const description = $el.find('p, .description, .summary').first().text().trim();
      const dateText = $el.find('time, .date, .event-date').first().text().trim();
      
      if (title && title.length > 3) {
        const fullLink = link?.startsWith('http') ? link : (link ? `${TIMEOUT_BASE_URL}${link}` : null);
        events.push({
          name: title,
          date: parseTimeoutDate(dateText),
          location: "New York City",
          description: description || `${title}. See Time Out for details.`,
          link: fullLink,
          price: "Check site"
        });
      }
    });
    
    // Look for numbered list items
    $('li').each((_, el) => {
      const $el = $(el);
      const text = $el.text();
      const numberedMatch = text.match(/^\d+\.\s+(.+)/);
      if (numberedMatch) {
        const title = $el.find('a, h3, h4, strong').first().text().trim();
        const link = $el.find('a').first().attr('href');
        if (title && title.length > 5 && title.length < 200) {
          const fullLink = link?.startsWith('http') ? link : (link ? `${TIMEOUT_BASE_URL}${link}` : null);
          events.push({
            name: title,
            date: null,
            location: "New York City",
            description: `${title}. Featured by Time Out New York.`,
            link: fullLink,
            price: "Check site"
          });
        }
      }
    });
    
    return events;
  } catch (err) {
    console.error(`Time Out ${pagePath} failed: ${err.message}`);
    return [];
  }
}

async function fetchTimeoutEvents() {
  console.log('Fetching Time Out NYC...');
  const allEvents = [];
  
  for (const pagePath of TIMEOUT_PAGES) {
    const events = await fetchTimeoutPage(pagePath);
    allEvents.push(...events);
    await new Promise(r => setTimeout(r, 1500));
  }
  
  // Deduplicate by name
  const unique = [];
  const seen = new Set();
  for (const event of allEvents) {
    const key = event.name?.toLowerCase().trim();
    if (key && !seen.has(key) && key.length > 3) {
      seen.add(key);
      unique.push(event);
    }
  }
  
  // Filter and normalize - include events with valid dates or no date (ongoing events)
  const events = unique
    .filter(e => !e.date || isWithinNext14Days(e.date))
    .map(event => ({
      name: event.name || 'Time Out Event',
      date: event.date || null,
      time: null,
      location: event.location || 'New York City',
      description: event.description?.substring(0, 200) || `${event.name}. Check Time Out for details.`,
      link: event.link || 'https://www.timeout.com/newyork',
      price: event.price || 'Check site',
      category: detectCategory(event.name || '', event.description || ''),
      source: 'GoodRec',
      platform: 'Time Out',
      isActive: true,
      _sourceId: event.link
    }));
  
  console.log(`Time Out: ${events.length} events found`);
  return events;
}

/* =====================
   DATABASE SYNC
===================== */

async function syncAllEvents() {
  console.log('\n========================================');
  console.log('Starting NYC Events Sync');
  console.log('========================================\n');

  // Fetch from all sources in parallel
  const [permitted, parks, eventbrite, ticketmaster, timeout] = await Promise.all([
    fetchPermittedEvents(),
    fetchParksEvents(),
    fetchEventbriteEvents(),
    fetchTicketmasterEvents(),
    fetchTimeoutEvents(),
  ]);

  const allEvents = [...permitted, ...parks, ...eventbrite, ...ticketmaster, ...timeout];

  console.log(`\nTotal events collected: ${allEvents.length}`);
  console.log(`  - NYC Permitted: ${permitted.length}`);
  console.log(`  - NYC Parks: ${parks.length}`);
  console.log(`  - Eventbrite: ${eventbrite.length}`);
  console.log(`  - Ticketmaster: ${ticketmaster.length}`);
  console.log(`  - Time Out: ${timeout.length}`);

  if (allEvents.length === 0) {
    console.log('No events to sync.');
    return;
  }

  if (!MONGO_URI) {
    console.error('\nMONGO_URI not found. Skipping DB sync.');
    console.log('\nSample events:');
    allEvents.slice(0, 3).forEach((e, i) => {
      console.log(`\n${i + 1}. ${e.name}`);
      console.log(`   Date: ${e.date} at ${e.time}`);
      console.log(`   Location: ${e.location}`);
      console.log(`   Price: ${e.price}`);
      console.log(`   Platform: ${e.platform}`);
    });
    return;
  }

  // Connect to MongoDB
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('\nConnected to MongoDB');

  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION_NAME);

  // Enhanced deduplication across all sources
  // Normalizes names to catch duplicates like "The Magic Flute" vs "Magic Flute"
  function normalizeEventName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/^(the|a|an)\s+/i, '')  // Remove leading articles
      .replace(/[^\w\s]/g, '')          // Remove punctuation
      .replace(/\s+/g, ' ')             // Normalize whitespace
      .trim();
  }

  // Priority order: Eventbrite > Ticketmaster > Time Out > NYC Parks > NYC Open Data
  // (Eventbrite/Ticketmaster have better links and pricing)
  const platformPriority = {
    'Eventbrite': 1,
    'Ticketmaster': 2,
    'Time Out': 3,
    'NYC Parks': 4,
    'NYC Open Data': 5
  };

  // Sort by platform priority (lower = better)
  const sorted = [...allEvents].sort((a, b) => {
    const priorityA = platformPriority[a.platform] || 99;
    const priorityB = platformPriority[b.platform] || 99;
    return priorityA - priorityB;
  });

  const unique = [];
  const seen = new Set();

  for (const e of sorted) {
    // Create multiple keys to catch duplicates
    const normalizedName = normalizeEventName(e.name);
    const exactKey = `${e.name?.toLowerCase()}|${e.date}`;
    const normalizedKey = `${normalizedName}|${e.date}`;
    
    // Also check without date for ongoing events
    const nameOnlyKey = normalizedName;

    if (!seen.has(exactKey) && !seen.has(normalizedKey)) {
      // For very short names, also check name-only to avoid "Jazz" duplicates
      if (normalizedName.length < 15 && seen.has(nameOnlyKey)) {
        continue;
      }
      
      unique.push(e);
      seen.add(exactKey);
      seen.add(normalizedKey);
      if (normalizedName.length < 15) {
        seen.add(nameOnlyKey);
      }
    }
  }

  console.log(`After deduplication: ${unique.length} unique events`);

  // Delete all existing events and insert fresh
  const deleteResult = await collection.deleteMany({});
  console.log(`Deleted ${deleteResult.deletedCount} old events`);

  if (unique.length > 0) {
    // Remove internal _sourceId before inserting (optional, or keep for debugging)
    const toInsert = unique.map(({ _sourceId, ...rest }) => rest);

    await collection.insertMany(toInsert);
    console.log(`Inserted ${toInsert.length} events`);
  }

  // Create indexes for fast queries
  await collection.createIndex({ date: 1 });
  await collection.createIndex({ platform: 1 });
  await collection.createIndex({ isActive: 1 });
  await collection.createIndex({ name: 'text', description: 'text', location: 'text' });

  console.log('Indexes created');

  await client.close();
  console.log('\n========================================');
  console.log('Sync complete!');
  console.log('========================================\n');
}

/* =====================
   RUN
===================== */

(async () => {
  try {
    await syncAllEvents();
    process.exit(0);
  } catch (err) {
    console.error('Sync failed:', err);
    process.exit(1);
  }
})();

