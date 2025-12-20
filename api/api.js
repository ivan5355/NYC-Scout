const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const { handleDM, fetchAllEvents, searchEvents } = require('../helpers/events');

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
  try {
    await handleDM(req.body);
  } catch (err) {
    console.error('handleDM failed:', err.message);
    // Still 200 so Meta doesn't keep retrying
  }
  res.sendStatus(200);
});

/* =====================
   SERVER START
===================== */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
