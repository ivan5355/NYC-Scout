/**
 * NYC Scout API Server (Instagram Only)
 * Run with: node api/api.js
 */

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
const { handleDM } = require('../helpers/messaging/message_handler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use((req, res, next) => {
  const started = Date.now();
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

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
async function instagramWebhookHandler(req, res) {
  const body = req.body;
  const messaging = body?.entry?.[0]?.messaging?.[0];
  const messageId = messaging?.message?.mid || messaging?.postback?.mid || null;
  const senderId = messaging?.sender?.id || null;

  console.log('[WEBHOOK] Instagram POST received', JSON.stringify({
    object: body?.object || null,
    entryCount: body?.entry?.length || 0,
    senderId,
    messageId
  }));

  if (body?.object !== 'instagram') {
    console.log('[WEBHOOK] Not an instagram event, ignoring');
    return res.sendStatus(200);
  }

  try {
    await handleDM(body);
  } catch (err) {
    console.error('❌ Error handling DM:', err.message, err.stack);
  }

  res.sendStatus(200);
}

app.post('/instagram', instagramWebhookHandler);
app.post('/api/instagram', instagramWebhookHandler);

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
