const axios = require('axios');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const { checkAndIncrementGemini } = require('./rate_limiter');

// Restaurant keywords
const RESTAURANT_KEYWORDS = [
  'food', 'eat', 'restaurant', 'restaurants', 'cuisine', 'dinner', 'lunch', 
  'breakfast', 'brunch', 'pizza', 'sushi', 'burger', 'tacos', 'ramen', 
  'mexican', 'italian', 'chinese', 'japanese', 'indian', 'thai', 'korean',
  'french', 'american', 'seafood', 'steakhouse', 'vegetarian', 'vegan', 
  'halal', 'kosher', 'cafe', 'bistro', 'deli', 'bakery', 'dessert',
  'hungry', 'meal', 'dining', 'resto', 'spot', 'place to eat',
  'birthday dinner', 'date night', 'anniversary dinner', 'romantic dinner',
  'where to take', 'suggest something', 'recommend', 'craving',
  'why not', 'what about', 'how about', 'is it good', 'have you heard'
];

// Event keywords
const EVENT_KEYWORDS = [
  'event', 'events', 'concert', 'show', 'shows', 'festival', 'parade',
  'park', 'parks', 'things to do', 'what to do', 'activities', 'activity',
  'music', 'comedy', 'theater', 'theatre', 'museum', 'art', 'exhibition', 
  'sports', 'game', 'tour', 'walk', 'run', 'market', 'fair', 'happening', 
  'going on', 'plans', 'tickets'
];

// Classifies a user query into RESTAURANT, EVENT, or OTHER
async function classifyQuery(userId, text) {
  const lowerText = text.toLowerCase();

  // SPOTLIGHT PATTERNS - always RESTAURANT
  const spotlightPatterns = [
    /why not/i, /what about/i, /how about/i, /is .+ good/i,
    /tell me about/i, /have you heard of/i, /how is/i
  ];
  if (spotlightPatterns.some(p => p.test(lowerText))) {
    console.log('Detected spotlight pattern -> RESTAURANT');
    return 'RESTAURANT';
  }

  // Special patterns that are clearly RESTAURANT
  const restaurantPatterns = [
    'birthday', 'anniversary', 'date', 'girlfriend', 'boyfriend', 'gf', 'bf',
    'romantic', 'dinner', 'lunch', 'brunch', 'breakfast', 'eat', 'food',
    'hungry', 'craving', 'restaurant', 'suggest something', 'recommend',
    'where to take', 'place to eat', 'resto'
  ];
  
  const isLikelyRestaurant = restaurantPatterns.some(p => lowerText.includes(p));
  
  // Quick heuristic check
  const hasRestaurantKeyword = RESTAURANT_KEYWORDS.some(k => lowerText.includes(k));
  const hasEventKeyword = EVENT_KEYWORDS.some(k => lowerText.includes(k));

  // If clearly restaurant pattern, return immediately
  if (isLikelyRestaurant && !hasEventKeyword) return 'RESTAURANT';
  
  // If clear match, return immediately
  if (hasRestaurantKeyword && !hasEventKeyword) return 'RESTAURANT';
  if (hasEventKeyword && !hasRestaurantKeyword) return 'EVENT';

  // If no Gemini or rate limited, use heuristic
  if (!GEMINI_API_KEY || !await checkAndIncrementGemini(userId)) {
    if (isLikelyRestaurant || hasRestaurantKeyword) return 'RESTAURANT';
    if (hasEventKeyword) return 'EVENT';
    return 'OTHER';
  }

  // Use Gemini for ambiguous cases
  console.log(`Classifying query: "${text}"`);

  const prompt = `Classify this NYC request:
- RESTAURANT: looking for food, places to eat, cuisines, dining, birthday dinner, date night, where to take someone, asking about a specific restaurant
- EVENT: concerts, shows, festivals, things to do, activities (NOT food-related)
- OTHER: greetings, off-topic, not NYC food/events

Query: "${text}"

Return ONLY: RESTAURANT, EVENT, or OTHER`;

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    const result = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();

    if (result?.includes('RESTAURANT')) return 'RESTAURANT';
    if (result?.includes('EVENT')) return 'EVENT';
    return 'OTHER';
  } catch (err) {
    console.error('Classification failed:', err.message);
    // Fallback to heuristic
    if (hasRestaurantKeyword) return 'RESTAURANT';
    if (hasEventKeyword) return 'EVENT';
    return 'OTHER';
  }
}

module.exports = { classifyQuery };