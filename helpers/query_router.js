const path = require('path');

// Load environment variables from .env.local or .env (must be first!)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config(); // Also load .env if .env.local doesn't exist
} catch (err) {
  console.warn('⚠️  dotenv failed to load in query_router.js:', err.message);
}

const axios = require('axios');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

const { checkAndIncrementGemini } = require('./rate_limiter');

// Classifies a user query into RESTAURANT, EVENT, or OTHER.
async function classifyQuery(userId, text, history = []) {
    const lowerText = text.toLowerCase();

    // Helper for heuristic classification
    const getHeuristicCategory = (t) => {
        // Check event keywords FIRST (dates/times should lean towards events, not restaurants)
        const eventKeywords = [
            'event', 'concert', 'show', 'festival', 'park', 'doing', 'weekend', 'today', 'tonight', 'music',
            'comedy', 'theater', 'parade', 'market', 'exhibit', 'party', 'gig', 'performance', 'happen',
            'things to do', 'tomorrow', 'this week', 'next week', 'saturday', 'sunday', 'friday',
            'soccer', 'sports', 'game', 'match', 'basketball', 'baseball', 'football', 'hockey',
            'brooklyn', 'manhattan', 'queens', 'bronx', 'staten island', 'brookyn', 'manhatten'
        ];
        if (eventKeywords.some(k => t.includes(k))) return 'EVENT';

        // Then check restaurant keywords (food-specific)
        const restKeywords = [
            'food', 'eat', 'restaurant', 'cuisine', 'dinner', 'lunch', 'breakfast', 'pizza', 'sushi', 'burger',
            'ramen', 'pasta', 'taco', 'steak', 'cafe', 'bakery', 'hungry', 'dining', 'brunch', 'menu', 'delicious',
            'italian', 'mexican', 'chinese', 'thai', 'japanese', 'korean', 'french', 'indian', 'seafood'
        ];
        if (restKeywords.some(k => t.includes(k))) return 'RESTAURANT';

        return 'OTHER';
    };

    if (!GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY missing. Using heuristic classification.');
        return getHeuristicCategory(lowerText);
    }

    // If rate limit exceeded, fallback to heuristic classification
    if (!await checkAndIncrementGemini(userId)) {
        console.warn(`User ${userId} exceeded Gemini rate limit. Using heuristic classification.`);
        return getHeuristicCategory(lowerText);
    }

    console.log(`Classifying query: "${text}" with history of ${history.length} messages`);

    const historyContext = history.length > 0 
        ? `Recent conversation context:\n${history.map(m => `${m.role}: ${m.content}`).join('\n')}\n\n`
        : '';

    const prompt = `${historyContext}Classify this new user request into one of these categories:
- RESTAURANT: user is looking for food, places to eat, specific cuisines, or dining recommendations.
- EVENT: user is looking for concerts, festivals, parades, parks, shows, or "things to do" in NYC.
- OTHER: greetings, general conversation, or any questions NOT related to finding restaurants or NYC events.

New Query: "${text}"

Return ONLY one word: RESTAURANT, EVENT, or OTHER. No explanation.`;

    try {
        if (!GEMINI_API_KEY || GEMINI_API_KEY.trim() === '') {
            console.warn('⚠️ GEMINI_API_KEY is empty in query_router, using heuristic');
            return getHeuristicCategory(lowerText);
        }
        
        console.log('Calling Gemini API for classification with key:', GEMINI_API_KEY.substring(0, 10) + '...');
        const response = await geminiClient.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 10, temperature: 0.1 }
            }
        );

        const classification = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() || '';

        if (classification.includes('RESTAURANT')) return 'RESTAURANT';
        if (classification.includes('EVENT')) return 'EVENT';
        
        // If Gemini returns OTHER but heuristic sees a restaurant/event, trust heuristic
        // This helps when Gemini is being too conservative
        const heuristic = getHeuristicCategory(lowerText);
        if (heuristic !== 'OTHER') return heuristic;

        return 'OTHER';
    } catch (err) {
        console.error('Classification failed, falling back to heuristic:', err.message);
        if (err.response) {
            console.error('   Status:', err.response.status);
            console.error('   Response data:', JSON.stringify(err.response.data));
        }
        return getHeuristicCategory(lowerText);
    }
}

module.exports = { classifyQuery };
