const { MongoClient } = require('mongodb');

// Validate required environment variables
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const LIMITS = {
    GEMINI_REQUESTS: 100,
    WEB_SEARCHES: 20
};

let mongoClient = null;
let limitsCollection = null;

async function connectToMongoDB() {
    if (limitsCollection) return limitsCollection;

    if (!MONGODB_URI) {
        console.error('MongoDB URI not found in environment variables (Rate Limiter)');
        return null;
    }

    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        const db = mongoClient.db('nyc-events');
        limitsCollection = db.collection('user_limits');
        console.log('Connected to MongoDB user_limits collection');
        return limitsCollection;
    } catch (err) {
        console.error('Failed to connect to MongoDB in rate_limiter:', err.message);
        return null;
    }
}

async function checkAndIncrementGemini(userId) {
    const collection = await connectToMongoDB();
    // Fail open if database is unreachable so we don't block users due to infrastructure issues
    if (!collection) return true;

    const today = new Date().toISOString().split('T')[0];

    try {
        const userRecord = await collection.findOne({ userId });

        // Reset if new day or new user
        if (!userRecord || userRecord.date !== today) {
            await collection.updateOne(
                { userId },
                { $set: { date: today, gemini: 1, search: 0 } },
                { upsert: true }
            );
            console.log(`User ${userId} Gemini usage: 1/${LIMITS.GEMINI_REQUESTS} (Reset)`);
            return true;
        }

        // Check limit
        if (userRecord.gemini >= LIMITS.GEMINI_REQUESTS) {
            console.log(`User ${userId} Gemini limit exceeded: ${userRecord.gemini}/${LIMITS.GEMINI_REQUESTS}`);
            return false;
        }

        // Increment
        await collection.updateOne(
            { userId },
            { $inc: { gemini: 1 } }
        );
        console.log(`User ${userId} Gemini usage: ${userRecord.gemini + 1}/${LIMITS.GEMINI_REQUESTS}`);
        return true;
    } catch (err) {
        console.error('Error checking Gemini rate limit:', err);
        return true; // Fail open
    }
}

async function checkAndIncrementSearch(userId) {
    const collection = await connectToMongoDB();
    if (!collection) return true;

    const today = new Date().toISOString().split('T')[0];

    try {
        const userRecord = await collection.findOne({ userId });

        // Reset if new day or new user
        if (!userRecord || userRecord.date !== today) {
            await collection.updateOne(
                { userId },
                { $set: { date: today, gemini: 0, search: 1 } },
                { upsert: true }
            );
            console.log(`User ${userId} Web Search usage: 1/${LIMITS.WEB_SEARCHES} (Reset)`);
            return true;
        }

        // Check limit
        if (userRecord.search >= LIMITS.WEB_SEARCHES) {
            console.log(`User ${userId} Web Search limit exceeded: ${userRecord.search}/${LIMITS.WEB_SEARCHES}`);
            return false;
        }

        // Increment
        await collection.updateOne(
            { userId },
            { $inc: { search: 1 } }
        );
        console.log(`User ${userId} Web Search usage: ${userRecord.search + 1}/${LIMITS.WEB_SEARCHES}`);
        return true;
    } catch (err) {
        console.error('Error checking Web Search rate limit:', err);
        return true; // Fail open
    }
}

module.exports = {
    checkAndIncrementGemini,
    checkAndIncrementSearch
};
