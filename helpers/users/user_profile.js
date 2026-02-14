// In-memory User Profile store
// NOTE: This will reset whenever the server restarts or Vercel function cold starts.

const profiles = new Map();

function createDefaultProfile(senderId) {
  return {
    _id: senderId,
    username: null,
    foodProfile: {
      dietary: [],
      budget: null,
      borough: null,
      craving: null,
      favSpots: []
    },
    context: {
      lastCategory: null,
      lastFilters: null,
      lastIntent: null,
      lastQuerySignature: null,
      pool: [],
      page: 0,
      shownKeys: [],
      shownDedupeKeys: [],
      shownNames: [],
      shownEventIds: [],
      lastEventTitle: null,
      lastEventFilters: null,
      pendingType: null,
      pendingQuery: null,
      pendingFilters: null,
      pendingGate: null,
      lastUpdatedAt: null
    },
    firstSeen: new Date(),
    lastSeen: new Date()
  };
}

async function getOrCreateProfile(senderId) {
  if (!profiles.has(senderId)) {
    profiles.set(senderId, createDefaultProfile(senderId));
    console.log(`[MEMORY] Created new in-memory profile for ${senderId}`);
  } else {
    const profile = profiles.get(senderId);
    profile.lastSeen = new Date();
  }
  return profiles.get(senderId);
}

async function updateProfile(senderId, updates) {
  const profile = profiles.get(senderId);
  if (!profile) return false;
  Object.assign(profile, updates);
  return true;
}

async function deleteProfile(senderId) {
  return profiles.delete(senderId);
}

async function getProfile(senderId) {
  return profiles.get(senderId) || null;
}

async function profileExists(senderId) {
  return profiles.has(senderId);
}

async function updateContext(senderId, contextUpdates) {
  const profile = profiles.get(senderId);
  if (!profile) return false;

  for (const [key, value] of Object.entries(contextUpdates)) {
    profile.context[key] = value;
  }
  profile.context.lastUpdatedAt = new Date();
  return true;
}

async function addShownRestaurants(senderId, dedupeKeys, names = []) {
  const profile = profiles.get(senderId);
  if (!profile) return;

  profile.context.lastUpdatedAt = new Date();
  
  if (dedupeKeys.length > 0) {
    profile.context.shownDedupeKeys = [...(profile.context.shownDedupeKeys || []), ...dedupeKeys].slice(-100);
  }
  
  if (names.length > 0) {
    profile.context.shownNames = [...(profile.context.shownNames || []), ...names].slice(-100);
  }
}

async function addShownEvents(senderId, ids) {
  const profile = profiles.get(senderId);
  if (!profile) return;

  profile.context.shownEventIds = [...(profile.context.shownEventIds || []), ...ids].slice(-50);
  profile.context.lastUpdatedAt = new Date();
}

async function clearContext(senderId) {
  const profile = profiles.get(senderId);
  if (!profile) return false;

  profile.context = {
    lastCategory: null,
    lastFilters: null,
    lastIntent: null,
    pool: [],
    page: 0,
    shownKeys: [],
    shownDedupeKeys: [],
    shownNames: [],
    shownEventIds: [],
    lastEventTitle: null,
    lastEventFilters: null,
    pendingType: null,
    pendingQuery: null,
    pendingFilters: null,
    pendingGate: null,
    lastUpdatedAt: null
  };
  return true;
}

async function getContext(senderId) {
  const profile = profiles.get(senderId);
  if (!profile?.context) return null;
  
  const ctx = profile.context;
  if (!ctx.lastUpdatedAt) return null;
  
  const age = Date.now() - new Date(ctx.lastUpdatedAt).getTime();
  const TTL = 30 * 60 * 1000; // 30 minutes
  
  if (age > TTL) {
    await clearContext(senderId);
    return null;
  }
  
  return ctx;
}

module.exports = {
  getOrCreateProfile,
  updateProfile,
  deleteProfile,
  getProfile,
  profileExists,
  updateContext,
  addShownRestaurants,
  addShownEvents,
  clearContext,
  getContext,
};
