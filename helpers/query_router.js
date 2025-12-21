const axios = require('axios');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({ keepAlive: true }),
});

/**
 * Uses Gemini AI to classify a user query into RESTAURANT, EVENT, or OTHER.
 * @param {string} text The user's message
 * @returns {Promise<string>} 'RESTAURANT', 'EVENT', or 'OTHER'
 */
async function classifyQuery(text) {
    if (!GEMINI_API_KEY) return 'OTHER';

    console.log(`Classifying query: "${text}"`);

    const prompt = `Classify this user request into one of these categories:
- RESTAURANT: user is looking for food, places to eat, specific cuisines, or dining recommendations.
- EVENT: user is looking for concerts, festivals, parades, parks, shows, or "things to do" in NYC.
- OTHER: greetings, general conversation, or any questions NOT related to finding restaurants or NYC events.

Query: "${text}"

Return ONLY one word: RESTAURANT, EVENT, or OTHER. No explanation.`;

    try {
        const response = await geminiClient.post(
            'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
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
