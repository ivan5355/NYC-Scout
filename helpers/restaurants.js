const axios = require('axios');
const https = require('https');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const apiClient = axios.create({
  timeout: 60000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

let mongoClient = null;
let restaurantsCollection = null;

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

// =====================
// INTENT EXTRACTION
// =====================
function extractIntent(query) {
  const t = query.toLowerCase();
  const intent = { query, dish_or_cuisine: null, is_dish: false, borough: null, budget: null, occasion: null, dietary: [] };
  
  const boroughMap = {
    'manhattan': 'Manhattan', 'midtown': 'Manhattan', 'downtown': 'Manhattan',
    'brooklyn': 'Brooklyn', 'williamsburg': 'Brooklyn',
    'queens': 'Queens', 'flushing': 'Queens', 'astoria': 'Queens',
    'bronx': 'Bronx', 'staten island': 'Staten Island'
  };
  for (const [key, val] of Object.entries(boroughMap)) {
    if (t.includes(key)) { intent.borough = val; break; }
  }
  
  if (t.includes('cheap') || t.includes('budget')) intent.budget = '$';
  else if (t.includes('fancy') || t.includes('upscale')) intent.budget = '$$$';
  
  if (t.includes('birthday') || t.includes('anniversary')) intent.occasion = 'celebration';
  else if (t.includes('date') || t.includes('romantic')) intent.occasion = 'date';
  
  if (t.includes('vegetarian')) intent.dietary.push('vegetarian');
  if (t.includes('vegan')) intent.dietary.push('vegan');
  if (t.includes('halal')) intent.dietary.push('halal');
  
  const dishPatterns = [/fried rice/i, /noodles?/i, /soup/i, /burger/i, /tacos?/i, /pizza/i, /curry/i, /biryani/i, /ramen/i, /pho/i, /sushi/i, /dumpling/i, /borscht/i, /pierogi/i, /pastrami/i, /cake/i, /medovik/i, /dessert/i];
  intent.is_dish = dishPatterns.some(p => p.test(t));
  
  const cuisines = ['indian', 'chinese', 'thai', 'japanese', 'korean', 'mexican', 'italian', 'french', 'vietnamese', 'russian', 'ukrainian', 'jewish', 'polish'];
  for (const c of cuisines) {
    if (t.includes(c)) { intent.dish_or_cuisine = c.charAt(0).toUpperCase() + c.slice(1); break; }
  }
  if (!intent.dish_or_cuisine) {
    intent.dish_or_cuisine = query.replace(/in (manhattan|brooklyn|queens|bronx|nyc)/gi, '').replace(/food|restaurant|spots?|places?/gi, '').trim();
  }
  
  return intent;
}

// =====================
// DISH SYNONYMS - DYNAMIC WITH GEMINI
// =====================
async function getDishSynonyms(dish) {
  if (!dish) return [];
  const d = dish.toLowerCase().trim();
  
  // For very common terms, just return as-is
  if (d.length < 3) return [d];
  
  // Use Gemini to get synonyms for any dish
  if (GEMINI_API_KEY) {
    try {
      const prompt = `For the food/dish "${dish}":
1. What cuisine is it from?
2. What are similar dishes?
3. What type of restaurant serves it?

Return ONLY a comma-separated list of 5-7 search terms. Include: dish name, cuisine type, similar dishes, restaurant type.
Example for "junglee mutton": junglee mutton, indian mutton, spicy lamb curry, indian restaurant, north indian, mutton masala, lamb dishes`;
      
      const response = await apiClient.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 150, temperature: 0.2 } },
        { params: { key: GEMINI_API_KEY } }
      );
      
      const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) {
        const synonyms = text.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 1 && s.length < 50);
        if (synonyms.length > 0) {
          console.log(`Synonyms for "${dish}": ${synonyms.join(', ')}`);
          return synonyms;
        }
      }
    } catch (err) {
      console.log('Synonym generation failed:', err.message);
    }
  }
  
  // Fallback: just use the original term
  return [d];
}

// =====================
// AMBIGUOUS DISH CLARIFICATION
// =====================
function getAmbiguousDishClarification(dish) {
  if (!dish) return { needsClarification: false };
  const d = dish.toLowerCase();
  
  if (d.includes('triple') && (d.includes('rice') || d.includes('schezwan'))) {
    return {
      needsClarification: true,
      question: "Quick check - do you mean Mumbai-style Triple Schezwan?",
      options: [
        { title: "Yes, Triple Schezwan", payload: "DISH_TRIPLE_SCHEZWAN" },
        { title: "No, just fried rice", payload: "DISH_FRIED_RICE" },
        { title: "Any Indo-Chinese", payload: "DISH_INDO_CHINESE" }
      ],
      dishMappings: {
        "DISH_TRIPLE_SCHEZWAN": { dish: "triple schezwan", cuisine: "Indo-Chinese" },
        "DISH_FRIED_RICE": { dish: "fried rice", cuisine: "Chinese" },
        "DISH_INDO_CHINESE": { dish: "indo-chinese", cuisine: "Indo-Chinese" }
      }
    };
  }
  return { needsClarification: false };
}

// =====================
// SPOTLIGHT SEARCH (GEMINI WEB SEARCH)
// =====================
async function spotlightRestaurant(restaurantName, context = null) {
  if (!GEMINI_API_KEY) {
    return { text: `I don't have info on ${restaurantName}. Try Google Maps!`, isSpotlight: true };
  }
  
  const borough = context?.lastIntent?.borough || 'NYC';
  const prompt = `Research "${restaurantName}" restaurant in ${borough}.
Return JSON only: {"found":true,"name":"","neighborhood":"","borough":"","cuisine":"","price_range":"$20-40","vibe":"","known_for":[],"tips":"","sentiment":"","why_good":"","why_skip":""}. 
If not found, return {"found":false}. Use actual dollar amounts for price_range.`;

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );
    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const info = JSON.parse(match[0]);
      if (!info.found) return { text: `Couldn't find "${restaurantName}" in NYC.`, isSpotlight: true };
      
      let r = `Here's what I found about ${info.name}:\n\n`;
      r += `📍 ${info.neighborhood}, ${info.borough}\n`;
      r += `🍽️ ${info.cuisine} · ${info.price_range || info.price} · ${info.vibe}\n`;
      if (info.known_for?.length) r += `🌟 Known for: ${info.known_for.join(', ')}\n`;
      if (info.why_good) r += `💡 ${info.why_good}\n`;
      if (info.tips) r += `📝 ${info.tips}\n`;
      if (info.sentiment) r += `💬 ${info.sentiment}\n`;
      r += `\nWant similar spots?`;
      return { text: r, isSpotlight: true };
    }
    return { text: `Found info but couldn't parse it. Try again?`, isSpotlight: true };
  } catch (err) {
    console.error('Restaurant spotlight failed:', err.message);
    return { text: `Trouble looking up ${restaurantName}. Try again?`, isSpotlight: true };
  }
}

// =====================
// GEMINI WEB SEARCH FOR RESTAURANTS
// =====================
async function searchRestaurantsWeb(intent, shownKeys = []) {
  if (!GEMINI_API_KEY) return { results: [], error: 'API key missing' };
  
  const exclude = shownKeys.length ? `Exclude: ${shownKeys.map(k => k.split('|')[0]).join(', ')}` : '';
  const synonyms = await getDishSynonyms(intent.dish_or_cuisine);
  const area = intent.borough && intent.borough !== 'Any' ? `in ${intent.borough}` : 'in NYC';

  const prompt = `Find 5-8 NYC restaurants for "${intent.dish_or_cuisine || intent.query}" ${area}.

Search terms: ${synonyms.join(', ')}
${exclude}

IMPORTANT RULES:
1. If the exact dish is rare/niche, include restaurants serving similar dishes from that cuisine
3. Always return at least 3-5 restaurants that serve the cuisine type, even if they don't have the exact dish
4. price_range MUST be actual dollar amounts like "$15-25" or "$30-50"

Return JSON ONLY: {"results":[{"name":"","neighborhood":"","borough":"","price_range":"$20-35","why":"","what_to_order":[],"vibe":""}],"note":""}

If exact dish not widely available, add a note like "Junglee mutton is rare - these Indian spots have great mutton dishes"`;

  try {
    console.log(`Gemini Search: "${intent.dish_or_cuisine}" ${area}`);
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 2500, temperature: 0.3 }
      },
      { params: { key: GEMINI_API_KEY } }
    );
    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log('Search response:', text.substring(0, 400));
    
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const results = validateResults(parsed.results || []);
      console.log(`Found ${results.length} restaurants`);
      return { results, note: parsed.note };
    }
    return { results: [], error: 'No JSON in response' };
  } catch (err) {
    console.error('Restaurant search failed:', err.message);
    return { results: [], error: err.message };
  }
}

// =====================
// VALIDATE RESULTS
// =====================
function validateResults(results) {
  if (!Array.isArray(results)) return [];
  const bad = ['museum', 'tour', 'attraction', 'grocery'];
  
  return results.filter(r => {
    if (!r.name || r.name.length < 2) return false;
    if (!r.neighborhood && !r.borough) return false;
    if (bad.some(w => r.name.toLowerCase().includes(w))) return false;
    return true;
  }).map(r => ({
    ...r,
    dedupeKey: createDedupeKey(r.name, r.neighborhood || r.borough),
    why: r.why || '',
    vibe: r.vibe || 'Casual',
    price_range: r.price_range || r.price_hint || ''
  }));
}


// =====================
// GEMINI FORMATTER
// =====================
async function geminiFormatResponse(intent, results) {
  if (!GEMINI_API_KEY || !results.length) return formatResultsFallback(intent, results);
  
  const prompt = `Format these NYC restaurants for Instagram DM. User asked for: "${intent.dish_or_cuisine || intent.query}"

Results: ${JSON.stringify(results.slice(0, 5))}

Format each as:
1. NAME
📍 Location
💰 Price range (use the actual dollar amount like "$15-25")
🍽️ Order: dishes
💡 Why good

End with: Reply "more" for different options.
Keep it short. No markdown headers.`;

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1200, temperature: 0.3 } },
      { params: { key: GEMINI_API_KEY } }
    );
    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text.length > 50) return text.trim();
  } catch (err) { console.error('Gemini format failed:', err.message); }
  
  return formatResultsFallback(intent, results);
}

function formatResultsFallback(intent, results) {
  if (!results.length) return `Couldn't find spots for "${intent.dish_or_cuisine || intent.query}". Try a different area?`;
  
  let r = `Here are some spots:\n\n`;
  results.slice(0, 5).forEach((x, i) => {
    r += `${i + 1}. ${x.name.toUpperCase()}\n`;
    r += `📍 ${x.neighborhood || ''}, ${x.borough || ''}\n`;
    if (x.price_range) r += `💰 ${x.price_range}`;
    if (x.vibe) r += ` · ${x.vibe}`;
    r += '\n';
    if (x.what_to_order?.length) r += `🍽️ ${x.what_to_order.slice(0, 2).join(', ')}\n`;
    if (x.why) r += `💡 ${x.why}\n`;
    r += '\n';
  });
  r += 'Reply "more" for different options.';
  return r;
}

// =====================
// DB SEARCH
// =====================
async function searchRestaurantsDB(filters, limit = 20) {
  const collection = await connectToRestaurants();
  if (!collection) {
    console.error('No database connection for searchRestaurantsDB');
    return [];
  }

  const query = {};
  
  if (filters.cuisine) {
    // Search in cuisineDescription (case insensitive)
    query.cuisineDescription = { $regex: new RegExp(filters.cuisine, 'i') };
  }
  
  if (filters.borough && filters.borough !== 'Any' && filters.borough !== 'Anywhere') {
    // Search for borough name in fullAddress
    query.fullAddress = { $regex: new RegExp(filters.borough, 'i') };
  }
  
  if (filters.budget) {
    // budget is $, $$, $$$, or $$$$
    const priceMap = { '$': 1, '$$': 2, '$$$': 3, '$$$$': 4 };
    const level = priceMap[filters.budget];
    if (level) query.priceLevel = level;
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
      userRatingsTotal: r.userRatingsTotal,
      priceLevel: r.priceLevel,
      cuisineDescription: r.cuisineDescription,
      reviewSummary: r.reviewSummary,
      phoneNumber: r.phoneNumber,
      website: r.website,
      googleMapsUri: r.googleMapsUri,
      openingHours: r.openingHours,
      dedupeKey: createDedupeKey(r.name, r.fullAddress)
    }));
  } catch (err) {
    console.error('DB search failed:', err.message);
    return [];
  }
}

// =====================
// WEB RESEARCH (FOR ENRICHMENT)
// =====================
async function getWebResearch(queries) {
  if (!GEMINI_API_KEY || !queries?.length) return [];
  
  const researchPrompt = `Research these NYC restaurant queries and provide specific details (best dishes, vibe, reservation tips).
Queries: ${queries.join(', ')}

Return a list of specific snippets with sources.`;

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: researchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );
    
    // We want to return the raw text of snippets or structured data if possible
    // For now, let's just return the text which the system prompt will use
    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    console.error('Web research enrichment failed:', err.message);
    return '';
  }
}

// =====================
// MAIN SEARCH FUNCTION
// =====================
async function searchRestaurants(userId, query, providedFilters = null, foodProfile = null, context = null, skipConstraintGate = false) {
  // Spotlight check first
  const spotlight = detectSpotlightQuery(query);
  if (spotlight.isSpotlight) {
    console.log(`Spotlight: "${spotlight.restaurantName}"`);
    const result = await spotlightRestaurant(spotlight.restaurantName, context);
    return { query, intent: { query, spotlight: true, restaurantName: spotlight.restaurantName }, results: [], count: 0, formattedResponse: result.text, needsConstraints: false, isSpotlight: true };
  }
  
  let intent = extractIntent(query);
  console.log(`[RESTAURANTS] Extracted intent for "${query}":`, JSON.stringify(intent, null, 2));
  
  // Apply filters
  if (providedFilters) {
    if (providedFilters.borough) intent.borough = providedFilters.borough;
    if (providedFilters.budget) intent.budget = providedFilters.budget;
    if (providedFilters.dishQuery) intent.dish_or_cuisine = providedFilters.dishQuery;
    if (providedFilters.resolvedDish) { intent.dish_or_cuisine = providedFilters.resolvedDish.dish; intent.is_dish = true; }
  }
  
  // Profile defaults
  if (foodProfile) {
    if (!intent.borough && foodProfile.borough) intent.borough = foodProfile.borough;
    if (!intent.budget && foodProfile.budget) intent.budget = foodProfile.budget;
  }
  
  // Follow-up handling ("more", "other", etc.)
  const lower = query.toLowerCase().trim();
  const isFollowUp = ['more', 'other', 'different', 'another', 'next'].some(p => lower === p || lower === `show ${p}` || lower === `${p} options`);
  
  if (isFollowUp) {
    console.log('Follow-up detected, checking pool...');
    
    if (context?.pool?.length > 0) {
      const page = (context.page || 0) + 1;
      const startIdx = page * 5;
      const batch = context.pool.slice(startIdx, startIdx + 5);
      
      if (batch.length > 0) {
        console.log(`Serving page ${page} from pool (${batch.length} items)`);
        const formatted = await geminiFormatResponse(context.lastIntent || intent, batch);
        return { query, intent: context.lastIntent || intent, results: batch, count: batch.length, formattedResponse: formatted, needsConstraints: false, pool: context.pool, page };
      }
    }
    
    // No more results in pool - tell user
    if (context?.lastIntent) {
      const dish = context.lastIntent.dish_or_cuisine || context.lastIntent.query;
      return { 
        query, 
        intent: context.lastIntent, 
        results: [], 
        count: 0, 
        formattedResponse: `That's all I found for "${dish}". Want to try a different dish or area?`,
        needsConstraints: false 
      };
    }
  }
  
  // Dish clarification gate
  if (!skipConstraintGate && intent.is_dish && intent.dish_or_cuisine && !providedFilters?.resolvedDish) {
    const clarification = getAmbiguousDishClarification(intent.dish_or_cuisine);
    if (clarification.needsClarification) {
      return {
        query, intent, results: [], count: 0, needsConstraints: true,
        pendingFilters: { dishQuery: intent.dish_or_cuisine, dishClarification: clarification.dishMappings, borough: intent.borough },
        geminiResponse: { type: 'question', message: clarification.question, followUpQuestion: { text: clarification.question, replies: clarification.options } }
      };
    }
  }
  
  // Area gate
  if (!skipConstraintGate && !intent.borough && intent.dish_or_cuisine) {
    return {
      query, intent, results: [], count: 0, needsConstraints: true,
      pendingFilters: { dishQuery: intent.dish_or_cuisine, resolvedDish: providedFilters?.resolvedDish },
      geminiResponse: {
        type: 'question', message: 'Nice choice! Where in NYC?',
        followUpQuestion: {
          text: 'Nice choice! Where in NYC?',
          replies: [
            { title: 'Manhattan', payload: 'BOROUGH_MANHATTAN' },
            { title: 'Brooklyn', payload: 'BOROUGH_BROOKLYN' },
            { title: 'Queens', payload: 'BOROUGH_QUEENS' },
            { title: 'Anywhere', payload: 'BOROUGH_ANY' }
          ]
        }
      }
    };
  }

  // Search
  const shownNames = context?.shownNames || [];
  const { results, error, note } = await searchRestaurantsWeb(intent, shownNames);
  
  if (!results.length) {
    return { query, intent, results: [], count: 0, needsConstraints: false, message: error || `Couldn't find spots for "${intent.dish_or_cuisine}". Try a different area?` };
  }
  
  const top5 = results.slice(0, 5);
  let formatted = await geminiFormatResponse(intent, top5);
  if (note) formatted = `(Note: ${note})\n\n${formatted}`;
  
  return { query, intent, results: top5, count: top5.length, formattedResponse: formatted, needsConstraints: false, pool: results, page: 0 };
}

// =====================
// FORMAT RESULTS
// =====================
function formatRestaurantResults(searchResult) {
  if (searchResult.needsConstraints && searchResult.geminiResponse?.type === 'question') {
    return { text: searchResult.geminiResponse.message, replies: searchResult.geminiResponse.followUpQuestion?.replies || [], isQuestion: true, pendingFilters: searchResult.pendingFilters };
  }
  if (!searchResult.count || !searchResult.formattedResponse) {
    return { text: searchResult.message || "What are you craving?", isQuestion: false };
  }
  return { text: searchResult.formattedResponse, replies: [], isQuestion: false };
}

// =====================
// EXPORTS
// =====================
module.exports = {
  searchRestaurants, formatRestaurantResults, extractIntent,
  detectSpotlightQuery, spotlightRestaurant, createDedupeKey, normalizeForDedupe,
  searchRestaurantsDB, getWebResearch
};
