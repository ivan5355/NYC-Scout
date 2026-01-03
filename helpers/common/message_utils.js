const axios = require('axios');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const MORE_PATTERNS = [
  /^more$/i,
  /^more please$/i,
  /^more options$/i,
  /^show more$/i,
  /^show me more$/i,
  /^different options$/i,
  /^other options$/i,
  /^next$/i,
  /^next options$/i,
  /^different ones$/i,
  /^other ones$/i,
  /^gimme more$/i,
  /^give me more$/i,
  /^any more$/i,
  /^anymore$/i,
  /^what else$/i
];

function isMoreRequest(text) {
  if (!text) return false;
  const cleaned = text.toLowerCase().trim();
  return MORE_PATTERNS.some(pattern => pattern.test(cleaned));
}

async function answerFoodQuestion(question, context = null) {
  if (!GEMINI_API_KEY) {
    return "Great question! I'd need to think about that one. In the meantime, want me to find you some restaurant recommendations?";
  }
  
  // Build context about last search/restaurant
  let contextInfo = '';
  if (context?.lastIntent?.restaurantName) {
    contextInfo = `\nContext: User just asked about "${context.lastIntent.restaurantName}"`;
  } else if (context?.lastIntent?.dish_or_cuisine) {
    contextInfo = `\nContext: User just searched for "${context.lastIntent.dish_or_cuisine}" in ${context.lastIntent.borough || 'NYC'}`;
  }
  if (context?.lastResults?.length > 0) {
    const lastRestaurants = context.lastResults.slice(0, 5).map(r => r.name).join(', ');
    contextInfo += `\nRestaurants shown: ${lastRestaurants}`;
  }
  
  const prompt = `You are NYC Scout, a friendly NYC food expert. Answer this question concisely (2-4 sentences max).

Question: "${question}"${contextInfo}

Rules:
- If user asks "why didn't you suggest X" or "why not X" - explain that your search results come from Gemini AI and may not include every restaurant. Suggest they ask specifically about that restaurant.
- If asking about a specific restaurant, use the context to give a helpful answer
- Be honest if you don't know something
- Keep it short for Instagram DM
- Be friendly and helpful

Answer:`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.7 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    const answer = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (answer && answer.length > 10) {
      return answer;
    }
  } catch (err) {
    console.error('Food question answer failed:', err.message);
  }
  
  return "Good question! My search results come from various sources and may not include every restaurant. If you want info on a specific place, just ask me about it directly!";
}

function getSenderId(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  const id = msg?.sender?.id;
  return (id && id !== 'null' && id !== 'undefined') ? String(id) : null;
}

function getIncomingTextOrPayload(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  return {
    text: msg?.message?.text?.trim() || null,
    payload: msg?.message?.quick_reply?.payload || msg?.postback?.payload || null
  };
}

function parseBoroughFromPayload(payload) {
  const boroughMap = {
    'BOROUGH_MANHATTAN': 'Manhattan',
    'BOROUGH_BROOKLYN': 'Brooklyn',
    'BOROUGH_QUEENS': 'Queens',
    'BOROUGH_BRONX': 'Bronx',
    'BOROUGH_STATEN': 'Staten Island',
    'BOROUGH_ANY': 'any',
    'CONSTRAINT_BOROUGH_MANHATTAN': 'Manhattan',
    'CONSTRAINT_BOROUGH_BROOKLYN': 'Brooklyn',
    'CONSTRAINT_BOROUGH_QUEENS': 'Queens',
    'CONSTRAINT_BOROUGH_BRONX': 'Bronx',
    'CONSTRAINT_BOROUGH_STATEN': 'Staten Island',
    'CONSTRAINT_BOROUGH_ANYWHERE': 'any',
    'EVENT_BOROUGH_Manhattan': 'Manhattan',
    'EVENT_BOROUGH_Brooklyn': 'Brooklyn',
    'EVENT_BOROUGH_Queens': 'Queens',
    'EVENT_BOROUGH_Bronx': 'Bronx',
    'EVENT_BOROUGH_Staten Island': 'Staten Island',
    'EVENT_BOROUGH_any': 'any'
  };
  return boroughMap[payload];
}

function parseBoroughFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const boroughMap = {
    'manhattan': 'Manhattan', 'midtown': 'Manhattan', 'downtown': 'Manhattan',
    'uptown': 'Manhattan', 'harlem': 'Manhattan', 'soho': 'Manhattan',
    'brooklyn': 'Brooklyn', 'williamsburg': 'Brooklyn',
    'queens': 'Queens', 'flushing': 'Queens', 'astoria': 'Queens', 'jackson heights': 'Queens',
    'bronx': 'Bronx',
    'staten island': 'Staten Island', 'staten': 'Staten Island',
    'anywhere': 'any', 'any': 'any', 'all': 'any'
  };
  for (const [key, val] of Object.entries(boroughMap)) {
    if (t.includes(key)) return val;
  }
  return undefined; // undefined means not found, null means "anywhere"
}

module.exports = {
  isMoreRequest,
  answerFoodQuestion,
  getSenderId,
  getIncomingTextOrPayload,
  parseBoroughFromPayload,
  parseBoroughFromText,
  geminiClient,
  GEMINI_API_KEY
};

