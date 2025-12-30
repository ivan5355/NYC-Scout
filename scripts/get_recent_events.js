/**
 * Unified NYC Events → MongoDB Sync
 * 
 * Sources:
 * 1. NYC Open Data (Permitted Events)
 * 2. NYC Parks Events
 * 3. Eventbrite NYC
 * 
 * Runs periodically (cron or manual) to keep events fresh.
 * Deletes old events and inserts new ones.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit");
const { MongoClient } = require("mongodb");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

/* =====================
   CONFIG
===================== */

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "goodrec";
const COLLECTION_NAME = "events";

// NYC Open Data
const NYC_PERMITTED_EVENTS_URL = 'https://data.cityofnewyork.us/resource/tvpp-9vvx.json';
const NYC_PARKS_EVENTS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.json';

// Eventbrite
const EVENTBRITE_BASE_URL = "https://www.eventbrite.com/d/ny--new-york/events/";
const EVENTBRITE_MAX_PAGES = 10;
const CONCURRENCY = 2;

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
   SOURCE 1: NYC PERMITTED EVENTS
===================== */

async function fetchPermittedEvents() {
  const today = new Date().toISOString().split('T')[0];
  try {
    console.log('Fetching NYC Permitted Events...');
    const response = await axios.get(NYC_PERMITTED_EVENTS_URL, {
      params: {
        '$where': `start_date_time >= '${today}'`,
        '$order': 'start_date_time',
        '$limit': 500
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
          link: `https://www.nyc.gov/events`, // NYC Open Data doesn't provide direct links
          price: 'Check source',
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
    const response = await axios.get(NYC_PARKS_EVENTS_URL, { timeout: 15000 });

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

function findEventsRecursive(obj) {
  let events = [];
  
  if (!obj || typeof obj !== 'object') return events;
  
  if (Array.isArray(obj)) {
    obj.forEach(item => {
      events.push(...findEventsRecursive(item));
    });
  } else {
    if (obj["@type"] === "Event") {
      events.push(obj);
    }
    
    for (const key in obj) {
      if (typeof obj[key] === 'object') {
        events.push(...findEventsRecursive(obj[key]));
      }
    }
  }
  
  return events;
}

async function fetchEventbritePage(page) {
  const url = `${EVENTBRITE_BASE_URL}?page=${page}`;
  try {
    console.log(`Fetching Eventbrite page ${page}...`);
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

    const events = [];
    
    const scripts = $('script[type="application/ld+json"]');

    scripts.each((i, el) => {
      try {
        const content = $(el).text();
        if (!content || !content.trim()) return;
        
        const json = JSON.parse(content);
        const extracted = findEventsRecursive(json);
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
   DATABASE SYNC
===================== */

async function syncAllEvents() {
  console.log('\n========================================');
  console.log('Starting NYC Events Sync');
  console.log('========================================\n');

  // Fetch from all sources in parallel
  const [permitted, parks, eventbrite] = await Promise.all([
    fetchPermittedEvents(),
    fetchParksEvents(),
    fetchEventbriteEvents(),
  ]);

  const allEvents = [...permitted, ...parks, ...eventbrite];

  console.log(`\nTotal events collected: ${allEvents.length}`);
  console.log(`  - NYC Permitted: ${permitted.length}`);
  console.log(`  - NYC Parks: ${parks.length}`);
  console.log(`  - Eventbrite: ${eventbrite.length}`);

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

  // Deduplicate by name + date (across all sources)
  const unique = [];
  const seen = new Set();
  for (const e of allEvents) {
    const key = `${e.name?.toLowerCase()}|${e.date}`;
    if (!seen.has(key)) {
      unique.push(e);
      seen.add(key);
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

