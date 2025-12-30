const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

// Validate required environment variables
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGODB_URI) {
    console.error('MONGODB_URI or MONGO_URI environment variable is required');
    process.exit(1);
}

async function extractFiltersFromMongoDB() {
    let client;

    try {
        console.log('🔗 Connecting to MongoDB...');
        client = new MongoClient(MONGODB_URI);
        await client.connect();

        const db = client.db('nyc-events');
        const collection = db.collection('restaurants');

        console.log('📊 Extracting unique cuisines...');
        const cuisines = await collection.distinct('cuisineDescription');

        console.log('📍 Extracting boroughs from addresses...');
        const addresses = await collection.distinct('fullAddress');

        // Extract boroughs from addresses
        const boroughSet = new Set();
        const boroughPatterns = {
            'Manhattan': /manhattan|new york, ny/i,
            'Brooklyn': /brooklyn/i,
            'Queens': /queens/i,
            'Bronx': /bronx/i,
            'Staten Island': /staten island/i
        };

        addresses.forEach(address => {
            if (!address) return;
            for (const [borough, pattern] of Object.entries(boroughPatterns)) {
                if (pattern.test(address)) {
                    boroughSet.add(borough);
                }
            }
        });

        console.log('💰 Extracting price levels...');
        const priceLevels = await collection.distinct('priceLevel');

        console.log('⭐ Extracting rating range...');
        const ratingStats = await collection.aggregate([
            {
                $group: {
                    _id: null,
                    minRating: { $min: '$rating' },
                    maxRating: { $max: '$rating' },
                    avgRating: { $avg: '$rating' }
                }
            }
        ]).toArray();

        // Build cuisine mapping (purely data-driven, no hardcoded keywords)
        const cuisineMapping = {};
        cuisines.filter(c => c).forEach(cuisine => {
            cuisineMapping[cuisine] = [cuisine.toLowerCase()];
        });

        // Build borough mapping with neighborhood keywords
        const boroughMapping = {
            'Manhattan': ['manhattan', 'midtown', 'downtown', 'uptown', 'harlem', 'soho', 'tribeca', 'chelsea', 'east village', 'west village'],
            'Brooklyn': ['brooklyn', 'williamsburg', 'bushwick', 'dumbo', 'park slope', 'bed-stuy'],
            'Queens': ['queens', 'flushing', 'astoria', 'jackson heights', 'long island city'],
            'Bronx': ['bronx', 'fordham'],
            'Staten Island': ['staten island']
        };

        const filters = {
            cuisines: cuisineMapping,
            boroughs: boroughMapping,
            priceLevels: priceLevels.filter(p => p != null).sort(),
            ratingRange: ratingStats[0] || { minRating: 0, maxRating: 5, avgRating: 3.5 },
            extractedAt: new Date().toISOString(),
            totalRestaurants: await collection.countDocuments()
        };

        // Write to file
        const outputPath = path.join(__dirname, '..', 'data', 'restaurant_filters.json');
        fs.writeFileSync(outputPath, JSON.stringify(filters, null, 2));

        console.log('\nFilter extraction complete!');
        console.log(`Saved to: ${outputPath}`);
        console.log(`\nSummary:`);
        console.log(`   - Total Restaurants: ${filters.totalRestaurants}`);
        console.log(`   - Unique Cuisines: ${Object.keys(cuisineMapping).length}`);
        console.log(`   - Boroughs: ${Object.keys(boroughMapping).length}`);
        console.log(`   - Price Levels: ${priceLevels.join(', ')}`);
        console.log(`   - Rating Range: ${ratingStats[0]?.minRating?.toFixed(1)} - ${ratingStats[0]?.maxRating?.toFixed(1)}`);

        return filters;

    } catch (error) {
        console.error('Error extracting filters:', error);
        throw error;
    } finally {
        if (client) {
            await client.close();
            console.log('\nMongoDB connection closed');
        }
    }
}

// Run if executed directly
if (require.main === module) {
    extractFiltersFromMongoDB()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { extractFiltersFromMongoDB };
