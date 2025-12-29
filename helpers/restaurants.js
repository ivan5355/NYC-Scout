const { MongoClient } = require('mongodb');
const axios = require('axios');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const geminiClient = axios.create({
  timeout: 60000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

let mongoClient = null;
let restaurantsCollection = null;

async function connectToMongoDB() {
  if (mongoClient && restaurantsCollection) return restaurantsCollection;
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    restaurantsCollection = db.collection('restaurants');
    console.log('Connected to MongoDB restaurants collection');
    return restaurantsCollection;
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
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

function createDedupeKey(name, address) {
  return `${normalizeForDedupe(name)}|${normalizeForDedupe(address)}`;
}

// =====================
// FILTER DETECTION
// =====================
const CUISINE_PATTERNS = [
  { key: "Indian", patterns: ["indian", "curry", "tikka", "biryani", "masala", "tandoori", "naan", "samosa", "dosa"] },
  { key: "Mexican", patterns: ["mexican", "tacos", "taqueria", "birria", "burrito", "quesadilla"] },
  { key: "Italian", patterns: ["italian", "pizza", "pasta", "risotto", "lasagna", "trattoria"] },
  { key: "Chinese", patterns: ["chinese", "dim sum", "dumpling", "wonton", "szechuan"] },
  { key: "Japanese", patterns: ["japanese", "sushi", "ramen", "udon", "sashimi", "omakase"] },
  { key: "Korean", patterns: ["korean", "kbbq", "bibimbap", "kimchi", "bulgogi"] },
  { key: "Thai", patterns: ["thai", "pad thai", "tom yum", "satay"] },
  { key: "Vietnamese", patterns: ["vietnamese", "pho", "banh mi"] },
  { key: "French", patterns: ["french", "bistro", "brasserie", "crepe"] },
  { key: "American", patterns: ["american", "burger", "steakhouse", "diner", "bbq"] },
  { key: "Middle Eastern", patterns: ["middle eastern", "shawarma", "hummus", "kebab", "falafel", "halal"] }
];

function detectCuisine(text) {
  const t = text.toLowerCase();
  for (const c of CUISINE_PATTERNS) {
    if (c.patterns.some(p => t.includes(p))) return c.key;
  }
  return null;
}

function detectBorough(text) {
  const t = text.toLowerCase();
  const boroughs = {
    'manhattan': 'Manhattan', 'manhatten': 'Manhattan', 'midtown': 'Manhattan', 
    'downtown': 'Manhattan', 'uptown': 'Manhattan', 'harlem': 'Manhattan', 
    'soho': 'Manhattan', 'tribeca': 'Manhattan', 'east village': 'Manhattan', 
    'west village': 'Manhattan', 'chelsea': 'Manhattan', 'brooklyn': 'Brooklyn', 
    'williamsburg': 'Brooklyn', 'queens': 'Queens', 'flushing': 'Queens', 
    'astoria': 'Queens', 'bronx': 'Bronx', 'staten island': 'Staten Island'
  };
  for (const [key, val] of Object.entries(boroughs)) {
    if (t.includes(key)) return val;
  }
  return null;
}

function detectBudget(text) {
  const t = text.toLowerCase();
  if (t.includes('cheap') || t.includes('budget') || t.includes('affordable')) return '$';
  if (t.includes('expensive') || t.includes('fancy') || t.includes('upscale')) return '$$$';
  return null;
}

function detectOccasion(text) {
  const t = text.toLowerCase();
  if (t.includes('birthday') || t.includes('anniversary')) return 'celebration';
  if (t.includes('date') || t.includes('romantic') || t.includes('girlfriend')) return 'date';
  return null;
}


// =====================
// SPOTLIGHT DETECTION (specific restaurant queries)
// =====================
function detectSpecificRestaurant(text) {
  const t = text.toLowerCase().trim();
  
  // Skip if it's clearly a general cuisine search (not asking about specific place)
  const cuisineOnly = /^(find|best|top|good)?\s*(indian|thai|chinese|mexican|italian|japanese|korean)\s*(food|restaurant|resto|spots?)?$/i;
  if (cuisineOnly.test(t)) {
    return null;
  }
  
  // Patterns for specific restaurant questions - order matters!
  const patterns = [
    // "why not soothr" -> extract "soothr"
    /why not (?:this )?(?:\w+ )?(?:resto |restaurant )?(.+?)$/i,
    // "what about soothr" -> extract "soothr"  
    /what about (.+?)(?:\?|$)/i,
    // "how about soothr"
    /how about (.+?)(?:\?|$)/i,
    // "is soothr good"
    /is (.+?) good/i,
    // "tell me about soothr"
    /tell me about (.+?)(?:\?|$)/i,
    // "have you heard of soothr"
    /have you heard of (.+?)(?:\?|$)/i,
    // "how is soothr"
    /how is (.+?)(?:\?|$)/i
  ];
  
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match && match[1]) {
      let name = match[1].trim();
      // Clean up
      name = name.replace(/^(the|a|an)\s+/i, '').trim();
      name = name.replace(/\?+$/, '').trim();
      
      // Filter out generic/short words
      if (name.length > 2 && !['good', 'bad', 'nice', 'great', 'it', 'this', 'that'].includes(name.toLowerCase())) {
        console.log(`Detected spotlight query for: "${name}"`);
        return name;
      }
    }
  }
  
  return null;
}

// =====================
// DB QUERIES
// =====================
async function fetchDBCandidates(filters, shownDedupeKeys = []) {
  const collection = await connectToMongoDB();
  if (!collection) return [];

  const mongoQuery = {};

  if (filters.cuisine) {
    mongoQuery.$or = [
      { cuisineDescription: { $regex: filters.cuisine, $options: 'i' } },
      { googleTypes: { $regex: filters.cuisine.toLowerCase().replace(' ', '_'), $options: 'i' } },
      { Name: { $regex: filters.cuisine, $options: 'i' } }
    ];
  }

  if (filters.borough && filters.borough !== 'Anywhere') {
    mongoQuery.fullAddress = { $regex: filters.borough, $options: 'i' };
  }

  console.log('DB query:', JSON.stringify(mongoQuery));

  try {
    let results = await collection
      .find(mongoQuery)
      .sort({ userRatingsTotal: -1, rating: -1 })
      .limit(100)
      .toArray();

    // Add dedupeKey and score
    results = results.map(r => ({
      ...r,
      dedupeKey: createDedupeKey(r.Name, r.fullAddress),
      nameNorm: normalizeForDedupe(r.Name), // Use same normalization
      qualityScore: calculateQualityScore(r, filters)
    }));

    // Filter shown
    if (shownDedupeKeys.length > 0) {
      const shownSet = new Set(shownDedupeKeys);
      results = results.filter(r => !shownSet.has(r.dedupeKey));
    }

    // DEDUPE BY NORMALIZED NAME (prevents chains like OBAO showing twice)
    const seenNames = new Set();
    results = results.filter(r => {
      const normName = r.nameNorm;
      if (seenNames.has(normName)) {
        console.log(`Deduped: ${r.Name} (already have ${normName})`);
        return false;
      }
      seenNames.add(normName);
      return true;
    });

    // Sort by quality and take top
    results.sort((a, b) => b.qualityScore - a.qualityScore);
    
    console.log(`DB found ${results.length} unique candidates`);
    return results.slice(0, 30);
  } catch (err) {
    console.error('DB fetch failed:', err.message);
    return [];
  }
}

function calculateQualityScore(r, filters) {
  let score = 0;
  score += (r.rating || 0) * 2;
  score += Math.log1p(r.userRatingsTotal || 0) * 1.2;
  
  // Penalize suspicious high ratings with low reviews
  if (r.rating >= 4.8 && (r.userRatingsTotal || 0) < 50) {
    score -= 3;
  }
  
  // OCCASION BONUSES
  if (filters.occasion === 'celebration' || filters.occasion === 'date') {
    // Boost nicer restaurants for special occasions
    if (r.priceLevel === 'Expensive' || r.priceLevel === 'Very Expensive') {
      score += 5;
    } else if (r.priceLevel === 'Moderate') {
      score += 2;
    }
    
    // Penalize fast food / casual chains for special occasions
    const casualPatterns = ['pizza', 'bbq', 'deli', 'fast', 'famous', 'grill'];
    const nameLower = (r.Name || '').toLowerCase();
    const cuisineLower = (r.cuisineDescription || '').toLowerCase();
    if (casualPatterns.some(p => nameLower.includes(p) || cuisineLower.includes(p))) {
      score -= 4;
    }
    
    // Boost fine dining keywords
    const fineDiningPatterns = ['steakhouse', 'omakase', 'tasting', 'fine', 'upscale'];
    if (fineDiningPatterns.some(p => nameLower.includes(p) || cuisineLower.includes(p))) {
      score += 3;
    }
  }
  
  return score;
}

// Lookup specific restaurant by name
async function lookupRestaurantByName(name) {
  const collection = await connectToMongoDB();
  if (!collection) return null;

  const searchName = name.trim();
  console.log(`Looking up restaurant: "${searchName}"`);

  try {
    // Try exact match first (case insensitive)
    let result = await collection.findOne({
      Name: { $regex: `^${escapeRegex(searchName)}$`, $options: 'i' }
    });
    
    if (result) {
      console.log(`Exact match found: ${result.Name}`);
      return result;
    }
    
    // Try starts-with match
    result = await collection.findOne({
      Name: { $regex: `^${escapeRegex(searchName)}`, $options: 'i' }
    });
    
    if (result) {
      console.log(`Starts-with match found: ${result.Name}`);
      return result;
    }
    
    // Try contains match (but require significant overlap)
    if (searchName.length >= 4) {
      result = await collection.findOne({
        Name: { $regex: escapeRegex(searchName), $options: 'i' }
      });
      
      if (result) {
        console.log(`Contains match found: ${result.Name}`);
        return result;
      }
    }
    
    console.log(`No match found for: "${searchName}"`);
    return null;
  } catch (err) {
    console.error('Restaurant lookup failed:', err.message);
    return null;
  }
}

// Escape special regex characters
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// =====================
// MULTI-SOURCE WEB RESEARCH
// Searches: Reddit, YouTube, Web, X/Twitter
// =====================
async function researchRestaurants(candidates, cuisine, borough) {
  if (!GEMINI_API_KEY || candidates.length === 0) {
    return { notesByName: {}, sources: [] };
  }

  const names = candidates.slice(0, 8).map(r => r.Name);
  
  const searchPrompt = `Research these ${cuisine || ''} restaurants in ${borough || 'NYC'}. 

Restaurants:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Search these sources:
- Reddit: site:reddit.com/r/FoodNYC and site:reddit.com/r/AskNYC
- YouTube: "${cuisine} NYC" restaurant reviews
- Food blogs: Eater NY, Infatuation, TimeOut
- Twitter/X: recent mentions

For EACH restaurant, find:
1. What to order (specific dishes)
2. Vibe/atmosphere
3. Reservation tips (hard to get? walk-in?)
4. What Reddit/social media says

Also search: "best ${cuisine} ${borough} NYC reddit 2024"

Format your response as:

**[Restaurant Name]**
- Order: [specific dishes]
- Vibe: [atmosphere]
- Reservations: [tips]
- Reddit says: [sentiment]

SOURCES:
- [list actual URLs you found]`;

  try {
    console.log(`Researching ${names.length} restaurants across web/Reddit/YouTube...`);
    
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 2500, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    // Extract text from all parts
    const parts = response.data.candidates?.[0]?.content?.parts || [];
    const fullText = parts.map(p => p.text || '').join('\n');
    
    // Extract grounding metadata for sources
    const groundingMeta = response.data.candidates?.[0]?.groundingMetadata;
    const groundingSources = groundingMeta?.groundingChunks?.map(c => c.web?.uri).filter(Boolean) || [];
    
    // Parse the research text into structured data
    const notesByName = parseResearchText(fullText, names);
    
    // Also extract URLs from the text itself
    const textUrls = extractUrlsFromText(fullText);
    const allSources = [...new Set([...groundingSources, ...textUrls])];
    
    console.log(`Research complete. Found info for ${Object.keys(notesByName).length} restaurants, ${allSources.length} sources`);
    
    return { notesByName, sources: allSources };
  } catch (err) {
    console.error('Research failed:', err.message);
    return { notesByName: {}, sources: [] };
  }
}

// Parse research text into structured notes per restaurant
function parseResearchText(text, names) {
  const notesByName = {};
  
  for (const name of names) {
    const nameNorm = normalizeForDedupe(name);
    const notes = {
      whatToOrder: null,
      vibe: null,
      reservations: null,
      redditSays: null
    };
    
    // Find section for this restaurant
    const patterns = [
      new RegExp(`\\*\\*${name}\\*\\*([\\s\\S]*?)(?=\\*\\*[A-Z]|SOURCES:|$)`, 'i'),
      new RegExp(`${name}[:\\n]([\\s\\S]*?)(?=\\n\\n[A-Z]|SOURCES:|$)`, 'i')
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const section = match[1];
        
        // Extract fields
        const orderMatch = section.match(/Order:?\s*(.+?)(?:\n|$)/i);
        if (orderMatch) notes.whatToOrder = orderMatch[1].trim();
        
        const vibeMatch = section.match(/Vibe:?\s*(.+?)(?:\n|$)/i);
        if (vibeMatch) notes.vibe = vibeMatch[1].trim();
        
        const resMatch = section.match(/Reservations?:?\s*(.+?)(?:\n|$)/i);
        if (resMatch) notes.reservations = resMatch[1].trim();
        
        const redditMatch = section.match(/Reddit(?:\s+says)?:?\s*(.+?)(?:\n|$)/i);
        if (redditMatch) notes.redditSays = redditMatch[1].trim();
        
        break;
      }
    }
    
    // Only add if we found something
    if (notes.whatToOrder || notes.redditSays) {
      notesByName[nameNorm] = notes;
    }
  }
  
  return notesByName;
}

// Extract URLs from text
function extractUrlsFromText(text) {
  const urlPattern = /https?:\/\/[^\s\)\"\'<>]+/g;
  const matches = text.match(urlPattern) || [];
  return matches.map(url => url.replace(/[.,;:]+$/, '')); // Clean trailing punctuation
}

// Research a specific restaurant (spotlight mode)
async function researchSpecificRestaurant(name, borough) {
  if (!GEMINI_API_KEY) return { text: null, sources: [] };

  const searchPrompt = `Research "${name}" restaurant in ${borough || 'NYC'} thoroughly.

Search:
- site:reddit.com/r/FoodNYC "${name}"
- site:reddit.com/r/AskNYC "${name}"
- "${name}" NYC review
- "${name}" NYC what to order
- YouTube "${name}" NYC restaurant

Tell me:
1. What dishes to order (be specific)
2. The vibe/atmosphere
3. Reservation situation
4. What Reddit users say
5. Any tips or warnings
6. Price range

Include source URLs.`;

  try {
    console.log(`Spotlight research for: ${name}`);
    
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    const parts = response.data.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('\n').trim();
    
    const groundingMeta = response.data.candidates?.[0]?.groundingMetadata;
    const sources = groundingMeta?.groundingChunks?.map(c => c.web?.uri).filter(Boolean) || [];
    const textUrls = extractUrlsFromText(text);
    
    return { 
      text, 
      sources: [...new Set([...sources, ...textUrls])]
    };
  } catch (err) {
    console.error('Spotlight research failed:', err.message);
    return { text: null, sources: [] };
  }
}


// =====================
// MAIN SEARCH FUNCTION
// =====================
async function searchRestaurants(userId, query, providedFilters = null, foodProfile = null, context = null, skipConstraintGate = false) {
  const lowerQuery = query.toLowerCase();
  
  // CHECK FOR SPOTLIGHT MODE first
  const specificRestaurant = detectSpecificRestaurant(query);
  if (specificRestaurant) {
    return await handleSpotlightMode(specificRestaurant, context);
  }
  
  // Check for follow-up
  const followUpPatterns = ['more', 'other', 'different', 'another', 'next'];
  const isFollowUp = followUpPatterns.some(p => lowerQuery.includes(p)) && lowerQuery.split(' ').length <= 5;

  // Build filters
  let filters = {};
  const hasProvidedFilters = providedFilters && Object.keys(providedFilters).length > 0;
  
  if (hasProvidedFilters) {
    filters = { ...providedFilters };
    skipConstraintGate = true;
  } else if (isFollowUp && context?.lastFilters) {
    filters = { ...context.lastFilters };
    skipConstraintGate = true;
  } else {
    filters.cuisine = detectCuisine(query);
    filters.borough = detectBorough(query);
    filters.budget = detectBudget(query);
    filters.occasion = detectOccasion(query);
  }

  // Apply profile defaults
  if (foodProfile) {
    if (!filters.borough && foodProfile.borough) filters.borough = foodProfile.borough;
    if (!filters.budget && foodProfile.budget) filters.budget = foodProfile.budget;
  }

  // CONSTRAINT GATE: Ask ONE question if needed
  if (!skipConstraintGate && filters.cuisine && !filters.borough) {
    return {
      query, filters, results: [], count: 0,
      needsConstraints: true,
      pendingFilters: filters,
      geminiResponse: {
        type: 'question',
        message: 'Quick one — what area?',
        followUpQuestion: {
          text: 'Quick one — what area?',
          replies: [
            { title: 'Manhattan 🏙', payload: 'BOROUGH_MANHATTAN' },
            { title: 'Brooklyn 🌉', payload: 'BOROUGH_BROOKLYN' },
            { title: 'Queens 🚇', payload: 'BOROUGH_QUEENS' },
            { title: 'Anywhere 🌍', payload: 'BOROUGH_ANY' }
          ]
        }
      }
    };
  }

  const shownDedupeKeys = context?.shownDedupeKeys || [];

  // STEP 1: Fetch from DB
  let candidates = await fetchDBCandidates(filters, shownDedupeKeys);

  if (candidates.length === 0) {
    return {
      query, filters, results: [], count: 0,
      needsConstraints: false,
      message: filters.cuisine 
        ? `No ${filters.cuisine} spots found${filters.borough ? ' in ' + filters.borough : ''}. Try a different area?`
        : "What cuisine are you craving?"
    };
  }

  // STEP 2: Research top candidates
  const { notesByName, sources } = await researchRestaurants(
    candidates.slice(0, 10), 
    filters.cuisine, 
    filters.borough
  );

  // Merge research into candidates
  candidates = candidates.map(c => {
    const notes = notesByName[normalizeForDedupe(c.Name)];
    return notes ? { ...c, research: notes } : c;
  });

  const finalResults = candidates.slice(0, 5);

  return {
    query, filters,
    results: finalResults,
    count: finalResults.length,
    sources,
    needsConstraints: false,
    researchWorked: Object.keys(notesByName).length > 0
  };
}

// SPOTLIGHT MODE
async function handleSpotlightMode(restaurantName, context) {
  console.log(`Spotlight mode for: ${restaurantName}`);
  
  const dbResult = await lookupRestaurantByName(restaurantName);
  const borough = context?.lastFilters?.borough || 'NYC';
  const { text: researchText, sources } = await researchSpecificRestaurant(restaurantName, borough);
  
  if (dbResult) {
    return {
      query: restaurantName, filters: {},
      results: [{
        ...dbResult,
        dedupeKey: createDedupeKey(dbResult.Name, dbResult.fullAddress),
        spotlightResearch: researchText
      }],
      count: 1,
      sources,
      isSpotlight: true,
      needsConstraints: false
    };
  } else {
    return {
      query: restaurantName, filters: {},
      results: [], count: 0,
      isSpotlight: true,
      notInDB: true,
      spotlightName: restaurantName,
      spotlightResearch: researchText,
      sources,
      needsConstraints: false
    };
  }
}


// =====================
// FORMAT RESULTS
// =====================
function formatRestaurantResults(searchResult) {
  // Question mode
  if (searchResult.needsConstraints && searchResult.geminiResponse?.type === 'question') {
    return {
      text: searchResult.geminiResponse.message,
      replies: searchResult.geminiResponse.followUpQuestion?.replies || [],
      isQuestion: true,
      pendingFilters: searchResult.pendingFilters
    };
  }

  // Spotlight mode
  if (searchResult.isSpotlight) {
    return formatSpotlightResult(searchResult);
  }

  // No results
  if (searchResult.count === 0) {
    return { text: searchResult.message || "What cuisine are you craving?", isQuestion: false };
  }

  // Format regular results
  const { cuisine, borough } = searchResult.filters || {};
  let response = cuisine 
    ? `Here are the top ${cuisine} spots${borough ? ' in ' + borough : ''}:\n\n`
    : `Here are some top picks:\n\n`;

  searchResult.results.forEach((r, i) => {
    response += `${i + 1}. ${r.Name}\n`;
    response += `📍 ${formatAddress(r.fullAddress)}\n`;
    
    if (r.rating) {
      const reviews = r.userRatingsTotal ? `(${r.userRatingsTotal.toLocaleString()} reviews)` : '';
      response += `⭐ ${r.rating} ${reviews}`;
      if (r.priceLevel) response += ` · 💲${formatPrice(r.priceLevel)}`;
      response += '\n';
    }
    
    // Research data
    if (r.research?.whatToOrder) {
      response += `🍽️ Order: ${r.research.whatToOrder}\n`;
    }
    if (r.research?.redditSays) {
      response += `💬 Reddit: ${r.research.redditSays}\n`;
    }
    if (r.research?.reservations) {
      response += `📞 ${r.research.reservations}\n`;
    }
    
    // Fallback to DB summary if no research
    if (!r.research && r.reviewSummary) {
      const summary = r.reviewSummary.length > 80 ? r.reviewSummary.substring(0, 80) + '...' : r.reviewSummary;
      response += `💡 ${summary}\n`;
    }
    
    response += '\n';
  });

  response += 'Reply "more" for different options.';

  // Add sources if we have them
  if (searchResult.sources?.length > 0) {
    const validSources = searchResult.sources.filter(s => s && typeof s === 'string').slice(0, 4);
    if (validSources.length > 0) {
      response += '\n\n📚 Sources:\n';
      validSources.forEach(s => {
        response += `• ${formatSourceUrl(s)}\n`;
      });
    }
  } else if (!searchResult.researchWorked) {
    // Research failed - be honest
    response += '\n\n(Web research unavailable - showing DB ratings)';
  }

  return { text: response.trim(), replies: [], isQuestion: false };
}

function formatSpotlightResult(searchResult) {
  const name = searchResult.spotlightName || searchResult.query;
  
  if (searchResult.notInDB) {
    let response = `"${name}" isn't in our database yet.\n\n`;
    if (searchResult.spotlightResearch) {
      response += `Here's what I found online:\n\n${searchResult.spotlightResearch}`;
    } else {
      response += "Couldn't find much info online either. Try searching directly!";
    }
    
    if (searchResult.sources?.length > 0) {
      response += '\n\n📚 Sources:\n';
      searchResult.sources.slice(0, 3).forEach(s => {
        response += `• ${formatSourceUrl(s)}\n`;
      });
    }
    
    return { text: response.trim(), isQuestion: false };
  }
  
  // In DB
  const r = searchResult.results[0];
  let response = `Here's what I know about ${r.Name}:\n\n`;
  response += `📍 ${r.fullAddress || 'NYC'}\n`;
  
  if (r.rating) {
    response += `⭐ ${r.rating} (${r.userRatingsTotal?.toLocaleString() || '?'} reviews)\n`;
  }
  if (r.priceLevel) response += `💲 ${r.priceLevel}\n`;
  if (r.cuisineDescription) response += `🍽️ ${r.cuisineDescription}\n`;
  if (r.phoneNumber) response += `📞 ${r.phoneNumber}\n`;
  
  if (r.spotlightResearch) {
    response += `\n📰 What people say:\n${r.spotlightResearch}`;
  }
  
  if (searchResult.sources?.length > 0) {
    response += '\n\n📚 Sources:\n';
    searchResult.sources.slice(0, 3).forEach(s => {
      response += `• ${formatSourceUrl(s)}\n`;
    });
  }
  
  return { text: response.trim(), isQuestion: false };
}

// Helpers
function formatAddress(address) {
  if (!address) return 'NYC';
  const parts = address.split(',');
  return parts.length >= 2 ? parts.slice(0, 2).join(',').trim() : address;
}

function formatPrice(priceLevel) {
  const map = { 'Inexpensive': '$', 'Moderate': '$$', 'Expensive': '$$$' };
  return map[priceLevel] || priceLevel || '';
}

function formatSourceUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    const path = u.pathname.length > 30 ? u.pathname.substring(0, 30) + '...' : u.pathname;
    return `${host}${path !== '/' ? path : ''}`;
  } catch {
    return url.length > 50 ? url.substring(0, 50) + '...' : url;
  }
}

// =====================
// EXPORTS
// =====================
module.exports = {
  searchRestaurants,
  formatRestaurantResults,
  detectCuisine,
  detectBorough,
  detectBudget,
  detectOccasion,
  detectSpecificRestaurant,
  createDedupeKey,
  normalizeForDedupe
};

process.on('SIGINT', async () => {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
