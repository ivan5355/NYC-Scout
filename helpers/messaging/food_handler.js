const {
  searchRestaurants,
  formatRestaurantResults,
  searchRestaurantsDB
} = require('../search/restaurants');
const { RESTAURANT_SYSTEM_PROMPT } = require('../search/restaurant_prompts');
const { updateContext, addShownRestaurants } = require('../users/user_profile');
const {
  geminiClient,
  sendMessage,
  GEMINI_API_KEY
} = require('./messenger_utils');




async function handleRestaurantQueryWithSystemPrompt(senderId, messageText, profile, context, returnResult = false, detectedFilters = null) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });

  // Use pre-detected filters from classifyIntentAndFilters if provided (avoids redundant Gemini call)
  let intent;
  if (detectedFilters) {
    // Build intent from pre-detected filters
    intent = {
      request_type: detectedFilters.dish ? 'dish' : (detectedFilters.cuisine ? 'cuisine' : 'vague'),
      dish: detectedFilters.dish || null,
      cuisine: detectedFilters.cuisine || null,
      borough: detectedFilters.borough || null,
      budget: detectedFilters.budget || null,
      vibe: detectedFilters.vibe || null
    };
    console.log('[RESTAURANTS] Using pre-detected filters:', intent);
  } else {
    // Fallback: use context or defaults (shouldn't normally happen)
    console.log('[RESTAURANTS] No pre-detected filters, using context fallback');
    intent = {
      request_type: 'vague',
      dish: context?.pendingFilters?.dish || null,
      cuisine: context?.pendingFilters?.cuisine || null,
      borough: context?.pendingFilters?.borough || null,
      budget: context?.pendingFilters?.budget || null
    };
  }

  const dishOrCuisine = intent.dish || intent.cuisine;
  const hasDish = !!intent.dish && intent.request_type === 'dish';

  const filters = {
    cuisine: null,
    borough: null,
    budget: null,
    isDishQuery: hasDish
  };

  const isNewSearch = !!messageText;

  if (dishOrCuisine && !['best', 'good', 'food', 'restaurant', 'restaurants', 'find', 'me', 'the'].includes(dishOrCuisine.toLowerCase())) {
    filters.cuisine = dishOrCuisine;
  } else if (context?.pendingFilters?.cuisine) {
    filters.cuisine = context.pendingFilters.cuisine;
  } else if (context?.lastFilters?.cuisine) {
    filters.cuisine = context.lastFilters.cuisine;
  }

  if (isNewSearch) {
    filters.borough = intent.borough;
  } else {
    filters.borough = intent.borough || context?.pendingFilters?.borough || context?.lastFilters?.borough;
  }

  if (isNewSearch) {
    filters.budget = intent.budget;
  } else {
    filters.budget = intent.budget || context?.pendingFilters?.budget || context?.lastFilters?.budget;
  }



  const genericWords = ['best', 'good', 'nice', 'great', 'amazing', 'food', 'restaurant', 'restaurants', 'spots', 'places', 'hungry', 'eat', 'dinner', 'lunch', 'breakfast'];
  const cleanCuisine = (filters.cuisine || '').toLowerCase().trim();
  const hasCuisineOrDish = filters.cuisine && cleanCuisine.length >= 2 && !genericWords.includes(cleanCuisine);

  if (!hasCuisineOrDish) {
    await updateContext(senderId, {
      pendingType: 'restaurant_gate',
      pendingQuery: messageText || context?.pendingQuery,
      pendingFilters: filters,
      lastCategory: 'FOOD_SEARCH'
    });

    const question = "What kind of food are you craving? (e.g. sushi, pizza, thai...)";
    if (returnResult) return { reply: question, category: 'RESTAURANT' };
    await sendMessage(senderId, question);
    return;
  }

  if (!filters.borough) {
    await updateContext(senderId, {
      pendingType: 'restaurant_preferences',
      pendingQuery: messageText || context?.pendingQuery,
      pendingFilters: filters,
      lastCategory: 'FOOD_SEARCH'
    });

    const dishOrCuisine = filters.cuisine;
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

Tell me what you're looking for (all optional):

📍 Location: Manhattan, Brooklyn, Queens...
💰 Budget: cheap, moderate, fancy
✨ Vibe: casual, date night, trendy, hidden gem

🎲 Or just say "surprise me" or "search"

Example: "Brooklyn" or "cheap, casual" or just hit search!`;

    if (returnResult) return { reply: question, category: 'RESTAURANT' };
    await sendMessage(senderId, question);
    return;
  }

  if (!filters.budget && profile?.foodProfile?.budget) {
    filters.budget = profile.foodProfile.budget;
  }

  await updateContext(senderId, {
    pendingType: null,
    pendingQuery: null,
    pendingFilters: null,
    lastFilters: filters,
    lastCategory: 'FOOD_SEARCH'
  });

  let dbRestaurants = await searchRestaurantsDB(filters, 25);

  if (dbRestaurants.length === 0 && filters.cuisine) {
    const broaderFilters = { ...filters, cuisine: null };
    dbRestaurants = await searchRestaurantsDB(broaderFilters, 25);
  }

  if (dbRestaurants.length === 0) {
    const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true, intent);
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
      return { reply: formatted.text, category: 'RESTAURANT' };
    }
    await sendMessage(senderId, formatted.text);
    return;
  }

  let fullPrompt = RESTAURANT_SYSTEM_PROMPT
    .replace('{{TODAY_DATE}}', today)
    .replace('{{USER_MESSAGE}}', messageText || '')
    .replace('{{USER_PAYLOAD}}', '')
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

    let cleanResult = resultText;
    if (resultText.startsWith('```')) {
      cleanResult = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    if (cleanResult.startsWith('{') && cleanResult.includes('NEED_RESEARCH')) {
      try {
        const researchData = JSON.parse(cleanResult);

        if (!researchData.queries?.length || !researchData.shortlist?.length) {
          const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true, intent);
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
            return { reply: formatted.text, category: 'RESTAURANT' };
          }
          await sendMessage(senderId, formatted.text);
          return;
        }

        // Since manual web research is deprecated in favor of searchRestaurants
        // we directly fallback to searchRestaurants if research is needed
        const searchResult = await searchRestaurants(senderId, messageText || '', filters, profile?.foodProfile, context, true, intent);
        const formatted = formatRestaurantResults(searchResult);

        if (returnResult) {
          return { reply: formatted.text, category: 'RESTAURANT' };
        }
        await sendMessage(senderId, formatted.text);
        return;
      } catch (e) {
        console.error('Failed to parse research JSON or handle research request:', e.message);
        const searchResult = await searchRestaurants(senderId, messageText || '', filters, profile?.foodProfile, context, true, intent);
        const formatted = formatRestaurantResults(searchResult);

        if (returnResult) {
          return { reply: formatted.text, category: 'RESTAURANT' };
        }
        await sendMessage(senderId, formatted.text);
        return;
      }
    } else {
      resultText = cleanResult;
    }

    const isAsk = resultText.length < 200 && (resultText.toLowerCase().includes('area') || resultText.toLowerCase().includes('budget') || resultText.toLowerCase().includes('thinking'));

    if (isAsk) {
      if (returnResult) {
        return { reply: resultText, category: 'RESTAURANT' };
      }
      await sendMessage(senderId, resultText);
    } else {
      const finalReply = resultText || "I found some spots for you! What else are you looking for?";

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

async function handleConversationalPreferences(senderId, messageText, profile, context) {
  console.log(`[PREFERENCES] Parsing user preferences: "${messageText}"`);

  const pendingFilters = { ...(context.pendingFilters || {}) };
  const textLower = messageText.toLowerCase();

  if (textLower.includes('manhattan')) pendingFilters.borough = 'Manhattan';
  else if (textLower.includes('brooklyn')) pendingFilters.borough = 'Brooklyn';
  else if (textLower.includes('queens')) pendingFilters.borough = 'Queens';
  else if (textLower.includes('bronx')) pendingFilters.borough = 'Bronx';
  else if (textLower.includes('staten')) pendingFilters.borough = 'Staten Island';
  else if (textLower.includes('surprise') || textLower.includes('anywhere') || textLower.includes('any')) {
    pendingFilters.borough = 'any';
  } else {
    pendingFilters.borough = 'any';
  }

  if (textLower.includes('cheap') || textLower.includes('budget') || textLower.includes('under $20') || textLower.includes('$')) {
    pendingFilters.budget = '$';
  } else if (textLower.includes('moderate') || textLower.includes('mid') || textLower.includes('under $40') || textLower.includes('$$')) {
    pendingFilters.budget = '$$';
  } else if (textLower.includes('fancy') || textLower.includes('upscale') || textLower.includes('expensive') || textLower.includes('$$$')) {
    pendingFilters.budget = '$$$';
  } else {
    pendingFilters.budget = 'any';
  }

  if (textLower.includes('casual') || textLower.includes('chill') || textLower.includes('relaxed')) {
    pendingFilters.vibe = 'casual';
  } else if (textLower.includes('date') || textLower.includes('romantic')) {
    pendingFilters.vibe = 'date night';
  } else if (textLower.includes('trendy') || textLower.includes('hip') || textLower.includes('cool')) {
    pendingFilters.vibe = 'trendy';
  } else if (textLower.includes('hidden') || textLower.includes('gem') || textLower.includes('secret')) {
    pendingFilters.vibe = 'hidden gem';
  }

  if (textLower.includes('surprise') || textLower.includes('search')) {
    const boroughs = ['Manhattan', 'Brooklyn', 'Queens'];
    if (!pendingFilters.borough || pendingFilters.borough === 'any') {
      pendingFilters.borough = boroughs[Math.floor(Math.random() * boroughs.length)];
    }
    pendingFilters.budget = pendingFilters.budget || 'any';
  }

  await updateContext(senderId, {
    pendingType: null,
    pendingQuery: null,
    pendingFilters: null,
    lastFilters: pendingFilters,
    lastCategory: 'RESTAURANT'
  });

  // Construct intent from pending filters to avoid redundant extraction
  const prebuiltIntent = {
    request_type: pendingFilters.isDishQuery ? 'dish' : 'cuisine',
    dish: pendingFilters.isDishQuery ? pendingFilters.cuisine : null,
    cuisine: pendingFilters.isDishQuery ? null : pendingFilters.cuisine,
    borough: pendingFilters.borough,
    budget: pendingFilters.budget,
    needs_constraint: false
  };

  const searchResult = await searchRestaurants(
    senderId,
    context.pendingQuery || pendingFilters.cuisine || 'restaurant',
    pendingFilters,
    profile?.foodProfile,
    context,
    true,
    prebuiltIntent
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

  return { reply: formatted.text, category: 'RESTAURANT' };
}

module.exports = {
  handleRestaurantQueryWithSystemPrompt,
  handleConversationalPreferences
};

