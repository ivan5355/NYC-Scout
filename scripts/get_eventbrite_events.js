const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const { MongoClient } = require("mongodb");
const path = require("path");

// Load environment variables from .env.local or .env
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config();
} catch (err) {
  console.warn('⚠️  dotenv failed to load in get_eventbrite_events.js:', err.message);
}

const httpsAgent = new https.Agent({  
  rejectUnauthorized: false
});

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function saveEventsToMongoDB(events) {
  if (!MONGODB_URI) {
    console.error("⚠️  MONGODB_URI not set. Skipping database save.");
    return;
  }

  let client = null;
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('nyc-events');
    const collection = db.collection('eventbrite_events');

    // Create index on URL for efficient upserts
    await collection.createIndex({ url: 1 }, { unique: true });
    await collection.createIndex({ start: 1 }); // Index for date queries
    await collection.createIndex({ scrapedAt: 1 }); // Index for cache management

    const scrapedAt = new Date();
    let inserted = 0;
    let updated = 0;

    // Upsert each event (update if exists, insert if new)
    for (const event of events) {
      const result = await collection.updateOne(
        { url: event.url },
        {
          $set: {
            ...event,
            scrapedAt: scrapedAt,
            source: 'eventbrite'
          },
          $setOnInsert: {
            createdAt: scrapedAt
          }
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        inserted++;
      } else if (result.modifiedCount > 0) {
        updated++;
      }
    }

    // Clean up old events (older than 3 weeks to keep DB lean)
    const threeWeeksAgo = new Date();
    threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
    const deleteResult = await collection.deleteMany({ start: { $lt: threeWeeksAgo.toISOString() } });

    console.error(`\n✅ MongoDB: ${inserted} new events inserted, ${updated} updated, ${deleteResult.deletedCount} old events removed`);
  } catch (err) {
    console.error(`❌ Error saving to MongoDB: ${err.message}`);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

async function getEvents() {
  const baseUrl = "https://www.eventbrite.com/d/ny--new-york/all-events/";

  // Calculate date range for next 2 weeks
  const now = new Date();
  const twoWeeksFromNow = new Date();
  twoWeeksFromNow.setDate(now.getDate() + 14);
  
  // Set to start of day for accurate comparison
  now.setHours(0, 0, 0, 0);
  twoWeeksFromNow.setHours(23, 59, 59, 999);

  const allFoundEvents = [];
  const pagesToFetch = 150;
  const concurrencyLimit = 5; // Fetch 5 pages at a time to be faster but safe

  try {
    for (let i = 1; i <= pagesToFetch; i += concurrencyLimit) {
      const batch = [];
      for (let j = 0; j < concurrencyLimit && (i + j) <= pagesToFetch; j++) {
        batch.push(i + j);
      }

      console.error(`Fetching pages ${batch.join(', ')}...`);
      
      const results = await Promise.all(batch.map(async (page) => {
        try {
          const url = `${baseUrl}?page=${page}`;
          const { data } = await axios.get(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            httpsAgent,
            timeout: 15000
          });
          return data;
        } catch (err) {
          console.error(`Failed to fetch page ${page}: ${err.message}`);
          return null;
        }
      }));

      for (const data of results) {
        if (!data) continue;
        
        const $ = cheerio.load(data);
        const jsonLdScripts = $('script[type="application/ld+json"]');

        jsonLdScripts.each((_, el) => {
          try {
            const json = JSON.parse($(el).html());
            
            const processEvent = (event) => {
              if (event["@type"] === "Event") {
                allFoundEvents.push({
                  title: event.name,
                  start: event.startDate,
                  end: event.endDate,
                  url: event.url,
                  venue: event.location?.name || event.location?.address?.addressLocality
                });
              }
            };

            if (json["@type"] === "ItemList" && json.itemListElement) {
              json.itemListElement.forEach(item => {
                if (item.item) processEvent(item.item);
              });
            } else if (Array.isArray(json)) {
              json.forEach(processEvent);
            } else {
              processEvent(json);
            }
          } catch (err) {}
        });
      }

      // Small delay between batches to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Deduplicate and filter by date
    const seenUrls = new Set();
    const events = allFoundEvents
      .filter(event => {
        // Deduplicate by URL
        if (!event.url || seenUrls.has(event.url)) return false;
        seenUrls.add(event.url);

        if (!event.start) return false;
        try {
          const eventDate = new Date(event.start);
          return eventDate >= now && eventDate <= twoWeeksFromNow;
        } catch (err) {
          return false;
        }
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    console.error(`\nTotal events found: ${events.length}`);
    
    // Save to MongoDB
    await saveEventsToMongoDB(events);
    
    return events;
  } catch (error) {
    console.error("Error fetching events:", error.message);
    return [];
  }
}

// If run directly, execute and print results
if (require.main === module) {
  getEvents().then(events => {
    console.log(JSON.stringify(events, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { getEvents, saveEventsToMongoDB };
