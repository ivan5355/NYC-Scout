/**
 * Extract unique event categories from MongoDB
 * and save them to a JSON file for use in query classification
 */

const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "goodrec";
const COLLECTION_NAME = "events";

async function extractCategories() {
  if (!MONGO_URI) {
    console.error("MONGO_URI not found");
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("Connected to MongoDB");

  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION_NAME);

  // Get all unique values from relevant fields
  const [names, descriptions, platforms, locations] = await Promise.all([
    collection.distinct("name"),
    collection.distinct("description"),
    collection.distinct("platform"),
    collection.distinct("location"),
  ]);

  console.log(`Found ${names.length} unique event names`);
  console.log(`Found ${descriptions.length} unique descriptions`);
  console.log(`Found ${platforms.length} unique platforms`);

  // Extract category keywords from event names and descriptions
  const categoryKeywords = new Set();
  
  // Common event category words to look for
  const categoryPatterns = [
    // Sports
    /soccer/i, /football/i, /basketball/i, /baseball/i, /hockey/i, /tennis/i,
    /running/i, /marathon/i, /5k/i, /10k/i, /cycling/i, /fitness/i, /yoga/i,
    /golf/i, /boxing/i, /wrestling/i, /mma/i, /skating/i,
    
    // Music & Performance
    /concert/i, /music/i, /jazz/i, /rock/i, /hip.?hop/i, /classical/i, /orchestra/i,
    /dj/i, /live music/i, /band/i, /singer/i, /karaoke/i, /open mic/i,
    /opera/i, /symphony/i, /choir/i,
    
    // Comedy & Theater
    /comedy/i, /stand.?up/i, /improv/i, /theater/i, /theatre/i, /play/i,
    /musical/i, /broadway/i, /drama/i, /performance/i,
    
    // Art & Culture
    /art/i, /gallery/i, /museum/i, /exhibition/i, /painting/i, /sculpture/i,
    /photography/i, /film/i, /movie/i, /screening/i, /documentary/i,
    /dance/i, /ballet/i, /contemporary/i,
    
    // Food & Drink
    /food/i, /tasting/i, /wine/i, /beer/i, /cocktail/i, /brunch/i,
    /cooking/i, /culinary/i, /chef/i, /restaurant/i,
    
    // Markets & Fairs
    /market/i, /fair/i, /festival/i, /flea/i, /farmers/i, /craft/i,
    /vintage/i, /antique/i,
    
    // Education & Networking
    /workshop/i, /class/i, /seminar/i, /lecture/i, /talk/i, /panel/i,
    /networking/i, /meetup/i, /conference/i, /summit/i,
    
    // Family & Kids
    /kids/i, /children/i, /family/i, /storytime/i, /puppet/i,
    
    // Outdoor & Nature
    /outdoor/i, /park/i, /garden/i, /nature/i, /hike/i, /walk/i, /tour/i,
    /boat/i, /cruise/i,
    
    // Nightlife & Social
    /party/i, /club/i, /nightlife/i, /social/i, /mixer/i, /singles/i,
    /trivia/i, /game night/i, /bingo/i,
    
    // Wellness
    /wellness/i, /meditation/i, /mindfulness/i, /healing/i, /spa/i,
    
    // Special Events
    /parade/i, /celebration/i, /holiday/i, /ceremony/i, /opening/i,
    /launch/i, /premiere/i, /gala/i, /fundraiser/i, /charity/i,
  ];

  // Extract categories from names and descriptions
  const allText = [...names, ...descriptions].join(" ");
  
  for (const pattern of categoryPatterns) {
    const match = allText.match(pattern);
    if (match) {
      // Normalize the category name
      const category = match[0].toLowerCase().replace(/[^a-z]/g, '');
      categoryKeywords.add(category);
    }
  }

  // Also get unique event types/categories from the data directly
  const eventTypes = await collection.aggregate([
    { $match: { description: { $exists: true, $ne: null } } },
    { $project: { 
      words: { $split: [{ $toLower: "$description" }, " "] }
    }},
    { $unwind: "$words" },
    { $group: { _id: "$words", count: { $sum: 1 } } },
    { $match: { count: { $gte: 3 } } }, // At least 3 occurrences
    { $sort: { count: -1 } },
    { $limit: 100 }
  ]).toArray();

  // Filter to meaningful category words
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were',
    'will', 'have', 'has', 'had', 'been', 'being', 'your', 'our', 'their',
    'nyc', 'new', 'york', 'city', 'event', 'events', 'check', 'source', 'details',
    'public', 'free', 'open', 'all', 'ages', 'welcome', 'join', 'come',
    'a', 'an', 'in', 'on', 'at', 'to', 'of', 'is', 'it', '-', '—', '&'
  ]);

  const meaningfulWords = eventTypes
    .map(w => w._id)
    .filter(w => w.length > 3 && !stopWords.has(w) && /^[a-z]+$/.test(w));

  meaningfulWords.forEach(w => categoryKeywords.add(w));

  // Create final categories list
  const categories = Array.from(categoryKeywords).sort();

  // Group into high-level categories
  const groupedCategories = {
    sports: ['soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 
             'running', 'marathon', 'cycling', 'fitness', 'yoga', 'golf', 'boxing',
             'wrestling', 'skating', 'swimming'],
    music: ['concert', 'music', 'jazz', 'rock', 'hiphop', 'classical', 'orchestra',
            'dj', 'band', 'singer', 'karaoke', 'opera', 'symphony', 'choir'],
    comedy: ['comedy', 'standup', 'improv', 'openmic'],
    theater: ['theater', 'theatre', 'play', 'musical', 'broadway', 'drama', 'performance'],
    art: ['art', 'gallery', 'museum', 'exhibition', 'painting', 'sculpture', 'photography'],
    film: ['film', 'movie', 'screening', 'documentary', 'cinema'],
    dance: ['dance', 'ballet', 'contemporary', 'salsa', 'swing'],
    food: ['food', 'tasting', 'wine', 'beer', 'cocktail', 'brunch', 'cooking', 'culinary'],
    market: ['market', 'fair', 'festival', 'flea', 'farmers', 'craft', 'vintage'],
    education: ['workshop', 'class', 'seminar', 'lecture', 'talk', 'panel', 'conference'],
    networking: ['networking', 'meetup', 'social', 'mixer', 'singles'],
    family: ['kids', 'children', 'family', 'storytime', 'puppet'],
    outdoor: ['outdoor', 'park', 'garden', 'nature', 'hike', 'walk', 'tour', 'boat'],
    nightlife: ['party', 'club', 'nightlife', 'trivia', 'bingo', 'gamenight'],
    wellness: ['wellness', 'meditation', 'mindfulness', 'healing', 'spa'],
    special: ['parade', 'celebration', 'holiday', 'ceremony', 'gala', 'fundraiser', 'charity'],
  };

  // Save to JSON file
  const output = {
    generatedAt: new Date().toISOString(),
    totalEvents: await collection.countDocuments(),
    platforms: platforms,
    categories: categories,
    groupedCategories: groupedCategories,
    topKeywords: meaningfulWords.slice(0, 50),
  };

  const outputPath = path.join(__dirname, "..", "data", "event_categories.json");
  
  // Ensure data directory exists
  const dataDir = path.dirname(outputPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved categories to ${outputPath}`);

  console.log("\n=== Summary ===");
  console.log(`Total events: ${output.totalEvents}`);
  console.log(`Platforms: ${platforms.join(", ")}`);
  console.log(`\nTop-level categories (${Object.keys(groupedCategories).length}):`);
  Object.entries(groupedCategories).forEach(([cat, keywords]) => {
    console.log(`  ${cat}: ${keywords.slice(0, 5).join(", ")}...`);
  });

  await client.close();
}

(async () => {
  try {
    await extractCategories();
    process.exit(0);
  } catch (err) {
    console.error("Failed:", err);
    process.exit(1);
  }
})();

