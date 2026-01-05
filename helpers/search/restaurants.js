const axios = require('axios');
const https = require('https');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });
const {
  RESTAURANT_SYSTEM_PROMPT,
  NYC_SCOUT_GEMINI_GROUNDED_SEARCH_PROMPT,
  NYC_SCOUT_GEMINI_FORMATTER_PROMPT,
  SPOTLIGHT_SEARCH_PROMPT
} = require('./restaurant_prompts');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const apiClient = axios.create({
  timeout: 60000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// Repair truncated JSON by extracting complete array elements
function repairTruncatedJSON(jsonText) {
  try {
    // Try to find and extract complete results array entries
    const resultsMatch = jsonText.match(/"results"\s*:\s*\[/);
    if (!resultsMatch) return null;

    const startIdx = resultsMatch.index + resultsMatch[0].length;
    const results = [];
    let depth = 1;
    let objStart = startIdx;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < jsonText.length && depth > 0; i++) {
      const char = jsonText[i];

      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;

      if (char === '{') {
        if (depth === 1) objStart = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 1) {
          // Complete object found
          const objText = jsonText.substring(objStart, i + 1);
          try {
            results.push(JSON.parse(objText));
          } catch (e) { /* skip malformed */ }
        }
      } else if (char === ']' && depth === 1) {
        break;
      }
    }

    if (results.length > 0) {
      console.log(`[GEMINI SEARCH] Recovered ${results.length} restaurants from truncated JSON`);
      return { results, note: 'Some results may have been truncated' };
    }
    return null;
  } catch (e) {
    console.error('[GEMINI SEARCH] JSON repair failed:', e.message);
    return null;
  }
}

let mongoClient = null;
let restaurantsCollection = null;

// Prompts moved to restaurant_prompts.js

async function connectToRestaurants() {
  if (mongoClient && restaurantsCollection) return restaurantsCollection;
  if (!MONGODB_URI) return null;

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    restaurantsCollection = db.collection('restaurants');
    return restaurantsCollection;
  } catch (err) {
    console.error('Failed to connect to restaurants collection:', err.message);
    return null;
  }
}

// =====================
// NORMALIZE & DEDUPE
// =====================
function normalizeForDedupe(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function createDedupeKey(name, neighborhood) {
  return `${normalizeForDedupe(name)}|${normalizeForDedupe(neighborhood)}`;
}

// =====================
// SPOTLIGHT DETECTION
// =====================
function detectSpotlightQuery(query) {
  const t = query.toLowerCase();
  const patterns = [
    /why not (.+?)(?:\?|$)/i, /what about (.+?)(?:\?|$)/i,
    /how about (.+?)(?:\?|$)/i, /how is (.+?)(?:\?|$)/i,
    /is (.+?) good/i, /tell me about (.+?)(?:\?|$)/i,
    /have you heard of (.+?)(?:\?|$)/i
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().replace(/[?.!,]+$/, '').trim();
      if (name.length > 2 && !['that', 'this', 'it', 'them'].includes(name)) {
        return { isSpotlight: true, restaurantName: name };
      }
    }
  }
  return { isSpotlight: false, restaurantName: null };
}

// Intent extraction removed - now handled by classifyIntentAndFilters in query_router.js


// search prompt removed - now in restaurant_prompts.js

// formatter prompt removed - now in restaurant_prompts.js

// =====================
// GEMINI WEB SEARCH (retriever with grounding)
// =====================
async function searchWithGemini(intent, excludeNames = []) {
  if (!GEMINI_API_KEY) return { results: [], error: 'No API key' };

  const searchTarget = intent.dish || intent.cuisine || intent.dish_or_cuisine || intent.query || 'restaurant';
  const area = (intent.borough && !['any', 'Any', 'Anywhere'].includes(intent.borough)) ? intent.borough : 'NYC';
  const excludeClause = excludeNames.length > 0 ? excludeNames.join(', ') : '';
  const isDishQuery = intent.request_type === 'dish';
  const dietary = (intent.dietary && intent.dietary.length) ? intent.dietary.join(', ') : 'none';
  const budget = intent.budget || 'any';

  const prompt = NYC_SCOUT_GEMINI_GROUNDED_SEARCH_PROMPT({ searchTarget, area, dietary, budget, excludeClause, isDishQuery });

  try {
    console.log(`[GEMINI SEARCH] "${searchTarget}" in ${area}`);
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[GEMINI SEARCH] Raw response:', text.substring(0, 400));

    // Clean markdown
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      let jsonText = match[0];
      let parsed;

      try {
        parsed = JSON.parse(jsonText);
      } catch (parseErr) {
        // JSON is truncated - try to repair it
        console.log('[GEMINI SEARCH] JSON truncated, attempting repair...');
        parsed = repairTruncatedJSON(jsonText);
      }

      if (parsed && parsed.results) {
        const results = validateResults(parsed.results || [], isDishQuery, isDishQuery ? searchTarget : null);
        console.log(`[GEMINI SEARCH] Found ${results.length} valid restaurants for "${searchTarget}"`);
        return { results, note: parsed.note };
      }
    }
    return { results: [], error: 'No JSON in response' };
  } catch (err) {
    console.error('[GEMINI SEARCH] Failed:', err.message);
    return { results: [], error: err.message };
  }
}

// =====================
// VALIDATE RESULTS
// =====================
function validateResults(results, isDishQuery = false, dishName = null) {
  if (!Array.isArray(results)) return [];

  const badWords = ['museum', 'tour', 'attraction', 'grocery', 'supermarket', 'food hall', 'market'];

  // Build dish-specific evidence pattern if we have a dish name
  let dishEvidencePattern = null;
  if (dishName) {
    const dishLower = dishName.toLowerCase();
    // Create patterns for specific dish types
    if (DISH_PATTERNS.sushi?.test(dishLower) || dishLower.includes('sushi') || dishLower.includes('omakase')) {
      dishEvidencePattern = /(sushi|omakase|nigiri|sashimi|hand ?roll|temaki|maki|chirashi)/i;
    } else if (DISH_PATTERNS.ramen?.test(dishLower) || dishLower.includes('ramen')) {
      dishEvidencePattern = /(ramen|shoyu|tonkotsu|miso|tsukemen|noodle)/i;
    } else if (DISH_PATTERNS.dumplings?.test(dishLower) || dishLower.includes('dumpling')) {
      dishEvidencePattern = /(dumpling|xiaolongbao|xiao long bao|jiaozi|gyoza|momo|bao)/i;
    } else if (DISH_PATTERNS.tacos?.test(dishLower) || dishLower.includes('taco')) {
      dishEvidencePattern = /(taco|birria|al pastor|carnitas|carne asada)/i;
    } else if (dishLower) {
      // Generic pattern: look for the dish name in evidence
      dishEvidencePattern = new RegExp(dishLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }

  return results.filter(r => {
    if (!r.name || r.name.length < 2) return false;
    if (!r.neighborhood && !r.borough) return false;
    if (badWords.some(w => r.name.toLowerCase().includes(w))) return false;

    // For dish queries, require evidence for BOTH exact AND close matches
    // Only cuisine_fallback is allowed without evidence (and must be clearly labeled)
    if (isDishQuery) {
      const matchType = r.dish_match || 'cuisine_fallback';
      if (matchType === 'exact' || matchType === 'close') {
        if (!r.evidence_text || r.evidence_text.length < 5) {
          console.log(`[VALIDATE] Dropping ${r.name} - no evidence_text for ${matchType} dish match`);
          return false;
        }
        if (!r.evidence_url) {
          console.log(`[VALIDATE] Dropping ${r.name} - no evidence_url for ${matchType} dish match`);
          return false;
        }
        // Verify evidence_text actually contains dish-related keywords
        if (dishEvidencePattern && !dishEvidencePattern.test(r.evidence_text)) {
          console.log(`[VALIDATE] Dropping ${r.name} - evidence_text doesn't mention the dish (looking for ${dishName})`);
          return false;
        }
      }
    }

    return true;
  }).map(r => ({
    name: r.name,
    neighborhood: r.neighborhood,
    borough: r.borough,
    price_range: r.price_range,
    what_to_order: r.what_to_order,
    why: r.why,
    vibe: r.vibe,
    dedupeKey: createDedupeKey(r.name, r.neighborhood || r.borough),
    // Keep evidence internal - never expose to user
    _dish_match: r.dish_match,
    _evidence_text: r.evidence_text,
    _evidence_url: r.evidence_url
  }));
}


// =====================
// GEMINI FORMATTER (no sources in output)
// =====================
async function geminiFormatResponse(intent, results, note = null) {
  if (!results.length) {
    return `Couldn't find spots for "${intent.dish || intent.cuisine || 'that'}". Try a different area?`;
  }

  if (!GEMINI_API_KEY) return formatResultsFallback(intent, results);

  // Strip internal fields for formatting
  const cleanResults = results.slice(0, 5).map(r => ({
    name: r.name,
    neighborhood: r.neighborhood,
    borough: r.borough,
    price_range: r.price_range,
    why: r.why,
    what_to_order: r.what_to_order,
    vibe: r.vibe
  }));

  const userRequest = intent.dish || intent.cuisine || 'food';
  const area = intent.borough || 'NYC';
  const resultsJson = JSON.stringify(cleanResults);

  const prompt = NYC_SCOUT_GEMINI_FORMATTER_PROMPT({ userRequest, area, note, resultsJson });

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1000, temperature: 0.3 } },
      { params: { key: GEMINI_API_KEY } }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Strip any URLs that slipped through
    text = text.replace(/https?:\/\/[^\s)]+/g, '').replace(/\[source\]/gi, '');

    if (text.length > 50) return text.trim();
  } catch (err) {
    console.error('[FORMAT] Gemini failed:', err.message);
  }

  return formatResultsFallback(intent, results);
}

function formatResultsFallback(intent, results) {
  if (!results.length) return `Couldn't find spots for "${intent.dish || intent.cuisine}". Try a different area?`;

  let text = '';
  results.slice(0, 5).forEach((r, i) => {
    text += `${i + 1}. ${(r.name || '').toUpperCase()}\n`;
    text += `📍 ${r.neighborhood || ''}, ${r.borough || ''}\n`;
    if (r.price_range) text += `💰 ${r.price_range}`;
    if (r.vibe) text += ` · ${r.vibe}`;
    text += '\n';
    if (r.what_to_order?.length) text += `🍽️ ${r.what_to_order.slice(0, 2).join(', ')}\n`;
    if (r.why) text += `💡 ${r.why}\n`;
    text += '\n';
  });
  text += 'Reply "more" for different options.';
  return text;
}

// =====================
// SPOTLIGHT SEARCH
// =====================
async function spotlightRestaurant(restaurantName, context = null) {
  if (!GEMINI_API_KEY) {
    return { text: `I don't have info on ${restaurantName}. Try Google Maps!`, isSpotlight: true };
  }

  const borough = context?.lastIntent?.borough || 'NYC';
  const prompt = SPOTLIGHT_SEARCH_PROMPT(restaurantName, borough);

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const info = JSON.parse(match[0]);
      if (!info.found) return { text: `Couldn't find "${restaurantName}" in NYC.`, isSpotlight: true };

      let r = `Here's what I found about ${info.name}:\n\n`;
      r += `📍 ${info.neighborhood}, ${info.borough}\n`;
      r += `🍽️ ${info.cuisine} · ${info.price_range} · ${info.vibe}\n`;
      if (info.known_for?.length) r += `🌟 Known for: ${info.known_for.join(', ')}\n`;
      if (info.why_good) r += `💡 ${info.why_good}\n`;
      if (info.tips) r += `📝 ${info.tips}\n`;
      r += `\nWant similar spots?`;
      return { text: r, isSpotlight: true };
    }
  } catch (err) {
    console.error('[SPOTLIGHT] Failed:', err.message);
  }
  return { text: `Trouble looking up ${restaurantName}. Try again?`, isSpotlight: true };
}


// =====================
// MAIN SEARCH FUNCTION
// =====================
async function searchRestaurants(userId, query, providedFilters = null, foodProfile = null, context = null, skipConstraintGate = false, providedIntent = null) {
  // 1. Spotlight check
  const spotlight = detectSpotlightQuery(query);
  if (spotlight.isSpotlight) {
    console.log(`[SPOTLIGHT] "${spotlight.restaurantName}"`);
    const result = await spotlightRestaurant(spotlight.restaurantName, context);
    return {
      query,
      intent: { query, spotlight: true, restaurantName: spotlight.restaurantName },
      results: [],
      count: 0,
      formattedResponse: result.text,
      needsConstraints: false,
      isSpotlight: true
    };
  }

  // 2. Intent is now REQUIRED (provided by classifyIntentAndFilters)
  if (!providedIntent) {
    console.error('[SEARCH] No intent provided - this should not happen');
    return {
      query,
      intent: { request_type: 'vague' },
      results: [],
      count: 0,
      formattedResponse: 'Something went wrong. Please try your search again.',
      needsConstraints: false
    };
  }
  let intent = { ...providedIntent };

  // 3. Apply provided filters
  if (providedFilters) {
    if (providedFilters.borough) intent.borough = providedFilters.borough;
    if (providedFilters.budget) intent.budget = providedFilters.budget;
    if (providedFilters.dish) intent.dish = providedFilters.dish;
    if (providedFilters.cuisine) intent.cuisine = providedFilters.cuisine;
  }

  // 4. Apply profile defaults
  if (foodProfile) {
    if (!intent.borough && foodProfile.borough) intent.borough = foodProfile.borough;
    if (!intent.budget && foodProfile.budget) intent.budget = foodProfile.budget;
  }

  // 5. Check if we need constraints (only if not skipping gate)
  if (!skipConstraintGate && intent.needs_constraint && intent.missing_constraint === 'borough') {
    return {
      query,
      intent,
      results: [],
      count: 0,
      needsConstraints: true,
      pendingFilters: { dish: intent.dish, cuisine: intent.cuisine },
      constraintQuestion: intent.followup_question || 'Where in NYC? (Manhattan, Brooklyn, Queens, Bronx, or Staten Island)'
    };
  }

  // 6. Search with Gemini (grounded web search)
  const excludeNames = context?.shownNames || [];
  const { results, note, error } = await searchWithGemini(intent, excludeNames);

  // 7. Handle low/no results
  if (results.length === 0) {
    if (intent.borough && intent.borough !== 'any') {
      return {
        query,
        intent,
        results: [],
        count: 0,
        needsConstraints: false,
        formattedResponse: `Couldn't find "${intent.dish || intent.cuisine}" in ${intent.borough}. Want me to search all of NYC?`,
        lowResults: true,
        expandOption: true
      };
    }
    return {
      query,
      intent,
      results: [],
      count: 0,
      needsConstraints: false,
      formattedResponse: error || `Couldn't find spots for "${intent.dish || intent.cuisine}". Try something else?`
    };
  }

  // 8. Handle low results (< 3) in specific borough
  if (results.length < 3 && intent.borough && intent.borough !== 'any') {
    const formatted = await geminiFormatResponse(intent, results);
    return {
      query,
      intent,
      results,
      count: results.length,
      formattedResponse: `"${intent.dish || intent.cuisine}" is rare in ${intent.borough} - found ${results.length} spot${results.length === 1 ? '' : 's'}.\n\n${formatted}\n\nWant me to check other boroughs?`,
      pool: results,
      page: 0,
      shownKeys: results.map(r => r.dedupeKey),
      lowResults: true
    };
  }

  // 9. Format and return
  const top5 = results.slice(0, 5);
  let formatted = await geminiFormatResponse(intent, top5, note);

  return {
    query,
    intent,
    results: top5,
    count: top5.length,
    formattedResponse: formatted,
    needsConstraints: false,
    pool: results,
    page: 0,
    shownKeys: top5.map(r => r.dedupeKey),
    shownNames: top5.map(r => r.name),
    hasMore: results.length > 5
  };
}

// =====================
// FORMAT RESULTS (for message handler)
// =====================
function formatRestaurantResults(searchResult) {
  if (searchResult.needsConstraints) {
    return {
      text: searchResult.constraintQuestion || 'Where in NYC? (Manhattan, Brooklyn, Queens, Bronx, or Staten Island)',
      isQuestion: true,
      pendingFilters: searchResult.pendingFilters
    };
  }

  if (searchResult.lowResults && searchResult.expandOption) {
    return {
      text: `${searchResult.formattedResponse}\n\nWant me to search all of NYC? Or try a different dish?`,
      isQuestion: true
    };
  }

  if (searchResult.lowResults) {
    return {
      text: `${searchResult.formattedResponse}\n\nWant me to search all of NYC? Or try a different dish?`,
      isQuestion: false
    };
  }

  return {
    text: searchResult.formattedResponse || "What are you craving?",
    replies: [],
    isQuestion: false
  };
}

// =====================
// DB SEARCH (optional fallback)
// =====================
async function searchRestaurantsDB(filters, limit = 20) {
  const collection = await connectToRestaurants();
  if (!collection) return [];

  const query = {};
  if (filters.cuisine) {
    query.cuisineDescription = { $regex: new RegExp(filters.cuisine, 'i') };
  }
  if (filters.borough && !['any', 'Any', 'Anywhere'].includes(filters.borough)) {
    query.fullAddress = { $regex: new RegExp(filters.borough, 'i') };
  }

  try {
    const results = await collection.find(query)
      .sort({ rating: -1, userRatingsTotal: -1 })
      .limit(limit)
      .toArray();

    return results.map(r => ({
      name: r.name,
      fullAddress: r.fullAddress,
      rating: r.rating,
      cuisineDescription: r.cuisineDescription,
      dedupeKey: createDedupeKey(r.name, r.fullAddress)
    }));
  } catch (err) {
    console.error('DB search failed:', err.message);
    return [];
  }
}

// =====================
// EXPORTS
// =====================
module.exports = {
  searchRestaurants,
  formatRestaurantResults,
  searchRestaurantsDB
};
