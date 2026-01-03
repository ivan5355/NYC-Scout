// User Profile store using MongoDB
// Keyed by IG sender ID (NOT username)
// Now includes conversation context for "show me more"

const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

let mongoClient = null;
let profilesCollection = null;

async function connectToProfiles() {
  if (mongoClient && profilesCollection) return profilesCollection;

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    profilesCollection = db.collection('user_profiles');
    await profilesCollection.createIndex({ _id: 1 });
    console.log('Connected to MongoDB user_profiles collection');
    return profilesCollection;
  } catch (err) {
    console.error('Failed to connect to user_profiles:', err.message);
    return null;
  }
}

// Get or create user profile by sender ID
async function getOrCreateProfile(senderId) {
  const collection = await connectToProfiles();
  if (!collection) return null;

  try {
    let profile = await collection.findOne({ _id: senderId });
    
    if (!profile) {
      profile = {
        _id: senderId,
        username: null,
        foodProfile: {
          dietary: [],
          budget: null,
          borough: null,
          craving: null,
          favSpots: []
        },
        // Social matching profile
        socialProfile: {
          optIn: false,              // Has user opted into matching
          optInAt: null,             // When they opted in
          matchingEnabled: true,     // Can be disabled without deleting
          borough: null,             // "Manhattan" | "Brooklyn" | "Queens" | "Bronx" | "Anywhere"
          vibe: null,                // "chill" | "social" | "party" | "activity"
          availability: null,        // "weeknights" | "weekends" | "anytime"
          groupSize: null,           // "one" | "small" | "any"
          profileCompletedAt: null,
          onboardingStep: 0,         // 0-4 (which question, 0 = not started)
          lastEventContext: null,    // { eventId, eventTitle, eventTimeWindow, borough }
          lastActiveAt: null,
          createdAt: null,
          updatedAt: null
        },
        // Conversation context (persisted for "show me more" and constraint gate)
        context: {
          lastCategory: null,
          lastFilters: null,
          lastIntent: null,          // Full intent object from last search
          lastQuerySignature: null,  // dish+borough+budget+dietary for "more" validation
          pool: [],                  // Restaurant results pool for pagination
          page: 0,                   // Current page in pool
          shownKeys: [],             // dedupeKeys of shown restaurants (for exclusion)
          shownDedupeKeys: [],       // Restaurant dedupeKeys (name|address normalized)
          shownNames: [],            // Restaurant names (for web search exclusion)
          shownEventIds: [],
          lastEventTitle: null,      // For social matching context
          lastEventFilters: null,    // Event filters for follow-up
          pendingType: null,         // 'restaurant_gate' | 'event_gate' | 'social_gate' | null
          pendingQuery: null,        // Original query text
          pendingFilters: null,      // Partial filters extracted
          pendingGate: null,         // Gate question text
          lastUpdatedAt: null
        },
        firstSeen: new Date(),
        lastSeen: new Date()
      };
      await collection.insertOne(profile);
      console.log(`Created new profile for ${senderId}`);
    } else {
      await collection.updateOne(
        { _id: senderId },
        { $set: { lastSeen: new Date() } }
      );
      profile.lastSeen = new Date();
    }
    
    return profile;
  } catch (err) {
    console.error('Error in getOrCreateProfile:', err.message);
    return null;
  }
}

// Update profile
async function updateProfile(senderId, updates) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  try {
    await collection.updateOne(
      { _id: senderId },
      { $set: updates }
    );
    return true;
  } catch (err) {
    console.error('Error updating profile:', err.message);
    return false;
  }
}

// Delete user data (returns true, does NOT recreate)
async function deleteProfile(senderId) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  try {
    await collection.deleteOne({ _id: senderId });
    console.log(`Deleted profile for ${senderId}`);
    return true;
  } catch (err) {
    console.error('Error deleting profile:', err.message);
    return false;
  }
}

// Get profile by sender ID (does NOT create)
async function getProfile(senderId) {
  const collection = await connectToProfiles();
  if (!collection) return null;

  try {
    return await collection.findOne({ _id: senderId });
  } catch (err) {
    console.error('Error getting profile:', err.message);
    return null;
  }
}

// Check if profile exists
async function profileExists(senderId) {
  const collection = await connectToProfiles();
  if (!collection) return false;
  
  try {
    const count = await collection.countDocuments({ _id: senderId });
    return count > 0;
  } catch (err) {
    return false;
  }
}

// Update conversation context (for "show me more")
async function updateContext(senderId, contextUpdates) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  const updates = {};
  for (const [key, value] of Object.entries(contextUpdates)) {
    updates[`context.${key}`] = value;
  }
  updates['context.lastUpdatedAt'] = new Date();

  try {
    await collection.updateOne(
      { _id: senderId },
      { $set: updates }
    );
    return true;
  } catch (err) {
    console.error('Error updating context:', err.message);
    return false;
  }
}

// Add shown restaurant dedupeKeys and names (for no-repeat)
async function addShownRestaurants(senderId, dedupeKeys, names = []) {
  const collection = await connectToProfiles();
  if (!collection) return;

  try {
    const updates = {
      $set: { 'context.lastUpdatedAt': new Date() }
    };
    
    if (dedupeKeys.length > 0) {
      updates.$push = updates.$push || {};
      updates.$push['context.shownDedupeKeys'] = { 
        $each: dedupeKeys, 
        $slice: -100
      };
    }
    
    if (names.length > 0) {
      updates.$push = updates.$push || {};
      updates.$push['context.shownNames'] = { 
        $each: names, 
        $slice: -100
      };
    }
    
    await collection.updateOne({ _id: senderId }, updates);
  } catch (err) {
    console.error('Error adding shown restaurants:', err.message);
  }
}

// Add shown event IDs
async function addShownEvents(senderId, ids) {
  const collection = await connectToProfiles();
  if (!collection) return;

  try {
    await collection.updateOne(
      { _id: senderId },
      { 
        $push: { 
          'context.shownEventIds': { 
            $each: ids, 
            $slice: -50
          } 
        },
        $set: { 'context.lastUpdatedAt': new Date() }
      }
    );
  } catch (err) {
    console.error('Error adding shown events:', err.message);
  }
}

// Clear context (but keep profile) - for "reset" command
async function clearContext(senderId) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  try {
    await collection.updateOne(
      { _id: senderId },
      { 
        $set: { 
          'context.lastCategory': null,
          'context.lastFilters': null,
          'context.lastIntent': null,
          'context.pool': [],
          'context.page': 0,
          'context.shownKeys': [],
          'context.shownDedupeKeys': [],
          'context.shownNames': [],
          'context.shownEventIds': [],
          'context.lastEventTitle': null,
          'context.lastEventFilters': null,
          'context.pendingType': null,
          'context.pendingQuery': null,
          'context.pendingFilters': null,
          'context.pendingGate': null,
          'context.lastUpdatedAt': null
        } 
      }
    );
    return true;
  } catch (err) {
    console.error('Error clearing context:', err.message);
    return false;
  }
}

// Get context (check if stale - 30 min TTL)
async function getContext(senderId) {
  const profile = await getProfile(senderId);
  if (!profile?.context) return null;
  
  const ctx = profile.context;
  if (!ctx.lastUpdatedAt) return null;
  
  const age = Date.now() - new Date(ctx.lastUpdatedAt).getTime();
  const TTL = 30 * 60 * 1000; // 30 minutes
  
  if (age > TTL) {
    // Context is stale, clear it
    await clearContext(senderId);
    return null;
  }
  
  return ctx;
}

// =====================
// SOCIAL PROFILE FUNCTIONS
// =====================

// Get social profile by sender ID
async function getSocialProfile(senderId) {
  const profile = await getProfile(senderId);
  return profile?.socialProfile || null;
}

// Update social profile fields
async function updateSocialProfile(senderId, updates) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  const setUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    setUpdates[`socialProfile.${key}`] = value;
  }
  setUpdates['socialProfile.updatedAt'] = new Date();
  setUpdates['socialProfile.lastActiveAt'] = new Date();

  try {
    await collection.updateOne(
      { _id: senderId },
      { $set: setUpdates }
    );
    return true;
  } catch (err) {
    console.error('Error updating social profile:', err.message);
    return false;
  }
}

// Delete social profile (but keep user doc and food profile)
async function deleteSocialProfile(senderId) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  try {
    await collection.updateOne(
      { _id: senderId },
      { 
        $set: { 
          'socialProfile.optIn': false,
          'socialProfile.optInAt': null,
          'socialProfile.matchingEnabled': true,
          'socialProfile.borough': null,
          'socialProfile.vibe': null,
          'socialProfile.availability': null,
          'socialProfile.groupSize': null,
          'socialProfile.profileCompletedAt': null,
          'socialProfile.onboardingStep': 0,
          'socialProfile.lastEventContext': null,
          'socialProfile.lastActiveAt': null,
          'socialProfile.createdAt': null,
          'socialProfile.updatedAt': null
        } 
      }
    );
    console.log(`Deleted social profile for ${senderId}`);
    return true;
  } catch (err) {
    console.error('Error deleting social profile:', err.message);
    return false;
  }
}

// Set social opt-in status
async function setSocialOptIn(senderId, status) {
  const collection = await connectToProfiles();
  if (!collection) return false;

  const updates = {
    'socialProfile.optIn': status,
    'socialProfile.updatedAt': new Date(),
    'socialProfile.lastActiveAt': new Date()
  };
  
  if (status) {
    updates['socialProfile.optInAt'] = new Date();
    updates['socialProfile.createdAt'] = new Date();
    updates['socialProfile.matchingEnabled'] = true;
  }

  try {
    await collection.updateOne(
      { _id: senderId },
      { $set: updates }
    );
    return true;
  } catch (err) {
    console.error('Error setting social opt-in:', err.message);
    return false;
  }
}

// Check if social profile is complete (all 4 questions answered)
async function isSocialProfileComplete(senderId) {
  const profile = await getSocialProfile(senderId);
  if (!profile) return false;
  
  return profile.optIn && 
         profile.borough && 
         profile.vibe && 
         profile.availability && 
         profile.groupSize &&
         profile.profileCompletedAt;
}

// Update last event context for matching
async function updateLastEventContext(senderId, eventContext) {
  return await updateSocialProfile(senderId, {
    lastEventContext: eventContext
  });
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
  // Social profile functions
  getSocialProfile,
  updateSocialProfile,
  deleteSocialProfile,
  setSocialOptIn,
  isSocialProfileComplete,
  updateLastEventContext
};