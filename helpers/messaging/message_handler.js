const {
  classifyQuery,
  getClassificationType,
  getEventFilters,
  classifyIntentAndFilters,
  isReadyToSearch
} = require('./query_router');
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
   MAIN DM PROCESSING (with Intent Classification Flow)
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

  // =====================
  // NEW INTENT CLASSIFICATION FLOW
  // Step 1: Classify EVENT vs RESTAURANT
  // Step 2: Detect existing filters
  // Step 3: Ask for missing filters OR run search
  // =====================

  const intentResult = await classifyIntentAndFilters(senderId, messageText);
  console.log(`[INTENT FLOW] Type: ${intentResult.type}, Ready: ${isReadyToSearch(intentResult)}`);

  // Handle follow-up mode
  if (intentResult.type === 'FOLLOWUP' && context?.lastCategory) {
    if (context.lastCategory === 'EVENT' || context.lastCategory === 'FOOD_SEARCH' || context.lastCategory === 'RESTAURANT') {
      // Continue with previous category
      if (context.lastCategory === 'EVENT') {
        return await runEventSearchWithFilters(senderId, messageText, context?.lastEventFilters || {}, profile, context);
      } else {
        return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
      }
    }
  }

  // =====================
  // EVENT FLOW
  // =====================
  if (intentResult.type === 'EVENT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;

    // Generic terms that should NOT be considered valid search terms
    const genericEventTerms = ['events', 'event', 'things to do', 'activities', 'happenings', 'stuff', 'something', 'anything', 'what to do', 'whats happening', "what's happening"];

    // Check if we have a SPECIFIC (non-generic) search term or category
    const searchTerm = detectedFilters.searchTerm?.toLowerCase() || '';
    const categoryName = detectedFilters.category?.toLowerCase() || '';

    const hasSpecificTerm = searchTerm && !genericEventTerms.includes(searchTerm);
    const hasSpecificCategory = categoryName && !['general', 'other', 'any', 'special'].includes(categoryName);

    const hasSearchableTerm = hasSpecificTerm || hasSpecificCategory;

    // Only search immediately if we have a SPECIFIC term/category
    if (hasSearchableTerm) {
      // Ready to search - convert detected filters to event filters format
      const eventFilters = {
        date: detectedFilters.date ? { type: detectedFilters.date } : null,
        borough: detectedFilters.borough || null,
        price: detectedFilters.price || null,
        category: detectedFilters.category || null,
        searchTerm: detectedFilters.searchTerm || null
      };

      return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context);
    }

    // Need to ask for filters - use filterPrompt if available, otherwise generate default prompt
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: messageText,
      pendingFilters: detectedFilters,
      lastCategory: 'EVENT'
    });

    if (filterPrompt) {
      await sendMessage(senderId, filterPrompt.text, filterPrompt.buttons);
    } else {
      // Fallback: default event filter prompt
      const defaultPrompt = `🎪 NYC has hundreds of events!

Tell me what you're looking for:

📍 Location (Manhattan, Brooklyn, Queens...)
📅 Date (tonight, this weekend, next week...)
💰 Price (free, budget)
✨ Type (music, comedy, art, nightlife, special...)

Example: "Brooklyn, tonight, free comedy"`;
      const defaultButtons = [
        { title: '🌙 Tonight', payload: 'EVENT_DATE_today' },
        { title: '📅 This weekend', payload: 'EVENT_DATE_weekend' },
        { title: '🆓 Free stuff', payload: 'EVENT_PRICE_free' },
        { title: '🎵 Live music', payload: 'EVENT_CAT_music' },
        { title: '😂 Comedy', payload: 'EVENT_CAT_comedy' },
        { title: '🍻 Nightlife', payload: 'EVENT_CAT_nightlife' },
        { title: '🎲 Surprise me', payload: 'EVENT_DATE_any' }
      ];
      await sendMessage(senderId, defaultPrompt, defaultButtons);
    }
    return;
  }

  // =====================
  // RESTAURANT FLOW
  // =====================
  if (intentResult.type === 'RESTAURANT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;

    // Check if we have enough info to search
    const hasCuisineOrDish = detectedFilters.cuisine || detectedFilters.dish;

    if (hasCuisineOrDish) {
      // We have cuisine/dish - pass to restaurant handler which will ask for remaining filters
      return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
    }

    // Need to ask for cuisine/dish first
    if (filterPrompt) {
      await updateContext(senderId, {
        pendingType: 'restaurant_gate',
        pendingQuery: messageText,
        pendingFilters: detectedFilters,
        lastCategory: 'FOOD_SEARCH'
      });

      await sendMessage(senderId, filterPrompt.text, filterPrompt.buttons);
      return;
    }

    // Fallback to existing handler
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
  }

  // =====================
  // FALLBACK TO ORIGINAL CLASSIFICATION (for edge cases)
  // =====================
  const classificationResult = await classifyQuery(senderId, messageText);
  let category = getClassificationType(classificationResult);
  let eventFilters = getEventFilters(classificationResult);

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

  // Social appreciation / Emojis
  const isAppreciation = messageText && /^(thanks|thank you|thx|ty|awesome|cool|great|dope|nice|🔥|🙌|👏|👍|👌|❤️|✨)$/i.test(messageText.trim());
  if (isAppreciation) {
    await sendMessage(senderId, "You got it! 🗽 Let me know if you need help finding anything else.");
    return;
  }

  // Handle Get Started or generic greetings
  const isGreeting = (payload === 'GET_STARTED') || (messageText && /^(hi|hello|hey|yo|greetings|get started)$/i.test(messageText.trim()));

  if (isGreeting) {
    const welcome = "Welcome to NYC Scout! 🗽 I'm your local guide to the best food, events, and people in the city. What are we looking for today?";
    await sendMessage(senderId, welcome);
    return;
  }

  await sendMessage(senderId, "Welcome to NYC Scout! 🗽 I'm your local guide to the best food, events, and people in the city. What are we looking for today?");
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

  // Handle event_gate text responses (user types instead of clicking buttons)
  if (context?.pendingType === 'event_gate' && messageText && !payload) {
    console.log(`[EVENT_GATE] Parsing text preferences: "${messageText}"`);
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';
    const textLower = messageText.toLowerCase();

    // Parse date from text
    if (textLower.includes('today') || textLower.includes('tonight')) {
      pendingFilters.date = { type: 'today' };
    } else if (textLower.includes('tomorrow')) {
      pendingFilters.date = { type: 'tomorrow' };
    } else if (textLower.includes('weekend')) {
      pendingFilters.date = { type: 'weekend' };
    } else if (textLower.includes('next week')) {
      pendingFilters.date = { type: 'next_week' };
    } else if (textLower.includes('this week')) {
      pendingFilters.date = { type: 'this_week' };
    } else if (textLower.includes('anytime') || textLower.includes('any time') || textLower.includes('whenever')) {
      pendingFilters.date = { type: 'any' };
    }

    // Parse borough from text (handle common typos)
    if (textLower.includes('manhattan') || textLower.includes('manhatten')) {
      pendingFilters.borough = 'Manhattan';
    } else if (textLower.includes('brooklyn')) {
      pendingFilters.borough = 'Brooklyn';
    } else if (textLower.includes('queens')) {
      pendingFilters.borough = 'Queens';
    } else if (textLower.includes('bronx')) {
      pendingFilters.borough = 'Bronx';
    } else if (textLower.includes('staten')) {
      pendingFilters.borough = 'Staten Island';
    } else if (textLower.includes('anywhere') || textLower.includes('any area') || textLower.includes('surprise')) {
      pendingFilters.borough = 'any';
    }

    // Parse price from text
    if (textLower.includes('free')) {
      pendingFilters.price = 'free';
    } else if (textLower.includes('cheap') || textLower.includes('budget')) {
      pendingFilters.price = 'budget';
    } else if (textLower.includes('any price') || textLower.includes('any budget')) {
      pendingFilters.price = 'any';
    }

    // If we parsed at least one filter, run the search
    if (pendingFilters.date || pendingFilters.borough || pendingFilters.price) {
      console.log(`[EVENT_GATE] Parsed filters:`, JSON.stringify(pendingFilters));
      return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, true);
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

  // =====================
  // NEW INTENT CLASSIFICATION FLOW IN TEST MODE
  // =====================
  const intentResult = await classifyIntentAndFilters(senderId, messageText);
  console.log(`[TEST INTENT FLOW] Type: ${intentResult.type}, Ready: ${isReadyToSearch(intentResult)}`);

  // Handle follow-up mode
  if (intentResult.type === 'FOLLOWUP' && context?.lastCategory) {
    if (context.lastCategory === 'EVENT' || context.lastCategory === 'FOOD_SEARCH' || context.lastCategory === 'RESTAURANT') {
      if (context.lastCategory === 'EVENT') {
        return await runEventSearchWithFilters(senderId, messageText, context?.lastEventFilters || {}, profile, context, true);
      } else {
        return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
      }
    }
  }

  // EVENT FLOW
  if (intentResult.type === 'EVENT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;
    const genericEventTerms = ['events', 'event', 'things to do', 'activities', 'happenings', 'stuff', 'something', 'anything', 'what to do', 'whats happening', "what's happening"];
    const searchTerm = detectedFilters.searchTerm?.toLowerCase() || '';
    const categoryName = detectedFilters.category?.toLowerCase() || '';
    const hasSpecificTerm = searchTerm && !genericEventTerms.includes(searchTerm);
    const hasSpecificCategory = categoryName && !['general', 'other', 'any'].includes(categoryName);
    const hasSearchableTerm = hasSpecificTerm || hasSpecificCategory;

    if (hasSearchableTerm) {
      const eventFilters = {
        date: detectedFilters.date ? { type: detectedFilters.date } : null,
        borough: detectedFilters.borough || null,
        price: detectedFilters.price || null,
        category: detectedFilters.category || null,
        searchTerm: detectedFilters.searchTerm || null
      };
      return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context, true);
    }

    // Need to ask for filters
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: messageText,
      pendingFilters: detectedFilters,
      lastCategory: 'EVENT'
    });

    if (filterPrompt) {
      return { reply: filterPrompt.text, buttons: filterPrompt.buttons, category: 'EVENT' };
    } else {
      const defaultPrompt = `🎪 NYC has hundreds of events!

Tell me what you're looking for:

📍 Location (Manhattan, Brooklyn, Queens...)
📅 Date (tonight, this weekend, next week...)
💰 Price (free, budget)
✨ Type (music, comedy, art, nightlife, special...)

Example: "Brooklyn, tonight, free comedy"`;
      const defaultButtons = [
        { title: '🌙 Tonight', payload: 'EVENT_DATE_today' },
        { title: '📅 This weekend', payload: 'EVENT_DATE_weekend' },
        { title: '🆓 Free stuff', payload: 'EVENT_PRICE_free' },
        { title: '🎵 Live music', payload: 'EVENT_CAT_music' },
        { title: '😂 Comedy', payload: 'EVENT_CAT_comedy' },
        { title: '🍻 Nightlife', payload: 'EVENT_CAT_nightlife' },
        { title: '🎲 Surprise me', payload: 'EVENT_DATE_any' }
      ];
      return { reply: defaultPrompt, buttons: defaultButtons, category: 'EVENT' };
    }
  }

  // RESTAURANT FLOW
  if (intentResult.type === 'RESTAURANT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;
    const hasCuisineOrDish = detectedFilters.cuisine || detectedFilters.dish;

    if (hasCuisineOrDish) {
      return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
    }

    if (filterPrompt) {
      await updateContext(senderId, {
        pendingType: 'restaurant_gate',
        pendingQuery: messageText,
        pendingFilters: detectedFilters,
        lastCategory: 'FOOD_SEARCH'
      });
      return { reply: filterPrompt.text, buttons: filterPrompt.buttons, category: 'RESTAURANT' };
    }
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, true);
  }

  // FALLBACK TO OLD CLASSIFICATION
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
    reply: "Welcome to NYC Scout! 🗽 I'm your local guide to the best food, events, and people in the city. What are we looking for today?",
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
