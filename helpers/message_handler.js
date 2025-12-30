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
const { RESTAURANT_SYSTEM_PROMPT } = require('./restaurant_prompt');
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
  getContext
} = require('./user_profile');
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
  
  // 1. Extract intent for initial DB search
  const intent = extractIntent(messageText || payload || '');
  
  // 2. Get candidate restaurants from DB
  const filters = {
    cuisine: intent.dish_or_cuisine || context?.lastFilters?.cuisine || profile?.foodProfile?.craving,
    borough: intent.borough || context?.lastFilters?.borough || profile?.foodProfile?.borough,
    budget: intent.budget || context?.lastFilters?.budget || profile?.foodProfile?.budget
  };
  
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
      
      await updateContext(senderId, {
        lastCategory: 'FOOD_SEARCH',
        lastFilters: filters,
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
    'BOROUGH_ANY': null,
    'CONSTRAINT_BOROUGH_MANHATTAN': 'Manhattan',
    'CONSTRAINT_BOROUGH_BROOKLYN': 'Brooklyn',
    'CONSTRAINT_BOROUGH_QUEENS': 'Queens',
    'CONSTRAINT_BOROUGH_BRONX': 'Bronx',
    'CONSTRAINT_BOROUGH_STATEN': 'Staten Island',
    'CONSTRAINT_BOROUGH_ANYWHERE': null
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
    'anywhere': null, 'any': null, 'all': null
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
    'BUDGET_ANY': null
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
    return await handleRestaurantQueryWithSystemPrompt(senderId, null, payload, profile, context);
  }
  
  // Handle event price payloads
  if (payload.startsWith('EVENT_PRICE_') && pendingType === 'event_gate') {
    const priceMap = { 'EVENT_PRICE_free': 'free', 'EVENT_PRICE_budget': 'budget', 'EVENT_PRICE_any': null };
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
    pendingFilters.date = type === 'any' ? null : { type };
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

  // Handle category selection payloads
  if (payload === 'CATEGORY_FOOD') {
    await sendMessage(senderId, "I'm all about NYC food and restaurants! 🍽️ Ask me things like:\n\n• \"Best ramen in Manhattan\"\n• \"Where to eat for a birthday dinner\"\n• \"Is Peter Luger worth it?\"\n• \"What should I order at a Thai restaurant?\"\n\nWhat are you craving?");
    return;
  }
  
  if (payload === 'CATEGORY_EVENTS') {
    await sendMessage(senderId, "Awesome! I can help you find the best events in NYC. 🎉 Ask me things like:\n\n• \"Free concerts this weekend\"\n• \"Comedy shows tonight\"\n• \"Street festivals in Brooklyn\"\n• \"Things to do with kids today\"\n\nWhat kind of events are you interested in?");
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
      pendingType: null
    });
    return;
  }

  const quickReplies = [
    { title: '🍽️ Eating', payload: 'CATEGORY_FOOD' },
    { title: '🎉 Events', payload: 'CATEGORY_EVENTS' }
  ];
  await sendMessage(senderId, "Hey! 👋 I'm NYC Scout — your guide to the best spots in the city.\n\nWhat are you looking for today?", quickReplies);
}

/* =====================
   TEST-FRIENDLY VERSION
===================== */
async function processDMForTest(senderId, messageText, payload = null) {
  console.log(`[TEST] ${senderId}: ${messageText || payload}`);

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

  // 1. EARLY CLASSIFICATION: If user types a search, bypass onboarding
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

  // 2. SPECIAL COMMANDS / PAYLOADS
  if (payload === 'CATEGORY_FOOD') {
    return { 
      reply: "I'm all about NYC food and restaurants! 🍽️ Ask me things like:\n\n• \"Best ramen in Manhattan\"\n• \"Where to eat for a birthday dinner\"\n• \"Is Peter Luger worth it?\"\n• \"What should I order at a Thai restaurant?\"\n\nWhat are you craving?", 
      category: "SYSTEM" 
    };
  }
  
  if (payload === 'CATEGORY_EVENTS') {
    return { 
      reply: "Awesome! I can help you find the best events in NYC. 🎉 Ask me things like:\n\n• \"Free concerts this weekend\"\n• \"Comedy shows tonight\"\n• \"Street festivals in Brooklyn\"\n• \"Things to do with kids today\"\n\nWhat kind of events are you interested in?", 
      category: "SYSTEM" 
    };
  }

  // 3. CONSTRAINT GATE HANDLER (for pending queries)
  if (context?.pendingType && payload) {
    // If it's a restaurant gate, the system prompt handler handles it
    if (context.pendingType === 'restaurant_gate') {
      return await handleRestaurantQueryWithSystemPrompt(senderId, null, payload, profile, context, true);
    }
    
    // For event gate, we need to handle the specific event payloads
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';

    if (payload.startsWith('EVENT_PRICE_')) {
      const priceMap = { 'EVENT_PRICE_free': 'free', 'EVENT_PRICE_budget': 'budget', 'EVENT_PRICE_any': null };
      pendingFilters.price = priceMap[payload];
    } else if (payload.startsWith('EVENT_CAT_')) {
      pendingFilters.category = payload.replace('EVENT_CAT_', '');
    } else if (payload.startsWith('EVENT_DATE_')) {
      const type = payload.replace('EVENT_DATE_', '');
      pendingFilters.date = type === 'any' ? null : { type };
    }

    if (payload.startsWith('EVENT_')) {
      // Re-run search with the updated filters
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
      await updateContext(senderId, { lastIntent: searchResult.intent });
      
      return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
    }
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
    const searchResult = await searchEvents(senderId, messageText, context);

    if (searchResult.needsConstraints) {
      const formatted = formatEventResults(searchResult);
      await updateContext(senderId, {
        pendingType: 'event_gate',
        pendingQuery: messageText,
        pendingFilters: searchResult.filters,
        lastCategory: category
      });
      return { reply: formatted.text, buttons: formatted.replies, category };
    }

    const formatted = formatEventResults(searchResult);
    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) await addShownEvents(senderId, shownIds);

    await updateContext(senderId, {
      lastCategory: category,
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
    reply: "Hey! 👋 I'm NYC Scout — your guide to the best spots in the city.\n\nWhat are you looking for today?",
    buttons: [
      { title: '🍽️ Eating', payload: 'CATEGORY_FOOD' },
      { title: '🎉 Events', payload: 'CATEGORY_EVENTS' }
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
