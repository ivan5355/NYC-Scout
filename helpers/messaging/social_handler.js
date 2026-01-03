const {
  handleSocialFlow,
  startOptIn,
  detectSocialIntent,
  handleOptOut,
  handleStopMatching,
  handleReport,
  findCompatibleMatches,
  formatMatchResults,
  requestMatch,
  handleMatchResponse
} = require('../users/social_matching');
const { getSocialProfile, updateSocialProfile } = require('../users/user_profile');
const { sendMessage } = require('./messenger_utils');

async function handleSocialDM(senderId, messageText, payload, context) {
  if (messageText) {
    const lowerText = messageText.toLowerCase().trim();

    if (lowerText === 'opt out') {
      const result = await handleOptOut(senderId);
      return { reply: result.text, category: 'SOCIAL' };
    }

    if (lowerText === 'stop matching') {
      const result = await handleStopMatching(senderId);
      return { reply: result.text, category: 'SOCIAL' };
    }

    if (lowerText === 'report') {
      const result = await handleReport(senderId, context);
      return { reply: result.text, category: 'SOCIAL' };
    }

    if (detectSocialIntent(messageText)) {
      const socialProfile = await getSocialProfile(senderId);
      if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
        const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
        const result = formatMatchResults(matches, socialProfile?.lastEventContext);
        return { reply: result.text, category: 'SOCIAL' };
      } else {
        const result = await startOptIn(senderId);
        return { reply: result.text, category: 'SOCIAL' };
      }
    }
  }

  if (payload === 'MODE_SOCIAL') {
    const socialProfile = await getSocialProfile(senderId);
    if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
      const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
      const result = formatMatchResults(matches, socialProfile?.lastEventContext);
      return { reply: result.text, category: 'SOCIAL' };
    }
    const result = await startOptIn(senderId);
    return { reply: result.text, category: 'SOCIAL' };
  }

  if (payload?.startsWith('SOCIAL_')) {
    const result = await handleSocialFlow(senderId, payload, context);
    if (result.continueToEvents) {
      return {
        reply: "What kind of events are you looking for? (e.g. tonight, this weekend, free stuff)",
        category: 'EVENT'
      };
    }
    return { reply: result.text, category: 'SOCIAL' };
  }

  if (payload?.startsWith('MATCH_REQUEST_')) {
    const targetId = payload.replace('MATCH_REQUEST_', '');
    const socialProfile = await getSocialProfile(senderId);
    const eventTitle = socialProfile?.lastEventContext?.eventTitle || 'an event';
    const eventId = socialProfile?.lastEventContext?.eventId;

    const result = await requestMatch(senderId, targetId, eventId, eventTitle);

    if (!result.success) {
      const errorMessages = {
        'daily_limit': "You've sent a lot of requests today. Try again tomorrow!",
        'recently_declined': "You can't send another request to this person right now.",
        'pending_exists': "You already have a pending request to this person.",
        'target_not_opted_in': "This person isn't available for matching right now.",
        'db_error': "Something went wrong. Try again?"
      };
      return { reply: errorMessages[result.reason] || "Something went wrong. Try again?", category: 'SOCIAL' };
    }

    if (result.targetMessage) {
      await sendMessage(targetId, result.targetMessage.text, result.targetMessage.replies);
    }
    return { reply: "Request sent! I'll let you know if they accept.", targetId, category: 'SOCIAL' };
  }

  if (payload?.startsWith('MATCH_ACCEPT_')) {
    const requestId = payload.replace('MATCH_ACCEPT_', '');
    const result = await handleMatchResponse(senderId, requestId, true);

    if (!result.success) {
      const errorMessages = {
        'request_not_found': "That request doesn't exist anymore.",
        'already_responded': "You already responded to this request.",
        'expired': "That request expired. Want to find new matches?",
        'db_error': "Something went wrong. Try again?"
      };
      return { reply: errorMessages[result.reason] || "Something went wrong.", category: 'SOCIAL' };
    }

    if (result.requesterMessage && result.requesterId) {
      await sendMessage(result.requesterId, result.requesterMessage.text);
    }
    return {
      reply: result.targetMessage?.text || "You're connected!",
      requesterId: result.requesterId,
      category: 'SOCIAL'
    };
  }

  if (payload?.startsWith('MATCH_DECLINE_')) {
    const requestId = payload.replace('MATCH_DECLINE_', '');
    const result = await handleMatchResponse(senderId, requestId, false);
    return { reply: result.message || "Got it. No worries!", category: 'SOCIAL' };
  }

  if (payload === 'MATCH_SHOW_MORE') {
    const socialProfile = await getSocialProfile(senderId);
    const matches = await findCompatibleMatches(senderId, socialProfile?.lastEventContext);
    const result = formatMatchResults(matches.slice(3, 6), socialProfile?.lastEventContext);
    return { reply: result.text, category: 'SOCIAL' };
  }

  if (payload?.startsWith('EVENT_FIND_BUDDY_')) {
    const eventId = payload.replace('EVENT_FIND_BUDDY_', '');
    await updateSocialProfile(senderId, {
      lastEventContext: { eventId, eventTitle: context?.lastEventTitle || 'an event' },
      lastActiveAt: new Date()
    });

    const socialProfile = await getSocialProfile(senderId);
    if (socialProfile?.optIn && socialProfile?.profileCompletedAt) {
      const matches = await findCompatibleMatches(senderId, { eventId });
      const result = formatMatchResults(matches, { eventId });
      return { reply: result.text, category: 'SOCIAL' };
    }
    const result = await startOptIn(senderId);
    return { reply: result.text, category: 'SOCIAL' };
  }

  if (payload === 'EVENT_SKIP_SOCIAL') {
    return { reply: "No problem! What else can I help you find?", category: 'SYSTEM' };
  }

  return null;
}

module.exports = {
  handleSocialDM
};

