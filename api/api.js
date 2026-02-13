/**
 * NYC Scout API Server
 * Run with: node api/api.js
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const { handleDM, processDMForTest } = require('../helpers/messaging/message_handler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
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
app.post('/instagram', async (req, res) => {
  console.log('📩 Incoming webhook:', JSON.stringify(req.body, null, 2));

  try {
    await handleDM(req.body);
    res.sendStatus(200);
  } catch (err) {
    // Handle rate limiting from Gemini API
    if (err.response?.status === 429) {
      console.log('[RATE LIMIT] Bypassing intent classification - rate limited');
      res.status(200).send('RATE_LIMITED');
      return;
    }
    console.error('❌ Error handling DM:', err.message);
    res.sendStatus(500);
  }
});

// Chat endpoint (used by frontend)
app.post('/api/chat', async (req, res) => {
  const { message, userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  console.log('💬 Chat:', { userId, message });

  try {
    const result = await processDMForTest(userId, message || null);

    res.json({
      reply: result.reply || "I'm not sure how to respond to that.",
      category: result.category || 'OTHER'
    });
  } catch (err) {
    console.error('❌ Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`
  🗽 NYC Scout API Server
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🌐 Server running at: http://localhost:${PORT}
  📩 Instagram webhook: http://localhost:${PORT}/instagram
  💬 Chat endpoint:     POST http://localhost:${PORT}/api/chat
  ❤️ Health check:      http://localhost:${PORT}/api/health
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  });
}

// Export for Vercel serverless
module.exports = app;
