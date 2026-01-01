const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function getEventCount() {
    if (!MONGODB_URI) {
        console.error('No MONGODB_URI found');
        process.exit(1);
    }

    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db('goodrec');
        const eventsCollection = db.collection('events');
        const count = await eventsCollection.countDocuments({});
        const activeCount = await eventsCollection.countDocuments({ isActive: true });

        console.log(`Total NYC Events: ${count}`);
        console.log(`Active NYC Events: ${activeCount}`);

        // Count by source (platform)
        console.log('\nEvents by Source:');
        const sources = await eventsCollection.aggregate([
            { $group: { _id: "$platform", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]).toArray();

        sources.forEach(source => {
            console.log(`- ${source._id || 'Unknown'}: ${source.count}`);
        });
    } catch (err) {
        console.error('Error querying events:', err.message);
    } finally {
        await client.close();
    }
}

getEventCount();
