#!/usr/bin/env node

/**
 * Reset Rate Limit Script
 * Usage: node scripts/reset_rate_limit.js [userId]
 * 
 * If no userId is provided, it will reset the "test-user" (used by the web frontend)
 */

const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function resetRateLimit(userId) {
    if (!MONGODB_URI) {
        console.error('❌ MONGODB_URI not found in environment variables');
        process.exit(1);
    }

    const client = new MongoClient(MONGODB_URI);
    
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB');
        
        const db = client.db('nyc-events');
        const collection = db.collection('user_limits');
        
        const today = new Date().toISOString().split('T')[0];
        
        const result = await collection.updateOne(
            { userId },
            { $set: { date: today, gemini: 0, search: 0 } },
            { upsert: true }
        );
        
        if (result.matchedCount > 0 || result.upsertedCount > 0) {
            console.log(`✅ Rate limits reset for user: ${userId}`);
            console.log('   Gemini requests: 0/100');
            console.log('   Web searches: 0/20');
        }
        
        // Show current state
        const record = await collection.findOne({ userId });
        console.log('\n📊 Current record:', record);
        
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await client.close();
        console.log('\n👋 Disconnected from MongoDB');
    }
}

// Get userId from command line or default to "test-user"
const userId = process.argv[2] || 'test-user';
console.log(`\n🔄 Resetting rate limits for user: ${userId}\n`);

resetRateLimit(userId);

