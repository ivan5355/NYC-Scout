const { classifyQuery, getClassificationType, getEventFilters } = require('./query_router');
const { 
  getOrCreateProfile, 
  updateProfile, 
  deleteProfile, 
  getProfile,
  profileExists,
  updateContext,
  addShownRestaurants,
  addShownEvents,
  getContext
} = require('../users/user_profile');

const {
  isMoreRequest,
  getSenderId,
  getIncomingTextOrPayload,
  sendMessage,
  parseBoroughFromText
} = require('./messenger_utils');

const { 
  runEventSearchWithFilters, 
  handleEventCategoryPayload 
} = require('./event_handler');
const { 
  answerFoodQuestion, 
  handleRestaurantQueryWithSystemPrompt,
  handleConversationalPreferences
} = require('./food_handler');
const { handleSocialDM } = require('./social_handler');

/* =====================
   CONSTRAINT GATE HANDLER
===================== */
async function handleConstraintResponse(senderId, payload, profile, context) {
  console.log(`Handling constraint response: ${payload}`);
  
  const pendingFilters = context?.pendingFilters ? { ...context.pendingFilters } : {};
  const pendingQuery = context?.pendingQuery || '';
  const pendingType = context?.pendingType;
  
  if (!pendingType) return false;
  
  if (pendingType === 'restaurant_gate') {
    await handleRestaurantQueryWithSystemPrompt(senderId, null, payload, profile, context);
    return true;
  }
  
  return await handleEventCategoryPayload(senderId, payload, pendingQuery, pendingFilters, profile, context);
}

async function handleSystemCommands(senderId, text, returnResult = false) {
  if (!text) return null;
  const lowerText = text.toLowerCase().trim();
        
  if (lowerText === 'delete my data') {
    const exists = await profileExists(senderId);
    if (exists) await deleteProfile(senderId);
    const reply = exists ? "Done — I deleted your data." : "No data found.";
    if (returnResult) return { reply, category: "SYSTEM" };
    await sendMessage(senderId, reply);
    return true;
  }
  
  if (lowerText === 'reset') {
    await sendMessage(senderId, "Reset complete! How can I help you today?");
    return true;
  }
  
    return null;
}

async function handleModeSelection(senderId, payload, returnResult = false) {
  if (payload === 'MODE_FOOD' || payload === 'CATEGORY_FOOD') {
    const reply = "What are you craving?";
    if (returnResult) return { reply, category: "SYSTEM" };
    await sendMessage(senderId, reply);
    return true;
  }
  
  if (payload === 'MODE_EVENTS' || payload === 'CATEGORY_EVENTS') {
    const reply = "What kind of vibe?";
    const buttons = [
      { title: 'Tonight', payload: 'EVENT_DATE_tonight' },
      { title: 'This weekend', payload: 'EVENT_DATE_weekend' },
      { title: 'Free stuff', payload: 'EVENT_PRICE_free' },
      { title: 'Live music', payload: 'EVENT_CAT_music' },
      { title: 'Comedy', payload: 'EVENT_CAT_comedy' },
      { title: 'Tech / Meetups', payload: 'EVENT_CAT_tech' },
      { title: 'Nightlife', payload: 'EVENT_CAT_nightlife' }
    ];
    if (returnResult) return { reply, buttons, category: "SYSTEM" };
    await sendMessage(senderId, reply, buttons);
    return true;
  }
  
  return null;
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
  const systemHandled = await handleSystemCommands(senderId, incoming.text);
  if (systemHandled) return;

  const profile = await getOrCreateProfile(senderId);
  const context = await getContext(senderId);

  // Handle pending constraint gate
  if (context?.pendingType && incoming.payload) {
    const handled = await handleConstraintResponse(senderId, incoming.payload, profile, context);
    if (handled) return;
  }
  
  // Handle BOROUGH_ANY
  if (incoming.payload === 'BOROUGH_ANY') {
    const cuisine = context?.pendingFilters?.cuisine || context?.lastFilters?.cuisine;
    if (cuisine) {
      const searchFilters = { 
        cuisine: cuisine,
        borough: 'any', 
        budget: context?.pendingFilters?.budget || 'any',
        isDishQuery: false
      };
      await updateContext(senderId, { 
        pendingType: null,
        pendingFilters: searchFilters,
        pool: [],
        page: 0,
        shownKeys: [],
        shownNames: []
      });
      await handleRestaurantQueryWithSystemPrompt(
        senderId, 
        cuisine, 
        'BOROUGH_ANY', 
        profile, 
        { ...context, pendingFilters: searchFilters, pool: [], page: 0 }
      );
      return;
    }
  }

  await processDM(senderId, incoming.text, incoming.payload, profile, context);
}

/* =====================
   MAIN DM PROCESSING
   ===================== */
async function processDM(senderId, messageText, payload, profile, context) {
  console.log(`Processing: ${messageText || payload}`);

  if (isMoreRequest(messageText)) {
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
  }

  const socialResult = await handleSocialDM(senderId, messageText, payload, context);
  if (socialResult) {
    if (socialResult.reply) {
      await sendMessage(senderId, socialResult.reply, socialResult.buttons);
    }
      return;
    }
    
  // Handle mode selection
  const modeHandled = await handleModeSelection(senderId, payload);
  if (modeHandled) return;

  const classificationResult = await classifyQuery(senderId, messageText);
  let category = getClassificationType(classificationResult);
  let eventFilters = getEventFilters(classificationResult);
  
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
    return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context);
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

  if (isMoreRequest(messageText)) {
    const profile = await getOrCreateProfile(senderId);
    const context = await getContext(senderId);
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
  }

  const systemResult = await handleSystemCommands(senderId, messageText, true);
  if (systemResult) return systemResult;

  const profile = await getOrCreateProfile(senderId);
  const context = await getContext(senderId);

  if (context?.pendingType && payload) {
    if (context.pendingType === 'restaurant_gate') {
      return await handleRestaurantQueryWithSystemPrompt(senderId, null, payload, profile, context, true);
    }
    if (payload.startsWith('EVENT_')) {
    const pendingFilters = { ...(context.pendingFilters || {}) };
      const pendingQuery = context.pendingQuery || '';
      return await handleEventCategoryPayload(senderId, payload, pendingQuery, pendingFilters, profile, context, true);
    }
  }

  if (context?.pendingType === 'restaurant_preferences' && messageText && !payload) {
    return await handleConversationalPreferences(senderId, messageText, profile, context);
  }

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
    const answer = await answerFoodQuestion(messageText, context);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return { reply: answer, category: 'FOOD_QUESTION' };
  }

  const classificationResult = await classifyQuery(senderId, messageText);
  let category = getClassificationType(classificationResult);
  let eventFilters = getEventFilters(classificationResult);
  
  if (category === 'FOOD_SEARCH' || category === 'RESTAURANT' || category === 'FOOD_SPOTLIGHT') {
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
  }

  if (category === 'EVENT') {
    return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context, true);
  }

  if (category === 'FOOD_QUESTION') {
    const answer = await answerFoodQuestion(messageText, context);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return { reply: answer, category };
  }

  const socialResult = await handleSocialDM(senderId, messageText, payload, context);
  if (socialResult) return socialResult;

  const modeResult = await handleModeSelection(senderId, payload, true);
  if (modeResult) return modeResult;

  if (context?.pendingType === 'restaurant_gate' && messageText && !payload) {
    const textBorough = parseBoroughFromText(messageText);
    if (textBorough !== undefined) {
      const pendingFilters = { ...(context.pendingFilters || {}) };
      pendingFilters.borough = textBorough;
      return await handleConversationalPreferences(senderId, messageText, profile, context);
    }
  }

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

module.exports = {
  handleDM,
  processDM,
  processDMForTest,
  sendMessage,
  getSenderId,
  getIncomingTextOrPayload
};
