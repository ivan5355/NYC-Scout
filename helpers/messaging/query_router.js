const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

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
    const categoriesPath = path.join(__dirname, '..', '..', 'data', 'event_categories.json');
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

/* =====================
   INTENT CLASSIFICATION WITH FILTER DETECTION
   This is the new 3-step flow:
   1. Classify query type (EVENT vs RESTAURANT)
   2. Detect existing filters from the query
   3. Generate prompts for missing filters
===================== */

async function classifyIntentAndFilters(userId, text) {
  if (!text || text.trim().length === 0) {
    return {
      type: 'OTHER',
      detectedFilters: {},
      missingFilters: [],
      filterPrompt: null
    };
  }

  const t = text.toLowerCase().trim();
  console.log(`[INTENT] Classifying intent: "${t}"`);

  // Check follow-up patterns locally
  if (FOLLOWUP_PATTERNS.some(p => p.test(t))) {
    console.log(`[INTENT] Match: FOLLOWUP`);
    return {
      type: 'FOLLOWUP',
      detectedFilters: {},
      missingFilters: [],
      filterPrompt: null
    };
  }

  // Use Gemini for classification
  if (GEMINI_API_KEY) {
    return await classifyIntentWithGemini(text);
  }

  // Fallback: basic keyword-based classification
  return fallbackIntentClassification(text);
}

async function classifyIntentWithGemini(text) {
  const categories = loadEventCategories();
  const categoryHelp = Object.entries(categories)
    .map(([cat, keywords]) => `- ${cat}: ${keywords.slice(0, 10).join(', ')}`)
    .join('\n');

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const prompt = `You are a query classifier for a NYC discovery bot. Analyze this message and return structured data.

User message: "${text}"
Today's date: ${todayStr}

STEP 1 - CLASSIFY THE QUERY TYPE:
Return ONE of these types:
- "EVENT" - looking for events, activities, concerts, sports, things to do
- "RESTAURANT" - looking for food, restaurants, where to eat, cuisines, dishes
- "OTHER" - greetings, general questions, unrelated

STEP 2 - DETECT EXISTING FILTERS:
For EVENT queries, check for:
- date: today, tonight, tomorrow, weekend, this week, next week, specific date, or null if not mentioned
- borough: Manhattan, Brooklyn, Queens, Bronx, Staten Island, or null
- price: free, budget, or null
- category: Pick from: ${Object.keys(categories).join(', ')}
- searchTerm: The specific thing they want (e.g., "comedy", "jazz", "soccer")

For RESTAURANT queries, check for:
- cuisine: The type of food (e.g., "thai", "italian", "sushi")
- dish: Specific dish if mentioned (e.g., "pizza", "ramen")
- borough: Manhattan, Brooklyn, Queens, Bronx, Staten Island, or null
- budget: cheap, moderate, expensive, or null
- vibe: casual, romantic, trendy, hidden gem, or null

STEP 3 - IDENTIFY MISSING CRITICAL FILTERS:
For EVENT: date and category/searchTerm are most important
For RESTAURANT: cuisine/dish and borough are most important

Return ONLY valid JSON:
{
  "type": "EVENT" or "RESTAURANT" or "OTHER",
  "detectedFilters": {
    // Include ALL detected filters here
  },
  "missingFilters": ["list", "of", "missing", "critical", "filters"],
  "confidence": 0.0-1.0
}

Examples:
- "jazz tonight in brooklyn" → EVENT, detected: {date: "tonight", borough: "Brooklyn", category: "music", searchTerm: "jazz"}, missing: []
- "best sushi" → RESTAURANT, detected: {cuisine: "sushi"}, missing: ["borough"]
- "things to do" → EVENT, detected: {}, missing: ["category", "date"]
- "thai food manhattan" → RESTAURANT, detected: {cuisine: "thai", borough: "Manhattan"}, missing: []`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    let resultText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    // Clean markdown if present
    if (resultText.startsWith('```')) {
      resultText = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    try {
      const parsed = JSON.parse(resultText);
      const type = parsed.type?.toUpperCase();

      // Validate against user text to prevent hallucination
      const lowerText = text.toLowerCase();
      const detectedFilters = parsed.detectedFilters || {};
      const missingFilters = parsed.missingFilters || [];

      // Verify date wasn't hallucinated
      if (type === 'EVENT' && detectedFilters.date) {
        const dateWords = ['today', 'tonight', 'tomorrow', 'weekend', 'week', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const hasDateMention = dateWords.some(word => lowerText.includes(word));
        if (!hasDateMention) {
          detectedFilters.date = null;
          if (!missingFilters.includes('date')) missingFilters.push('date');
        }
      }

      // Verify borough wasn't hallucinated
      if (detectedFilters.borough) {
        const boroughWords = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten'];
        const hasBoroughMention = boroughWords.some(word => lowerText.includes(word));
        if (!hasBoroughMention) {
          detectedFilters.borough = null;
          if (!missingFilters.includes('borough')) missingFilters.push('borough');
        }
      }

      // Generate appropriate filter prompt
      const filterPrompt = generateFilterPrompt(type, detectedFilters, missingFilters);

      console.log(`[INTENT] Type: ${type}, Detected:`, detectedFilters, 'Missing:', missingFilters);

      return {
        type: type || 'OTHER',
        detectedFilters,
        missingFilters,
        filterPrompt,
        confidence: parsed.confidence || 0.8
      };
    } catch (parseErr) {
      console.error('[INTENT] JSON parse failed:', parseErr.message);
      return fallbackIntentClassification(text);
    }
  } catch (err) {
    console.error('[INTENT] Gemini classification failed:', err.message);
    return fallbackIntentClassification(text);
  }
}

function fallbackIntentClassification(text) {
  const t = text.toLowerCase();

  // Event keywords
  const eventKeywords = ['event', 'concert', 'show', 'comedy', 'music', 'jazz', 'sports', 'game', 'match', 'party', 'festival', 'things to do', 'activities', 'happenings', 'tonight', 'theater', 'theatre', 'nightlife'];

  // Restaurant keywords  
  const foodKeywords = ['food', 'eat', 'restaurant', 'hungry', 'dinner', 'lunch', 'breakfast', 'brunch', 'sushi', 'pizza', 'ramen', 'thai', 'chinese', 'italian', 'mexican', 'indian', 'cuisine', 'dish', 'craving'];

  const isEvent = eventKeywords.some(kw => t.includes(kw));
  const isFood = foodKeywords.some(kw => t.includes(kw));

  let type = 'OTHER';
  if (isEvent && !isFood) type = 'EVENT';
  else if (isFood && !isEvent) type = 'RESTAURANT';
  else if (isEvent && isFood) type = 'OTHER'; // ambiguous

  const detectedFilters = {};
  const missingFilters = [];

  // Basic filter detection
  if (t.includes('tonight') || t.includes('today')) detectedFilters.date = 'today';
  else if (t.includes('tomorrow')) detectedFilters.date = 'tomorrow';
  else if (t.includes('weekend')) detectedFilters.date = 'weekend';
  else if (type === 'EVENT') missingFilters.push('date');

  if (t.includes('manhattan')) detectedFilters.borough = 'Manhattan';
  else if (t.includes('brooklyn')) detectedFilters.borough = 'Brooklyn';
  else if (t.includes('queens')) detectedFilters.borough = 'Queens';
  else missingFilters.push('borough');

  if (t.includes('free')) detectedFilters.price = 'free';

  const filterPrompt = generateFilterPrompt(type, detectedFilters, missingFilters);

  return { type, detectedFilters, missingFilters, filterPrompt, confidence: 0.5 };
}

/* =====================
   FILTER PROMPT GENERATION
===================== */

function generateFilterPrompt(type, detectedFilters, missingFilters) {
  if (!missingFilters || missingFilters.length === 0) {
    return null; // All filters present, ready to search
  }

  if (type === 'EVENT') {
    return generateEventFilterPrompt(detectedFilters, missingFilters);
  } else if (type === 'RESTAURANT') {
    return generateRestaurantFilterPrompt(detectedFilters, missingFilters);
  }

  return null;
}

function generateEventFilterPrompt(detectedFilters, missingFilters) {
  const searchTerm = detectedFilters.searchTerm || detectedFilters.category;

  // Build summary of what we already know
  let knownParts = [];
  if (detectedFilters.searchTerm) knownParts.push(`"${detectedFilters.searchTerm}"`);
  else if (detectedFilters.category) knownParts.push(detectedFilters.category);
  if (detectedFilters.date) knownParts.push(detectedFilters.date);
  if (detectedFilters.borough) knownParts.push(detectedFilters.borough);
  if (detectedFilters.price === 'free') knownParts.push('free');

  // If we have a search term, acknowledge it and ask only for missing filters
  if (searchTerm && missingFilters.length > 0) {
    const summary = `🎪 ${searchTerm}! `;
    
    // Build a focused prompt for just the missing filters
    let missingPrompts = [];
    if (missingFilters.includes('date') && !detectedFilters.date) {
      missingPrompts.push('📅 When? (tonight, this weekend, next week...)');
    }
    if (missingFilters.includes('borough') && !detectedFilters.borough) {
      missingPrompts.push('📍 Where? (Manhattan, Brooklyn, Queens...)');
    }
    if (missingFilters.includes('price') && !detectedFilters.price) {
      missingPrompts.push('💰 Budget? (free, any)');
    }

    if (missingPrompts.length > 0) {
      return {
        text: `${summary}\n\n${missingPrompts.join('\n')}\n\nExample: "Brooklyn this weekend" or "free tonight"`,
        buttons: null,
        type: 'event_filter_request'
      };
    }
  }

  // No search term yet - ask for everything
  const eventFullPrompt = `🎪 NYC has hundreds of events!

Tell me what you're looking for in one message:

📍 Location (Manhattan, Brooklyn, Queens...)
📅 Date (tonight, this weekend, next week...)
💰 Price (free, budget, any)
✨ Type (music, comedy, art, nightlife, sports...)

Example: "comedy in Brooklyn this weekend" or "free concerts tonight"`;

  return {
    text: eventFullPrompt,
    buttons: null,
    type: 'event_filter_request'
  };
}

function generateRestaurantFilterPrompt(detectedFilters, missingFilters) {
  const cuisine = detectedFilters.cuisine || detectedFilters.dish;

  // Build summary of what we already know
  let knownParts = [];
  if (detectedFilters.cuisine) knownParts.push(detectedFilters.cuisine);
  if (detectedFilters.dish) knownParts.push(detectedFilters.dish);
  if (detectedFilters.borough) knownParts.push(detectedFilters.borough);
  if (detectedFilters.budget) knownParts.push(detectedFilters.budget);
  if (detectedFilters.vibe) knownParts.push(detectedFilters.vibe);

  // If we have a cuisine/dish, acknowledge it and ask only for missing filters
  if (cuisine && missingFilters.length > 0) {
    const summary = `🍜 ${cuisine}! `;
    
    // Build a focused prompt for just the missing filters
    let missingPrompts = [];
    if (missingFilters.includes('borough') && !detectedFilters.borough) {
      missingPrompts.push('📍 Where? (Manhattan, Brooklyn, Queens...)');
    }
    if (missingFilters.includes('budget') && !detectedFilters.budget) {
      missingPrompts.push('💰 Budget? (cheap, moderate, fancy)');
    }
    if (missingFilters.includes('vibe') && !detectedFilters.vibe) {
      missingPrompts.push('✨ Vibe? (casual, date night, trendy, hidden gem)');
    }

    if (missingPrompts.length > 0) {
      return {
        text: `${summary}\n\n${missingPrompts.join('\n')}\n\nExample: "Brooklyn, cheap" or "Manhattan date night"`,
        buttons: null,
        type: 'restaurant_filter_request'
      };
    }
  }

  // No cuisine yet - ask for everything
  const restaurantFullPrompt = `🍽️ NYC has thousands of restaurants!

Tell me what you're looking for in one message:

🍜 Food type (sushi, pizza, thai, tacos, italian...)
📍 Location (Manhattan, Brooklyn, Queens...)
💰 Budget (cheap, moderate, fancy)
✨ Vibe (casual, date night, trendy, hidden gem)

Example: "cheap sushi in Manhattan" or "trendy Italian date spot in Brooklyn"`;

  return {
    text: restaurantFullPrompt,
    buttons: null,
    type: 'restaurant_filter_request'
  };
}


/* =====================
   HELPER TO CHECK IF READY TO SEARCH
===================== */

function isReadyToSearch(intentResult) {
  if (!intentResult || intentResult.type === 'OTHER') return false;

  const { type, missingFilters } = intentResult;

  if (type === 'EVENT') {
    // Events need at least a category/searchTerm OR we can default everything
    return missingFilters.length === 0 ||
      (intentResult.detectedFilters.searchTerm || intentResult.detectedFilters.category);
  }

  if (type === 'RESTAURANT') {
    // Restaurants need at least a cuisine/dish
    return intentResult.detectedFilters.cuisine || intentResult.detectedFilters.dish;
  }

  return false;
}

module.exports = {
  classifyQuery,
  getClassificationType,
  getEventFilters,
  loadEventCategories,
  // New exports for intent classification flow
  classifyIntentAndFilters,
  generateFilterPrompt,
  generateEventFilterPrompt,
  generateRestaurantFilterPrompt,
  isReadyToSearch
};
