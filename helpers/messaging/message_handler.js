const {
  classifyQuery,
  getClassificationType,
  getEventFilters,
  classifyIntentAndFilters,
  isReadyToSearch,
  parseEventFiltersWithGemini
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
   MESSAGE DEDUPLICATION
   Instagram can send the same webhook multiple times
===================== */
const processedMessages = new Map();
const MESSAGE_DEDUP_TTL = 60000; // 60 seconds

function getMessageId(body) {
  const messaging = body?.entry?.[0]?.messaging?.[0];
  return messaging?.message?.mid || messaging?.postback?.mid || null;
}

function isDuplicateMessage(messageId) {
  if (!messageId) return false;

  // Clean up old entries
  const now = Date.now();
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(id);
    }
  }

  if (processedMessages.has(messageId)) {
    console.log(`[DEDUP] Skipping duplicate message: ${messageId}`);
    return true;
  }

  processedMessages.set(messageId, now);
  return false;
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
    if (returnResult) return { reply, category: "SYSTEM" };
    await sendMessage(senderId, reply);
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

  // Deduplicate webhook calls - Instagram can send the same message multiple times
  const messageId = getMessageId(body);
  if (isDuplicateMessage(messageId)) return;

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
  console.log(`[DM] Processing Instagram DM: "${messageText || payload}"`);


  if (isMoreRequest(messageText)) {
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context);
  }

  const socialResult = await handleSocialDM(senderId, messageText, payload, context);
  if (socialResult) {
    if (socialResult.reply) {
      await sendMessage(senderId, socialResult.reply);
    }
    return;
  }

  // Handle mode selection
  const modeHandled = await handleModeSelection(senderId, payload);
  if (modeHandled) return;

  // Handle restaurant_preferences pending type (user responding with filters like "Brooklyn, cheap")
  if (context?.pendingType === 'restaurant_preferences' && messageText && !payload) {
    const result = await handleConversationalPreferences(senderId, messageText, profile, context);
    if (result?.reply) {
      await sendMessage(senderId, result.reply);
    }
    return;
  }

  // Handle event_gate text responses (user responding with filters like "Brooklyn this weekend")
  if (context?.pendingType === 'event_gate' && messageText && !payload) {
    console.log(`[EVENT_GATE] Parsing text preferences with Gemini: "${messageText}"`);
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';

    // Use Gemini to parse the filters
    const parsedFilters = await parseEventFiltersWithGemini(messageText);

    // Merge parsed filters with pending filters (pending has searchTerm/category)
    if (parsedFilters.date) pendingFilters.date = parsedFilters.date;
    if (parsedFilters.borough) pendingFilters.borough = parsedFilters.borough;
    if (parsedFilters.price) pendingFilters.price = parsedFilters.price;

    // If we parsed at least one new filter, run the search
    if (parsedFilters.date || parsedFilters.borough || parsedFilters.price) {
      console.log(`[EVENT_GATE] Merged filters:`, JSON.stringify(pendingFilters));
      return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
    }

    // No filters parsed - treat as a new query, clear pending state
    await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null });
  }

  // =====================
  // NEW INTENT CLASSIFICATION FLOW
  // Step 1: Classify EVENT vs RESTAURANT
  // Step 2: Detect existing filters
  // Step 3: Ask for missing filters OR run search
  // =====================
  console.log(`[DM INTENT] Starting intent classification for: "${messageText}"`);
  const intentResult = await classifyIntentAndFilters(senderId, messageText);
  console.log(`[DM INTENT FLOW] Type: ${intentResult.type}, Ready: ${isReadyToSearch(intentResult)}, Filters:`, JSON.stringify(intentResult.detectedFilters));

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

    // Check if we have the key filters (date and borough)
    const hasDate = !!detectedFilters.date;
    const hasBorough = !!detectedFilters.borough;
    const hasCriticalFilters = hasDate || hasBorough;

    // Only search immediately if we have a SPECIFIC term AND at least one critical filter (date or borough)
    // OR if user provided all filters
    if (hasSearchableTerm && hasCriticalFilters) {
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

    // Need to ask for filters - save what we detected and ask for more
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: messageText,
      pendingFilters: detectedFilters,
      lastCategory: 'EVENT'
    });

    if (filterPrompt) {
      await sendMessage(senderId, filterPrompt.text);
    } else {
      // Fallback: default event filter prompt
      const defaultPrompt = `🎪 NYC has hundreds of events!

Tell me what you're looking for in one message:

📍 Location (Manhattan, Brooklyn, Queens...)
📅 Date (tonight, this weekend, next week...)
💰 Price (free, budget, any)
✨ Type (music, comedy, art, nightlife, sports...)

Example: "comedy in Brooklyn this weekend" or "free concerts tonight"`;
      await sendMessage(senderId, defaultPrompt);
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

      await sendMessage(senderId, filterPrompt.text);
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
    console.log(`[EVENT_GATE] Parsing text preferences with Gemini: "${messageText}"`);
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';

    // Use Gemini to parse the filters
    const parsedFilters = await parseEventFiltersWithGemini(messageText);

    // Merge parsed filters with pending filters (pending has searchTerm/category)
    if (parsedFilters.date) pendingFilters.date = parsedFilters.date;
    if (parsedFilters.borough) pendingFilters.borough = parsedFilters.borough;
    if (parsedFilters.price) pendingFilters.price = parsedFilters.price;

    // If we parsed at least one filter, run the search
    if (parsedFilters.date || parsedFilters.borough || parsedFilters.price) {
      console.log(`[EVENT_GATE] Merged filters:`, JSON.stringify(pendingFilters));
      return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, true);
    }

    // No filters parsed - treat as a new query, clear pending state
    await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null });
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
    const hasSpecificCategory = categoryName && !['general', 'other', 'any', 'special'].includes(categoryName);
    const hasSearchableTerm = hasSpecificTerm || hasSpecificCategory;

    // Check if we have the key filters (date and borough)
    const hasDate = !!detectedFilters.date;
    const hasBorough = !!detectedFilters.borough;
    const hasCriticalFilters = hasDate || hasBorough;

    // Only search immediately if we have a SPECIFIC term AND at least one critical filter
    if (hasSearchableTerm && hasCriticalFilters) {
      const eventFilters = {
        date: detectedFilters.date ? { type: detectedFilters.date } : null,
        borough: detectedFilters.borough || null,
        price: detectedFilters.price || null,
        category: detectedFilters.category || null,
        searchTerm: detectedFilters.searchTerm || null
      };
      return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context, true);
    }

    // Need to ask for filters - save what we detected
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: messageText,
      pendingFilters: detectedFilters,
      lastCategory: 'EVENT'
    });

    if (filterPrompt) {
      return { reply: filterPrompt.text, category: 'EVENT' };
    } else {
      const defaultPrompt = `🎪 NYC has hundreds of events!

Tell me what you're looking for in one message:

📍 Location (Manhattan, Brooklyn, Queens...)
📅 Date (tonight, this weekend, next week...)
💰 Price (free, budget, any)
✨ Type (music, comedy, art, nightlife, sports...)

Example: "comedy in Brooklyn this weekend" or "free concerts tonight"`;
      return { reply: defaultPrompt, buttons: null, category: 'EVENT' };
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
      return { reply: filterPrompt.text, category: 'RESTAURANT' };
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
