const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   LOAD EVENT CATEGORIES
===================== */

let EVENT_CATEGORIES = null;

function loadEventCategories() {
  if (EVENT_CATEGORIES) return EVENT_CATEGORIES;
  
  try {
    const categoriesPath = path.join(__dirname, '..', 'data', 'event_categories.json');
    if (fs.existsSync(categoriesPath)) {
      const data = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
      EVENT_CATEGORIES = data.groupedCategories || {};
      console.log(`[ROUTER] Loaded ${Object.keys(EVENT_CATEGORIES).length} event category groups`);
      return EVENT_CATEGORIES;
    }
  } catch (err) {
    console.error('[ROUTER] Failed to load event categories:', err.message);
  }
  
  // Fallback categories if file doesn't exist
  EVENT_CATEGORIES = {
    sports: ['soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'running', 'marathon', 'fitness', 'yoga', 'golf', 'boxing', 'wrestling', 'skating', 'swimming'],
    music: ['concert', 'music', 'jazz', 'rock', 'hiphop', 'classical', 'orchestra', 'dj', 'band', 'singer', 'karaoke', 'opera', 'symphony', 'choir'],
    comedy: ['comedy', 'standup', 'improv', 'openmic'],
    theater: ['theater', 'theatre', 'play', 'musical', 'broadway', 'drama', 'performance'],
    art: ['art', 'gallery', 'museum', 'exhibition', 'painting', 'sculpture', 'photography'],
    film: ['film', 'movie', 'screening', 'documentary', 'cinema'],
    dance: ['dance', 'ballet', 'contemporary', 'salsa', 'swing'],
    food: ['food', 'tasting', 'wine', 'beer', 'cocktail', 'brunch', 'cooking', 'culinary'],
    market: ['market', 'fair', 'festival', 'flea', 'farmers', 'craft', 'vintage'],
    education: ['workshop', 'class', 'seminar', 'lecture', 'talk', 'panel', 'conference'],
    networking: ['networking', 'meetup', 'social', 'mixer', 'singles'],
    family: ['kids', 'children', 'family', 'storytime', 'puppet'],
    outdoor: ['outdoor', 'park', 'garden', 'nature', 'hike', 'walk', 'tour', 'boat'],
    nightlife: ['party', 'club', 'nightlife', 'trivia', 'bingo', 'gamenight'],
    wellness: ['wellness', 'meditation', 'mindfulness', 'healing', 'spa'],
    special: ['parade', 'celebration', 'holiday', 'ceremony', 'gala', 'fundraiser', 'charity'],
  };
  
  return EVENT_CATEGORIES;
}

/* =====================
   FOLLOW-UP DETECTION
===================== */

const FOLLOWUP_PATTERNS = [
  /^more$/i, /^other$/i, /^another$/i, /^different$/i, /^next$/i,
  /show me more/i, /something else/i
];

/* =====================
   MAIN CLASSIFICATION
===================== */

async function classifyQuery(userId, text) {
  if (!text || text.trim().length === 0) return { type: 'OTHER' };
  
  const t = text.toLowerCase().trim();
  console.log(`[ROUTER] Classifying: "${t}"`);
  
  // Check follow-up patterns locally
  if (FOLLOWUP_PATTERNS.some(p => p.test(t))) {
    console.log(`[ROUTER] Match: FOLLOWUP`);
    return { type: 'FOLLOWUP' };
  }
  
  // Use Gemini for classification
  if (GEMINI_API_KEY) {
    console.log(`[ROUTER] Using Gemini classification...`);
    const result = await classifyWithGemini(text);
    console.log(`[ROUTER] Gemini result:`, JSON.stringify(result));
    return result;
  }
  
  console.log(`[ROUTER] No Gemini API key, defaulting to OTHER`);
  return { type: 'OTHER' };
}

/* =====================
   GEMINI CLASSIFICATION
===================== */

async function classifyWithGemini(text) {
  const categories = loadEventCategories();
  
  // Format categories with their keywords for the prompt so Gemini knows our mapping
  const categoryHelp = Object.entries(categories)
    .map(([cat, keywords]) => `- ${cat}: ${keywords.slice(0, 15).join(', ')}`)
    .join('\n');

  // Get today's date for reference
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const prompt = `You are a classifier for a NYC scout chatbot. Analyze this user message and extract structured information.

User message: "${text}"
Today's date: ${todayStr}

STEP 1: Determine the HIGH-LEVEL TYPE:
- FOOD_SEARCH: wants restaurant recommendations or mentions cuisine/dish (e.g. "best pizza", "sushi", "thai food")
- FOOD_SPOTLIGHT: asking about a specific restaurant by name (e.g. "is Lucali good?")
- FOOD_QUESTION: general food/dining questions (e.g. "how to tip in NYC")
- EVENT: wants to find activities, events, sports, concerts, things to do
- OTHER: greetings, unrelated questions

STEP 2: If TYPE is EVENT, extract these 3 filters:

1. DATE - Extract date/time intent ONLY if explicitly mentioned:
   - "today", "tonight", "tomorrow", "weekend", "this week", "next week", "jan 5th", etc.
   - If NO date or relative time is mentioned in the message, you MUST return: "date": null
   - DO NOT guess a date based on the event type.
   - DO NOT default to "next week".

2. PRICE - Extract price intent:
   - "free" mentioned → "free"
   - "cheap" or "budget" or "under $X" → "budget"
   - No price mentioned → null

3. BOROUGH - Extract borough intent:
   - Manhattan, Brooklyn, Queens, Bronx, Staten Island
   - No borough mentioned → null

4. CATEGORY - You MUST pick exactly ONE category from this list based on the keywords:
${categoryHelp}

Also extract the specific SEARCH_TERM (the main thing they're looking for, e.g. "soccer", "jazz", "comedy").

Return JSON only:
{
  "type": "EVENT",
  "eventFilters": {
    "date": {"type": "next_week"} or null,
    "price": "free" or "budget" or null,
    "borough": "Manhattan" or null,
    "category": "Pick from list above",
    "searchTerm": "soccer"
  }
}

Or for non-event queries:
{"type": "FOOD_SEARCH"} or {"type": "OTHER"} etc.`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    let resultText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    
    // Clean markdown if present
    if (resultText.startsWith('```')) {
      resultText = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    }
    
    // Parse JSON response
    try {
      const parsed = JSON.parse(resultText);
      const type = parsed.type?.toUpperCase();
      
      if (type === 'EVENT') {
        const filters = parsed.eventFilters || {};
        const lowerText = text.toLowerCase();
        
        // --- STRICT DATE VERIFICATION ---
        // If Gemini guessed a date but the user didn't mention one, force it to null
        const dateWords = ['today', 'tonight', 'tomorrow', 'weekend', 'week', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'morning', 'afternoon', 'evening', 'night'];
        const hasDateMention = dateWords.some(word => lowerText.includes(word)) || /\d{1,2}\/\d{1,2}/.test(lowerText) || /\d{4}/.test(lowerText);
        
        if (filters.date && !hasDateMention) {
          console.log(`[ROUTER] Gemini guessed date "${JSON.stringify(filters.date)}", but no date in user text "${text}". Nullifying.`);
          filters.date = null;
        }
        
        // --- STRICT PRICE VERIFICATION ---
        // If Gemini guessed a price but the user didn't mention one, force it to null
        const priceWords = ['free', 'cheap', 'budget', 'expensive', 'affordable', '$', 'dollar', 'cost', 'price'];
        const hasPriceMention = priceWords.some(word => lowerText.includes(word));
        
        if (filters.price && !hasPriceMention) {
          console.log(`[ROUTER] Gemini guessed price "${filters.price}", but no price in user text "${text}". Nullifying.`);
          filters.price = null;
        }

        // --- STRICT BOROUGH VERIFICATION ---
        const boroughWords = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten island', 'staten', 'nyc', 'new york'];
        const hasBoroughMention = boroughWords.some(word => lowerText.includes(word));
        
        if (filters.borough && !hasBoroughMention) {
          console.log(`[ROUTER] Gemini guessed borough "${filters.borough}", but no borough in user text "${text}". Nullifying.`);
          filters.borough = null;
        }

        return {
          type: 'EVENT',
          eventFilters: filters
        };
      }
      
      if (['FOOD_SEARCH', 'FOOD_SPOTLIGHT', 'FOOD_QUESTION', 'OTHER', 'FOLLOWUP'].includes(type)) {
        return { type };
      }
      
      return { type: 'OTHER' };
    } catch (parseErr) {
      // If JSON parsing fails, try to extract type from text
      const upper = resultText.toUpperCase();
      if (upper.includes('FOOD_SEARCH')) return { type: 'FOOD_SEARCH' };
      if (upper.includes('FOOD_SPOTLIGHT')) return { type: 'FOOD_SPOTLIGHT' };
      if (upper.includes('FOOD_QUESTION')) return { type: 'FOOD_QUESTION' };
      if (upper.includes('EVENT')) return { type: 'EVENT', eventFilters: {} };
      return { type: 'OTHER' };
    }
  } catch (err) {
    console.error('[ROUTER] Gemini classification failed:', err.message);
    return { type: 'OTHER' };
  }
}

/* =====================
   HELPER FUNCTIONS
===================== */

function getClassificationType(result) {
  if (typeof result === 'string') return result;
  if (result && result.type) return result.type;
  return 'OTHER';
}

function getEventFilters(result) {
  if (result && result.eventFilters) return result.eventFilters;
  return null;
}

module.exports = { 
  classifyQuery, 
  getClassificationType, 
  getEventFilters,
  loadEventCategories 
};
