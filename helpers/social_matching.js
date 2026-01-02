// Social Matching Module for NYC Scout
// Handles event buddy matching with two-way consent

const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const {
  getSocialProfile,
  updateSocialProfile,
  deleteSocialProfile,
  setSocialOptIn,
  isSocialProfileComplete,
  updateLastEventContext,
  getProfile,
  deleteProfile
} = require('./user_profile');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

let mongoClient = null;
let matchRequestsCollection = null;

// =====================
// DATABASE CONNECTION
// =====================

async function connectToMatchRequests() {
  if (mongoClient && matchRequestsCollection) return matchRequestsCollection;

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    matchRequestsCollection = db.collection('match_requests');
    
    // Create indexes
    await matchRequestsCollection.createIndex({ fromUserId: 1, toUserId: 1, status: 1 });
    await matchRequestsCollection.createIndex({ toUserId: 1, status: 1 });
    await matchRequestsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index
    await matchRequestsCollection.createIndex({ requestId: 1 }, { unique: true });
    
    console.log('Connected to MongoDB match_requests collection');
    return matchRequestsCollection;
  } catch (err) {
    console.error('Failed to connect to match_requests:', err.message);
    return null;
  }
}

// =====================
// CONSTANTS
// =====================

const SOCIAL_QUESTIONS = {
  1: {
    text: "Which borough works best for you?",
    field: 'borough',
    replies: [
      { title: 'Manhattan', payload: 'SOCIAL_Q1_MANHATTAN' },
      { title: 'Brooklyn', payload: 'SOCIAL_Q1_BROOKLYN' },
      { title: 'Queens', payload: 'SOCIAL_Q1_QUEENS' },
      { title: 'Bronx', payload: 'SOCIAL_Q1_BRONX' },
      { title: 'Anywhere', payload: 'SOCIAL_Q1_ANYWHERE' }
    ]
  },
  2: {
    text: "What's your vibe?",
    field: 'vibe',
    replies: [
      { title: 'Chill & lowkey', payload: 'SOCIAL_Q2_CHILL' },
      { title: 'Social & talkative', payload: 'SOCIAL_Q2_SOCIAL' },
      { title: 'Party / nightlife', payload: 'SOCIAL_Q2_PARTY' },
      { title: 'Just there for the activity', payload: 'SOCIAL_Q2_ACTIVITY' }
    ]
  },
  3: {
    text: "When do you usually go out?",
    field: 'availability',
    replies: [
      { title: 'Weeknights', payload: 'SOCIAL_Q3_WEEKNIGHTS' },
      { title: 'Weekends', payload: 'SOCIAL_Q3_WEEKENDS' },
      { title: 'Anytime', payload: 'SOCIAL_Q3_ANYTIME' }
    ]
  },
  4: {
    text: "What kind of group are you looking for?",
    field: 'groupSize',
    replies: [
      { title: '1 person', payload: 'SOCIAL_Q4_ONE' },
      { title: 'Small group (3-5)', payload: 'SOCIAL_Q4_SMALL' },
      { title: 'Any', payload: 'SOCIAL_Q4_ANY' }
    ]
  }
};

const VIBE_EMOJI = {
  'chill': '😌',
  'social': '🗣️',
  'party': '🎉',
  'activity': '🎯'
};

const MATCH_REQUEST_EXPIRY_MINUTES = 30;
const DAILY_REQUEST_LIMIT = 10;
const DECLINE_BLOCK_HOURS = 24;
const INACTIVE_DAYS_THRESHOLD = 14;


// =====================
// SOCIAL INTENT DETECTION
// =====================

const SOCIAL_INTENT_PHRASES = [
  'go with someone',
  'find friends',
  'anyone going',
  'buddy',
  'buddies',
  'group',
  'join',
  'find people',
  'meet people',
  'looking for someone',
  'want company',
  'find someone'
];

function detectSocialIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return SOCIAL_INTENT_PHRASES.some(phrase => lower.includes(phrase));
}

// =====================
// OPT-IN FLOW
// =====================

async function startOptIn(senderId) {
  return {
    text: "I can help match you with others who want to go too. I won't share your profile unless you accept a match.",
    replies: [
      { title: '✅ Opt in', payload: 'SOCIAL_OPTIN_YES' },
      { title: '❌ Not now', payload: 'SOCIAL_OPTIN_NO' }
    ]
  };
}

async function handleOptInResponse(senderId, accepted) {
  if (!accepted) {
    return {
      text: "No problem! Let me know if you change your mind.",
      continueToEvents: true
    };
  }
  
  // Set opt-in and start profile questions
  await setSocialOptIn(senderId, true);
  await updateSocialProfile(senderId, { onboardingStep: 1 });
  
  // Return first question
  return getNextQuestion(1);
}

// =====================
// PROFILE QUESTIONS
// =====================

function getNextQuestion(step) {
  const question = SOCIAL_QUESTIONS[step];
  if (!question) return null;
  
  return {
    text: question.text,
    replies: question.replies
  };
}

async function handleProfileQuestion(senderId, questionNum, answer) {
  const question = SOCIAL_QUESTIONS[questionNum];
  if (!question) {
    return { error: 'Invalid question number' };
  }
  
  // Save the answer
  const updates = {
    [question.field]: answer,
    onboardingStep: questionNum + 1
  };
  
  // If this was the last question, mark profile as complete
  if (questionNum === 4) {
    updates.profileCompletedAt = new Date();
    await updateSocialProfile(senderId, updates);
    
    return {
      text: "You're in ✅ When you tap \"Find someone to go with\" on an event, I'll look for matches.",
      replies: [
        { title: 'Back to events', payload: 'SOCIAL_BACK_EVENTS' },
        { title: 'Find matches now', payload: 'SOCIAL_FIND_NOW' }
      ],
      profileComplete: true
    };
  }
  
  await updateSocialProfile(senderId, updates);
  
  // Return next question
  return getNextQuestion(questionNum + 1);
}

// Parse answer from payload
function parseQuestionAnswer(payload) {
  // SOCIAL_Q1_MANHATTAN -> { questionNum: 1, answer: 'Manhattan' }
  const match = payload.match(/SOCIAL_Q(\d)_(.+)/);
  if (!match) return null;
  
  const questionNum = parseInt(match[1]);
  const answerKey = match[2].toLowerCase();
  
  const answerMap = {
    // Q1 - Borough
    'manhattan': 'Manhattan',
    'brooklyn': 'Brooklyn',
    'queens': 'Queens',
    'bronx': 'Bronx',
    'anywhere': 'Anywhere',
    // Q2 - Vibe
    'chill': 'chill',
    'social': 'social',
    'party': 'party',
    'activity': 'activity',
    // Q3 - Availability
    'weeknights': 'weeknights',
    'weekends': 'weekends',
    'anytime': 'anytime',
    // Q4 - Group size
    'one': 'one',
    'small': 'small',
    'any': 'any'
  };
  
  return {
    questionNum,
    answer: answerMap[answerKey] || answerKey
  };
}


// =====================
// MATCHING ENGINE
// =====================

async function findCompatibleMatches(userId, eventContext = null) {
  const collection = await connectToMatchRequests();
  if (!collection) return [];
  
  const userProfile = await getSocialProfile(userId);
  if (!userProfile || !userProfile.optIn) return [];
  
  const fourteenDaysAgo = new Date(Date.now() - INACTIVE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000);
  
  // Get the user_profiles collection
  const db = mongoClient.db('nyc-events');
  const profilesCollection = db.collection('user_profiles');
  
  try {
    // 1. Get all eligible candidates
    const candidates = await profilesCollection.find({
      'socialProfile.optIn': true,
      'socialProfile.matchingEnabled': true,
      'socialProfile.profileCompletedAt': { $exists: true, $ne: null },
      'socialProfile.lastActiveAt': { $gte: fourteenDaysAgo },
      _id: { $ne: userId }  // Not self
    }).toArray();
    
    // 2. Filter by compatibility
    const compatible = candidates.filter(c => {
      const cp = c.socialProfile;
      if (!cp) return false;
      
      // Borough: match if either is "Anywhere" or same
      const boroughMatch = userProfile.borough === 'Anywhere' || 
                           cp.borough === 'Anywhere' || 
                           userProfile.borough === cp.borough;
      
      // Availability: match if either is "anytime" or overlap
      const availMatch = userProfile.availability === 'anytime' || 
                         cp.availability === 'anytime' || 
                         userProfile.availability === cp.availability;
      
      return boroughMatch && availMatch;
    });
    
    // 3. Get blocked users (declined in last 24h or reported)
    const blockedUsers = await getBlockedUsers(userId);
    const filtered = compatible.filter(c => !blockedUsers.includes(c._id));
    
    // 4. Get already connected users
    const connectedUsers = await getConnectedUsers(userId);
    const final = filtered.filter(c => !connectedUsers.includes(c._id));
    
    // 5. Sort by most recent activity
    final.sort((a, b) => {
      const aTime = a.socialProfile?.lastActiveAt ? new Date(a.socialProfile.lastActiveAt).getTime() : 0;
      const bTime = b.socialProfile?.lastActiveAt ? new Date(b.socialProfile.lastActiveAt).getTime() : 0;
      return bTime - aTime;
    });
    
    // 6. Return top 3 candidates
    return final.slice(0, 3).map(c => ({
      oderId: c._id,
      profile: {
        borough: c.socialProfile.borough,
        vibe: c.socialProfile.vibe,
        availability: c.socialProfile.availability,
        groupSize: c.socialProfile.groupSize
      }
    }));
  } catch (err) {
    console.error('Error finding matches:', err.message);
    return [];
  }
}

async function getBlockedUsers(userId) {
  const collection = await connectToMatchRequests();
  if (!collection) return [];
  
  const twentyFourHoursAgo = new Date(Date.now() - DECLINE_BLOCK_HOURS * 60 * 60 * 1000);
  
  try {
    // Get users who declined this user's requests in last 24h
    const declined = await collection.find({
      fromUserId: userId,
      status: 'declined',
      respondedAt: { $gte: twentyFourHoursAgo }
    }).toArray();
    
    // Get users this user reported
    const reported = await collection.find({
      $or: [
        { fromUserId: userId, reported: true },
        { toUserId: userId, reported: true }
      ]
    }).toArray();
    
    const blockedIds = new Set();
    declined.forEach(r => blockedIds.add(r.toUserId));
    reported.forEach(r => {
      if (r.fromUserId !== userId) blockedIds.add(r.fromUserId);
      if (r.toUserId !== userId) blockedIds.add(r.toUserId);
    });
    
    return Array.from(blockedIds);
  } catch (err) {
    console.error('Error getting blocked users:', err.message);
    return [];
  }
}

async function getConnectedUsers(userId) {
  const collection = await connectToMatchRequests();
  if (!collection) return [];
  
  try {
    const connected = await collection.find({
      $or: [
        { fromUserId: userId, status: 'accepted' },
        { toUserId: userId, status: 'accepted' }
      ]
    }).toArray();
    
    const connectedIds = new Set();
    connected.forEach(r => {
      if (r.fromUserId !== userId) connectedIds.add(r.fromUserId);
      if (r.toUserId !== userId) connectedIds.add(r.toUserId);
    });
    
    return Array.from(connectedIds);
  } catch (err) {
    console.error('Error getting connected users:', err.message);
    return [];
  }
}

// =====================
// ANONYMOUS MATCH DISPLAY
// =====================

function formatAnonymousMatch(profile, matchIndex) {
  const vibeEmoji = VIBE_EMOJI[profile.vibe] || '😊';
  const groupText = profile.groupSize === 'one' ? '1 person' : 
                    profile.groupSize === 'small' ? 'Small group' : 'Any group';
  
  return {
    text: `Match ${matchIndex}\n📍 ${profile.borough} · ${profile.availability}\n${vibeEmoji} ${profile.vibe}\n👥 ${groupText}`,
    payload: `MATCH_REQUEST_${matchIndex}`
  };
}

function formatMatchResults(matches, eventContext = null) {
  if (!matches || matches.length === 0) {
    return {
      text: "No matches right now for this event. Check back later or try a different event!",
      replies: [{ title: 'Back to events', payload: 'SOCIAL_BACK_EVENTS' }]
    };
  }
  
  let text = "I found people who said they're into this vibe. Want to request a connection?\n\n";
  const replies = [];
  
  matches.forEach((match, i) => {
    const formatted = formatAnonymousMatch(match.profile, i + 1);
    text += formatted.text + '\n\n';
    replies.push({ title: `Request Match ${i + 1}`, payload: `MATCH_REQUEST_${match.senderId}` });
  });
  
  if (matches.length >= 3) {
    replies.push({ title: 'Show more', payload: 'MATCH_SHOW_MORE' });
  }
  
  return { text, replies };
}


// =====================
// MATCH REQUEST SYSTEM
// =====================

async function canSendMatchRequest(fromUserId, toUserId) {
  const collection = await connectToMatchRequests();
  if (!collection) return { allowed: false, reason: 'db_error' };
  
  try {
    // Check daily rate limit
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const requestsToday = await collection.countDocuments({
      fromUserId,
      requestedAt: { $gte: today }
    });
    if (requestsToday >= DAILY_REQUEST_LIMIT) {
      return { allowed: false, reason: 'daily_limit' };
    }
    
    // Check 24h block after decline
    const twentyFourHoursAgo = new Date(Date.now() - DECLINE_BLOCK_HOURS * 60 * 60 * 1000);
    const recentDecline = await collection.findOne({
      fromUserId,
      toUserId,
      status: 'declined',
      respondedAt: { $gte: twentyFourHoursAgo }
    });
    if (recentDecline) {
      return { allowed: false, reason: 'recently_declined' };
    }
    
    // Check if target has messaged bot before (has a profile)
    const targetProfile = await getProfile(toUserId);
    if (!targetProfile) {
      return { allowed: false, reason: 'target_never_messaged' };
    }
    
    // Check if target has opted in
    if (!targetProfile.socialProfile?.optIn) {
      return { allowed: false, reason: 'target_not_opted_in' };
    }
    
    // Check for pending request to same user
    const pendingRequest = await collection.findOne({
      fromUserId,
      toUserId,
      status: 'pending'
    });
    if (pendingRequest) {
      return { allowed: false, reason: 'pending_exists' };
    }
    
    return { allowed: true };
  } catch (err) {
    console.error('Error checking match request eligibility:', err.message);
    return { allowed: false, reason: 'error' };
  }
}

async function requestMatch(requesterId, targetId, eventId = null, eventTitle = null) {
  const canSend = await canSendMatchRequest(requesterId, targetId);
  if (!canSend.allowed) {
    return { success: false, reason: canSend.reason };
  }
  
  const collection = await connectToMatchRequests();
  if (!collection) return { success: false, reason: 'db_error' };
  
  const requestId = new ObjectId().toString();
  const expiresAt = new Date(Date.now() + MATCH_REQUEST_EXPIRY_MINUTES * 60 * 1000);
  
  try {
    await collection.insertOne({
      requestId,
      fromUserId: requesterId,
      toUserId: targetId,
      eventId,
      eventTitle: eventTitle || 'an event',
      status: 'pending',
      requestedAt: new Date(),
      expiresAt,
      respondedAt: null,
      revealed: false,
      revealedAt: null,
      declinedAt: null,
      reported: false,
      reportedAt: null,
      reportedBy: null
    });
    
    console.log(`Match request created: ${requesterId} -> ${targetId}`);
    
    return {
      success: true,
      requestId,
      targetId,
      eventTitle,
      // Message to send to target
      targetMessage: {
        text: `Someone wants to go to ${eventTitle || 'an event'} with you. If you accept, I'll share your IG so you can coordinate.`,
        replies: [
          { title: '✅ Accept', payload: `MATCH_ACCEPT_${requestId}` },
          { title: '❌ Decline', payload: `MATCH_DECLINE_${requestId}` }
        ]
      }
    };
  } catch (err) {
    console.error('Error creating match request:', err.message);
    return { success: false, reason: 'error' };
  }
}

async function handleMatchResponse(targetId, requestId, accepted) {
  const collection = await connectToMatchRequests();
  if (!collection) return { success: false, reason: 'db_error' };
  
  try {
    const request = await collection.findOne({ requestId, toUserId: targetId });
    if (!request) {
      return { success: false, reason: 'request_not_found' };
    }
    
    if (request.status !== 'pending') {
      return { success: false, reason: 'already_responded' };
    }
    
    // Check if expired
    if (new Date() > new Date(request.expiresAt)) {
      await collection.updateOne(
        { requestId },
        { $set: { status: 'expired' } }
      );
      return { success: false, reason: 'expired' };
    }
    
    const updates = {
      status: accepted ? 'accepted' : 'declined',
      respondedAt: new Date()
    };
    
    if (!accepted) {
      updates.declinedAt = new Date();
    }
    
    await collection.updateOne({ requestId }, { $set: updates });
    
    if (accepted) {
      // Trigger reveal
      return await revealProfiles(request.fromUserId, targetId, requestId);
    }
    
    // Declined - don't notify requester
    return {
      success: true,
      accepted: false,
      message: "Got it. No worries!"
    };
  } catch (err) {
    console.error('Error handling match response:', err.message);
    return { success: false, reason: 'error' };
  }
}

async function revealProfiles(requesterId, targetId, requestId) {
  const collection = await connectToMatchRequests();
  if (!collection) return { success: false, reason: 'db_error' };
  
  try {
    // Get both profiles
    const requesterProfile = await getProfile(requesterId);
    const targetProfile = await getProfile(targetId);
    
    if (!requesterProfile || !targetProfile) {
      return { success: false, reason: 'profile_not_found' };
    }
    
    // Mark as revealed
    await collection.updateOne(
      { requestId },
      { $set: { revealed: true, revealedAt: new Date() } }
    );
    
    // For now, we use sender IDs as handles (in production, you'd get actual IG handles)
    // Instagram API provides username in some contexts
    const requesterHandle = requesterProfile.username || `user_${requesterId.slice(-6)}`;
    const targetHandle = targetProfile.username || `user_${targetId.slice(-6)}`;
    
    return {
      success: true,
      accepted: true,
      // Messages to send to both users
      requesterMessage: {
        text: `You're connected ✅ Here's their IG: @${targetHandle}\n\nSay 'report' if anything feels off.`
      },
      targetMessage: {
        text: `You're connected ✅ Here's their IG: @${requesterHandle}\n\nSay 'report' if anything feels off.`
      },
      requesterId,
      targetId
    };
  } catch (err) {
    console.error('Error revealing profiles:', err.message);
    return { success: false, reason: 'error' };
  }
}


// =====================
// SAFETY COMMANDS
// =====================

async function handleDeleteAllData(senderId) {
  // Delete social profile
  await deleteSocialProfile(senderId);
  
  // Delete all match requests involving this user
  const collection = await connectToMatchRequests();
  if (collection) {
    await collection.deleteMany({
      $or: [
        { fromUserId: senderId },
        { toUserId: senderId }
      ]
    });
  }
  
  // Delete the entire user profile (food + events + everything)
  await deleteProfile(senderId);
  
  return {
    text: "Done — I deleted all your data.",
    deleted: true
  };
}

async function handleOptOut(senderId) {
  // Set opt-in to false but keep food/event preferences
  await setSocialOptIn(senderId, false);
  await updateSocialProfile(senderId, { matchingEnabled: false });
  
  return {
    text: "You've been removed from matching. Your food and event preferences are still saved.",
    optedOut: true
  };
}

async function handleStopMatching(senderId) {
  // Disable matching but keep profile data
  await updateSocialProfile(senderId, { matchingEnabled: false });
  
  return {
    text: "Matching paused. Say 'start matching' to resume.",
    stopped: true
  };
}

async function handleReport(senderId, context = null) {
  const collection = await connectToMatchRequests();
  if (!collection) {
    return { text: "Report received. We'll look into it.", reported: true };
  }
  
  try {
    // Find the most recent match request involving this user
    const recentRequest = await collection.findOne(
      {
        $or: [
          { fromUserId: senderId },
          { toUserId: senderId }
        ],
        status: 'accepted'
      },
      { sort: { respondedAt: -1 } }
    );
    
    if (recentRequest) {
      await collection.updateOne(
        { _id: recentRequest._id },
        { 
          $set: { 
            reported: true, 
            reportedAt: new Date(),
            reportedBy: senderId
          } 
        }
      );
      
      console.log(`Report filed by ${senderId} for request ${recentRequest.requestId}`);
    }
    
    return {
      text: "Report received. We'll look into it and won't match you with that person again.",
      reported: true
    };
  } catch (err) {
    console.error('Error handling report:', err.message);
    return { text: "Report received. We'll look into it.", reported: true };
  }
}

// =====================
// REQUEST EXPIRATION
// =====================

async function expireOldRequests() {
  const collection = await connectToMatchRequests();
  if (!collection) return { expired: 0 };
  
  try {
    const result = await collection.updateMany(
      {
        status: 'pending',
        expiresAt: { $lt: new Date() }
      },
      {
        $set: { status: 'expired' }
      }
    );
    
    console.log(`Expired ${result.modifiedCount} old match requests`);
    return { expired: result.modifiedCount };
  } catch (err) {
    console.error('Error expiring requests:', err.message);
    return { expired: 0, error: err.message };
  }
}

// =====================
// MAIN FLOW HANDLER
// =====================

async function handleSocialFlow(senderId, payload, context = null) {
  // Handle opt-in responses
  if (payload === 'SOCIAL_OPTIN_YES') {
    return await handleOptInResponse(senderId, true);
  }
  if (payload === 'SOCIAL_OPTIN_NO') {
    return await handleOptInResponse(senderId, false);
  }
  
  // Handle profile questions
  if (payload?.startsWith('SOCIAL_Q')) {
    const parsed = parseQuestionAnswer(payload);
    if (parsed) {
      return await handleProfileQuestion(senderId, parsed.questionNum, parsed.answer);
    }
  }
  
  // Handle post-profile actions
  if (payload === 'SOCIAL_BACK_EVENTS') {
    return { continueToEvents: true };
  }
  if (payload === 'SOCIAL_FIND_NOW') {
    const profile = await getSocialProfile(senderId);
    const matches = await findCompatibleMatches(senderId, profile?.lastEventContext);
    return formatMatchResults(matches, profile?.lastEventContext);
  }
  
  // Handle match requests
  if (payload?.startsWith('MATCH_REQUEST_')) {
    const targetId = payload.replace('MATCH_REQUEST_', '');
    const profile = await getSocialProfile(senderId);
    const eventTitle = profile?.lastEventContext?.eventTitle || 'an event';
    return await requestMatch(senderId, targetId, profile?.lastEventContext?.eventId, eventTitle);
  }
  
  // Handle match responses
  if (payload?.startsWith('MATCH_ACCEPT_')) {
    const requestId = payload.replace('MATCH_ACCEPT_', '');
    return await handleMatchResponse(senderId, requestId, true);
  }
  if (payload?.startsWith('MATCH_DECLINE_')) {
    const requestId = payload.replace('MATCH_DECLINE_', '');
    return await handleMatchResponse(senderId, requestId, false);
  }
  
  // Handle show more
  if (payload === 'MATCH_SHOW_MORE') {
    const profile = await getSocialProfile(senderId);
    const matches = await findCompatibleMatches(senderId, profile?.lastEventContext);
    return formatMatchResults(matches.slice(3, 6), profile?.lastEventContext);
  }
  
  // Default: start opt-in flow
  return await startOptIn(senderId);
}

// =====================
// EXPORTS
// =====================

module.exports = {
  // Flow handlers
  handleSocialFlow,
  startOptIn,
  handleOptInResponse,
  handleProfileQuestion,
  getNextQuestion,
  parseQuestionAnswer,
  
  // Matching
  findCompatibleMatches,
  formatAnonymousMatch,
  formatMatchResults,
  canSendMatchRequest,
  requestMatch,
  handleMatchResponse,
  revealProfiles,
  
  // Safety
  handleDeleteAllData,
  handleOptOut,
  handleStopMatching,
  handleReport,
  
  // Utilities
  detectSocialIntent,
  expireOldRequests,
  
  // Constants
  SOCIAL_QUESTIONS,
  SOCIAL_INTENT_PHRASES
};
