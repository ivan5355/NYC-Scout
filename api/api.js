/**
 * NYC Scout API Server
 * Run with: node api/api.js
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const { handleDM, processDMForTest } = require('../helpers/message_handler');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB setup for rate limiting
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const LIMITS = {
  GEMINI_REQUESTS: 100,
  WEB_SEARCHES: 20
};

let mongoClient = null;
let limitsCollection = null;

async function connectToMongoDB() {
  if (limitsCollection) return limitsCollection;

  if (!MONGODB_URI) {
    console.error('MongoDB URI not found in environment variables');
    return null;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    limitsCollection = db.collection('user_limits');
    console.log('Connected to MongoDB user_limits collection');
    return limitsCollection;
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    return null;
  }
}

async function checkAndIncrementGemini(userId) {
  const collection = await connectToMongoDB();
  if (!collection) return true;

  const today = new Date().toISOString().split('T')[0];

  try {
    const userRecord = await collection.findOne({ userId });

    if (!userRecord || userRecord.date !== today) {
      await collection.updateOne(
        { userId },
        { $set: { date: today, gemini: 1, search: 0 } },
        { upsert: true }
      );
      return true;
    }

    if (userRecord.gemini >= LIMITS.GEMINI_REQUESTS) {
      return false;
    }

    await collection.updateOne({ userId }, { $inc: { gemini: 1 } });
    return true;
  } catch (err) {
    console.error('Error checking Gemini rate limit:', err);
    return true;
  }
}

async function checkAndIncrementSearch(userId) {
  const collection = await connectToMongoDB();
  if (!collection) return true;

  const today = new Date().toISOString().split('T')[0];

  try {
    const userRecord = await collection.findOne({ userId });

    if (!userRecord || userRecord.date !== today) {
      await collection.updateOne(
        { userId },
        { $set: { date: today, gemini: 0, search: 1 } },
        { upsert: true }
      );
      return true;
    }

    if (userRecord.search >= LIMITS.WEB_SEARCHES) {
      return false;
    }

    await collection.updateOne({ userId }, { $inc: { search: 1 } });
    return true;
  } catch (err) {
    console.error('Error checking Web Search rate limit:', err);
    return true;
  }
}

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
    console.error('❌ Error handling DM:', err.message);
    res.sendStatus(500);
  }
});

// Chat endpoint (used by frontend)
app.post('/api/chat', async (req, res) => {
  const { message, userId, payload } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  console.log('💬 Chat:', { userId, message, payload });

  try {
    const result = await processDMForTest(userId, message || null, payload || null);
    
    res.json({
      reply: result.reply || "I'm not sure how to respond to that.",
      category: result.category || 'OTHER',
      buttons: result.buttons || null
    });
  } catch (err) {
    console.error('❌ Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint to simulate DM
app.post('/api/test-dm', async (req, res) => {
  const { senderId, text, payload } = req.body;
  
  if (!senderId) {
    return res.status(400).json({ error: 'senderId is required' });
  }

  console.log('🧪 Test DM:', { senderId, text, payload });

  try {
    const result = await processDMForTest(senderId, text || null, payload || null);
    res.json(result);
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`
🗽 NYC Scout API Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 Server running at: http://localhost:${PORT}
📩 Instagram webhook: http://localhost:${PORT}/instagram
💬 Chat endpoint:     POST http://localhost:${PORT}/api/chat
🧪 Test endpoint:     POST http://localhost:${PORT}/api/test-dm
❤️ Health check:      http://localhost:${PORT}/api/health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});

// Export for Vercel serverless (if needed)
module.exports = {
  checkAndIncrementGemini,
  checkAndIncrementSearch
};
