const path = require('path');

// Load environment variables from .env.local or .env (must be first!)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config(); // Also load .env if .env.local doesn't exist
} catch (err) {
  console.warn('⚠️  dotenv failed to load in message_handler.js:', err.message);
}

const { classifyQuery } = require('./query_router');
const { 
    searchRestaurants, 
    formatRestaurantResults, 
    extractRestaurantFiltersWithGemini 
} = require('./restaurants');
const { 
    searchEvents, 
    formatEventResults, 
    extractFiltersWithGemini 
} = require('./events');
const axios = require('axios');
const https = require('https');
const { MongoClient } = require('mongodb');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

let mongoClient = null;
let historyCollection = null;

async function connectToMongoDB() {
    if (historyCollection) return historyCollection;
    if (!MONGODB_URI) return null;
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        const db = mongoClient.db('nyc-events');
        historyCollection = db.collection('conversation_history');
        return historyCollection;
    } catch (err) {
        console.error('Failed to connect to MongoDB for history:', err.message);
        return null;
    }
}

async function getHistory(userId) {
    const col = await connectToMongoDB();
    if (!col) return [];
    const record = await col.findOne({ userId });
    return record?.messages || [];
}

async function saveToHistory(userId, message, role = 'user') {
    const col = await connectToMongoDB();
    if (!col) return;
    const history = await getHistory(userId);
    const updatedHistory = [...history, { role, content: message }].slice(-10); // Keep last 10
    await col.updateOne(
        { userId },
        { $set: { messages: updatedHistory, updatedAt: new Date() } },
        { upsert: true }
    );
}

const geminiClient = axios.create({
    timeout: 30000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const graphClient = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   SHARED QUERY PROCESSOR
   Used by both Instagram DMs and Web Chat
===================== */
async function processQuery(userId, messageText) {
    console.log(`Processing query from ${userId}: ${messageText}`);

    let reply = null;
    let category = null;
    let history = []; // History disabled for now

    try {
        // history = await getHistory(userId); // Disabled
        category = await classifyQuery(userId, messageText, history);
        console.log(`Query classified as: ${category}`);
    } catch (err) {
        console.error('Classification failed:', err.message);
        category = 'OTHER';
    }

    // 1) Restaurants
    if (category === 'RESTAURANT') {
        try {
            console.log('Processing as restaurant query...');
            const filters = await extractRestaurantFiltersWithGemini(userId, messageText, history);
            
            const missing = [];
            // Borough and Cuisine are strictly mandatory (searchTerm is NOT a substitute)
            if (!filters.cuisine) missing.push('cuisine (e.g., Italian, Pizza, Chinese)');
            if (!filters.borough) missing.push('borough (e.g., Manhattan, Brooklyn)');
            
            if (missing.length > 0) {
                reply = `To find the best restaurants, I need to know the ${missing.join(' and ')}. Could you please provide those?`;
                return { reply, category };
            }

            const searchResult = await searchRestaurants(userId, messageText, filters);
            reply = formatRestaurantResults(searchResult);
        } catch (err) {
            console.error('Restaurant search failed:', err.message);
            reply = "I'm sorry, I'm having trouble searching for restaurants right now. Please try again in a moment!";
        }
    }
    // 2) Events
    else if (category === 'EVENT') {
        try {
            console.log('Processing as event query...');
            const filters = await extractFiltersWithGemini(userId, messageText, history);
            
            const missing = [];
            if (!filters.category && !filters.searchTerm) missing.push('what kind of events you are looking for');
            if (!filters.date) missing.push('when (e.g., today, this weekend)');
            if (!filters.borough) missing.push('which borough');

            if (missing.length > 0) {
                reply = `I can help you find events! Could you let me know ${missing.join(' and ')}?`;
                return { reply, category };
            }

            const searchResult = await searchEvents(userId, messageText, filters);
            reply = formatEventResults(searchResult);
        } catch (err) {
            console.error('Event search failed:', err.message);
            reply = "I'm sorry, I'm having trouble searching for events right now. Please try again in a moment!";
        }
    }
    // 3) Everything else (category === 'OTHER')
    else {
        console.log('Processing as general query...');
        try {
            const chatPrompt = `You are NYC Scout, a friendly local guide for New York City. 
            The user said: "${messageText}"
            
            Recent history for context:
            ${history.map(m => `${m.role}: ${m.content}`).join('\n')}

            If they are greeting you, greet them back warmly and explain you can help them find the best restaurants and events in NYC.
            If they are asking a general question not related to NYC food or events, politely steer them back to what you do best (NYC recommendations).
            Keep it brief and helpful.`;

            const response = await geminiClient.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                { contents: [{ parts: [{ text: chatPrompt }] }] }
            );
            
            reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm NYC Scout! I can help you find restaurants and events in NYC. What are you looking for?";
        } catch (err) {
            console.error('General chat failed:', err.message);
            reply = "Hi! I'm NYC Scout. I can help you find the best restaurants and events in NYC. Feel free to ask about food or things to do!";
        }
    }
    
    return { reply, category };
}

/* =====================
   WEBHOOK DM ENTRYPOINT
===================== */
async function handleDM(body) {
    const entry = body?.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging || messaging.message?.is_echo) {
        return;
    }

    const senderId = messaging.sender?.id;
    const text = messaging.message?.text;

    if (!senderId || !text) return;

    await processDM(senderId, text);
}

/* =====================
   DM PROCESSING (Instagram)
===================== */
async function processDM(senderId, messageText) {
    const { reply } = await processQuery(senderId, messageText);
    await sendInstagramMessage(senderId, reply);
}


/* =====================
   INSTAGRAM MESSAGING
===================== */
async function sendInstagramMessage(recipientId, text) {
    if (!PAGE_ACCESS_TOKEN) {
        console.error('PAGE_ACCESS_TOKEN missing');
        return;
    }

    // Instagram has a 1000-character limit for text messages
    const safeText = text.length > 1000 ? text.substring(0, 997) + '...' : text;

    try {
        await graphClient.post(
            'https://graph.facebook.com/v18.0/me/messages',
            { recipient: { id: recipientId }, message: { text: safeText } },
            { params: { access_token: PAGE_ACCESS_TOKEN } }
        );
        console.log(`Reply sent to ${recipientId}`);
    } catch (err) {
        console.error('Send failed:', err.response?.data || err.message);
    }
}

module.exports = {
    handleDM,
    processDM,
    processQuery,
    sendInstagramMessage,
};
