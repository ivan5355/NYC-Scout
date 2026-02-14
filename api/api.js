/**
 * NYC Scout API Server (Instagram Only)
 * Run with: node api/api.js
 */

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
const { waitUntil } = require('@vercel/functions');

const { handleDM } = require('../helpers/messaging/message_handler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Instagram Webhook Verification (GET)
app.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'nyc_scout_verify';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Instagram Webhook Handler (POST)
app.post('/instagram', (req, res) => {
  const body = req.body;
  console.log('📩 Incoming webhook:', JSON.stringify(body, null, 2));

  if (body?.object !== 'instagram') {
    console.log('[WEBHOOK] Not an instagram event, ignoring');
    return res.sendStatus(200);
  }

  // Always ACK quickly so Meta keeps webhook delivery healthy.
  res.sendStatus(200);

  const work = handleDM(body).catch((err) => {
    console.error('❌ Error handling DM:', err.message);
  });
  waitUntil(work);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`
  🗽 NYC Scout API Server (Instagram Only)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🌐 Server running at: http://localhost:${PORT}
  📩 Instagram webhook: http://localhost:${PORT}/instagram
  ❤️ Health check:      http://localhost:${PORT}/api/health
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  });
}

// Export for Vercel serverless
module.exports = app;
