const {
  classifyIntentAndFilters,
  isReadyToSearch,
  parseEventFiltersWithGemini,
  parseRestaurantFiltersWithGemini
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
  getContext,
  clearContext
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
  handleRestaurantQueryWithSystemPrompt,
  handleConversationalPreferences
} = require('./food_handler');

/* =====================
   MESSAGE DEDUPLICATION (MongoDB-based)
   Instagram can send the same webhook multiple times.
   In-memory dedup does NOT work on Vercel serverless (each invocation
   is a separate process). We use MongoDB atomic upsert instead.
===================== */
const { MongoClient } = require('mongodb');

let dedupCollection = null;
const processDMInFlight = new Set();

async function getDedupCollection() {
  if (dedupCollection) return dedupCollection;
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('nyc-events');
    dedupCollection = db.collection('processed_messages');
    // TTL index: auto-delete entries after 120 seconds
    await dedupCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 120 }).catch(() => {});
    return dedupCollection;
  } catch (err) {
    console.error('[DEDUP] MongoDB connection failed:', err.message);
    return null;
  }
}

function getMessageId(body) {
  const messaging = body?.entry?.[0]?.messaging?.[0];
  return messaging?.message?.mid || messaging?.postback?.mid || null;
}

async function isDuplicateMessage(messageId) {
  if (!messageId) return false;

  try {
    const col = await getDedupCollection();
    if (!col) {
      console.log('[DEDUP] Collection unavailable, allowing message through');
      return false; // If DB fails, allow processing (better than dropping messages)
    }

    // Atomic: insert only if _id doesn't exist. If it already exists, it's a duplicate.
    const result = await col.updateOne(
      { _id: messageId },
      { $setOnInsert: { _id: messageId, createdAt: new Date() } },
      { upsert: true }
    );

    if (result.upsertedCount === 0) {
      // Document already existed = duplicate
      console.log(`[DEDUP] Skipping duplicate message: ${messageId}`);
      return true;
    }

    console.log(`[DEDUP] Accepted new message: ${messageId}`);
    return false;
  } catch (err) {
    // Duplicate key error (race condition between concurrent upserts) = duplicate
    if (err.code === 11000) {
      console.log(`[DEDUP] Skipping duplicate message (race): ${messageId}`);
      return true;
    }
    console.error('[DEDUP] Error checking duplicate:', err.message);
    return false; // On error, allow processing
  }
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
    await clearContext(senderId);
    await sendMessage(senderId, "Reset complete! How can I help you today?");
    return true;
  }

  return null;
}

function looksLikeEventIntent(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const eventKeywords = [
    'event', 'events', 'things to do', 'concert', 'show', 'comedy', 'music',
    'jazz', 'sports', 'game', 'festival', 'party', 'nightlife', 'theater',
    'theatre', 'activity', 'activities'
  ];
  return eventKeywords.some((kw) => t.includes(kw));
}

function looksLikeRestaurantIntent(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const restaurantKeywords = [
    'restaurant', 'restaurants', 'food', 'eat', 'hungry', 'dinner', 'lunch',
    'breakfast', 'brunch', 'sushi', 'pizza', 'ramen', 'thai', 'italian',
    'mexican', 'chinese', 'indian', 'burger', 'cuisine'
  ];
  return restaurantKeywords.some((kw) => t.includes(kw));
}


/* =====================
   WEBHOOK ENTRYPOINT
===================== */
async function handleDM(body) {
  const messaging = body?.entry?.[0]?.messaging?.[0];
  if (!messaging) {
    console.log('[handleDM] No messaging object');
    return;
  }

  // Block ALL echoes and bot-sent messages
  if (messaging.message?.is_echo) {
    console.log('[handleDM] Skipping echo');
    return;
  }

  // Block if sender is the page itself (prevents self-reply loops)
  const pageId = body?.entry?.[0]?.id;
  const senderId = getSenderId(body);
  if (senderId && pageId && senderId === String(pageId)) {
    console.log('[handleDM] Skipping message from page itself');
    return;
  }

  // Block read receipts, deliveries, reactions, etc.
  if (messaging.read || messaging.delivery || messaging.reaction) {
    console.log('[handleDM] Skipping non-message event (read/delivery/reaction)');
    return;
  }

  // Deduplicate webhook calls - Instagram can send the same message multiple times
  const messageId = getMessageId(body);
  console.log('[handleDM] Incoming messageId:', messageId || 'none');
  if (await isDuplicateMessage(messageId)) return;

  if (!senderId) {
    console.log('[handleDM] No senderId');
    return;
  }

  const incoming = getIncomingTextOrPayload(body);
  if (!incoming.text) {
    console.log('[handleDM] No text in message');
    return;
  }

  console.log('[handleDM] Processing message from', senderId, ':', incoming.text);

  try {
    // Handle special commands BEFORE creating profile
    const systemHandled = await handleSystemCommands(senderId, incoming.text);
    if (systemHandled) return;

    const profile = await getOrCreateProfile(senderId);
    console.log('[handleDM] Profile loaded:', !!profile);
    
    const context = await getContext(senderId);
    console.log('[handleDM] Context loaded:', JSON.stringify(context));

    await processDM(senderId, incoming.text, profile, context);
    console.log('[handleDM] processDM completed');
  } catch (err) {
    console.error('[handleDM] ERROR:', err.message, err.stack);
    // Try to send error message to user so they know something went wrong
    try {
      await sendMessage(senderId, "Sorry, something went wrong! Try again in a moment.");
    } catch (sendErr) {
      console.error('[handleDM] Failed to send error message:', sendErr.message);
    }
  }
}

/* =====================
   MAIN DM PROCESSING (with Intent Classification Flow)
   ===================== */
async function processDM(senderId, messageText, profile, context) {
  console.log(`[DM] Processing Instagram DM: "${messageText}" from sender: ${senderId}`);
  console.log(`[DM] Current context:`, JSON.stringify(context, null, 2));

  const guardKey = `${senderId}:${(messageText || '').trim().toLowerCase()}`;
  if (processDMInFlight.has(guardKey)) {
    console.error(`[DM_GUARD] Prevented re-entrant processDM loop for ${guardKey}`);
    await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null });
    return;
  }
  processDMInFlight.add(guardKey);

  try {
  // Handle restaurant_gate pending type - clear pending state FIRST to prevent infinite recursion
  if (context?.pendingType === 'restaurant_gate' && messageText) {
    const shouldEscapeToEvents = looksLikeEventIntent(messageText) && !looksLikeRestaurantIntent(messageText);
    if (shouldEscapeToEvents) {
      console.log(`[RESTAURANT_GATE] Event intent detected while in restaurant gate: "${messageText}" - routing to events`);
      await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null, lastCategory: 'EVENT' });
      const eventContext = { ...context, pendingType: null, pendingQuery: null, pendingFilters: null, lastCategory: 'EVENT' };
      return await runEventSearchWithFilters(senderId, messageText, {}, profile, eventContext);
    } else {
      console.log(`[RESTAURANT_GATE] User provided cuisine: "${messageText}" - clearing gate and re-processing`);
    }
    await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null });
    // Update the local context to reflect the cleared state
    context = { ...context, pendingType: null, pendingQuery: null, pendingFilters: null };
    // Fall through to intent classification below (don't recurse)
  }

  // Handle restaurant_preferences pending type (user responding with filters like "Brooklyn, cheap")
  if (context?.pendingType === 'restaurant_preferences' && messageText) {
    console.log(`[RESTAURANT_PREFERENCES] Parsing text preferences with Gemini: "${messageText}"`);
    const textLower = messageText.toLowerCase().trim();

    // Check if user just wants to search with current filters
    if (textLower === 'search' || textLower.includes('just search') || textLower.includes('show me')) {
      return await handleConversationalPreferences(senderId, messageText, profile, context);
    }

    // Use Gemini to parse the filters
    const parsedFilters = await parseRestaurantFiltersWithGemini(messageText);

    // Pass everything to the preferences handler
    const result = await handleConversationalPreferences(senderId, messageText, profile, context, parsedFilters);
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
  
  let intentResult;
  try {
    intentResult = await classifyIntentAndFilters(senderId, messageText);
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[RATE LIMIT] Gemini rate limited - sending fallback response');
      await sendMessage(senderId, "I'm getting a lot of messages right now! Try again in a moment. 🗽");
      return;
    }
    throw err;
  }
  let effectiveIntentType = intentResult.type;
  if (looksLikeEventIntent(messageText) && !looksLikeRestaurantIntent(messageText) && effectiveIntentType !== 'EVENT') {
    console.log(`[DM INTENT FLOW] Overriding ${effectiveIntentType} -> EVENT for explicit event query: "${messageText}"`);
    effectiveIntentType = 'EVENT';
  }
  console.log(`[DM INTENT FLOW] Type: ${effectiveIntentType}, Ready: ${isReadyToSearch(intentResult)}, Filters:`, JSON.stringify(intentResult.detectedFilters));

  // Handle follow-up mode
  if (effectiveIntentType === 'FOLLOWUP' && context?.lastCategory) {
    if (context.lastCategory === 'EVENT' || context.lastCategory === 'FOOD_SEARCH' || context.lastCategory === 'RESTAURANT') {
      // Continue with previous category
      if (context.lastCategory === 'EVENT') {
        return await runEventSearchWithFilters(senderId, messageText, context?.lastEventFilters || {}, profile, context);
      } else {
        return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, false, context?.lastFilters);
      }
    }
  }

  // =====================
  // EVENT FLOW (works like restaurant flow - always ask for missing filters)
  // =====================
  if (effectiveIntentType === 'EVENT') {
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
  if (effectiveIntentType === 'RESTAURANT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;

    // Check if we have enough info to search
    const hasCuisineOrDish = detectedFilters.cuisine || detectedFilters.dish;

    if (hasCuisineOrDish) {
      // We have cuisine/dish - pass to restaurant handler which will ask for remaining filters
      return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, false, detectedFilters);
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
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, false, detectedFilters);
  }

  // =====================
  // FOOD QUESTION FLOW
  // =====================
  if (effectiveIntentType === 'FOOD_QUESTION') {
    await sendMessage(senderId, "I'm best at finding specific restaurant and event recommendations! Tell me what you're craving or what kind of event you're looking for.");
    return;
  }

  // Appreciation / Emojis
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
  } finally {
    processDMInFlight.delete(guardKey);
  }
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

  if (context?.pendingType === 'restaurant_gate' && messageText) {
    const shouldEscapeToEvents = looksLikeEventIntent(messageText) && !looksLikeRestaurantIntent(messageText);
    if (shouldEscapeToEvents) {
      await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null, lastCategory: 'EVENT' });
      const eventContext = { ...context, pendingType: null, pendingQuery: null, pendingFilters: null, lastCategory: 'EVENT' };
      return await runEventSearchWithFilters(senderId, messageText, {}, profile, eventContext, true);
    }
    await updateContext(senderId, { pendingType: null, pendingQuery: null, pendingFilters: null });
  }


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
    const parsedFilters = await parseRestaurantFiltersWithGemini(messageText);
    return await handleConversationalPreferences(senderId, messageText, profile, context, parsedFilters);
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
    return {
      reply: "I'm focused on finding you the best recommendations right now! What else are you looking for?",
      category: 'RESTAURANT'
    };
  }

  // =====================
  // NEW INTENT CLASSIFICATION FLOW IN TEST MODE
  // =====================
  const intentResult = await classifyIntentAndFilters(senderId, messageText);
  let effectiveIntentType = intentResult.type;
  if (looksLikeEventIntent(messageText) && !looksLikeRestaurantIntent(messageText) && effectiveIntentType !== 'EVENT') {
    console.log(`[TEST INTENT FLOW] Overriding ${effectiveIntentType} -> EVENT for explicit event query: "${messageText}"`);
    effectiveIntentType = 'EVENT';
  }
  console.log(`[TEST INTENT FLOW] Type: ${effectiveIntentType}, Ready: ${isReadyToSearch(intentResult)}`);

  // Handle follow-up mode
  if (effectiveIntentType === 'FOLLOWUP' && context?.lastCategory) {
    if (context.lastCategory === 'EVENT' || context.lastCategory === 'FOOD_SEARCH' || context.lastCategory === 'RESTAURANT') {
      if (context.lastCategory === 'EVENT') {
        return await runEventSearchWithFilters(senderId, messageText, context?.lastEventFilters || {}, profile, context, true);
      } else {
        return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, true, context?.lastFilters);
      }
    }
  }

  // EVENT FLOW (works like restaurant flow - always ask for missing filters)
  if (effectiveIntentType === 'EVENT') {
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
  if (effectiveIntentType === 'RESTAURANT') {
    const { detectedFilters, missingFilters, filterPrompt } = intentResult;
    const hasCuisineOrDish = detectedFilters.cuisine || detectedFilters.dish;

    if (hasCuisineOrDish) {
      return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, true, intentResult?.detectedFilters);
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
    return await handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, true, intentResult?.detectedFilters);
  }

  // FOOD QUESTION FLOW
  if (effectiveIntentType === 'FOOD_QUESTION') {
    return {
      reply: "I'm best at finding specific restaurant and event recommendations! Tell me what you're craving or what kind of event you're looking for.",
      category: 'OTHER'
    };
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
