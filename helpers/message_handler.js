const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
const { classifyQuery, getClassificationType, getEventFilters } = require('./query_router');
const { 
  searchRestaurants, 
  formatRestaurantResults, 
  createDedupeKey,
  searchRestaurantsDB,
  getWebResearch,
  extractIntent
} = require('./restaurants');
const { searchEvents, formatEventResults } = require('./events');
const { FOOD_ONBOARDING } = require('./food_onboarding');
const { RESTAURANT_SYSTEM_PROMPT } = require('./restaurants');
const { 
  getOrCreateProfile, 
  updateProfile, 
  deleteProfile, 
  getProfile,
  profileExists,
  updateContext,
  addShownRestaurants,
  addShownEvents,
  clearContext,
  resetOnboarding,
  getContext,
  getSocialProfile,
  updateSocialProfile
} = require('./user_profile');
const {
  handleSocialFlow,
  startOptIn,
  detectSocialIntent,
  handleDeleteAllData,
  handleOptOut,
  handleStopMatching,
  handleReport,
  findCompatibleMatches,
  formatMatchResults,
  requestMatch,
  handleMatchResponse
} = require('./social_matching');
const axios = require('axios');
const https = require('https');

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const graphClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const geminiClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   "MORE" DETECTION HELPERS
===================== */
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

/* =====================
   FOOD QUESTION ANSWERER
===================== */
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

/* =====================
   RESTAURANT SYSTEM PROMPT HANDLER
===================== */
async function handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, returnResult = false) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  
  // ========================================================
  // POOL-BASED "MORE" HANDLING - MUST BE FIRST
  // Never call extractIntent, never ask constraints for "more"
  // ========================================================
  const isMoreFollowUp = isMoreRequest(messageText);
  
  if (isMoreFollowUp) {
    console.log(`[MORE] Detected "more" request: "${messageText}"`);
    
    // Check if we have a pool to paginate from
    if (context?.pool?.length > 0) {
      const currentPage = context.page || 0;
      const nextPage = currentPage + 1;
      const pageSize = 5;
      const startIdx = nextPage * pageSize;
      const batch = context.pool.slice(startIdx, startIdx + pageSize);
      
      if (batch.length > 0) {
        console.log(`[MORE] Serving page ${nextPage} from pool (${batch.length} items, pool size: ${context.pool.length})`);
        
        // Format the batch - never include URLs or sources
        let formatted = batch.map((r, i) => {
          let entry = `${i + 1}. ${(r.name || '').toUpperCase()}\n`;
          entry += `📍 ${r.neighborhood || ''}, ${r.borough || ''}\n`;
          if (r.price_range) entry += `💰 ${r.price_range}`;
          if (r.vibe) entry += ` · ${r.vibe}`;
          entry += '\n';
          if (r.what_to_order?.length) entry += `🍽️ ${r.what_to_order.slice(0, 2).join(', ')}\n`;
          if (r.why) entry += `💡 ${r.why}`;
          return entry.trim();
        }).join('\n\n');
        
        // Check if there are more results after this batch
        const hasMoreAfterThis = context.pool.length > (startIdx + batch.length);
        if (hasMoreAfterThis) {
          formatted += '\n\nReply "more" for different options.';
        } else {
          formatted += '\n\nThat\'s all I have for this search.';
        }
        
        // Update context with new page and shown keys
        await updateContext(senderId, {
          page: nextPage,
          shownKeys: [...(context.shownKeys || []), ...batch.map(r => r.dedupeKey).filter(Boolean)],
          shownNames: [...(context.shownNames || []), ...batch.map(r => r.name).filter(Boolean)]
        });
        
        if (returnResult) {
          return { reply: formatted, category: 'RESTAURANT' };
        }
        await sendMessage(senderId, formatted);
        return;
      }
      
      // Pool exhausted - provide helpful next steps
      console.log('[MORE] Pool exhausted');
      const dish = context.lastIntent?.dish || context.lastIntent?.cuisine || context.lastIntent?.dish_or_cuisine || 'that';
      const exhaustedMsg = `That's all I have for this search. Want to try a different borough or a slightly different dish?`;
      const exhaustedReplies = [
        { title: 'Manhattan 🏙️', payload: 'BOROUGH_MANHATTAN' },
        { title: 'Brooklyn 🌉', payload: 'BOROUGH_BROOKLYN' },
        { title: 'Queens 🚇', payload: 'BOROUGH_QUEENS' },
        { title: 'Anywhere 🗽', payload: 'BOROUGH_ANY' }
      ];
      
      // Clear the pool since it's exhausted
      await updateContext(senderId, {
        pool: [],
        page: 0,
        pendingType: 'restaurant_gate',
        pendingQuery: dish,
        pendingFilters: { cuisine: dish }
      });
      
      if (returnResult) {
        return { reply: exhaustedMsg, buttons: exhaustedReplies, category: 'RESTAURANT' };
      }
      await sendMessage(senderId, exhaustedMsg, exhaustedReplies);
      return;
    }
    
    // No pool available - treat as new search but ask what they want
    console.log('[MORE] No pool available, asking what user wants');
    const noPoolMsg = "What would you like more of? Tell me a dish or cuisine.";
    
    if (returnResult) {
      return { reply: noPoolMsg, category: 'RESTAURANT' };
    }
    await sendMessage(senderId, noPoolMsg);
    return;
  }
  
  // ========================================================
  // END OF "MORE" HANDLING - Continue with normal flow
  // ========================================================

  // Check if this is a constraint response (payload like BOROUGH_*, BUDGET_*, FILTER_*, VIBE_*, SET_*)
  const isConstraintResponse = payload && (
    payload.startsWith('BOROUGH_') || 
    payload.startsWith('BUDGET_') || 
    payload.startsWith('CUISINE_') ||
    payload.startsWith('FILTER_') ||
    payload.startsWith('VIBE_') ||
    payload.startsWith('SET_') ||
    payload === 'SHOW_TOP_5'
  );
  
  // ========================================================
  // STEP 1: Extract intent FIRST (this is async - must await!)
  // ========================================================
  let intent;
  try {
    intent = await extractIntent(messageText || payload || '');
  } catch (err) {
    console.error('[RESTAURANTS] extractIntent failed:', err.message);
    intent = { request_type: 'vague', dish: null, cuisine: null };
  }
  
  // Log immediately after extraction
  console.log(`[RESTAURANTS] Intent extracted: dish="${intent.dish}", cuisine="${intent.cuisine}", type="${intent.request_type}", borough="${intent.borough}"`);
  
  // ========================================================
  // STEP 2: Build filters from intent + context + profile
  // PRIORITY: intent.dish > intent.cuisine > context
  // ========================================================
  const dishOrCuisine = intent.dish || intent.cuisine || intent.dish_or_cuisine;
  const hasDish = !!intent.dish && intent.request_type === 'dish';
  
  const filters = {
    cuisine: null,
    borough: null,
    budget: null,
    isDishQuery: hasDish
  };
  
  // Determine if this is a NEW search or a constraint response
  // NEW search = user typed a food query (not just clicking a button)
  const isNewSearch = messageText && !isConstraintResponse;
  
  // Set cuisine/dish - prefer fresh intent over stale context
  if (dishOrCuisine && !['best', 'good', 'food', 'restaurant', 'restaurants', 'find', 'me', 'the'].includes(dishOrCuisine.toLowerCase())) {
    filters.cuisine = dishOrCuisine;
  } else if (context?.pendingFilters?.cuisine) {
    filters.cuisine = context.pendingFilters.cuisine;
  } else if (context?.lastFilters?.cuisine) {
    filters.cuisine = context.lastFilters.cuisine;
  }
  
  // Set borough - DON'T carry over from lastFilters for new searches
  if (isNewSearch) {
    // Fresh search - only use intent's borough (which is usually null)
    filters.borough = intent.borough;
  } else {
    // Constraint response - carry over from context
    filters.borough = intent.borough || context?.pendingFilters?.borough || context?.lastFilters?.borough;
  }
  
  // Set budget - DON'T carry over from lastFilters for new searches
  if (isNewSearch) {
    filters.budget = intent.budget;
  } else {
    filters.budget = intent.budget || context?.pendingFilters?.budget || context?.lastFilters?.budget;
  }
  
  // ========================================================
  // STEP 3: Handle constraint button responses (Multi-filter builder)
  // ========================================================
  const isFilterPayload = payload && payload.startsWith('FILTER_');
  
  // Helper to show filter menu with current selections
  const showFilterMenu = async (currentFilters, cuisine) => {
    const locationText = currentFilters.borough && currentFilters.borough !== 'any' ? currentFilters.borough : 'Any';
    const budgetText = currentFilters.budget && currentFilters.budget !== 'any' ? currentFilters.budget : 'Any';
    const vibeText = currentFilters.vibe && currentFilters.vibe !== 'any' ? currentFilters.vibe : 'Any';
    
    const question = `🍜 ${cuisine}\n\n📍 Location: ${locationText}\n💰 Budget: ${budgetText}\n✨ Vibe: ${vibeText}\n\nTap to change or search:`;
    const replies = [
      { title: `📍 ${locationText === 'Any' ? 'Set Location' : locationText}`, payload: 'FILTER_LOCATION' },
      { title: `💰 ${budgetText === 'Any' ? 'Set Budget' : budgetText}`, payload: 'FILTER_BUDGET' },
      { title: `✨ ${vibeText === 'Any' ? 'Set Vibe' : vibeText}`, payload: 'FILTER_VIBE' },
      { title: '🔍 Search Now!', payload: 'FILTER_SEARCH_NOW' },
      { title: '🎲 Surprise Me!', payload: 'FILTER_SURPRISE' }
    ];
    
    if (returnResult) return { reply: question, buttons: replies, category: 'RESTAURANT' };
    await sendMessage(senderId, question, replies);
    return null;
  };
  
  if (isConstraintResponse || payload === 'SHOW_TOP_5' || isFilterPayload) {
    // Preserve cuisine from context for all constraint/filter responses
    if (!filters.cuisine && context?.pendingFilters?.cuisine) {
      filters.cuisine = context.pendingFilters.cuisine;
      filters.isDishQuery = context.pendingFilters.isDishQuery || false;
    }
    
    // Carry over existing filter selections from context
    if (context?.pendingFilters?.borough) filters.borough = context.pendingFilters.borough;
    if (context?.pendingFilters?.budget) filters.budget = context.pendingFilters.budget;
    if (context?.pendingFilters?.vibe) filters.vibe = context.pendingFilters.vibe;
    
    if (payload === 'SHOW_TOP_5' || payload === 'FILTER_TOP_RATED') {
      // User wants top rated anywhere - go straight to search
      filters.borough = 'any';
      filters.budget = 'any';
      filters.vibe = 'top rated';
    } else if (payload === 'FILTER_SURPRISE') {
      // Surprise me - random borough, proceed to search
      const boroughs = ['Manhattan', 'Brooklyn', 'Queens'];
      filters.borough = boroughs[Math.floor(Math.random() * boroughs.length)];
      filters.budget = 'any';
    } else if (payload === 'FILTER_SEARCH_NOW') {
      // User is ready to search with current filters
      if (!filters.borough) filters.borough = 'any';
      if (!filters.budget) filters.budget = 'any';
      // Continue to search below
    } else if (payload === 'FILTER_LOCATION') {
      // Show borough options (will return to menu after selection)
      const question = `📍 Which area?`;
      const replies = [
        { title: 'Manhattan 🏙️', payload: 'SET_BOROUGH_MANHATTAN' },
        { title: 'Brooklyn 🌉', payload: 'SET_BOROUGH_BROOKLYN' },
        { title: 'Queens 🚇', payload: 'SET_BOROUGH_QUEENS' },
        { title: 'Bronx 🏠', payload: 'SET_BOROUGH_BRONX' },
        { title: 'Anywhere 🗽', payload: 'SET_BOROUGH_ANY' }
      ];
      if (returnResult) return { reply: question, buttons: replies, category: 'RESTAURANT' };
      await sendMessage(senderId, question, replies);
      return;
    } else if (payload === 'FILTER_BUDGET') {
      // Show budget options
      const question = `💰 What's your budget per person?`;
      const replies = [
        { title: 'Under $20', payload: 'SET_BUDGET_$' },
        { title: '$20-40', payload: 'SET_BUDGET_$$' },
        { title: '$40-80', payload: 'SET_BUDGET_$$$' },
        { title: '$80+', payload: 'SET_BUDGET_$$$$' },
        { title: 'Any budget', payload: 'SET_BUDGET_ANY' }
      ];
      if (returnResult) return { reply: question, buttons: replies, category: 'RESTAURANT' };
      await sendMessage(senderId, question, replies);
      return;
    } else if (payload === 'FILTER_VIBE') {
      // Show vibe options
      const question = `✨ What vibe are you looking for?`;
      const replies = [
        { title: 'Casual 🍕', payload: 'SET_VIBE_CASUAL' },
        { title: 'Date night 💕', payload: 'SET_VIBE_DATE' },
        { title: 'Trendy 🔥', payload: 'SET_VIBE_TRENDY' },
        { title: 'Hidden gem 💎', payload: 'SET_VIBE_HIDDEN' },
        { title: 'Any vibe', payload: 'SET_VIBE_ANY' }
      ];
      if (returnResult) return { reply: question, buttons: replies, category: 'RESTAURANT' };
      await sendMessage(senderId, question, replies);
      return;
    } else if (payload && payload.startsWith('SET_BOROUGH_')) {
      // Save borough and return to filter menu
      const boroughMap = {
        'SET_BOROUGH_MANHATTAN': 'Manhattan', 'SET_BOROUGH_BROOKLYN': 'Brooklyn',
        'SET_BOROUGH_QUEENS': 'Queens', 'SET_BOROUGH_BRONX': 'Bronx',
        'SET_BOROUGH_STATEN': 'Staten Island', 'SET_BOROUGH_ANY': 'any'
      };
      filters.borough = boroughMap[payload] || 'any';
      await updateContext(senderId, { pendingFilters: { ...context?.pendingFilters, cuisine: filters.cuisine, borough: filters.borough } });
      const result = await showFilterMenu(filters, filters.cuisine);
      if (result) return result;
      return;
    } else if (payload && payload.startsWith('SET_BUDGET_')) {
      // Save budget and return to filter menu
      const budgetMap = { 'SET_BUDGET_$': 'Under $20', 'SET_BUDGET_$$': '$20-40', 'SET_BUDGET_$$$': '$40-80', 'SET_BUDGET_$$$$': '$80+', 'SET_BUDGET_ANY': 'any' };
      filters.budget = budgetMap[payload] || 'any';
      await updateContext(senderId, { pendingFilters: { ...context?.pendingFilters, cuisine: filters.cuisine, budget: filters.budget } });
      const result = await showFilterMenu(filters, filters.cuisine);
      if (result) return result;
      return;
    } else if (payload && payload.startsWith('SET_VIBE_')) {
      // Save vibe and return to filter menu
      const vibeMap = { 
        'SET_VIBE_CASUAL': 'Casual', 'SET_VIBE_DATE': 'Date night', 
        'SET_VIBE_TRENDY': 'Trendy', 'SET_VIBE_HIDDEN': 'Hidden gem', 'SET_VIBE_ANY': 'any' 
      };
      filters.vibe = vibeMap[payload] || 'any';
      await updateContext(senderId, { pendingFilters: { ...context?.pendingFilters, cuisine: filters.cuisine, vibe: filters.vibe } });
      const result = await showFilterMenu(filters, filters.cuisine);
      if (result) return result;
      return;
    } else if (payload && payload.startsWith('VIBE_')) {
      // Legacy vibe handler - treat as SET_VIBE
      const vibeMap = { 'VIBE_CASUAL': 'Casual', 'VIBE_DATE': 'Date night', 'VIBE_TRENDY': 'Trendy', 'VIBE_HIDDEN': 'Hidden gem', 'VIBE_ANY': 'any' };
      filters.vibe = vibeMap[payload] || 'any';
      filters.borough = filters.borough || 'any';
      filters.budget = filters.budget || 'any';
    } else if (payload && payload.startsWith('BOROUGH_')) {
      const boroughMap = {
        'BOROUGH_MANHATTAN': 'Manhattan', 'BOROUGH_BROOKLYN': 'Brooklyn',
        'BOROUGH_QUEENS': 'Queens', 'BOROUGH_BRONX': 'Bronx',
        'BOROUGH_STATEN': 'Staten Island', 'BOROUGH_ANY': 'any'
      };
      filters.borough = boroughMap[payload] || filters.borough;
      if (!filters.budget) filters.budget = 'any';
    } else if (payload && payload.startsWith('BUDGET_')) {
      const budgetMap = { 'BUDGET_$': '$', 'BUDGET_$$': '$$', 'BUDGET_$$$': '$$$', 'BUDGET_$$$$': '$$$$', 'BUDGET_ANY': 'any' };
      filters.budget = budgetMap[payload] || filters.budget;
      if (!filters.borough) filters.borough = 'any';
    } else if (payload && payload.startsWith('CUISINE_')) {
      filters.cuisine = payload.replace('CUISINE_', '').replace(/_/g, ' ');
      filters.isDishQuery = false;
    }
  }
  
  console.log(`[RESTAURANTS] Filters built: cuisine="${filters.cuisine}", borough="${filters.borough}", budget="${filters.budget}", isDish=${filters.isDishQuery}`);
  
  // ========================================================
  // STEP 4: CONSTRAINT GATE - Only ask questions for missing required info
  // IMPORTANT: If user specified a DISH, skip the cuisine question!
  // ========================================================
  
  // Check if cuisine/dish is missing or generic
  const genericWords = ['best', 'good', 'nice', 'great', 'amazing', 'food', 'restaurant', 'restaurants', 'spots', 'places', 'hungry', 'eat', 'dinner', 'lunch', 'breakfast'];
  const cleanCuisine = (filters.cuisine || '').toLowerCase().trim();
  const hasCuisineOrDish = filters.cuisine && cleanCuisine.length >= 2 && !genericWords.includes(cleanCuisine);

  // ONLY ask "What kind of food" if we truly don't know what they want
  if (!hasCuisineOrDish) {
    console.log(`[RESTAURANTS] No dish/cuisine detected, asking...`);
    await updateContext(senderId, {
      pendingType: 'restaurant_gate',
      pendingQuery: messageText || context?.pendingQuery,
      pendingFilters: filters,
      lastCategory: 'FOOD_SEARCH'
    });
    
    const question = "What kind of food are you craving?";
    const replies = [
      { title: '🍜 Asian', payload: 'CUISINE_asian' },
      { title: '🍕 Italian', payload: 'CUISINE_italian' },
      { title: '🌮 Mexican', payload: 'CUISINE_mexican' },
      { title: '🍔 American', payload: 'CUISINE_american' },
      { title: '🍲 Indian', payload: 'CUISINE_indian' },
      { title: '🥙 Middle Eastern', payload: 'CUISINE_middle_eastern' }
    ];
    
    if (returnResult) return { reply: question, buttons: replies, category: 'RESTAURANT' };
    await sendMessage(senderId, question, replies);
    return;
  }
  
  // 2. Check if user needs to specify preferences (conversational flow)
  if (!filters.borough) {
    console.log(`[RESTAURANTS] No preferences set for ${filters.cuisine}, asking conversationally...`);
    
    await updateContext(senderId, {
      pendingType: 'restaurant_preferences',
      pendingQuery: messageText || context?.pendingQuery,
      pendingFilters: filters,
      lastCategory: 'FOOD_SEARCH'
    });
    
    const dishOrCuisine = filters.cuisine;
    
    // Estimate restaurant count based on cuisine popularity in NYC
    const cuisineLower = (dishOrCuisine || '').toLowerCase();
    let estimatedCount;
    if (['chinese', 'italian', 'mexican', 'american', 'pizza'].includes(cuisineLower)) {
      estimatedCount = '1,000+';
    } else if (['japanese', 'thai', 'indian', 'korean', 'sushi', 'ramen'].includes(cuisineLower)) {
      estimatedCount = '500+';
    } else if (['vietnamese', 'greek', 'french', 'spanish', 'mediterranean'].includes(cuisineLower)) {
      estimatedCount = '200+';
    } else {
      estimatedCount = '100+';
    }
    
    const question = `🍜 ${dishOrCuisine}! NYC has ${estimatedCount} spots.

Tell me what you're looking for:

📍 Location (Manhattan, Brooklyn, Queens...)
💰 Budget (cheap, moderate, fancy)
✨ Vibe (casual, date night, trendy, hidden gem)
🎲 Or just say "surprise me"

Example: "Manhattan, under $30, casual"`;
    
    // No buttons - user types their preferences
    if (returnResult) return { reply: question, buttons: null, category: 'RESTAURANT' };
    await sendMessage(senderId, question);
    return;
  }
  
  // 2b. If borough selected but no budget, just proceed (don't force budget question)
  // User can filter by budget if they want, but it's optional now
  
  // Use profile budget if not specified
  if (!filters.budget && profile?.foodProfile?.budget) {
    filters.budget = profile.foodProfile.budget;
  }
  
  // Clear pending state since we have all filters
  await updateContext(senderId, {
    pendingType: null,
    pendingQuery: null,
    pendingFilters: null,
    lastFilters: filters,
    lastCategory: 'FOOD_SEARCH'
  });
  
  // Get candidate restaurants from DB
  let dbRestaurants = await searchRestaurantsDB(filters, 25);
  
  // 2b. If no results with strict cuisine filter, try broader search
  if (dbRestaurants.length === 0 && filters.cuisine) {
    console.log(`No DB results for "${filters.cuisine}", trying broader search...`);
    // Try without cuisine filter to get some candidates
    const broaderFilters = { ...filters, cuisine: null };
    dbRestaurants = await searchRestaurantsDB(broaderFilters, 25);
    console.log(`Broader search found ${dbRestaurants.length} restaurants`);
  }
  
  // 2c. If still no results, fall back to direct web search
  if (dbRestaurants.length === 0) {
    console.log('No DB results, falling back to web search...');
    const { searchRestaurants, formatRestaurantResults } = require('./restaurants');
    const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true);
    const formatted = formatRestaurantResults(searchResult);
    
    await updateContext(senderId, {
      lastCategory: 'FOOD_SEARCH',
      lastFilters: filters,
      lastIntent: searchResult.intent,
      lastResults: searchResult.results?.slice(0, 10) || [],
      pool: searchResult.pool || [],
      page: searchResult.page || 0,
      shownKeys: searchResult.shownKeys || [],
      pendingType: null,
      pendingQuery: null
    });
    
    if (returnResult) {
      return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
    }
    await sendMessage(senderId, formatted.text, formatted.replies);
    return;
  }
  
  // 3. Prepare the prompt for Gemini
  let fullPrompt = RESTAURANT_SYSTEM_PROMPT
    .replace('{{TODAY_DATE}}', today)
    .replace('{{USER_MESSAGE}}', messageText || '')
    .replace('{{USER_PAYLOAD}}', payload || '')
    .replace('{{USER_PROFILE_JSON}}', JSON.stringify(profile.foodProfile || {}))
    .replace('{{USER_CONTEXT_JSON}}', JSON.stringify(context || {}))
    .replace('{{DB_RESTAURANTS_JSON}}', JSON.stringify(dbRestaurants))
    .replace('{{WEB_RESEARCH_SNIPPETS}}', '')
    .replace('{{WEB_RESEARCH_ALLOWED}}', 'true');

  try {
    let response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );

    let resultText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    
    // Check if it's a RESEARCH_ACTION (TYPE 3)
    // Be robust against markdown backticks or whitespace
    let cleanResult = resultText;
    if (resultText.startsWith('```')) {
      cleanResult = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    if (cleanResult.startsWith('{') && cleanResult.includes('NEED_RESEARCH')) {
      try {
        const researchData = JSON.parse(cleanResult);
        
        // If NEED_RESEARCH has empty queries/shortlist, fall back to web search
        if (!researchData.queries?.length || !researchData.shortlist?.length) {
          console.log('NEED_RESEARCH returned empty, falling back to web search...');
          const { searchRestaurants, formatRestaurantResults } = require('./restaurants');
          const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true);
          const formatted = formatRestaurantResults(searchResult);
          
          await updateContext(senderId, {
            lastCategory: 'FOOD_SEARCH',
            lastFilters: filters,
            lastIntent: searchResult.intent,
            lastResults: searchResult.results?.slice(0, 10) || [],
            pool: searchResult.pool || [],
            page: searchResult.page || 0,
            shownKeys: searchResult.shownKeys || [],
            pendingType: null,
            pendingQuery: null
          });
          
          if (returnResult) {
            return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
          }
          await sendMessage(senderId, formatted.text, formatted.replies);
          return;
        }
        
        const snippets = await getWebResearch(researchData.queries);
        
        // REBUILD the prompt with snippets (can't replace already-replaced placeholder)
        const promptWithSnippets = RESTAURANT_SYSTEM_PROMPT
          .replace('{{TODAY_DATE}}', today)
          .replace('{{USER_MESSAGE}}', messageText || '')
          .replace('{{USER_PAYLOAD}}', payload || '')
          .replace('{{USER_PROFILE_JSON}}', JSON.stringify(profile.foodProfile || {}))
          .replace('{{USER_CONTEXT_JSON}}', JSON.stringify(context || {}))
          .replace('{{DB_RESTAURANTS_JSON}}', JSON.stringify(dbRestaurants))
          .replace('{{WEB_RESEARCH_SNIPPETS}}', snippets || '')
          .replace('{{WEB_RESEARCH_ALLOWED}}', 'false'); // Don't ask for more research
        
        response = await geminiClient.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
          {
            contents: [{ parts: [{ text: promptWithSnippets }] }],
            generationConfig: { maxOutputTokens: 2048, temperature: 0.2 }
          },
          { params: { key: GEMINI_API_KEY } }
        );
        resultText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        
        // If the second response is also wrapped in markdown, clean it
        if (resultText.startsWith('```')) {
          resultText = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
        }
        
        // If Gemini STILL returns JSON after research, fall back to web search
        if (resultText.startsWith('{') && resultText.includes('NEED_RESEARCH')) {
          console.log('Gemini still returning NEED_RESEARCH after snippets, falling back...');
          const { searchRestaurants, formatRestaurantResults } = require('./restaurants');
          const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true);
          const formatted = formatRestaurantResults(searchResult);
          
          if (returnResult) {
            return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
          }
          await sendMessage(senderId, formatted.text, formatted.replies);
          return;
        }
      } catch (e) {
        console.error('Failed to parse research JSON or fetch snippets:', e.message);
        // Fall back to web search on error
        const { searchRestaurants, formatRestaurantResults } = require('./restaurants');
        const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true);
        const formatted = formatRestaurantResults(searchResult);
        
        if (returnResult) {
          return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
        }
        await sendMessage(senderId, formatted.text, formatted.replies);
        return;
      }
    } else {
      // If it wasn't JSON, use the (potentially cleaned) text
      resultText = cleanResult;
    }

    // TYPE 1 (ASK) or TYPE 2 (ANSWER)
    // Check for area/budget keywords in what is likely a TYPE 1 ASK
    const isAsk = resultText.length < 200 && (resultText.toLowerCase().includes('area') || resultText.toLowerCase().includes('budget') || resultText.toLowerCase().includes('thinking'));

    if (isAsk) {
      let buttons = null;
      if (resultText.toLowerCase().includes('area')) {
        buttons = [
          { title: 'Manhattan 🏙', payload: 'BOROUGH_MANHATTAN' },
          { title: 'Brooklyn 🌉', payload: 'BOROUGH_BROOKLYN' },
          { title: 'Queens 🚇', payload: 'BOROUGH_QUEENS' },
          { title: 'Bronx 🏢', payload: 'BOROUGH_BRONX' },
          { title: 'Staten Island 🗽', payload: 'BOROUGH_STATEN' },
          { title: 'Anywhere 🌍', payload: 'BOROUGH_ANY' }
        ];
      } else if (resultText.toLowerCase().includes('budget')) {
        buttons = [
          { title: 'Cheap ($) 💸', payload: 'BUDGET_$' },
          { title: 'Mid ($$) 🙂', payload: 'BUDGET_$$' },
          { title: 'Nice ($$$) ✨', payload: 'BUDGET_$$$' },
          { title: 'Any 🤷', payload: 'BUDGET_ANY' }
        ];
      }
      
      await updateContext(senderId, {
        pendingType: 'restaurant_gate',
        pendingQuery: messageText || context?.pendingQuery,
        lastFilters: filters,
        pendingGate: resultText
      });
      
      if (returnResult) {
        return { reply: resultText, buttons, category: 'RESTAURANT' };
      }
      await sendMessage(senderId, resultText, buttons);
    } else {
      // It's TYPE 2 (ANSWER)
      const finalReply = resultText || "I found some spots for you! What else are you looking for?";
      
      // IMPORTANT: Save dbRestaurants as pool for "more" pagination
      await updateContext(senderId, {
        lastCategory: 'FOOD_SEARCH',
        lastFilters: filters,
        lastIntent: { dish: filters.cuisine, borough: filters.borough, request_type: filters.isDishQuery ? 'dish' : 'cuisine' },
        lastResults: dbRestaurants?.slice(0, 10) || [],
        pool: dbRestaurants || [],
        page: 0,
        shownKeys: [],
        shownNames: [],
        pendingType: null,
        pendingQuery: null,
        pendingGate: null
      });
      
      if (returnResult) {
        return { reply: finalReply, category: 'RESTAURANT' };
      }
      await sendMessage(senderId, finalReply);
    }

  } catch (err) {
    console.error('System prompt processing failed:', err.message);
    const errorMsg = "Sorry, I'm having trouble finding restaurant info right now. Try again in a bit?";
    if (returnResult) {
      return { reply: errorMsg, category: 'RESTAURANT' };
    }
    await sendMessage(senderId, errorMsg);
  }
}


/* =====================
   HELPERS
===================== */
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


// Parse borough from various payload formats
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

// Parse borough from text (for when user types "queens" or "try in queens")
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

// Parse budget from payload
function parseBudgetFromPayload(payload) {
  const budgetMap = {
    'BUDGET_$': '$',
    'BUDGET_$$': '$$',
    'BUDGET_$$$': '$$$',
    'BUDGET_ANY': 'any'
  };
  return budgetMap[payload];
}


/* =====================
   WEBHOOK ENTRYPOINT
===================== */
async function handleDM(body) {
  const messaging = body?.entry?.[0]?.messaging?.[0];
  if (!messaging || messaging.message?.is_echo) return;

  const senderId = getSenderId(body);
  if (!senderId) return;

  const incoming = getIncomingTextOrPayload(body);
  if (!incoming.text && !incoming.payload) return;

  // Handle special commands BEFORE creating profile
  if (incoming.text) {
    const lowerText = incoming.text.toLowerCase().trim();
    
    if (lowerText === 'delete my data') {
      if (await profileExists(senderId)) {
        await deleteProfile(senderId);
        await sendMessage(senderId, "Done — I deleted your data.");
      } else {
        await sendMessage(senderId, "No data found for your account.");
      }
      return;
    }
    
    if (lowerText === 'reset') {
      await resetOnboarding(senderId);
      await sendMessage(senderId, "Reset complete!");
      await sendMessage(senderId, FOOD_ONBOARDING.START.text, FOOD_ONBOARDING.START.replies);
      return;
    }
  }

  const profile = await getOrCreateProfile(senderId);
  const context = await getContext(senderId);

  // Handle pending constraint gate
  if (context?.pendingType && incoming.payload) {
    const handled = await handleConstraintResponse(senderId, incoming.payload, profile, context);
    if (handled) return;
  }
  
  // Handle BOROUGH_ANY - consolidated handler for "Anywhere in NYC" option
  // This runs the search directly without going back to options screen
  if (incoming.payload === 'BOROUGH_ANY') {
    console.log(`[BOROUGH_ANY] Processing search for all boroughs`);
    const cuisine = context?.pendingFilters?.cuisine || context?.lastFilters?.cuisine;
    if (cuisine) {
      // Clear old pool and set borough to 'any' for a fresh NYC-wide search
      const searchFilters = { 
        cuisine: cuisine,
        borough: 'any', 
        budget: context?.pendingFilters?.budget || 'any',
        isDishQuery: false
      };
      await updateContext(senderId, { 
        pendingType: null, // Don't go back to options
        pendingFilters: searchFilters,
        pool: [],
        page: 0,
        shownKeys: [],
        shownNames: []
      });
      // Pass payload as constraint so it doesn't trigger "new search" logic
      await handleRestaurantQueryWithSystemPrompt(
        senderId, 
        cuisine, // The cuisine to search 
        'BOROUGH_ANY', // Mark as constraint response
        profile, 
        { ...context, pendingFilters: searchFilters, pool: [], page: 0 }
      );
      return;
    }
  }

  // Run onboarding if not completed
  if (!profile.onboarding.completed) {
    const result = await handleFoodOnboarding({ senderId, incoming, send: sendMessage, profile });
    if (result.handled) return;
  }

  await processDM(senderId, incoming.text, incoming.payload, profile, context);
}

/* =====================
   CONSTRAINT GATE HANDLER
===================== */
async function handleConstraintResponse(senderId, payload, profile, context) {
  console.log(`Handling constraint response: ${payload}`);
  
  const pendingFilters = context?.pendingFilters ? { ...context.pendingFilters } : {};
  const pendingQuery = context?.pendingQuery || '';
  const pendingType = context?.pendingType;
  
  if (!pendingType) return false;
  
  // Handle restaurant gate responses with new system prompt logic
  if (pendingType === 'restaurant_gate') {
    await handleRestaurantQueryWithSystemPrompt(senderId, null, payload, profile, context);
    return true;
  }
  
  // Handle event price payloads
  if (payload.startsWith('EVENT_PRICE_') && pendingType === 'event_gate') {
    const priceMap = { 'EVENT_PRICE_free': 'free', 'EVENT_PRICE_budget': 'budget', 'EVENT_PRICE_any': 'any' };
    pendingFilters.price = priceMap[payload];
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
  }

  // Handle event category payloads
  if (payload.startsWith('EVENT_CAT_') && pendingType === 'event_gate') {
    pendingFilters.category = payload.replace('EVENT_CAT_', '');
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
  }

  // Handle event date payloads
  if (payload.startsWith('EVENT_DATE_') && pendingType === 'event_gate') {
    const type = payload.replace('EVENT_DATE_', '');
    pendingFilters.date = type === 'any' ? { type: 'any' } : { type };
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
  }
  
  // Handle event borough payloads
  if (payload.startsWith('EVENT_BOROUGH_') && pendingType === 'event_gate') {
    const borough = parseBoroughFromPayload(payload);
    if (borough !== undefined) pendingFilters.borough = borough;
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
  }

  return false;
}

async function runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context) {
  // Clear pending state before searching
  await updateContext(senderId, {
    pendingType: null,
    pendingQuery: null,
    pendingFilters: null,
    lastFilters: pendingFilters,
    lastCategory: 'EVENT'
  });
  
  // Build a fresh context for the search (without the old pendingType)
  const freshContext = {
    ...context,
    pendingType: null,
    eventFilters: pendingFilters,
    lastFilters: pendingFilters
  };
  
  const searchResult = await searchEvents(senderId, pendingQuery || 'events', freshContext);
  
  if (searchResult.needsConstraints) {
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: pendingQuery,
      pendingFilters: searchResult.filters,
      lastCategory: 'EVENT'
    });
    await sendMessage(senderId, searchResult.question, searchResult.replies);
    return true;
  }

  const formatted = formatEventResults(searchResult);
  await sendMessage(senderId, formatted.text, formatted.replies || null);
  
  const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
  if (shownIds.length > 0) {
    await addShownEvents(senderId, shownIds);
  }
  return true;
}

/* =====================
   FOOD ONBOARDING
===================== */
async function handleFoodOnboarding({ senderId, incoming, send, profile }) {
  if (profile.onboarding.completed) {
    return { handled: false, profile };
  }

  const step = profile.onboarding.step;

  // Step -1: Initial category selection (new users)
  if (step === -1 || step === undefined) {
    if (incoming.payload === 'CATEGORY_FOOD') {
      await updateProfile(senderId, { 'onboarding.step': 0, 'onboarding.category': 'food' });
      await send(senderId, FOOD_ONBOARDING.START.text, FOOD_ONBOARDING.START.replies);
      return { handled: true, profile };
    }

    if (incoming.payload === 'CATEGORY_EVENTS') {
      await updateProfile(senderId, { 'onboarding.step': 0, 'onboarding.category': 'events', 'onboarding.completed': true, 'onboarding.completedAt': new Date() });
      await send(senderId, "Awesome! What kind of events are you looking for? Try things like:\n\n• \"Free events this weekend\"\n• \"Concerts in Brooklyn\"\n• \"Comedy shows tonight\"");
      return { handled: true, profile };
    }

    // Show the initial category selection
    await send(senderId, FOOD_ONBOARDING.CATEGORY_SELECT.text, FOOD_ONBOARDING.CATEGORY_SELECT.replies);
    return { handled: true, profile };
  }

  if (step === 0) {
    if (incoming.payload === 'FOOD_ONBOARD_START') {
      await updateProfile(senderId, { 'onboarding.step': 1, 'onboarding.startedAt': new Date() });
      await send(senderId, FOOD_ONBOARDING.Q1.text, FOOD_ONBOARDING.Q1.replies);
      return { handled: true, profile };
    }

    if (incoming.payload === 'FOOD_ONBOARD_SKIP') {
      await updateProfile(senderId, { 'onboarding.completed': true, 'onboarding.completedAt': new Date() });
      await send(senderId, FOOD_ONBOARDING.DONE.text);
      return { handled: true, profile };
    }

    await send(senderId, FOOD_ONBOARDING.START.text, FOOD_ONBOARDING.START.replies);
    return { handled: true, profile };
  }

  if (step >= 1 && step <= 4) {
    if (!incoming.payload) {
      const cfg = [null, FOOD_ONBOARDING.Q1, FOOD_ONBOARDING.Q2, FOOD_ONBOARDING.Q3, FOOD_ONBOARDING.Q4][step];
      await send(senderId, cfg.text, cfg.replies);
      return { handled: true, profile };
    }

    const updates = { 'onboarding.step': step + 1 };

    if (step === 1) {
      const map = { DIET_VEGETARIAN: "Vegetarian", DIET_VEGAN: "Vegan", DIET_HALAL: "Halal", DIET_KOSHER: "Kosher", DIET_NOPORK: "No pork", DIET_GLU_FREE: "Gluten-free", DIET_NUT: "Nut allergy", DIET_NONE: null };
      updates['foodProfile.dietary'] = map[incoming.payload] ? [map[incoming.payload]] : [];
    }
    if (step === 2) {
      const map = { "BUDGET_$": "$", "BUDGET_$$": "$$", "BUDGET_$$$": "$$$", "BUDGET_ANY": null };
      updates['foodProfile.budget'] = map[incoming.payload] || null;
    }
    if (step === 3) {
      const map = { BOROUGH_MANHATTAN: "Manhattan", BOROUGH_BROOKLYN: "Brooklyn", BOROUGH_QUEENS: "Queens", BOROUGH_BRONX: "Bronx", BOROUGH_STATEN: "Staten Island", BOROUGH_ANY: null };
      updates['foodProfile.borough'] = map[incoming.payload] || null;
    }
    if (step === 4) {
      const map = { CRAVE_ASIAN: "Asian", CRAVE_ITALIAN: "Italian", CRAVE_MEXICAN: "Mexican", CRAVE_AMERICAN: "American", CRAVE_MIDEAST: "Middle Eastern", CRAVE_INDIAN: "Indian", CRAVE_CAFE: "Cafe" };
      updates['foodProfile.craving'] = map[incoming.payload] || null;
    }

    await updateProfile(senderId, updates);

    const nextQ = [null, null, FOOD_ONBOARDING.Q2, FOOD_ONBOARDING.Q3, FOOD_ONBOARDING.Q4, FOOD_ONBOARDING.Q5][step + 1];
    if (nextQ) await send(senderId, nextQ.text, nextQ.replies);

    return { handled: true, profile };
  }

  if (step === 5) {
    const t = (incoming.text || "").trim();
    const updates = { 'onboarding.completed': true, 'onboarding.completedAt': new Date() };
    updates['foodProfile.favSpots'] = (t && t.toLowerCase() !== 'skip') 
      ? t.split(",").map(s => s.trim()).filter(Boolean).slice(0, 2) 
      : [];

    await updateProfile(senderId, updates);
    await send(senderId, FOOD_ONBOARDING.DONE.text);
    return { handled: true, profile };
  }

  return { handled: false, profile };
}


/* =====================
   MAIN DM PROCESSING
   ===================== */
async function processDM(senderId, messageText, payload, profile, context) {
  console.log(`Processing: ${messageText || payload}`);

  // ========================================================
  // "MORE" HANDLING - FIRST, before any classification
  // This ensures "more" never triggers classifyQuery
  // ========================================================
  if (isMoreRequest(messageText)) {
    console.log(`[PROCESS DM] "more" detected, routing directly to restaurant handler`);
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
  }

  // Handle safety text commands first
  if (messageText) {
    const lowerText = messageText.toLowerCase().trim();
    
    if (lowerText === 'opt out') {
      const result = await handleOptOut(senderId);
      await sendMessage(senderId, result.text);
      return;
    }
    
    if (lowerText === 'stop matching') {
      const result = await handleStopMatching(senderId);
      await sendMessage(senderId, result.text);
      return;
    }
    
    if (lowerText === 'report') {
      const result = await handleReport(senderId, context);
      await sendMessage(senderId, result.text);
      return;
    }
    
    // Check for social intent in text
    if (detectSocialIntent(messageText)) {
      const socialProfile = await getSocialProfile(senderId);
      if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
        // Already opted in, show matches
        const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
        const result = formatMatchResults(matches, socialProfile?.lastEventContext);
        await sendMessage(senderId, result.text, result.replies);
        return;
      } else {
        // Start opt-in flow
        const result = await startOptIn(senderId);
        await sendMessage(senderId, result.text, result.replies);
        return;
      }
    }
  }

  // Handle MODE_* payloads (welcome screen buttons)
  if (payload === 'MODE_FOOD' || payload === 'CATEGORY_FOOD') {
    await sendMessage(senderId, "What are you craving?");
    return;
  }
  
  if (payload === 'MODE_EVENTS' || payload === 'CATEGORY_EVENTS') {
    const replies = [
      { title: 'Tonight', payload: 'EVENT_DATE_tonight' },
      { title: 'This weekend', payload: 'EVENT_DATE_weekend' },
      { title: 'Free stuff', payload: 'EVENT_PRICE_free' },
      { title: 'Live music', payload: 'EVENT_CAT_music' },
      { title: 'Comedy', payload: 'EVENT_CAT_comedy' },
      { title: 'Tech / Meetups', payload: 'EVENT_CAT_tech' },
      { title: 'Nightlife', payload: 'EVENT_CAT_nightlife' }
    ];
    await sendMessage(senderId, "What kind of vibe?", replies);
    return;
  }
  
  if (payload === 'MODE_SOCIAL') {
    const socialProfile = await getSocialProfile(senderId);
    if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
      // Already opted in, show matches
      const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
      const result = formatMatchResults(matches, socialProfile?.lastEventContext);
      await sendMessage(senderId, result.text, result.replies);
      return;
    }
    // Start opt-in flow
    const result = await startOptIn(senderId);
    await sendMessage(senderId, result.text, result.replies);
    return;
  }

  // Handle SOCIAL_* payloads
  if (payload?.startsWith('SOCIAL_')) {
    const result = await handleSocialFlow(senderId, payload, context);
    
    if (result.continueToEvents) {
      // User chose to go back to events
      const replies = [
        { title: 'Tonight', payload: 'EVENT_DATE_tonight' },
        { title: 'This weekend', payload: 'EVENT_DATE_weekend' },
        { title: 'Free stuff', payload: 'EVENT_PRICE_free' }
      ];
      await sendMessage(senderId, "What kind of events are you looking for?", replies);
      return;
    }
    
    if (result.text) {
      await sendMessage(senderId, result.text, result.replies);
    }
    return;
  }

  // Handle MATCH_* payloads
  if (payload?.startsWith('MATCH_REQUEST_')) {
    const targetId = payload.replace('MATCH_REQUEST_', '');
    const socialProfile = await getSocialProfile(senderId);
    const eventTitle = socialProfile?.lastEventContext?.eventTitle || 'an event';
    const eventId = socialProfile?.lastEventContext?.eventId;
    
    const result = await requestMatch(senderId, targetId, eventId, eventTitle);
    
    if (!result.success) {
      const errorMessages = {
        'daily_limit': "You've sent a lot of requests today. Try again tomorrow!",
        'recently_declined': "You can't send another request to this person right now.",
        'pending_exists': "You already have a pending request to this person.",
        'target_not_opted_in': "This person isn't available for matching right now.",
        'db_error': "Something went wrong. Try again?"
      };
      await sendMessage(senderId, errorMessages[result.reason] || "Something went wrong. Try again?");
      return;
    }
    
    // Send confirmation to requester
    await sendMessage(senderId, "Request sent! I'll let you know if they accept.");
    
    // Send request to target user
    if (result.targetMessage) {
      await sendMessage(targetId, result.targetMessage.text, result.targetMessage.replies);
    }
    return;
  }
  
  if (payload?.startsWith('MATCH_ACCEPT_')) {
    const requestId = payload.replace('MATCH_ACCEPT_', '');
    const result = await handleMatchResponse(senderId, requestId, true);
    
    if (!result.success) {
      const errorMessages = {
        'request_not_found': "That request doesn't exist anymore.",
        'already_responded': "You already responded to this request.",
        'expired': "That request expired. Want to find new matches?",
        'db_error': "Something went wrong. Try again?"
      };
      await sendMessage(senderId, errorMessages[result.reason] || "Something went wrong.");
      return;
    }
    
    // Send reveal messages to both users
    if (result.targetMessage) {
      await sendMessage(senderId, result.targetMessage.text);
    }
    if (result.requesterMessage && result.requesterId) {
      await sendMessage(result.requesterId, result.requesterMessage.text);
    }
    return;
  }
  
  if (payload?.startsWith('MATCH_DECLINE_')) {
    const requestId = payload.replace('MATCH_DECLINE_', '');
    const result = await handleMatchResponse(senderId, requestId, false);
    
    if (result.message) {
      await sendMessage(senderId, result.message);
    } else {
      await sendMessage(senderId, "Got it. No worries!");
    }
    return;
  }
  
  if (payload === 'MATCH_SHOW_MORE') {
    const socialProfile = await getSocialProfile(senderId);
    const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
    const result = formatMatchResults(matches.slice(3, 6), socialProfile?.lastEventContext);
    await sendMessage(senderId, result.text, result.replies);
    return;
  }

  // Handle EVENT_FIND_BUDDY (social CTA after events)
  if (payload?.startsWith('EVENT_FIND_BUDDY_')) {
    const eventId = payload.replace('EVENT_FIND_BUDDY_', '');
    // Store event context
    await updateSocialProfile(senderId, {
      lastEventContext: { eventId, eventTitle: context?.lastEventTitle || 'an event' },
      lastActiveAt: new Date()
    });
    
    const socialProfile = await getSocialProfile(senderId);
    if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
      // Already opted in, show matches
      const matches = await findCompatibleMatches(senderId, { eventId });
      const result = formatMatchResults(matches, { eventId });
      await sendMessage(senderId, result.text, result.replies);
      return;
    }
    // Start opt-in flow
    const result = await startOptIn(senderId);
    await sendMessage(senderId, result.text, result.replies);
    return;
  }
  
  if (payload === 'EVENT_SKIP_SOCIAL') {
    await sendMessage(senderId, "No problem! What else can I help you find?");
    return;
  }

  const classificationResult = await classifyQuery(senderId, messageText);
  let category = getClassificationType(classificationResult);
  let eventFilters = getEventFilters(classificationResult);
  
  // Handle follow-up by using the last known category
  if (category === 'FOLLOWUP' && context?.lastCategory) {
    category = context.lastCategory;
    eventFilters = context?.lastEventFilters || null;
  }

  if (category === 'FOOD_SEARCH' || category === 'FOOD_SPOTLIGHT' || category === 'RESTAURANT') {
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
  }

  if (category === 'FOOD_QUESTION') {
    const answer = await answerFoodQuestion(messageText, context);
    await sendMessage(senderId, answer);
    await updateContext(senderId, { lastCategory: category, pendingType: null });
    return;
  }

  if (category === 'EVENT') {
    // Pass eventFilters to searchEvents via context
    const searchContext = { ...context, eventFilters };
    const searchResult = await searchEvents(senderId, messageText, searchContext);

    if (searchResult.needsConstraints) {
      await updateContext(senderId, {
        pendingType: 'event_gate',
        pendingQuery: messageText,
        pendingFilters: searchResult.filters,
        lastCategory: category
      });
      await sendMessage(senderId, searchResult.question, searchResult.replies);
      return;
    }

    const formatted = formatEventResults(searchResult);
    await sendMessage(senderId, formatted.text);

    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) await addShownEvents(senderId, shownIds);

    await updateContext(senderId, {
      lastCategory: category,
      lastEventFilters: eventFilters,
      lastFilters: searchResult.filters,
      lastEventTitle: searchResult.results?.[0]?.title || 'an event',
      pendingType: null
    });
    
    // Add social CTA after event results
    if (searchResult.results?.length > 0) {
      const socialCTA = {
        text: "Want to go with someone?",
        replies: [
          { title: '👥 Find someone to go with', payload: `EVENT_FIND_BUDDY_${shownIds[0] || 'general'}` },
          { title: 'Skip', payload: 'EVENT_SKIP_SOCIAL' }
        ]
      };
      await sendMessage(senderId, socialCTA.text, socialCTA.replies);
    }
    return;
  }

  const quickReplies = [
    { title: '🍽️ Food', payload: 'MODE_FOOD' },
    { title: '🎉 Events', payload: 'MODE_EVENTS' },
    { title: '👥 Find people to go with', payload: 'MODE_SOCIAL' }
  ];
  await sendMessage(senderId, "NYC Scout here 🗽 What do you want help with?", quickReplies);
}

/* =====================
   TEST-FRIENDLY VERSION
===================== */
async function processDMForTest(senderId, messageText, payload = null) {
  console.log(`[TEST] ${senderId}: ${messageText || payload}`);

  // ========================================================
  // "MORE" HANDLING - FIRST, before any classification
  // This ensures "more" never triggers classifyQuery
  // ========================================================
  if (isMoreRequest(messageText)) {
    console.log(`[TEST] "more" detected, routing directly to restaurant handler`);
    const profile = await getOrCreateProfile(senderId);
    const context = await getContext(senderId);
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
  }

  if (messageText) {
    const lowerText = messageText.toLowerCase().trim();
    
    if (lowerText === 'delete my data') {
      if (await profileExists(senderId)) {
        await deleteProfile(senderId);
        return { reply: "Done — I deleted your data.", category: "SYSTEM" };
      }
      return { reply: "No data found.", category: "SYSTEM" };
    }
    
    if (lowerText === 'reset') {
      await resetOnboarding(senderId);
      return { 
        reply: "Reset complete!\n\n" + FOOD_ONBOARDING.START.text,
        buttons: FOOD_ONBOARDING.START.replies,
        category: "SYSTEM"
      };
    }
  }

  const profile = await getOrCreateProfile(senderId);
  const context = await getContext(senderId);
  const incoming = { text: messageText, payload };

  // 1. Handle pending constraint gate
  if (context?.pendingType && payload) {
    const handled = await handleConstraintResponse(senderId, payload, profile, context);
    if (handled) {
      // If it returned a result (for test mode), we might need to capture it
      // But handleConstraintResponse sends messages directly in production.
      // For test mode, we'll need to adapt it slightly or just let it work.
      // Actually, handleConstraintResponse doesn't return the reply text, it calls sendMessage.
      // In test mode, we want it to return the reply.
    }
  }

  // 1a. Handle CONVERSATIONAL restaurant preferences (BEFORE classification)
  // This catches text like "Manhattan, cheap, casual" after asking for preferences
  if (context?.pendingType === 'restaurant_preferences' && messageText && !payload) {
    console.log(`[PREFERENCES] Parsing user preferences: "${messageText}"`);
    
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const textLower = messageText.toLowerCase();
    
    // Parse location
    if (textLower.includes('manhattan')) pendingFilters.borough = 'Manhattan';
    else if (textLower.includes('brooklyn')) pendingFilters.borough = 'Brooklyn';
    else if (textLower.includes('queens')) pendingFilters.borough = 'Queens';
    else if (textLower.includes('bronx')) pendingFilters.borough = 'Bronx';
    else if (textLower.includes('staten')) pendingFilters.borough = 'Staten Island';
    else if (textLower.includes('surprise') || textLower.includes('anywhere') || textLower.includes('any')) {
      pendingFilters.borough = 'any';
    } else {
      pendingFilters.borough = 'any'; // Default to anywhere
    }
    
    // Parse budget
    if (textLower.includes('cheap') || textLower.includes('budget') || textLower.includes('under $20') || textLower.includes('under 20')) {
      pendingFilters.budget = '$';
    } else if (textLower.includes('moderate') || textLower.includes('mid') || textLower.includes('under $40') || textLower.includes('under 40')) {
      pendingFilters.budget = '$$';
    } else if (textLower.includes('fancy') || textLower.includes('upscale') || textLower.includes('expensive')) {
      pendingFilters.budget = '$$$';
    } else {
      pendingFilters.budget = 'any';
    }
    
    // Parse vibe
    if (textLower.includes('casual') || textLower.includes('chill') || textLower.includes('relaxed')) {
      pendingFilters.vibe = 'casual';
    } else if (textLower.includes('date') || textLower.includes('romantic')) {
      pendingFilters.vibe = 'date night';
    } else if (textLower.includes('trendy') || textLower.includes('hip') || textLower.includes('cool')) {
      pendingFilters.vibe = 'trendy';
    } else if (textLower.includes('hidden') || textLower.includes('gem') || textLower.includes('secret')) {
      pendingFilters.vibe = 'hidden gem';
    }
    
    // Handle "surprise me"
    if (textLower.includes('surprise')) {
      const boroughs = ['Manhattan', 'Brooklyn', 'Queens'];
      pendingFilters.borough = boroughs[Math.floor(Math.random() * boroughs.length)];
      pendingFilters.budget = 'any';
    }
    
    console.log(`[PREFERENCES] Parsed filters:`, pendingFilters);
    
    await updateContext(senderId, { 
      pendingType: null, 
      pendingQuery: null, 
      lastFilters: pendingFilters, 
      lastCategory: 'RESTAURANT' 
    });
    
    const searchResult = await searchRestaurants(
      senderId, 
      context.pendingQuery || pendingFilters.cuisine || 'restaurant', 
      pendingFilters, 
      profile?.foodProfile, 
      context, 
      true
    );
    const formatted = formatRestaurantResults(searchResult);
    
    const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
    const shownNames = searchResult.results.map(r => r.name).filter(Boolean);
    if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);
    
    await updateContext(senderId, { 
      lastIntent: searchResult.intent,
      lastResults: searchResult.results?.slice(0, 10) || [],
      pool: searchResult.pool || [],
      page: searchResult.page || 0,
      shownKeys: searchResult.shownKeys || shownKeys
    });
    
    return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
  }

  // 1b. FOLLOW-UP QUESTIONS: Detect "why" questions about restaurants BEFORE classification
  // This prevents "why did you not suggest X" from being treated as a new search
  const lastCategory = context?.lastCategory;
  const isWhyQuestion = messageText && (
    messageText.toLowerCase().startsWith('why ') ||
    messageText.toLowerCase().startsWith('how come ') ||
    messageText.toLowerCase().includes('why did') ||
    messageText.toLowerCase().includes('why not') ||
    messageText.toLowerCase().includes('why didn') ||
    messageText.toLowerCase().includes('what about ')
  );
  
  if (isWhyQuestion && (lastCategory === 'FOOD_SEARCH' || lastCategory === 'RESTAURANT')) {
    console.log(`[CONTEXT] Follow-up "why" question detected: "${messageText}"`);
    const answer = await answerFoodQuestion(messageText, context);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return { reply: answer, category: 'FOOD_QUESTION' };
  }

  // 2. EARLY CLASSIFICATION: If user types a search, bypass onboarding
  const classificationResult = await classifyQuery(senderId, messageText);
  let category = getClassificationType(classificationResult);
  let eventFilters = getEventFilters(classificationResult);
  
  if (category === 'FOOD_SEARCH' || category === 'RESTAURANT' || category === 'FOOD_SPOTLIGHT') {
    // Auto-mark category if searching directly
    if (!profile.onboarding.completed && !profile.onboarding.category) {
      await updateProfile(senderId, { 'onboarding.category': 'food' });
    }
    const result = await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
    return result || { reply: "I'm having trouble finding restaurants right now.", category: 'RESTAURANT' };
  }

  if (category === 'EVENT') {
    // Auto-mark category if searching directly
    if (!profile.onboarding.completed && !profile.onboarding.category) {
      await updateProfile(senderId, { 'onboarding.category': 'events' });
    }
    // Pass eventFilters to searchEvents
    const searchContext = { ...context, eventFilters };
    const searchResult = await searchEvents(senderId, messageText, searchContext);

    if (searchResult.needsConstraints) {
      await updateContext(senderId, {
        pendingType: 'event_gate',
        pendingQuery: messageText,
        pendingFilters: searchResult.filters,
        lastCategory: category
      });
      return { reply: searchResult.question, buttons: searchResult.replies, category };
    }

    const formatted = formatEventResults(searchResult);
    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) await addShownEvents(senderId, shownIds);

    await updateContext(senderId, {
      lastCategory: category,
      lastEventFilters: eventFilters,
      lastFilters: searchResult.filters,
      pendingType: null
    });
    return { reply: formatted.text, category, eventFilters };
  }

  if (category === 'FOOD_QUESTION') {
    const answer = await answerFoodQuestion(messageText, context);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return { reply: answer, category };
  }

  // Handle safety text commands
  if (messageText) {
    const lowerText = messageText.toLowerCase().trim();
    
    if (lowerText === 'opt out') {
      const result = await handleOptOut(senderId);
      return { reply: result.text, category: 'SOCIAL' };
    }
    
    if (lowerText === 'stop matching') {
      const result = await handleStopMatching(senderId);
      return { reply: result.text, category: 'SOCIAL' };
    }
    
    if (lowerText === 'report') {
      const result = await handleReport(senderId, context);
      return { reply: result.text, category: 'SOCIAL' };
    }
    
    // Check for social intent in text
    if (detectSocialIntent(messageText)) {
      const socialProfile = await getSocialProfile(senderId);
      if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
        const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
        const result = formatMatchResults(matches, socialProfile?.lastEventContext);
        return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
      } else {
        const result = await startOptIn(senderId);
        return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
      }
    }
  }

  // 2. SPECIAL COMMANDS / PAYLOADS
  if (payload === 'MODE_FOOD' || payload === 'CATEGORY_FOOD') {
    return { 
      reply: "What are you craving?", 
      category: "SYSTEM" 
    };
  }
  
  if (payload === 'MODE_EVENTS' || payload === 'CATEGORY_EVENTS') {
    return { 
      reply: "What kind of vibe?",
      buttons: [
        { title: 'Tonight', payload: 'EVENT_DATE_tonight' },
        { title: 'This weekend', payload: 'EVENT_DATE_weekend' },
        { title: 'Free stuff', payload: 'EVENT_PRICE_free' },
        { title: 'Live music', payload: 'EVENT_CAT_music' },
        { title: 'Comedy', payload: 'EVENT_CAT_comedy' },
        { title: 'Tech / Meetups', payload: 'EVENT_CAT_tech' },
        { title: 'Nightlife', payload: 'EVENT_CAT_nightlife' }
      ],
      category: "SYSTEM" 
    };
  }
  
  if (payload === 'MODE_SOCIAL') {
    const socialProfile = await getSocialProfile(senderId);
    if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
      const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
      const result = formatMatchResults(matches, socialProfile?.lastEventContext);
      return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
    }
    const result = await startOptIn(senderId);
    return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
  }

  // Handle SOCIAL_* payloads
  if (payload?.startsWith('SOCIAL_')) {
    const result = await handleSocialFlow(senderId, payload, context);
    
    if (result.continueToEvents) {
      return {
        reply: "What kind of events are you looking for?",
        buttons: [
          { title: 'Tonight', payload: 'EVENT_DATE_tonight' },
          { title: 'This weekend', payload: 'EVENT_DATE_weekend' },
          { title: 'Free stuff', payload: 'EVENT_PRICE_free' }
        ],
        category: 'EVENT'
      };
    }
    
    return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
  }

  // Handle MATCH_* payloads
  if (payload?.startsWith('MATCH_REQUEST_')) {
    const targetId = payload.replace('MATCH_REQUEST_', '');
    const socialProfile = await getSocialProfile(senderId);
    const eventTitle = socialProfile?.lastEventContext?.eventTitle || 'an event';
    const eventId = socialProfile?.lastEventContext?.eventId;
    
    const result = await requestMatch(senderId, targetId, eventId, eventTitle);
    
    if (!result.success) {
      const errorMessages = {
        'daily_limit': "You've sent a lot of requests today. Try again tomorrow!",
        'recently_declined': "You can't send another request to this person right now.",
        'pending_exists': "You already have a pending request to this person.",
        'target_not_opted_in': "This person isn't available for matching right now.",
        'db_error': "Something went wrong. Try again?"
      };
      return { reply: errorMessages[result.reason] || "Something went wrong. Try again?", category: 'SOCIAL' };
    }
    
    return { 
      reply: "Request sent! I'll let you know if they accept.",
      targetMessage: result.targetMessage,
      targetId,
      category: 'SOCIAL'
    };
  }
  
  if (payload?.startsWith('MATCH_ACCEPT_')) {
    const requestId = payload.replace('MATCH_ACCEPT_', '');
    const result = await handleMatchResponse(senderId, requestId, true);
    
    if (!result.success) {
      const errorMessages = {
        'request_not_found': "That request doesn't exist anymore.",
        'already_responded': "You already responded to this request.",
        'expired': "That request expired. Want to find new matches?",
        'db_error': "Something went wrong. Try again?"
      };
      return { reply: errorMessages[result.reason] || "Something went wrong.", category: 'SOCIAL' };
    }
    
    return {
      reply: result.targetMessage?.text || "You're connected!",
      requesterMessage: result.requesterMessage,
      requesterId: result.requesterId,
      category: 'SOCIAL'
    };
  }
  
  if (payload?.startsWith('MATCH_DECLINE_')) {
    const requestId = payload.replace('MATCH_DECLINE_', '');
    const result = await handleMatchResponse(senderId, requestId, false);
    return { reply: result.message || "Got it. No worries!", category: 'SOCIAL' };
  }
  
  if (payload === 'MATCH_SHOW_MORE') {
    const socialProfile = await getSocialProfile(senderId);
    const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
    const result = formatMatchResults(matches.slice(3, 6), socialProfile?.lastEventContext);
    return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
  }

  // Handle EVENT_FIND_BUDDY (social CTA after events)
  if (payload?.startsWith('EVENT_FIND_BUDDY_')) {
    const eventId = payload.replace('EVENT_FIND_BUDDY_', '');
    await updateSocialProfile(senderId, {
      lastEventContext: { eventId, eventTitle: context?.lastEventTitle || 'an event' },
      lastActiveAt: new Date()
    });
    
    const socialProfile = await getSocialProfile(senderId);
    if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
      const matches = await findCompatibleMatches(senderId, { eventId });
      const result = formatMatchResults(matches, { eventId });
      return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
    }
    const result = await startOptIn(senderId);
    return { reply: result.text, buttons: result.replies, category: 'SOCIAL' };
  }
  
  if (payload === 'EVENT_SKIP_SOCIAL') {
    return { reply: "No problem! What else can I help you find?", category: 'SYSTEM' };
  }

  // 3. CONSTRAINT GATE HANDLER (for pending queries)
  if (context?.pendingType && payload) {
    // We'll use the same logic as production, but since handleConstraintResponse 
    // uses sendMessage, we'll need to manually return the result for TEST mode.
    // For now, let's keep it simple and just re-implement the logic for the test return.
    
    // If it's a restaurant gate, the system prompt handler handles it
    if (context.pendingType === 'restaurant_gate') {
      return await handleRestaurantQueryWithSystemPrompt(senderId, null, payload, profile, context, true);
    }
    
    // For event gate
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';

    if (payload.startsWith('EVENT_PRICE_')) {
      const priceMap = { 'EVENT_PRICE_free': 'free', 'EVENT_PRICE_budget': 'budget', 'EVENT_PRICE_any': 'any' };
      pendingFilters.price = priceMap[payload];
    } else if (payload.startsWith('EVENT_CAT_')) {
      pendingFilters.category = payload.replace('EVENT_CAT_', '');
    } else if (payload.startsWith('EVENT_DATE_')) {
      const type = payload.replace('EVENT_DATE_', '');
      pendingFilters.date = type === 'any' ? { type: 'any' } : { type };
    } else if (payload.startsWith('EVENT_BOROUGH_')) {
      const borough = parseBoroughFromPayload(payload);
      if (borough !== undefined) pendingFilters.borough = borough;
    }

    if (payload.startsWith('EVENT_')) {
      await updateContext(senderId, {
        pendingType: null, pendingQuery: null, pendingFilters: null,
        lastFilters: pendingFilters, lastCategory: 'EVENT'
      });
      
      const searchResult = await searchEvents(senderId, pendingQuery || 'events', { ...context, eventFilters: pendingFilters });
      
      if (searchResult.needsConstraints) {
        await updateContext(senderId, {
          pendingType: 'event_gate', pendingQuery: pendingQuery,
          pendingFilters: searchResult.filters, lastCategory: 'EVENT'
        });
        return { reply: searchResult.question, buttons: searchResult.replies, category: 'EVENT' };
      }

      const formatted = formatEventResults(searchResult);
      const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
      if (shownIds.length > 0) await addShownEvents(senderId, shownIds);
      
      return { reply: formatted.text, category: 'EVENT' };
    }
  }

  // Handle TEXT-BASED borough responses when there's a pending restaurant gate
  if (context?.pendingType === 'restaurant_gate' && messageText && !payload) {
    const textBorough = parseBoroughFromText(messageText);
    if (textBorough !== undefined) {
      const pendingFilters = { ...(context.pendingFilters || {}) };
      pendingFilters.borough = textBorough;
      
      console.log(`Text-based borough detected: "${messageText}" -> ${textBorough || 'Anywhere'}`);
      
      await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null, lastFilters: pendingFilters, lastCategory: 'RESTAURANT' });
      
      const searchResult = await searchRestaurants(senderId, context.pendingQuery || 'restaurant', pendingFilters, profile?.foodProfile, context, true);
      const formatted = formatRestaurantResults(searchResult);
      
      const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
      const shownNames = searchResult.results.map(r => r.name).filter(Boolean);
      if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);
      await updateContext(senderId, { 
        lastIntent: searchResult.intent,
        lastResults: searchResult.results?.slice(0, 10) || [],
        pool: searchResult.pool || [],
        page: searchResult.page || 0,
        shownKeys: searchResult.shownKeys || shownKeys
      });
      
      return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
    }
  }
  
  // Handle CONVERSATIONAL preferences when user types their preferences
  if (context?.pendingType === 'restaurant_preferences' && messageText && !payload) {
    console.log(`[PREFERENCES] Parsing user preferences: "${messageText}"`);
    
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const textLower = messageText.toLowerCase();
    
    // Parse location
    if (textLower.includes('manhattan')) pendingFilters.borough = 'Manhattan';
    else if (textLower.includes('brooklyn')) pendingFilters.borough = 'Brooklyn';
    else if (textLower.includes('queens')) pendingFilters.borough = 'Queens';
    else if (textLower.includes('bronx')) pendingFilters.borough = 'Bronx';
    else if (textLower.includes('staten')) pendingFilters.borough = 'Staten Island';
    else if (textLower.includes('surprise') || textLower.includes('anywhere') || textLower.includes('any')) {
      pendingFilters.borough = 'any';
    } else {
      pendingFilters.borough = 'any'; // Default to anywhere
    }
    
    // Parse budget
    if (textLower.includes('cheap') || textLower.includes('budget') || textLower.includes('under $20') || textLower.includes('$')) {
      pendingFilters.budget = '$';
    } else if (textLower.includes('moderate') || textLower.includes('mid') || textLower.includes('under $40') || textLower.includes('$$')) {
      pendingFilters.budget = '$$';
    } else if (textLower.includes('fancy') || textLower.includes('upscale') || textLower.includes('expensive') || textLower.includes('$$$')) {
      pendingFilters.budget = '$$$';
    } else {
      pendingFilters.budget = 'any';
    }
    
    // Parse vibe
    if (textLower.includes('casual') || textLower.includes('chill') || textLower.includes('relaxed')) {
      pendingFilters.vibe = 'casual';
    } else if (textLower.includes('date') || textLower.includes('romantic')) {
      pendingFilters.vibe = 'date night';
    } else if (textLower.includes('trendy') || textLower.includes('hip') || textLower.includes('cool')) {
      pendingFilters.vibe = 'trendy';
    } else if (textLower.includes('hidden') || textLower.includes('gem') || textLower.includes('secret')) {
      pendingFilters.vibe = 'hidden gem';
    }
    
    // Handle "surprise me"
    if (textLower.includes('surprise')) {
      const boroughs = ['Manhattan', 'Brooklyn', 'Queens'];
      pendingFilters.borough = boroughs[Math.floor(Math.random() * boroughs.length)];
      pendingFilters.budget = 'any';
    }
    
    console.log(`[PREFERENCES] Parsed filters:`, pendingFilters);
    
    await updateContext(senderId, { 
      pendingType: null, 
      pendingQuery: null, 
      pendingFilters: null, 
      lastFilters: pendingFilters, 
      lastCategory: 'RESTAURANT' 
    });
    
    const searchResult = await searchRestaurants(
      senderId, 
      context.pendingQuery || pendingFilters.cuisine || 'restaurant', 
      pendingFilters, 
      profile?.foodProfile, 
      context, 
      true
    );
    const formatted = formatRestaurantResults(searchResult);
    
    const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
    const shownNames = searchResult.results.map(r => r.name).filter(Boolean);
    if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);
    
    await updateContext(senderId, { 
      lastIntent: searchResult.intent,
      lastResults: searchResult.results?.slice(0, 10) || [],
      pool: searchResult.pool || [],
      page: searchResult.page || 0,
      shownKeys: searchResult.shownKeys || shownKeys
    });
    
    return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
  }

  // Handle onboarding
  if (!profile.onboarding.completed) {
    const result = await handleFoodOnboarding({ senderId, incoming, send: async () => {}, profile });
    if (result.handled) {
      const updatedProfile = await getProfile(senderId);
      
      // If category was just selected
      if (updatedProfile?.onboarding.step === 0 && updatedProfile?.onboarding.category === 'food') {
        return { reply: FOOD_ONBOARDING.START.text, buttons: FOOD_ONBOARDING.START.replies, category: "ONBOARDING" };
      }
      
      // If events was selected, they're done with onboarding
      if (updatedProfile?.onboarding.completed && updatedProfile?.onboarding.category === 'events') {
        return { 
          reply: "Awesome! What kind of events are you looking for? Try things like:\n\n• \"Free events this weekend\"\n• \"Concerts in Brooklyn\"\n• \"Comedy shows tonight\"", 
          category: "ONBOARDING" 
        };
      }
      
      if (updatedProfile?.onboarding.completed) {
        return { reply: FOOD_ONBOARDING.DONE.text, category: "ONBOARDING" };
      }
      
      const step = updatedProfile?.onboarding.step;
      
      // Category selection step
      if (step === -1 || step === undefined) {
        return { reply: FOOD_ONBOARDING.CATEGORY_SELECT.text, buttons: FOOD_ONBOARDING.CATEGORY_SELECT.replies, category: "ONBOARDING" };
      }
      
      const questions = [FOOD_ONBOARDING.START, FOOD_ONBOARDING.Q1, FOOD_ONBOARDING.Q2, FOOD_ONBOARDING.Q3, FOOD_ONBOARDING.Q4, FOOD_ONBOARDING.Q5];
      const q = questions[step] || FOOD_ONBOARDING.START;
      return { reply: q.text, buttons: q.replies, category: "ONBOARDING" };
    }
  }

  // Normal flow - use the category from early classification
  console.log(`[TEST] Query: "${messageText}", Classified as: ${category}`);

  // FOOD_SEARCH: User wants restaurant recommendations
  if (category === 'FOOD_SEARCH' || category === 'RESTAURANT' || category === 'FOOD_SPOTLIGHT') {
    const result = await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
    return result || { reply: "I'm having trouble finding restaurants right now.", category: 'RESTAURANT' };
  }

  // EVENT: User wants to find events
  if (category === 'EVENT') {
    const searchContext = { ...context, eventFilters };
    const searchResult = await searchEvents(senderId, messageText, searchContext);

    if (searchResult.needsConstraints) {
      await updateContext(senderId, {
        pendingType: 'event_gate',
        pendingQuery: messageText,
        pendingFilters: searchResult.filters,
        lastCategory: category
      });
      return { reply: searchResult.question, buttons: searchResult.replies, category };
    }

    const formatted = formatEventResults(searchResult);
    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) await addShownEvents(senderId, shownIds);

    await updateContext(senderId, {
      lastCategory: category,
      lastEventFilters: eventFilters,
      lastFilters: searchResult.filters,
      pendingType: null
    });
    return { reply: formatted.text, category };
  }

  // FOOD_QUESTION: General food/dining question (not a search)
  if (category === 'FOOD_QUESTION') {
    const answer = await answerFoodQuestion(messageText, context);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return { reply: answer, category };
  }

  // NOT_FOOD: Politely decline
  return { 
    reply: "NYC Scout here 🗽 What do you want help with?",
    buttons: [
      { title: '🍽️ Food', payload: 'MODE_FOOD' },
      { title: '🎉 Events', payload: 'MODE_EVENTS' },
      { title: '👥 Find people to go with', payload: 'MODE_SOCIAL' }
    ],
    category: 'OTHER' 
  };
}


/* =====================
   INSTAGRAM MESSAGING
===================== */
async function sendMessage(recipientId, text, quickReplies = null) {
  // Ensure text is a string
  const textStr = typeof text === 'string' ? text : String(text || '');
  
  // Extra safety: Check if token is actually set and not the literal string "null"
  const isTokenValid = PAGE_ACCESS_TOKEN && PAGE_ACCESS_TOKEN !== 'null' && PAGE_ACCESS_TOKEN !== 'undefined';
  
  if (!isTokenValid) {
    console.log('[DEV MODE] No valid PAGE_ACCESS_TOKEN. Recipient:', recipientId, 'Text:', textStr.substring(0, 50) + '...');
    return;
  }

  if (!recipientId || recipientId === 'null' || recipientId === 'undefined') {
    console.error('Cannot send message: recipientId is missing or invalid');
    return;
  }

  const safeText = textStr.length > 1000 ? textStr.substring(0, 997) + '...' : (textStr || '(Empty message)');
  const payload = { recipient: { id: recipientId }, message: { text: safeText } };

  if (quickReplies?.length) {
    payload.message.quick_replies = quickReplies.slice(0, 13).map(q => ({
      content_type: "text",
      title: (q.title || 'Option').substring(0, 20),
      payload: q.payload || 'DEFAULT_PAYLOAD'
    })).filter(q => q.title && q.payload);
  }

  // DEBUG: Log exactly what we're sending
  console.log('📤 Sending to Instagram API:');
  console.log('   Recipient ID:', recipientId);
  console.log('   Text length:', safeText?.length || 0);
  console.log('   Quick replies:', quickReplies?.length || 0);
  console.log('   Full payload:', JSON.stringify(payload, null, 2));

  try {
    const res = await graphClient.post('https://graph.facebook.com/v18.0/me/messages', payload, { 
      params: { access_token: PAGE_ACCESS_TOKEN } 
    });
    console.log(`✅ Successfully sent message to ${recipientId}`);
  } catch (err) {
    const apiError = err.response?.data?.error;
    if (apiError) {
      console.error('❌ Instagram API Error:', apiError.message, `(Code: ${apiError.code}, Type: ${apiError.type})`);
      console.error('   Full error:', JSON.stringify(err.response?.data, null, 2));
    } else {
      console.error('❌ Send failed:', err.message);
    }
  }
}

module.exports = {
  handleDM,
  processDM,
  processDMForTest,
  sendMessage,
  getSenderId,
  getIncomingTextOrPayload
};
