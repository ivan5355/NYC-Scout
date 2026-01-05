const {
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
  getSenderId,
  getIncomingTextOrPayload,
  sendMessage
} = require('./messenger_utils');

const {
  runEventSearchWithFilters
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
  if (!incoming.text) return;

  // Handle special commands BEFORE creating profile
  const systemHandled = await handleSystemCommands(senderId, incoming.text);
  if (systemHandled) return;

  const profile = await getOrCreateProfile(senderId);
  const context = await getContext(senderId);


  await processDM(senderId, incoming.text, profile, context);
}

/* =====================
   MAIN DM PROCESSING (with Intent Classification Flow)
   ===================== */
async function processDM(senderId, messageText, profile, context) {
  console.log(`[DM] Processing Instagram DM: "${messageText}"`);



  const socialResult = await handleSocialDM(senderId, messageText, null, context);
  if (socialResult) {
    if (socialResult.reply) {
      await sendMessage(senderId, socialResult.reply);
    }
    return;
  }

  // Handle restaurant_preferences pending type (user responding with filters like "Brooklyn, cheap")
  if (context?.pendingType === 'restaurant_preferences' && messageText) {
    const result = await handleConversationalPreferences(senderId, messageText, profile, context);
    if (result?.reply) {
      await sendMessage(senderId, result.reply);
    }
    return;
  }

  // Handle event_gate text responses (user responding with filters like "Brooklyn this weekend")
  if (context?.pendingType === 'event_gate' && messageText) {
    console.log(`[EVENT_GATE] Parsing text preferences with Gemini: "${messageText}"`);
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';
    const textLower = messageText.toLowerCase().trim();

    // Check if user just wants to search with current filters
    if (textLower === 'search' || textLower.includes('just search') || textLower.includes('show me')) {
      console.log(`[EVENT_GATE] User triggered search with current filters:`, JSON.stringify(pendingFilters));
      return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context);
    }

    // Use Gemini to parse the filters
    const parsedFilters = await parseEventFiltersWithGemini(messageText);

    // Merge parsed filters with pending filters (pending has searchTerm/category)
    if (parsedFilters.date) pendingFilters.date = parsedFilters.date;
    if (parsedFilters.borough) pendingFilters.borough = parsedFilters.borough;
    if (parsedFilters.price) pendingFilters.price = parsedFilters.price;

    // If we parsed at least one new filter OR user is providing any response, run the search
    if (parsedFilters.date || parsedFilters.borough || parsedFilters.price || messageText.length > 0) {
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
        return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context);
      }
    }
  }

  // =====================
  // EVENT FLOW (works like restaurant flow - always ask for missing filters)
  // =====================
  if (intentResult.type === 'EVENT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;

    // Check if we have the key filters (date and borough) - ALWAYS require these
    const hasDate = !!detectedFilters.date;
    const hasBorough = !!detectedFilters.borough;

    // Get search term or category if provided
    const searchTerm = detectedFilters.searchTerm || detectedFilters.category || null;

    // If we have BOTH date AND borough, we're ready to search
    if (hasDate && hasBorough) {
      const eventFilters = {
        date: detectedFilters.date ? { type: detectedFilters.date } : null,
        borough: detectedFilters.borough || null,
        price: detectedFilters.price || null,
        category: detectedFilters.category || null,
        searchTerm: detectedFilters.searchTerm || null
      };

      return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context);
    }

    // Save what we detected and ask for missing filters
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: messageText,
      pendingFilters: detectedFilters,
      lastCategory: 'EVENT'
    });

    // If we have a pre-generated prompt from the router, use it
    if (filterPrompt) {
      await sendMessage(senderId, filterPrompt.text);
      return;
    }

    // Fallback manual prompts (using Where, When, What category terminology)
    let promptText;
    if (searchTerm && !hasDate && !hasBorough) {
      promptText = `🎪 ${searchTerm}! NYC has a lot going on.

Tell me (all optional):
📍 Where: Manhattan, Brooklyn, Queens, or "all NYC"
📅 When: tonight, this weekend, next week...

🎲 Or just say "search" to see what's out there!

Example: "Brooklyn this weekend" or just "search"`;
    } else if (searchTerm && hasDate && !hasBorough) {
      promptText = `🎪 ${searchTerm} ${detectedFilters.date}! 

📍 Where (optional): Manhattan, Brooklyn, Queens, Bronx, Staten Island, or "all NYC"

🎲 Or just say "search" to see everything!`;
    } else if (searchTerm && !hasDate && hasBorough) {
      promptText = `🎪 ${searchTerm} in ${detectedFilters.borough}!

📅 When (optional): tonight, tomorrow, this weekend, next week...

🎲 Or just say "search" to see everything!`;
    } else if (!searchTerm && hasDate && !hasBorough) {
      promptText = `🎪 Events ${detectedFilters.date}!

Tell me (all optional):
📍 Where: Manhattan, Brooklyn, Queens, or "all NYC"
✨ Category: music, comedy, art, sports...

🎲 Or just say "search" to see everything!`;
    } else if (!searchTerm && !hasDate && hasBorough) {
      promptText = `🎪 Events in ${detectedFilters.borough}!

Tell me (all optional):
📅 When: tonight, this weekend, next week...
✨ Category: music, comedy, art, sports...

🎲 Or just say "search" to see everything!`;
    } else {
      promptText = `🎪 NYC has hundreds of events!

Tell me what you're looking for (all optional):

📍 Where: Manhattan, Brooklyn, Queens, or "all NYC"
📅 When: tonight, this weekend, next week...
✨ Category: music, comedy, art, nightlife, sports...

🎲 Or just say "search" to see what's happening!

Example: "Brooklyn this weekend" or just "search"`;
    }

    await sendMessage(senderId, promptText);
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
      return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context);
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
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context);
  }

  // =====================
  // FOOD QUESTION FLOW
  // =====================
  if (intentResult.type === 'FOOD_QUESTION') {
    const answer = await answerFoodQuestion(messageText, context);
    await sendMessage(senderId, answer);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return;
  }

  // Social appreciation / Emojis
  const isAppreciation = messageText && /^(thanks|thank you|thx|ty|awesome|cool|great|dope|nice|🔥|🙌|👏|👍|👌|❤️|✨)$/i.test(messageText.trim());
  if (isAppreciation) {
    await sendMessage(senderId, "You got it! 🗽 Let me know if you need help finding anything else.");
    return;
  }

  // Handle Get Started or generic greetings
  const isGreeting = (messageText && /^(hi|hello|hey|yo|greetings|get started)$/i.test(messageText.trim()));

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
async function processDMForTest(senderId, messageText) {
  console.log(`[TEST] ${senderId}: ${messageText}`);


  const systemResult = await handleSystemCommands(senderId, messageText, true);
  if (systemResult) return systemResult;

  const profile = await getOrCreateProfile(senderId);
  const context = await getContext(senderId);


  // Handle event_gate text responses (user types instead of clicking buttons)
  if (context?.pendingType === 'event_gate' && messageText) {
    console.log(`[EVENT_GATE] Parsing text preferences with Gemini: "${messageText}"`);
    const pendingFilters = { ...(context.pendingFilters || {}) };
    const pendingQuery = context.pendingQuery || '';
    const textLower = messageText.toLowerCase().trim();

    // Check if user just wants to search with current filters
    if (textLower === 'search' || textLower.includes('just search') || textLower.includes('show me')) {
      console.log(`[EVENT_GATE] User triggered search with current filters:`, JSON.stringify(pendingFilters));
      return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, true);
    }

    // Use Gemini to parse the filters
    const parsedFilters = await parseEventFiltersWithGemini(messageText);

    // Merge parsed filters with pending filters (pending has searchTerm/category)
    if (parsedFilters.date) pendingFilters.date = parsedFilters.date;
    if (parsedFilters.borough) pendingFilters.borough = parsedFilters.borough;
    if (parsedFilters.price) pendingFilters.price = parsedFilters.price;

    // If we parsed at least one filter OR user is providing any response, run the search
    if (parsedFilters.date || parsedFilters.borough || parsedFilters.price || messageText.length > 0) {
      console.log(`[EVENT_GATE] Merged filters:`, JSON.stringify(pendingFilters));
      return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, true);
    }

    // No filters parsed - treat as a new query, clear pending state
    await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null });
  }

  if (context?.pendingType === 'restaurant_preferences' && messageText) {
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
        return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, true);
      }
    }
  }

  // EVENT FLOW (works like restaurant flow - always ask for missing filters)
  if (intentResult.type === 'EVENT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;

    // Check if we have the key filters (date and borough) - ALWAYS require these
    const hasDate = !!detectedFilters.date;
    const hasBorough = !!detectedFilters.borough;

    // Get search term or category if provided
    const searchTerm = detectedFilters.searchTerm || detectedFilters.category || null;

    // If we have BOTH date AND borough, we're ready to search
    if (hasDate && hasBorough) {
      const eventFilters = {
        date: detectedFilters.date ? { type: detectedFilters.date } : null,
        borough: detectedFilters.borough || null,
        price: detectedFilters.price || null,
        category: detectedFilters.category || null,
        searchTerm: detectedFilters.searchTerm || null
      };
      return await runEventSearchWithFilters(senderId, messageText, eventFilters, profile, context, true);
    }

    // Save what we detected and ask for missing filters
    await updateContext(senderId, {
      pendingType: 'event_gate',
      pendingQuery: messageText,
      pendingFilters: detectedFilters,
      lastCategory: 'EVENT'
    });

    // If we have a pre-generated prompt from the router, use it
    if (filterPrompt) {
      return { reply: filterPrompt.text, buttons: null, category: 'EVENT' };
    }

    // Fallback manual prompts
    let promptText;
    if (searchTerm && !hasDate && !hasBorough) {
      promptText = `🎪 ${searchTerm}! NYC has a lot going on.

Tell me (all optional):
📍 Where: Manhattan, Brooklyn, Queens, or "all NYC"
📅 When: tonight, this weekend, next week...

🎲 Or just say "search" to see what's out there!

Example: "Brooklyn this weekend" or just "search"`;
    } else if (searchTerm && hasDate && !hasBorough) {
      promptText = `🎪 ${searchTerm} ${detectedFilters.date}! 

📍 Where (optional): Manhattan, Brooklyn, Queens, Bronx, Staten Island, or "all NYC"

🎲 Or just say "search" to see everything!`;
    } else if (searchTerm && !hasDate && hasBorough) {
      promptText = `🎪 ${searchTerm} in ${detectedFilters.borough}!

📅 When (optional): tonight, tomorrow, this weekend, next week...

🎲 Or just say "search" to see everything!`;
    } else if (!searchTerm && hasDate && !hasBorough) {
      promptText = `🎪 Events ${detectedFilters.date}!

Tell me (all optional):
📍 Where: Manhattan, Brooklyn, Queens, or "all NYC"
✨ Category: music, comedy, art, sports...

🎲 Or just say "search" to see everything!`;
    } else if (!searchTerm && !hasDate && hasBorough) {
      promptText = `🎪 Events in ${detectedFilters.borough}!

Tell me (all optional):
📅 When: tonight, this weekend, next week...
✨ Category: music, comedy, art, sports...

🎲 Or just say "search" to see everything!`;
    } else {
      promptText = `🎪 NYC has hundreds of events!

Tell me what you're looking for (all optional):

📍 Where: Manhattan, Brooklyn, Queens, or "all NYC"
📅 When: tonight, this weekend, next week...
✨ Category: music, comedy, art, nightlife, sports...

🎲 Or just say "search" to see what's happening!

Example: "Brooklyn this weekend" or just "search"`;
    }

    return { reply: promptText, buttons: null, category: 'EVENT' };
  }

  // RESTAURANT FLOW
  if (intentResult.type === 'RESTAURANT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;
    const hasCuisineOrDish = detectedFilters.cuisine || detectedFilters.dish;

    if (hasCuisineOrDish) {
      return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, true);
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
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, true);
  }

  // FOOD QUESTION FLOW
  if (intentResult.type === 'FOOD_QUESTION') {
    const answer = await answerFoodQuestion(messageText, context);
    await updateContext(senderId, { lastCategory: 'FOOD_QUESTION', pendingType: null });
    return { reply: answer, category: 'FOOD_QUESTION' };
  }

  const socialResult = await handleSocialDM(senderId, messageText, null, context);
  if (socialResult) return socialResult;

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
