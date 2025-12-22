const axios = require('axios');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const { checkAndIncrementGemini } = require('./rate_limiter');

// Classifies a user query into RESTAURANT, EVENT, or OTHER.
async function classifyQuery(userId, text) {
    if (!GEMINI_API_KEY) return 'OTHER';

    // If rate limit exceeded, fallback to heuristic classification
    if (!await checkAndIncrementGemini(userId)) {
        console.warn(`User ${userId} exceeded Gemini rate limit. Using heuristic classification.`);

        const lowerText = text.toLowerCase();

        // Basic keywords for Restaurants
        const restKeywords = ['food', 'eat', 'restaurant', 'cuisine', 'dinner', 'lunch', 'breakfast', 'pizza', 'sushi', 'burger'];
        if (restKeywords.some(k => lowerText.includes(k))) return 'RESTAURANT';

        // Basic keywords for Events
        const eventKeywords = ['event', 'concert', 'show', 'festival', 'park', 'doing', 'weekend', 'today', 'tonight', 'music'];
        if (eventKeywords.some(k => lowerText.includes(k))) return 'EVENT';

        return 'OTHER';
    }

    console.log(`Classifying query: "${text}"`);

    const prompt = `Classify this user request into one of these categories:
- RESTAURANT: user is looking for food, places to eat, specific cuisines, or dining recommendations.
- EVENT: user is looking for concerts, festivals, parades, parks, shows, or "things to do" in NYC.
- OTHER: greetings, general conversation, or any questions NOT related to finding restaurants or NYC events.

Query: "${text}"

Return ONLY one word: RESTAURANT, EVENT, or OTHER. No explanation.`;

    try {
        const response = await geminiClient.post(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 10, temperature: 0.1 }
            },
            { params: { key: GEMINI_API_KEY } }
        );

        const classification = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();

        if (classification.includes('RESTAURANT')) return 'RESTAURANT';
        if (classification.includes('EVENT')) return 'EVENT';
        return 'OTHER';
    } catch (err) {
        console.error('Classification failed, falling back to OTHER:', err.message);
        return 'OTHER';
    }
}

module.exports = { classifyQuery };
