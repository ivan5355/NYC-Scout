const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

// Load environment variables from .env.local or .env
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config();
} catch (err) {
  console.warn('⚠️  dotenv failed to load in restaurants.js:', err.message);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
  timeout: 30000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// Load restaurant metadata from JSON (with fallback)
let CUISINE_TYPES = null;
try {
  const filtersPath = path.join(__dirname, '..', 'data', 'restaurant_filters.json');
  if (fs.existsSync(filtersPath)) {
    CUISINE_TYPES = JSON.parse(fs.readFileSync(filtersPath, 'utf8'));
    console.log('Loaded restaurant filters from restaurant_filters.json');
  }
} catch (err) {
  console.warn('Could not load restaurant_filters.json, using hardcoded filters:', err.message);
}


// MongoDB connection (cached, lazy-loaded)
let mongoClient = null;
let restaurantsCollection = null;

async function connectToMongoDB() {
  if (mongoClient && restaurantsCollection) return restaurantsCollection;

  const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI or MONGO_URI not set. Restaurant search will be unavailable.');
    return null;
  }

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

// Detect if user is asking about restaurants
function isRestaurantQuery(query) {
  const queryLower = query.toLowerCase();
  const restaurantKeywords = [
    'restaurant', 'restaurants', 'food', 'eat', 'eating', 'dinner', 'lunch',
    'breakfast', 'brunch', 'cuisine', 'dining', 'dine', 'hungry', 'meal',
    'pizza', 'sushi', 'chinese', 'italian', 'mexican', 'indian', 'thai',
    'japanese', 'korean', 'french', 'american', 'seafood', 'steakhouse',
    'vegetarian', 'vegan', 'halal', 'kosher', 'cafe', 'bistro', 'deli',
    'where to eat', 'good food', 'best food', 'place to eat'
  ];
  return restaurantKeywords.some(k => queryLower.includes(k));
}

// Extract restaurant search filters from query (Heuristic Fallback)
function extractRestaurantFilters(query, history = []) {
  console.log('🔍 Executing extractRestaurantFilters (Heuristic fallback)...');
  
  // Combine query with recent history for better heuristic extraction
  const combinedQuery = [
    ...history.slice(-2).map(m => m.content),
    query
  ].join(' ').toLowerCase();

  const filters = {};

  // Use cuisines from JSON if available
  const cuisines = CUISINE_TYPES?.cuisines || {};

  for (const [cuisine, keywords] of Object.entries(cuisines)) {
    if (keywords.some(k => combinedQuery.includes(k))) {
      filters.cuisine = cuisine;
      break;
    }
  }

  // Use boroughs from JSON if available, otherwise fallback to hardcoded
  const boroughs = CUISINE_TYPES?.boroughs || {
    Manhattan: ['manhattan', 'midtown', 'downtown', 'uptown', 'harlem', 'soho', 'tribeca', 'manhatten'],
    Brooklyn: ['brooklyn', 'williamsburg', 'bushwick', 'dumbo', 'brookyn'],
    Queens: ['queens', 'flushing', 'astoria', 'jackson heights'],
    Bronx: ['bronx'],
    'Staten Island': ['staten island']
  };

  for (const [borough, keywords] of Object.entries(boroughs)) {
    if (keywords.some(k => combinedQuery.includes(k))) {
      filters.borough = borough;
      break;
    }
  }

  // Price level detection (Standard mapping)
  if (combinedQuery.includes('cheap') || combinedQuery.includes('budget') || combinedQuery.includes('affordable')) {
    filters.priceLevel = 'Inexpensive';
  } else if (combinedQuery.includes('expensive') || combinedQuery.includes('fancy') || combinedQuery.includes('upscale')) {
    filters.priceLevel = 'Expensive';
  } else if (combinedQuery.includes('moderate') || combinedQuery.includes('reasonable')) {
    filters.priceLevel = 'Moderate';
  }

  // Rating detection
  if (combinedQuery.includes('best') || combinedQuery.includes('top') || combinedQuery.includes('highly rated')) {
    filters.minRating = 4;
  }

  return filters;
}

// Extract restaurant filters using Gemini AI
async function extractRestaurantFiltersWithGemini(userId, query, history = []) {
  const { checkAndIncrementGemini } = require('./rate_limiter');

  if (!GEMINI_API_KEY || GEMINI_API_KEY.trim() === '') {
    console.log('⚠️ GEMINI_API_KEY missing or empty, falling back to heuristic extraction.');
    return extractRestaurantFilters(query, history);
  }

  if (!await checkAndIncrementGemini(userId)) {
    console.log(`⚠️ User ${userId} exceeded Gemini limit. Falling back to heuristic extraction.`);
    return extractRestaurantFilters(query, history);
  }

  console.log('Executing extractRestaurantFiltersWithGemini...');

  const availableCuisines = Object.keys(CUISINE_TYPES?.cuisines || {}).slice(0, 100).join(', ');
  const availableBoroughs = Object.keys(CUISINE_TYPES?.boroughs || {}).join(', ');
  const availablePrices = (CUISINE_TYPES?.priceLevels || ['Inexpensive', 'Moderate', 'Expensive', 'Very Expensive']).join(', ');

  const historyContext = history.length > 0 
    ? `Recent conversation context:\n${history.map(m => `${m.role}: ${m.content}`).join('\n')}\n\n`
    : '';

  const prompt = `${historyContext}Extract restaurant search filters from this new query. 
Query: "${query}"

Guidelines:
- IMPORTANT: If the new query mentions a SPECIFIC cuisine, borough, or search term, it should OVERRIDE any conflicting information in the recent conversation context.
- Do not let old search preferences linger if the user is asking for something different now.
- If the new query is just a borough (e.g., "Brooklyn"), use the cuisine mentioned in the history.
- cuisine: Choose the most relevant category from this list: [${availableCuisines}]. If none match, leave null.
- borough: Choose from [${availableBoroughs}].
- priceLevel: Choose from [${availablePrices}]. If they say "cheap", pick "Inexpensive". If "fancy", pick "Expensive".
- minRating: A number (1-5) if they ask for "best", "top", "highly rated" (default to 4 if user asks for best).
- searchTerm: Any specific name or food item mentioned that isn't a cuisine (e.g., "Lucali", "shrimp").

Return ONLY a valid JSON object.`;

  try {
    console.log('Calling Gemini API with key:', GEMINI_API_KEY ? `${GEMINI_API_KEY.substring(0, 10)}...` : 'MISSING');
    const response = await geminiClient.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.1 }
      }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text.startsWith('```')) {
      text = text.split('\n').slice(1).join('\n').replace(/```$/, '').trim();
    }
    const filters = JSON.parse(text);
    console.log('Gemini extracted restaurant filters:', filters);
    return filters;
  } catch (err) {
    console.error('Gemini restaurant filter extraction failed:', err.message);
    if (err.response) {
      console.error('   Status:', err.response.status);
      console.error('   Response data:', JSON.stringify(err.response.data));
    }
    return extractRestaurantFilters(query, history);
  }
}

// Search restaurants using MongoDB
async function searchRestaurants(userId, query, preExtractedFilters = null) {
  const collection = await connectToMongoDB();
  if (!collection) {
    const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!MONGODB_URI) {
      return { 
        query, 
        filters: {}, 
        results: [], 
        count: 0, 
        error: 'MongoDB not configured. Please set MONGODB_URI environment variable.' 
      };
    }
    return { query, filters: {}, results: [], count: 0, error: 'Failed to connect to MongoDB.' };
  }

  const filters = preExtractedFilters || await extractRestaurantFiltersWithGemini(userId, query);
  console.log('Applying filters to MongoDB query:', JSON.stringify(filters, null, 2));
  const mongoQuery = {};

  if (filters.cuisine) {
    mongoQuery.cuisineDescription = { $regex: filters.cuisine, $options: 'i' };
  }

  if (filters.borough) {
    mongoQuery.fullAddress = { $regex: filters.borough, $options: 'i' };
  }

  if (filters.priceLevel) {
    mongoQuery.priceLevel = filters.priceLevel;
  }

  if (filters.minRating) {
    mongoQuery.rating = { $gte: filters.minRating };
  }

  if (filters.searchTerm) {
    mongoQuery.$or = [
      { Name: { $regex: filters.searchTerm, $options: 'i' } },
      { cuisineDescription: { $regex: filters.searchTerm, $options: 'i' } },
      { reviewSummary: { $regex: filters.searchTerm, $options: 'i' } }
    ];
  }

  // If no specific filters and no search term, do lightweight regex search based on remaining terms
  if (!filters.cuisine && !filters.borough && !filters.searchTerm) {
    const stop = new Set(['restaurant', 'restaurants', 'food', 'eat', 'good', 'best', 'where', 'to', 'the', 'a', 'in']);
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t && !stop.has(t));

    if (searchTerms.length > 0) {
      const pattern = searchTerms.join('|');
      mongoQuery.$or = [
        { Name: { $regex: pattern, $options: 'i' } },
        { cuisineDescription: { $regex: pattern, $options: 'i' } }
      ];
    }
  }

  try {
    const results = await collection
      .find(mongoQuery)
      .sort({ rating: -1 })
      .limit(10) // Limit to 10 for Instagram
      .toArray();

    console.log(`Search complete. Found ${results.length} restaurants matching query.`);
    return { query, filters, results, count: results.length };
  } catch (err) {
    console.error('MongoDB restaurant search failed:', err.message);
    return { query, filters: {}, results: [], count: 0 };
  }
}

// Format restaurant results for Instagram messages
function formatRestaurantResults(searchResult) {
  if (searchResult.error) {
    return "I'm sorry, restaurant search is currently unavailable. Please try again later or ask about events instead!";
  }
  
  if (searchResult.count === 0) {
    return "I couldn't find any restaurants matching your search. Try a different cuisine or location!";
  }

  const restaurants = searchResult.results.slice(0, 3);
  let response = `Found ${searchResult.count} restaurant${searchResult.count > 1 ? 's' : ''}! Here are some top picks:\n\n`;

  restaurants.forEach((r, i) => {
    const name = r.Name?.length > 50 ? r.Name.substring(0, 47) + '...' : (r.Name || 'Unknown');
    response += `${i + 1}. ${name}\n`;

    if (r.cuisineDescription) response += `   Cuisine: ${r.cuisineDescription}\n`;
    if (r.rating) response += `   Rating: ${r.rating}/5\n`;

    if (r.priceLevel) {
      const priceMap = { 'Inexpensive': '$', 'Moderate': '$$', 'Expensive': '$$$', 'Very Expensive': '$$$$', 'Free': 'Free' };
      const priceDisplay = typeof r.priceLevel === 'number' ? '$'.repeat(r.priceLevel) : (priceMap[r.priceLevel] || r.priceLevel);
      response += `   Price: ${priceDisplay}\n`;
    }

    if (r.fullAddress) {
      const addr = r.fullAddress.length > 60 ? r.fullAddress.substring(0, 57) + '...' : r.fullAddress;
      response += `   Address: ${addr}\n`;
    }

    if (r.reviewSummary) {
      const summary = r.reviewSummary.length > 80 ? r.reviewSummary.substring(0, 77) + '...' : r.reviewSummary;
      response += `   Review: "${summary}"\n`;
    }
    response += '\n';
  });

  return response.trim();
}


// Graceful shutdown handler
process.on('SIGINT', async () => {
  await closeMongoDBConnection();
  process.exit(0);
});

// Handle other termination signals
process.on('SIGTERM', async () => {
  await closeMongoDBConnection();
  process.exit(0);
});

async function closeMongoDBConnection() {
  if (mongoClient) {
    try {
      await mongoClient.close();
      mongoClient = null;
      restaurantsCollection = null;
      console.log(' MongoDB connection closed');
    } catch (err) {
      console.error(' Error closing MongoDB connection:', err.message);
    }
  }
}

module.exports = {
  isRestaurantQuery,
  extractRestaurantFilters,
  extractRestaurantFiltersWithGemini,
  searchRestaurants,
  formatRestaurantResults,
  closeMongoDBConnection,
  getRestaurantMetadata: () => CUISINE_TYPES
};
