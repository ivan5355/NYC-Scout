const { searchEvents, formatEventResults } = require('../search/events');
const { updateContext, addShownEvents } = require('../users/user_profile');
const { sendMessage } = require('./messenger_utils');

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

  return true;
}

module.exports = {
  runEventSearchWithFilters
};

