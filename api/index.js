const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const {
  fetchAllEvents,
  searchEvents,
  formatEventResults,
  getGeminiResponse,
  sendInstagramMessage
} = require('./helpers');

const {
  isRestaurantQuery,
  searchRestaurants,
  formatRestaurantResults,
  getTopRatedRestaurants,
  getRestaurantsByCuisine,
  getRestaurantsByBorough
} = require('./restaurantHelpers');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.TOKEN || 'token';

/* =====================
   ROUTES
===================== */
app.get('/', async (req, res) => {
  const events = await fetchAllEvents();
  res.send(`<h1>Instagram Webhook Running</h1><p>Found ${events.length} NYC events from live APIs</p>`);
});

app.get('/privacy-policy', (req, res) => {
  const file = path.join(__dirname, '..', 'privacy-policy.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Not found');
});

app.get('/terms-of-service', (req, res) => {
  const file = path.join(__dirname, '..', 'terms-of-service.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Not found');
});

app.get('/events/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query parameter "q"' });
  const result = await searchEvents(query);
  res.json(result);
});

// Restaurant search endpoint
app.get('/restaurants/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query parameter "q"' });
  const result = await searchRestaurants(query);
  res.json(result);
});

// Get top-rated restaurants
app.get('/restaurants/top', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const minRating = parseFloat(req.query.minRating) || 4;
  const results = await getTopRatedRestaurants(limit, minRating);
  res.json({ results, count: results.length });
});

// Get restaurants by cuisine
app.get('/restaurants/cuisine/:cuisine', async (req, res) => {
  const cuisine = req.params.cuisine;
  const limit = parseInt(req.query.limit) || 10;
  const results = await getRestaurantsByCuisine(cuisine, limit);
  res.json({ cuisine, results, count: results.length });
});

// Get restaurants by borough
app.get('/restaurants/borough/:borough', async (req, res) => {
  const borough = req.params.borough;
  const limit = parseInt(req.query.limit) || 20;
  const results = await getRestaurantsByBorough(borough, limit);
  res.json({ borough, results, count: results.length });
});

/* =====================
   WEBHOOK VERIFY
===================== */
app.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* =====================
   WEBHOOK RECEIVE
===================== */
app.post('/instagram', async (req, res) => {
  console.log('🚀 POST /instagram hit');

  const entry = req.body.entry?.[0];
  const messaging = entry?.messaging?.[0];

  if (!messaging || messaging.message?.is_echo) {
    console.log('No message or echo, skipping');
    return res.sendStatus(200);
  }

  const senderId = messaging.sender?.id;
  const text = messaging.message?.text;

  if (!senderId || !text) {
    return res.sendStatus(200);
  }

  await processDM(senderId, text);
  res.sendStatus(200);
});

/* =====================
   DM PROCESSING
===================== */
async function processDM(senderId, messageText) {
  console.log(`Incoming DM from ${senderId}: ${messageText}`);

  let reply;
  const lowerMsg = messageText.toLowerCase();

  // Check if user is asking about restaurants
  if (isRestaurantQuery(messageText)) {
    try {
      console.log('Processing as restaurant query...');
      const searchResult = await searchRestaurants(messageText);
      reply = formatRestaurantResults(searchResult);
    } catch (err) {
      console.error('Restaurant search failed:', err.message);
      reply = await getGeminiResponse(messageText);
    }
  }
  // Check if user is asking about events
  else {
    const eventKeywords = ['event', 'concert', 'festival', 'parade', 'fair', 'show', 'happening', "what's on", 'things to do'];
    const isEventQuery = eventKeywords.some(k => lowerMsg.includes(k)) ||
                         ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten'].some(b => lowerMsg.includes(b));

    if (isEventQuery) {
      try {
        console.log('Processing as event query...');
        const searchResult = await searchEvents(messageText);
        reply = formatEventResults(searchResult);
      } catch (err) {
        console.error('Event search failed:', err.message);
        reply = await getGeminiResponse(messageText);
      }
    } else {
      try {
        console.log('Calling Gemini for general response...');
        reply = await getGeminiResponse(messageText);
      } catch (err) {
        console.error('Gemini failed, using fallback');
        reply = "Thanks for your message! We'll get back to you shortly.";
      }
    }
  }

  await sendInstagramMessage(senderId, reply);
}

/* =====================
   SERVER START
===================== */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
