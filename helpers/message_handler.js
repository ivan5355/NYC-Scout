const { classifyQuery } = require('./query_router');
const { searchRestaurants, formatRestaurantResults, createDedupeKey } = require('./restaurants');
const { searchEvents, formatEventResults } = require('./events');
const { FOOD_ONBOARDING } = require('./food_onboarding');
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

const graphClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   HELPERS
===================== */
function getSenderId(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  return msg?.sender?.id ? String(msg.sender.id) : null;
}

function getIncomingTextOrPayload(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  return {
    text: msg?.message?.text?.trim() || null,
    payload: msg?.message?.quick_reply?.payload || msg?.postback?.payload || null
  };
}

function isFollowUpQuery(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const patterns = ['more', 'show me more', 'other than these', 'different ones', 'another', 'next', 'other', 'else', 'besides'];
  return patterns.some(p => t.includes(p)) && t.split(' ').length <= 6;
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
  
  // Handle borough payloads (both formats)
  if ((payload.startsWith('BOROUGH_') || payload.startsWith('CONSTRAINT_BOROUGH_')) && pendingType === 'restaurant_gate') {
    const borough = parseBoroughFromPayload(payload);
    if (borough !== undefined) {
      pendingFilters.borough = borough;
    }
    return await runRestaurantSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
  }
  
  // Handle budget payloads
  if (payload.startsWith('BUDGET_') && pendingType === 'restaurant_gate') {
    const budget = parseBudgetFromPayload(payload);
    if (budget !== undefined) {
      pendingFilters.budget = budget;
    }
    return await runRestaurantSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
  }
  
  // Handle event price payloads
  if (payload.startsWith('EVENT_') && pendingType === 'event_gate') {
    const priceMap = { 'EVENT_FREE': 'free', 'EVENT_BUDGET': 'budget', 'EVENT_ANY_PRICE': null };
    pendingFilters.priceFilter = priceMap[payload];
    
    await updateContext(senderId, {
      pendingType: null,
      pendingQuery: null,
      pendingFilters: null,
      lastFilters: pendingFilters,
      lastCategory: 'EVENT'
    });
    
    const searchResult = await searchEvents(senderId, pendingQuery || 'events', { ...context, lastFilters: pendingFilters });
    const formatted = formatEventResults(searchResult);
    await sendMessage(senderId, formatted.text, formatted.replies || null);
    
    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) {
      await addShownEvents(senderId, shownIds);
    }
    return true;
  }
  
  return false;
}

async function runRestaurantSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context) {
  await updateContext(senderId, {
    pendingType: null,
    pendingQuery: null,
    pendingFilters: null,
    lastFilters: pendingFilters,
    lastCategory: 'RESTAURANT'
  });
  
  const searchResult = await searchRestaurants(
    senderId,
    pendingQuery || 'restaurant',
    pendingFilters,
    profile?.foodProfile,
    context,
    true
  );
  
  const formatted = formatRestaurantResults(searchResult);
  await sendMessage(senderId, formatted.text, formatted.replies || null);
  
  // Track shown restaurants by dedupeKey AND name
  const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
  const shownNames = searchResult.results.map(r => r.name || r.dbData?.Name).filter(Boolean);
  if (shownKeys.length > 0) {
    await addShownRestaurants(senderId, shownKeys, shownNames);
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

  const isFollowUp = isFollowUpQuery(messageText);
  
  let category;
  if (isFollowUp && context?.lastCategory) {
    category = context.lastCategory;
  } else {
    category = await classifyQuery(senderId, messageText);
  }

  if (category === 'RESTAURANT') {
    const searchResult = await searchRestaurants(
      senderId,
      messageText,
      null,
      profile?.foodProfile,
      context
    );

    if (searchResult.needsConstraints) {
      const formatted = formatRestaurantResults(searchResult);
      
      await updateContext(senderId, {
        pendingType: 'restaurant_gate',
        pendingQuery: messageText,
        pendingFilters: searchResult.pendingFilters || searchResult.filters,
        lastCategory: category
      });
      
      await sendMessage(senderId, formatted.text, formatted.replies);
      return;
    }

    const formatted = formatRestaurantResults(searchResult);
    await sendMessage(senderId, formatted.text, formatted.replies || null);

    const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
    const shownNames = searchResult.results.map(r => r.name || r.dbData?.Name).filter(Boolean);
    if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);

    await updateContext(senderId, {
      lastCategory: category,
      lastFilters: searchResult.filters,
      pendingType: null,
      pendingQuery: null,
      pendingFilters: null
    });
    return;
  }

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
      await sendMessage(senderId, formatted.text, formatted.replies);
      return;
    }

    const formatted = formatEventResults(searchResult);
    await sendMessage(senderId, formatted.text);

    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) await addShownEvents(senderId, shownIds);

    await updateContext(senderId, {
      lastCategory: category,
      lastFilters: searchResult.filters,
      pendingType: null
    });
    return;
  }

  await sendMessage(senderId, "I'm food-only right now—tell me what you're craving!");
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

  // Handle pending constraint gate
  if (context?.pendingType && payload) {
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';
    
    // Borough constraint (both formats)
    if ((payload.startsWith('BOROUGH_') || payload.startsWith('CONSTRAINT_BOROUGH_')) && context.pendingType === 'restaurant_gate') {
      const borough = parseBoroughFromPayload(payload);
      if (borough !== undefined) pendingFilters.borough = borough;
      
      await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null, lastFilters: pendingFilters, lastCategory: 'RESTAURANT' });
      
      const searchResult = await searchRestaurants(senderId, pendingQuery || 'restaurant', pendingFilters, profile?.foodProfile, context, true);
      const formatted = formatRestaurantResults(searchResult);
      
      const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
      const shownNames = searchResult.results.map(r => r.name || r.dbData?.Name).filter(Boolean);
      if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);
      
      return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
    }
    
    // Budget constraint
    if (payload.startsWith('BUDGET_') && context.pendingType === 'restaurant_gate') {
      const budget = parseBudgetFromPayload(payload);
      if (budget !== undefined) pendingFilters.budget = budget;
      
      await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null, lastFilters: pendingFilters, lastCategory: 'RESTAURANT' });
      
      const searchResult = await searchRestaurants(senderId, pendingQuery || 'restaurant', pendingFilters, profile?.foodProfile, context, true);
      const formatted = formatRestaurantResults(searchResult);
      
      const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
      const shownNames = searchResult.results.map(r => r.name || r.dbData?.Name).filter(Boolean);
      if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);
      
      return { reply: formatted.text, buttons: formatted.replies, category: 'RESTAURANT' };
    }
    
    // Event price constraint
    if (payload.startsWith('EVENT_') && context.pendingType === 'event_gate') {
      const priceMap = { 'EVENT_FREE': 'free', 'EVENT_BUDGET': 'budget', 'EVENT_ANY_PRICE': null };
      pendingFilters.priceFilter = priceMap[payload];
      
      await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null, lastFilters: pendingFilters, lastCategory: 'EVENT' });
      
      const searchResult = await searchEvents(senderId, pendingQuery || 'events', { ...context, lastFilters: pendingFilters });
      const formatted = formatEventResults(searchResult);
      
      const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
      if (shownIds.length > 0) await addShownEvents(senderId, shownIds);
      
      return { reply: formatted.text, buttons: formatted.replies, category: 'EVENT' };
    }
  }

  // Handle onboarding
  if (!profile.onboarding.completed) {
    const result = await handleFoodOnboarding({ senderId, incoming, send: async () => {}, profile });
    if (result.handled) {
      const updatedProfile = await getProfile(senderId);
      if (updatedProfile?.onboarding.completed) {
        return { reply: FOOD_ONBOARDING.DONE.text, category: "ONBOARDING" };
      }
      const step = updatedProfile?.onboarding.step || 0;
      const questions = [FOOD_ONBOARDING.START, FOOD_ONBOARDING.Q1, FOOD_ONBOARDING.Q2, FOOD_ONBOARDING.Q3, FOOD_ONBOARDING.Q4, FOOD_ONBOARDING.Q5];
      const q = questions[step] || FOOD_ONBOARDING.START;
      return { reply: q.text, buttons: q.replies, category: "ONBOARDING" };
    }
  }

  // Normal flow
  const isFollowUp = isFollowUpQuery(messageText);
  let category = (isFollowUp && context?.lastCategory) ? context.lastCategory : await classifyQuery(senderId, messageText);

  if (category === 'RESTAURANT') {
    const searchResult = await searchRestaurants(senderId, messageText, null, profile?.foodProfile, context);

    if (searchResult.needsConstraints) {
      await updateContext(senderId, { pendingType: 'restaurant_gate', pendingQuery: messageText, pendingFilters: searchResult.pendingFilters || searchResult.filters, lastCategory: category });
      const formatted = formatRestaurantResults(searchResult);
      return { reply: formatted.text, buttons: formatted.replies, category };
    }

    const formatted = formatRestaurantResults(searchResult);
    const shownKeys = searchResult.results.map(r => r.dedupeKey).filter(Boolean);
    const shownNames = searchResult.results.map(r => r.name || r.dbData?.Name).filter(Boolean);
    if (shownKeys.length > 0) await addShownRestaurants(senderId, shownKeys, shownNames);
    await updateContext(senderId, { lastCategory: category, lastFilters: searchResult.filters, pendingType: null });
    
    return { reply: formatted.text, category };
  }

  if (category === 'EVENT') {
    const searchResult = await searchEvents(senderId, messageText, context);

    if (searchResult.needsConstraints) {
      await updateContext(senderId, { pendingType: 'event_gate', pendingQuery: messageText, pendingFilters: searchResult.filters, lastCategory: category });
      const formatted = formatEventResults(searchResult);
      return { reply: formatted.text, buttons: formatted.replies, category };
    }

    const formatted = formatEventResults(searchResult);
    const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
    if (shownIds.length > 0) await addShownEvents(senderId, shownIds);
    await updateContext(senderId, { lastCategory: category, lastFilters: searchResult.filters, pendingType: null });
    
    return { reply: formatted.text, category };
  }

  return { reply: "I'm food-only right now—tell me what you're craving!", category };
}


/* =====================
   INSTAGRAM MESSAGING
===================== */
async function sendMessage(recipientId, text, quickReplies = null) {
  if (!PAGE_ACCESS_TOKEN) {
    console.log('[DEV]', recipientId, ':', text?.substring(0, 80));
    return;
  }

  const safeText = text.length > 1000 ? text.substring(0, 997) + '...' : text;
  const payload = { recipient: { id: recipientId }, message: { text: safeText } };

  if (quickReplies?.length) {
    payload.message.quick_replies = quickReplies.slice(0, 13).map(q => ({
      content_type: "text",
      title: q.title.substring(0, 20),
      payload: q.payload
    }));
  }

  try {
    await graphClient.post('https://graph.facebook.com/v18.0/me/messages', payload, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) {
    console.error('Send failed:', err.response?.data || err.message);
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
