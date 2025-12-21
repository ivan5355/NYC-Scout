const { classifyQuery } = require('./query_router');
const { searchRestaurants, formatRestaurantResults } = require('./restaurants');
const { searchEvents, formatEventResults } = require('./events');
const axios = require('axios');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const geminiClient = axios.create({
    timeout: 30000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const graphClient = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

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
   DM PROCESSING
===================== */
async function processDM(senderId, messageText) {
    console.log(`Incoming DM from ${senderId}: ${messageText}`);

    let reply = null;
    const category = await classifyQuery(messageText);

    // 1) Restaurants
    if (category === 'RESTAURANT') {
        try {
            console.log('Processing as restaurant query...');
            const searchResult = await searchRestaurants(messageText);
            reply = formatRestaurantResults(searchResult);
        } catch (err) {
            console.error('Restaurant search failed:', err.message);
            reply = "I'm sorry, I'm having trouble searching for restaurants right now. Please try again in a moment!";
        }

        await sendInstagramMessage(senderId, reply);
        return;
    }

    // 2) Events
    if (category === 'EVENT') {
        try {
            console.log('Processing as event query...');
            const searchResult = await searchEvents(messageText);
            reply = formatEventResults(searchResult);
        } catch (err) {
            console.error('Event search failed:', err.message);
            reply = "I'm sorry, I'm having trouble searching for events right now. Please try again in a moment!";
        }

        await sendInstagramMessage(senderId, reply);
        return;
    }

    // 3) Everything else (category === 'OTHER')
    console.log('Bot restricted to restaurants/events only.');
    reply = "I'm sorry, I can only help you find restaurants and events in NYC. Feel free to ask about food or things to do!";

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
    sendInstagramMessage,
};
