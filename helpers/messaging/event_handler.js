const { searchEvents, formatEventResults } = require('../search/events');
const { updateContext, addShownEvents } = require('../users/user_profile');
const { sendMessage, parseBoroughFromPayload } = require('./messenger_utils');

async function runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, returnResult = false) {
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

    if (returnResult) return { reply: searchResult.question, category: 'EVENT' };
    await sendMessage(senderId, searchResult.question);
    return true;
  }

  const formatted = formatEventResults(searchResult);

  const shownIds = searchResult.results.map(e => e.event_id).filter(Boolean);
  if (shownIds.length > 0) {
    await addShownEvents(senderId, shownIds);
  }

  await updateContext(senderId, {
    lastCategory: 'EVENT',
    lastEventFilters: pendingFilters,
    lastFilters: searchResult.filters,
    lastEventTitle: searchResult.results?.[0]?.title || 'an event',
    pendingType: null
  });

  if (returnResult) return { reply: formatted.text, category: 'EVENT' };

  await sendMessage(senderId, formatted.text);

  // Social CTA disabled for now - keeping logic for future use
  // if (searchResult.results?.length > 0) {
  //   const socialCTA = {
  //     text: "Want to go with someone?",
  //     replies: [
  //       { title: '👥 Find someone to go with', payload: `EVENT_FIND_BUDDY_${shownIds[0] || 'general'}` },
  //       { title: 'Skip', payload: 'EVENT_SKIP_SOCIAL' }
  //     ]
  //   };
  //   await sendMessage(senderId, socialCTA.text, socialCTA.replies);
  // }

  return true;
}

async function handleEventCategoryPayload(senderId, payload, pendingQuery, pendingFilters, profile, context, returnResult = false) {
  if (payload.startsWith('EVENT_PRICE_')) {
    const priceMap = { 'EVENT_PRICE_free': 'free', 'EVENT_PRICE_budget': 'budget', 'EVENT_PRICE_any': 'any' };
    pendingFilters.price = priceMap[payload];
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, returnResult);
  }

  if (payload.startsWith('EVENT_CAT_')) {
    pendingFilters.category = payload.replace('EVENT_CAT_', '');
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, returnResult);
  }

  if (payload.startsWith('EVENT_DATE_')) {
    const type = payload.replace('EVENT_DATE_', '');
    pendingFilters.date = type === 'any' ? { type: 'any' } : { type };
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, returnResult);
  }

  if (payload.startsWith('EVENT_BOROUGH_')) {
    const borough = parseBoroughFromPayload(payload);
    if (borough !== undefined) pendingFilters.borough = borough;
    return await runEventSearchWithFilters(senderId, pendingQuery, pendingFilters, profile, context, returnResult);
  }

  return false;
}

module.exports = {
  runEventSearchWithFilters,
  handleEventCategoryPayload
};

