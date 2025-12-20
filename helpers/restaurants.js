const { MongoClient, ObjectId } = require('mongodb');

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

// Extract restaurant search filters from query
function extractRestaurantFilters(query) {
  const queryLower = query.toLowerCase();
  const filters = {};

  const cuisines = {
    italian: ['italian', 'pizza', 'pasta'],
    chinese: ['chinese', 'dim sum', 'szechuan'],
    japanese: ['japanese', 'sushi', 'ramen'],
    mexican: ['mexican', 'tacos', 'burrito'],
    indian: ['indian', 'curry', 'tandoori'],
    thai: ['thai', 'pad thai'],
    korean: ['korean', 'bbq', 'bibimbap'],
    french: ['french', 'bistro'],
    american: ['american', 'burger', 'steakhouse'],
    seafood: ['seafood', 'fish', 'lobster'],
    vegetarian: ['vegetarian', 'vegan', 'plant-based'],
    mediterranean: ['mediterranean', 'greek', 'falafel'],
    caribbean: ['caribbean', 'jamaican', 'jerk'],
    'soul food': ['soul food', 'southern'],
    deli: ['deli', 'sandwich', 'bagel'],
    cafe: ['cafe', 'coffee', 'bakery']
  };

  for (const [cuisine, keywords] of Object.entries(cuisines)) {
    if (keywords.some(k => queryLower.includes(k))) {
      filters.cuisine = cuisine;
      break;
    }
  }

  const boroughs = {
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

  // Price level detection
  if (queryLower.includes('cheap') || queryLower.includes('budget') || queryLower.includes('affordable')) {
    filters.priceLevel = { $lte: 2 };
  } else if (queryLower.includes('expensive') || queryLower.includes('fancy') || queryLower.includes('upscale')) {
    filters.priceLevel = { $gte: 3 };
  }

  // Rating detection
  if (queryLower.includes('best') || queryLower.includes('top') || queryLower.includes('highly rated')) {
    filters.minRating = 4;
  }

  return filters;
}

// Search restaurants using MongoDB
async function searchRestaurants(query) {
  const collection = await connectToMongoDB();
  if (!collection) {
    return { query, filters: {}, results: [], count: 0 };
  }

  const filters = extractRestaurantFilters(query);
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

  // If no specific filters, do lightweight regex search based on remaining terms
  if (!filters.cuisine && !filters.borough) {
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
      .limit(100)
      .toArray();

    return { query, filters, results, count: results.length };
  } catch (err) {
    console.error('MongoDB restaurant search failed:', err.message);
    return { query, filters: {}, results: [], count: 0 };
  }
}

// Get restaurant by ID
async function getRestaurantById(id) {
  const collection = await connectToMongoDB();
  if (!collection) return null;

  try {
    return await collection.findOne({ _id: new ObjectId(id) });
  } catch (err) {
    console.error('Failed to get restaurant:', err.message);
    return null;
  }
}

// Get restaurants by cuisine type
async function getRestaurantsByCuisine(cuisine, limit = 10) {
  const collection = await connectToMongoDB();
  if (!collection) return [];

  try {
    return await collection
      .find({ cuisineDescription: { $regex: cuisine, $options: 'i' } })
      .sort({ rating: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.error('Failed to get restaurants by cuisine:', err.message);
    return [];
  }
}

// Get top-rated restaurants
async function getTopRatedRestaurants(limit = 10, minRating = 4) {
  const collection = await connectToMongoDB();
  if (!collection) return [];

  try {
    return await collection
      .find({ rating: { $gte: minRating } })
      .sort({ rating: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.error('Failed to get top-rated restaurants:', err.message);
    return [];
  }
}

// Get restaurants by borough
async function getRestaurantsByBorough(borough, limit = 20) {
  const collection = await connectToMongoDB();
  if (!collection) return [];

  try {
    return await collection
      .find({ fullAddress: { $regex: borough, $options: 'i' } })
      .sort({ rating: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.error('Failed to get restaurants by borough:', err.message);
    return [];
  }
}

// Get random restaurant suggestions
async function getRandomRestaurants(limit = 5) {
  const collection = await connectToMongoDB();
  if (!collection) return [];

  try {
    return await collection
      .aggregate([
        { $match: { rating: { $gte: 3.5 } } },
        { $sample: { size: limit } }
      ])
      .toArray();
  } catch (err) {
    console.error('Failed to get random restaurants:', err.message);
    return [];
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
    if (r.priceLevel) response += `   💰 ${'$'.repeat(r.priceLevel)}\n`;
    if (r.fullAddress) response += `   📍 ${r.fullAddress}\n`;
    if (r.reviewSummary) {
      const summary = r.reviewSummary.length > 80 ? r.reviewSummary.substring(0, 80) + '...' : r.reviewSummary;
      response += `   💬 "${summary}"\n`;
    }
    response += '\n';
  });

  return response.trim();
}

// Format single restaurant details
function formatRestaurantDetails(restaurant) {
  if (!restaurant) return "Restaurant not found.";

  let response = `🍽️ ${restaurant.Name}\n\n`;
  if (restaurant.cuisineDescription) response += `Cuisine: ${restaurant.cuisineDescription}\n`;
  if (restaurant.rating) response += `Rating: ⭐ ${restaurant.rating}/5\n`;
  if (restaurant.priceLevel) response += `Price: ${'$'.repeat(restaurant.priceLevel)}\n`;
  if (restaurant.fullAddress) response += `Address: 📍 ${restaurant.fullAddress}\n`;
  if (restaurant.reviewSummary) response += `\n💬 "${restaurant.reviewSummary}"`;

  return response;
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
  getRestaurantById,
  getRestaurantsByCuisine,
  getTopRatedRestaurants,
  getRestaurantsByBorough,
  getRandomRestaurants,
  formatRestaurantResults,
  formatRestaurantDetails,
  closeMongoDBConnection
};
