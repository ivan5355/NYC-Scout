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

async function handleSocialDM(senderId, messageText, context) {
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

  return null;
}

module.exports = {
  handleSocialDM
};

