const {
  searchRestaurants,
  formatRestaurantResults,
  searchRestaurantsDB,
  getWebResearch,
  extractIntent,
  RESTAURANT_SYSTEM_PROMPT
} = require('../search/restaurants');
const { updateContext, addShownRestaurants } = require('../users/user_profile');
const {
  geminiClient,
  sendMessage,
  isMoreRequest,
  parseBoroughFromText,
  GEMINI_API_KEY
} = require('./messenger_utils');

async function answerFoodQuestion(question, context = null) {
  if (!GEMINI_API_KEY) {
    return "Great question! I'd need to think about that one. In the meantime, want me to find you some restaurant recommendations?";
  }

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

// showFilterMenu removed - now using text-only prompts


async function handleRestaurantQueryWithSystemPrompt(senderId, messageText, payload, profile, context, returnResult = false) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });

  const isMoreFollowUp = isMoreRequest(messageText);

  if (isMoreFollowUp) {
    console.log(`[MORE] Detected "more" request: "${messageText}"`);
    if (context?.pool?.length > 0) {
      const currentPage = context.page || 0;
      const nextPage = currentPage + 1;
      const pageSize = 5;
      const startIdx = nextPage * pageSize;
      const batch = context.pool.slice(startIdx, startIdx + pageSize);

      if (batch.length > 0) {
        console.log(`[MORE] Serving page ${nextPage} from pool (${batch.length} items, pool size: ${context.pool.length})`);

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

        const hasMoreAfterThis = context.pool.length > (startIdx + batch.length);
        if (hasMoreAfterThis) {
          formatted += '\n\nReply "more" for different options.';
        } else {
          formatted += '\n\nThat\'s all I have for this search.';
        }

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

      console.log('[MORE] Pool exhausted');
      const dish = context.lastIntent?.dish || context.lastIntent?.cuisine || context.lastIntent?.dish_or_cuisine || 'that';
      const exhaustedMsg = `That's all I have for this search. Want to try a different borough or a slightly different dish?`;

      await updateContext(senderId, {
        pool: [],
        page: 0,
        pendingType: 'restaurant_gate',
        pendingQuery: dish,
        pendingFilters: { cuisine: dish }
      });

      if (returnResult) {
        return { reply: exhaustedMsg, category: 'RESTAURANT' };
      }
      await sendMessage(senderId, exhaustedMsg);
      return;
    }

    console.log('[MORE] No pool available, asking what user wants');
    const noPoolMsg = "What would you like more of? Tell me a dish or cuisine.";
    if (returnResult) return { reply: noPoolMsg, category: 'RESTAURANT' };
    await sendMessage(senderId, noPoolMsg);
    return;
  }

  const isConstraintResponse = payload && (
    payload.startsWith('BOROUGH_') ||
    payload.startsWith('BUDGET_') ||
    payload.startsWith('CUISINE_') ||
    payload.startsWith('FILTER_') ||
    payload.startsWith('VIBE_') ||
    payload.startsWith('SET_') ||
    payload === 'SHOW_TOP_5'
  );

  let intent;
  try {
    intent = await extractIntent(messageText || payload || '');
  } catch (err) {
    console.error('[RESTAURANTS] extractIntent failed:', err.message);
    intent = { request_type: 'vague', dish: null, cuisine: null };
  }

  const dishOrCuisine = intent.dish || intent.cuisine || intent.dish_or_cuisine;
  const hasDish = !!intent.dish && intent.request_type === 'dish';

  const filters = {
    cuisine: null,
    borough: null,
    budget: null,
    isDishQuery: hasDish
  };

  const isNewSearch = messageText && !isConstraintResponse;

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

  const isFilterPayload = payload && payload.startsWith('FILTER_');

  if (isConstraintResponse || payload === 'SHOW_TOP_5' || isFilterPayload) {
    if (!filters.cuisine && context?.pendingFilters?.cuisine) {
      filters.cuisine = context.pendingFilters.cuisine;
      filters.isDishQuery = context.pendingFilters.isDishQuery || false;
    }

    if (context?.pendingFilters?.borough) filters.borough = context.pendingFilters.borough;
    if (context?.pendingFilters?.budget) filters.budget = context.pendingFilters.budget;
    if (context?.pendingFilters?.vibe) filters.vibe = context.pendingFilters.vibe;

    if (payload === 'SHOW_TOP_5' || payload === 'FILTER_TOP_RATED') {
      filters.borough = 'any';
      filters.budget = 'any';
      filters.vibe = 'top rated';
    } else if (payload === 'FILTER_SURPRISE') {
      const boroughs = ['Manhattan', 'Brooklyn', 'Queens'];
      filters.borough = boroughs[Math.floor(Math.random() * boroughs.length)];
      filters.budget = 'any';
    } else if (payload === 'FILTER_SEARCH_NOW') {
      if (!filters.borough) filters.borough = 'any';
      if (!filters.budget) filters.budget = 'any';
    } else if (payload === 'FILTER_LOCATION') {
      const question = `📍 Which area? (Manhattan, Brooklyn, Queens, Bronx, or Staten Island)`;
      if (returnResult) return { reply: question, category: 'RESTAURANT' };
      await sendMessage(senderId, question);
      return;
    } else if (payload === 'FILTER_BUDGET') {
      const question = `💰 What's your budget? ($, $$, $$$, or $$$$)`;
      if (returnResult) return { reply: question, category: 'RESTAURANT' };
      await sendMessage(senderId, question);
      return;
    } else if (payload === 'FILTER_VIBE') {
      const question = `✨ What vibe? (casual, date night, trendy, or hidden gem)`;
      if (returnResult) return { reply: question, category: 'RESTAURANT' };
      await sendMessage(senderId, question);
      return;
    } else if (payload && payload.startsWith('SET_BOROUGH_')) {
      const boroughMap = {
        'SET_BOROUGH_MANHATTAN': 'Manhattan', 'SET_BOROUGH_BROOKLYN': 'Brooklyn',
        'SET_BOROUGH_QUEENS': 'Queens', 'SET_BOROUGH_BRONX': 'Bronx',
        'SET_BOROUGH_STATEN': 'Staten Island', 'SET_BOROUGH_ANY': 'any'
      };
      filters.borough = boroughMap[payload] || 'any';
      await updateContext(senderId, { pendingFilters: { ...context?.pendingFilters, cuisine: filters.cuisine, borough: filters.borough } });
      const prompt = `🍜 ${filters.cuisine}! I'll look in ${filters.borough}. Anything else (budget, vibe)? Or just say "search"!`;
      if (returnResult) return { reply: prompt, category: 'RESTAURANT' };
      await sendMessage(senderId, prompt);
      return;
    } else if (payload && payload.startsWith('SET_BUDGET_')) {
      const budgetMap = { 'SET_BUDGET_$': 'Under $20', 'SET_BUDGET_$$': '$20-40', 'SET_BUDGET_$$$': '$40-80', 'SET_BUDGET_$$$$': '$80+', 'SET_BUDGET_ANY': 'any' };
      filters.budget = budgetMap[payload] || 'any';
      await updateContext(senderId, { pendingFilters: { ...context?.pendingFilters, cuisine: filters.cuisine, budget: filters.budget } });
      const prompt = `🍜 ${filters.cuisine}! I'll filter for ${filters.budget} budget. Anything else (location, vibe)? Or just say "search"!`;
      if (returnResult) return { reply: prompt, category: 'RESTAURANT' };
      await sendMessage(senderId, prompt);
      return;
    } else if (payload && payload.startsWith('SET_VIBE_')) {
      const vibeMap = {
        'SET_VIBE_CASUAL': 'Casual', 'SET_VIBE_DATE': 'Date night',
        'SET_VIBE_TRENDY': 'Trendy', 'SET_VIBE_HIDDEN': 'Hidden gem', 'SET_VIBE_ANY': 'any'
      };
      filters.vibe = vibeMap[payload] || 'any';
      await updateContext(senderId, { pendingFilters: { ...context?.pendingFilters, cuisine: filters.cuisine, vibe: filters.vibe } });
      const prompt = `🍜 ${filters.cuisine}! I'll look for ${filters.vibe} vibes. Anything else (location, budget)? Or just say "search"!`;
      if (returnResult) return { reply: prompt, category: 'RESTAURANT' };
      await sendMessage(senderId, prompt);
      return;
    } else if (payload && payload.startsWith('VIBE_')) {
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

Tell me what you're looking for:

📍 Location (Manhattan, Brooklyn, Queens...)
💰 Budget (cheap, moderate, fancy)
✨ Vibe (casual, date night, trendy, hidden gem)
🎲 Or just say "surprise me"

Example: "Manhattan, under $30, casual"`;

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
      return { reply: formatted.text, category: 'RESTAURANT' };
    }
    await sendMessage(senderId, formatted.text);
    return;
  }

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

    let cleanResult = resultText;
    if (resultText.startsWith('```')) {
      cleanResult = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    if (cleanResult.startsWith('{') && cleanResult.includes('NEED_RESEARCH')) {
      try {
        const researchData = JSON.parse(cleanResult);

        if (!researchData.queries?.length || !researchData.shortlist?.length) {
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
            return { reply: formatted.text, category: 'RESTAURANT' };
          }
          await sendMessage(senderId, formatted.text);
          return;
        }

        const snippets = await getWebResearch(researchData.queries);

        const promptWithSnippets = RESTAURANT_SYSTEM_PROMPT
          .replace('{{TODAY_DATE}}', today)
          .replace('{{USER_MESSAGE}}', messageText || '')
          .replace('{{USER_PAYLOAD}}', payload || '')
          .replace('{{USER_PROFILE_JSON}}', JSON.stringify(profile.foodProfile || {}))
          .replace('{{USER_CONTEXT_JSON}}', JSON.stringify(context || {}))
          .replace('{{DB_RESTAURANTS_JSON}}', JSON.stringify(dbRestaurants))
          .replace('{{WEB_RESEARCH_SNIPPETS}}', snippets || '')
          .replace('{{WEB_RESEARCH_ALLOWED}}', 'false');

        response = await geminiClient.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
          {
            contents: [{ parts: [{ text: promptWithSnippets }] }],
            generationConfig: { maxOutputTokens: 2048, temperature: 0.2 }
          },
          { params: { key: GEMINI_API_KEY } }
        );
        resultText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

        if (resultText.startsWith('```')) {
          resultText = resultText.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
        }

        if (resultText.startsWith('{') && resultText.includes('NEED_RESEARCH')) {
          const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true);
          const formatted = formatRestaurantResults(searchResult);

          if (returnResult) {
            return { reply: formatted.text, category: 'RESTAURANT' };
          }
          await sendMessage(senderId, formatted.text);
          return;
        }
      } catch (e) {
        console.error('Failed to parse research JSON or fetch snippets:', e.message);
        const searchResult = await searchRestaurants(senderId, messageText || payload || '', filters, profile?.foodProfile, context, true);
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

  if (textLower.includes('surprise')) {
    const boroughs = ['Manhattan', 'Brooklyn', 'Queens'];
    pendingFilters.borough = boroughs[Math.floor(Math.random() * boroughs.length)];
    pendingFilters.budget = 'any';
  }

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

  return { reply: formatted.text, category: 'RESTAURANT' };
}

module.exports = {
  answerFoodQuestion,
  handleRestaurantQueryWithSystemPrompt,
  handleConversationalPreferences
};

