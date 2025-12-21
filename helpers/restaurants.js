const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

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
    console.log('✅ Loaded restaurant filters from restaurant_filters.json');
  }
} catch (err) {
  console.warn('⚠️  Could not load restaurant_filters.json, using hardcoded filters:', err.message);
}


// Validate required environment variables
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI or MONGO_URI environment variable is required');
  process.exit(1);
}

// MongoDB connection (cached)
let mongoClient = null;
let restaurantsCollection = null;

async function connectToMongoDB() {
  if (mongoClient && restaurantsCollection) return restaurantsCollection;

  if (!MONGODB_URI) {
    console.error('MongoDB URI not found in environment variables');
    return null;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    restaurantsCollection = db.collection('restaurants');
    console.log('✅ Connected to MongoDB restaurants collection');
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
function extractRestaurantFilters(query) {
  const queryLower = query.toLowerCase();
  const filters = {};

  // Use cuisines from JSON if available
  const cuisines = CUISINE_TYPES?.cuisines || {};

  for (const [cuisine, keywords] of Object.entries(cuisines)) {
    if (keywords.some(k => queryLower.includes(k))) {
      filters.cuisine = cuisine;
      break;
    }
  }

  // Use boroughs from JSON if available, otherwise fallback to hardcoded
  const boroughs = CUISINE_TYPES?.boroughs || {
    Manhattan: ['manhattan', 'midtown', 'downtown', 'uptown', 'harlem', 'soho', 'tribeca'],
    Brooklyn: ['brooklyn', 'williamsburg', 'bushwick', 'dumbo'],
    Queens: ['queens', 'flushing', 'astoria', 'jackson heights'],
    Bronx: ['bronx'],
    'Staten Island': ['staten island']
  };

  for (const [borough, keywords] of Object.entries(boroughs)) {
    if (keywords.some(k => queryLower.includes(k))) {
      filters.borough = borough;
      break;
    }
  }

  // Price level detection (Standard mapping)
  if (queryLower.includes('cheap') || queryLower.includes('budget') || queryLower.includes('affordable')) {
    filters.priceLevel = 'Inexpensive';
  } else if (queryLower.includes('expensive') || queryLower.includes('fancy') || queryLower.includes('upscale')) {
    filters.priceLevel = 'Expensive';
  } else if (queryLower.includes('moderate') || queryLower.includes('reasonable')) {
    filters.priceLevel = 'Moderate';
  }

  // Rating detection
  if (queryLower.includes('best') || queryLower.includes('top') || queryLower.includes('highly rated')) {
    filters.minRating = 4;
  }

  return filters;
}

// Extract restaurant filters using Gemini AI
async function extractRestaurantFiltersWithGemini(query) {
  if (!GEMINI_API_KEY) return extractRestaurantFilters(query);

  const availableCuisines = Object.keys(CUISINE_TYPES?.cuisines || {}).slice(0, 100).join(', ');
  const availableBoroughs = Object.keys(CUISINE_TYPES?.boroughs || {}).join(', ');
  const availablePrices = (CUISINE_TYPES?.priceLevels || ['Inexpensive', 'Moderate', 'Expensive', 'Very Expensive']).join(', ');

  const prompt = `Extract restaurant search filters from this query. 
Query: "${query}"

Guidelines:
- cuisine: Choose the most relevant category from this list: [${availableCuisines}]. If none match, leave null.
- borough: Choose from [${availableBoroughs}].
- priceLevel: Choose from [${availablePrices}]. If they say "cheap", pick "Inexpensive". If "fancy", pick "Expensive".
- minRating: A number (1-5) if they ask for "best", "top", "highly rated" (default to 4 if user asks for best).
- searchTerm: Any specific name or food item mentioned that isn't a cuisine (e.g., "Lucali", "shrimp").

Return ONLY a valid JSON object.`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text.startsWith('```')) {
      text = text.split('\n').slice(1).join('\n').replace(/```$/, '').trim();
    }
    const filters = JSON.parse(text);
    console.log('🤖 Gemini extracted restaurant filters:', filters);
    return filters;
  } catch (err) {
    console.error('Gemini restaurant filter extraction failed:', err.message);
    return extractRestaurantFilters(query);
  }
}

// Search restaurants using MongoDB
async function searchRestaurants(query) {
  const collection = await connectToMongoDB();
  if (!collection) {
    return { query, filters: {}, results: [], count: 0 };
  }

  const filters = await extractRestaurantFiltersWithGemini(query);
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

    return { query, filters, results, count: results.length };
  } catch (err) {
    console.error('MongoDB restaurant search failed:', err.message);
    return { query, filters: {}, results: [], count: 0 };
  }
}

// Format restaurant results for Instagram messages
function formatRestaurantResults(searchResult) {
  if (searchResult.count === 0) {
    return "I couldn't find any restaurants matching your search. Try a different cuisine or location!";
  }

  const restaurants = searchResult.results.slice(0, 5);
  let response = `Found ${searchResult.count} restaurant${searchResult.count > 1 ? 's' : ''}! Here are some top picks:\n\n`;

  restaurants.forEach((r, i) => {
    response += `${i + 1}. ${r.Name || 'Unknown'}\n`;
    if (r.cuisineDescription) response += `   🍽️ ${r.cuisineDescription}\n`;
    if (r.rating) response += `   ⭐ ${r.rating}/5\n`;
    if (r.priceLevel) {
      const priceMap = { 'Inexpensive': '$', 'Moderate': '$$', 'Expensive': '$$$', 'Very Expensive': '$$$$', 'Free': 'Free' };
      const priceDisplay = typeof r.priceLevel === 'number' ? '$'.repeat(r.priceLevel) : (priceMap[r.priceLevel] || r.priceLevel);
      response += `   💰 ${priceDisplay}\n`;
    }
    if (r.fullAddress) response += `   📍 ${r.fullAddress}\n`;
    if (r.reviewSummary) {
      const summary = r.reviewSummary.length > 80 ? r.reviewSummary.substring(0, 80) + '...' : r.reviewSummary;
      response += `   💬 "${summary}"\n`;
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
      console.log('✅ MongoDB connection closed');
    } catch (err) {
      console.error('❌ Error closing MongoDB connection:', err.message);
    }
  }
}

module.exports = {
  isRestaurantQuery,
  extractRestaurantFilters,
  searchRestaurants,
  formatRestaurantResults,
  closeMongoDBConnection
};
