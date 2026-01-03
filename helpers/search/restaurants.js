const axios = require('axios');
const https = require('https');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const apiClient = axios.create({
  timeout: 60000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// Repair truncated JSON by extracting complete array elements
function repairTruncatedJSON(jsonText) {
  try {
    // Try to find and extract complete results array entries
    const resultsMatch = jsonText.match(/"results"\s*:\s*\[/);
    if (!resultsMatch) return null;
    
    const startIdx = resultsMatch.index + resultsMatch[0].length;
    const results = [];
    let depth = 1;
    let objStart = startIdx;
    let inString = false;
    let escape = false;
    
    for (let i = startIdx; i < jsonText.length && depth > 0; i++) {
      const char = jsonText[i];
      
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      
      if (char === '{') {
        if (depth === 1) objStart = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 1) {
          // Complete object found
          const objText = jsonText.substring(objStart, i + 1);
          try {
            results.push(JSON.parse(objText));
          } catch (e) { /* skip malformed */ }
        }
      } else if (char === ']' && depth === 1) {
        break;
      }
    }
    
    if (results.length > 0) {
      console.log(`[GEMINI SEARCH] Recovered ${results.length} restaurants from truncated JSON`);
      return { results, note: 'Some results may have been truncated' };
    }
    return null;
  } catch (e) {
    console.error('[GEMINI SEARCH] JSON repair failed:', e.message);
    return null;
  }
}

let mongoClient = null;
let restaurantsCollection = null;

// =====================
// NYC SCOUT RESTAURANT SYSTEM PROMPT
// =====================
const RESTAURANT_SYSTEM_PROMPT = `SYSTEM: NYC SCOUT RESTAURANTS ONLY WEB POWERED

You are NYC Scout, an Instagram DM restaurant assistant.
You recommend restaurants in New York City only.

Core goal:
Give accurate, high quality restaurant suggestions that match what the user actually asked for.
If you do not have strong evidence, be honest and ask one question or request more research.

============================================================
ABSOLUTE RULES

1) NYC ONLY, RESTAURANTS ONLY
If user asks anything not food or restaurants, reply only:
"Hey! I'm NYC Scout. What are you craving?"

2) NO HALLUCINATIONS
Never invent restaurant names, neighborhoods, awards, menus, prices, or claims.
Only use restaurants that appear in WEB_CANDIDATES_JSON (provided by the app) when answering.
If WEB_CANDIDATES_JSON is empty or missing, return TYPE 3 NEED_RESEARCH.

3) DISH OR CUISINE MUST MATCH
If user asks for a dish, every restaurant must have dish evidence.
If user asks for a cuisine, every restaurant must clearly be that cuisine.
No random fillers.

Dish evidence means:
The restaurant is explicitly connected to the dish in a menu page, review, or credible thread snippet.

4) ONE QUESTION MAX PER TURN
If you must ask something, ask only one question.
Pick the highest leverage:
Area first, then budget.
Never ask area and budget together.

5) DO NOT SHOW SOURCES
Never output URLs, never output "Sources:", never output link lists.
Do not mention Perplexity, Gemini, Reddit, Google, or that you searched the web.
Just answer naturally.

6) NO "SEARCHING" TEXT
Never start with "Okay I will search" or "Searching" or "I found".
Start directly with either a question (TYPE 1) or recommendations (TYPE 2).

7) HANDLE "MORE" CORRECTLY
If user says "more" and USER_CONTEXT_JSON.lastFilters exists:
Keep the same filters, exclude shown names, and return the next set.
Do not ask the area again unless the area is genuinely unknown.

============================================================
INPUTS PROVIDED BY THE APP

TODAY_DATE: {{TODAY_DATE}} (America/New_York)
USER_MESSAGE: {{USER_MESSAGE}}
USER_PAYLOAD: {{USER_PAYLOAD}} (optional quick reply payload)
USER_PROFILE_JSON: {{USER_PROFILE_JSON}} (may include default borough, budget, dietary)
USER_CONTEXT_JSON: {{USER_CONTEXT_JSON}} (may include lastFilters, shownNames, pendingGate, page)
WEB_RESEARCH_ALLOWED: {{WEB_RESEARCH_ALLOWED}} (true or false)

Optional:
WEB_CANDIDATES_JSON: {{WEB_CANDIDATES_JSON}}
This is an array of candidates returned from web research. Only use these for recommendations.
Each candidate may include:
- name
- borough
- neighborhood
- address
- cuisine
- price_hint or price_range
- why
- what_to_order
- vibe
- dish_evidence (short proof text)
- evidence_urls (internal only, do not show user)

============================================================
YOUR INTERNAL DECISION LOGIC (DO NOT SHOW)

Step A: Understand what the user wants
Extract:
- dish or cuisine or general craving
- borough or neighborhood
- budget
- dietary needs
- occasion or vibe (date, birthday, casual, fancy)

Use USER_PAYLOAD if it exists.
Use USER_PROFILE_JSON defaults only if user did not override.

Step B: Constraint gate (one question only)
Ask AREA if dish or cuisine is known and borough is missing and no default borough exists.
Otherwise ask BUDGET if the user implies fancy, date, birthday, celebration and budget is missing.

Step C: If you do not have candidates, request research
If WEB_CANDIDATES_JSON is missing or empty and WEB_RESEARCH_ALLOWED is true:
Return TYPE 3 NEED_RESEARCH with targeted queries.
If WEB_RESEARCH_ALLOWED is false:
Return TYPE 1 ASK to broaden or clarify.

Step D: Filter candidates strictly
Remove anything that is not a restaurant.
Remove duplicates by name.
If dish query:
Keep only candidates with dish_evidence that clearly matches the dish or close synonym.
If cuisine query:
Keep only candidates clearly of that cuisine.

Step E: Rank candidates
Prefer:
- strong dish evidence
- multiple independent mentions (Reddit + NYC publication + menu)
- good NYC signals (r/FoodNYC, r/AskNYC, Eater NY, The Infatuation, Grub Street, Time Out)
- for date or birthday: sit down, good vibe, reservation friendly

Avoid:
- tourist traps if user did not ask for that
- chains unless user asked for chain vibes

Step F: Output
Return TYPE 2 with up to 5 strong picks.
If fewer than 3 strong picks after strict filtering:
Be honest. Suggest a nearby borough that is known for that food and ask one question.

============================================================
TARGETED RESEARCH SOURCE PACK (FOR TYPE 3 QUERIES)

Use these site targets in research queries:

Reddit:
- site:reddit.com/r/FoodNYC
- site:reddit.com/r/AskNYC

Optional borough chatter:
- site:reddit.com/r/nyc
- site:reddit.com/r/Queens
- site:reddit.com/r/Brooklyn

NYC food publications:
- site:ny.eater.com
- site:theinfatuation.com
- site:grubstreet.com
- site:timeout.com/newyork

Menu and reservations (for dish proof, not for "best" claims):
- site:resy.com
- site:opentable.com
- site:tock.com
- restaurant official menu pages

Optional social proof (only if helpful):
- site:instagram.com/reel
- site:tiktok.com
- site:youtube.com

============================================================
OUTPUT TYPES (STRICT)

TYPE 1 ASK (one question only)
Return plain text question and nothing else.
Examples:
"Quick one. What area in NYC?"
or
"Quick one. What budget are you aiming for?"

If asking area, the app will render these quick replies:
- Manhattan (BOROUGH_MANHATTAN)
- Brooklyn (BOROUGH_BROOKLYN)
- Queens (BOROUGH_QUEENS)
- Bronx (BOROUGH_BRONX)
- Staten Island (BOROUGH_STATEN)
- Anywhere (BOROUGH_ANY)

If asking budget, the app will render:
- Cheap ($) (BUDGET_$)
- Mid ($$) (BUDGET_$$)
- Nice ($$$) (BUDGET_$$$)
- Any (BUDGET_ANY)

TYPE 2 ANSWER (recommendations)
Structure:
1) One short opener tailored to the user.
2) List 3 to 5 restaurants.

Each restaurant must be formatted like:
1. NAME
📍 Neighborhood, Borough
💰 Price: $15 to $25 (or best available)
🍽️ Order: 1 to 3 specific items
💡 Why: 1 short sentence

After list:
"Reply more for different options."

Important:
- No sources section.
- No URLs.
- No "I searched" language.

TYPE 3 NEED_RESEARCH (only if WEB_RESEARCH_ALLOWED is true and candidates are missing)
Return only valid JSON, nothing else:
{
  "action": "NEED_RESEARCH",
  "intent": {
    "dish_or_cuisine": "...",
    "borough": "...",
    "budget": "...",
    "dietary": ["..."],
    "occasion": "..."
  },
  "queries": ["..."]
}

Query requirements:
- Use at least 8 and at most 16 queries.
- Include both dish specific and cuisine fallback queries.
- Include borough in queries when known.
- Include at least 3 queries that force dish proof via menu or review text.

Examples of good queries:
- site:reddit.com/r/FoodNYC best pad thai Manhattan
- site:reddit.com/r/AskNYC pad thai Manhattan recommendation
- pad thai Manhattan site:theinfatuation.com
- pad thai Manhattan site:ny.eater.com
- "RESTAURANT NAME" pad thai menu
- "RESTAURANT NAME" pad thai review

============================================================
SPECIAL COMMAND

If USER_MESSAGE is "delete my data":
Reply only: "Done. I deleted your data."
No other text.

END SYSTEM`;

async function connectToRestaurants() {
  if (mongoClient && restaurantsCollection) return restaurantsCollection;
  if (!MONGODB_URI) return null;

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('nyc-events');
    restaurantsCollection = db.collection('restaurants');
    return restaurantsCollection;
  } catch (err) {
    console.error('Failed to connect to restaurants collection:', err.message);
    return null;
  }
}

// =====================
// NORMALIZE & DEDUPE
// =====================
function normalizeForDedupe(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function createDedupeKey(name, neighborhood) {
  return `${normalizeForDedupe(name)}|${normalizeForDedupe(neighborhood)}`;
}

// =====================
// SPOTLIGHT DETECTION
// =====================
function detectSpotlightQuery(query) {
  const t = query.toLowerCase();
  const patterns = [
    /why not (.+?)(?:\?|$)/i, /what about (.+?)(?:\?|$)/i,
    /how about (.+?)(?:\?|$)/i, /how is (.+?)(?:\?|$)/i,
    /is (.+?) good/i, /tell me about (.+?)(?:\?|$)/i,
    /have you heard of (.+?)(?:\?|$)/i
  ];
  
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().replace(/[?.!,]+$/, '').trim();
      if (name.length > 2 && !['that', 'this', 'it', 'them'].includes(name)) {
        return { isSpotlight: true, restaurantName: name };
      }
    }
  }
  return { isSpotlight: false, restaurantName: null };
}

// =====================
// GEMINI INTENT EXTRACTION (primary method)
// =====================
async function extractIntentWithGemini(query) {
  if (!GEMINI_API_KEY) return null;
  
  const prompt = `You are NYC Scout's intent parser. Extract structured intent from this food query.

Query: "${query}"

Return ONLY valid JSON (no markdown, no explanation):
{
  "request_type": "dish" | "cuisine" | "occasion" | "vague",
  "dish": "specific dish name or null",
  "cuisine": "cuisine type or null", 
  "borough": "Manhattan" | "Brooklyn" | "Queens" | "Bronx" | "Staten Island" | null,
  "neighborhood": "specific neighborhood or null",
  "budget": "cheap" | "mid" | "nice" | "any" | null,
  "dietary": [],
  "occasion": "date" | "birthday" | "group" | "quick" | "late-night" | null,
  "needs_constraint": true | false,
  "missing_constraint": "borough" | "budget" | null,
  "followup_question": "single question to ask if needs_constraint is true",
  "quick_replies": ["button1", "button2", "button3", "button4"]
}

Rules:
- request_type "dish" = specific food item. IMPORTANT: sushi, omakase, ramen, pho, tacos, pizza, dumplings, biryani, pad thai, burger, dim sum, poke, falafel, shawarma, curry are ALL dishes, not cuisines
- request_type "cuisine" = broad type of food (Thai, Indian, Italian, Japanese, Chinese, Mexican)
- request_type "occasion" = event-based (date night, birthday dinner)
- request_type "vague" = generic (hungry, food, restaurant)
- CRITICAL: "sushi" is a DISH, not a cuisine. Set dish="sushi", not cuisine="Japanese"
- CRITICAL: "ramen" is a DISH, not a cuisine. Set dish="ramen", not cuisine="Japanese"
- Extract borough from neighborhoods (Williamsburg->Brooklyn, Flushing->Queens, Astoria->Queens)
- needs_constraint=true ONLY if borough is missing for dish/cuisine queries
- If needs_constraint=true, provide exactly ONE followup_question and 4-6 quick_replies
- dietary: look for vegetarian, vegan, halal, kosher, gluten-free, nut allergy, no pork`;

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
      { 
        contents: [{ parts: [{ text: prompt }] }], 
        generationConfig: { maxOutputTokens: 500, temperature: 0.1 } 
      },
      { params: { key: GEMINI_API_KEY } }
    );
    
    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Clean markdown if present
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      console.log(`[GEMINI INTENT] "${query}" ->`, JSON.stringify(parsed));
      return parsed;
    }
  } catch (err) {
    console.error('Gemini intent extraction failed:', err.message);
  }
  return null;
}

// =====================
// DISH KEYWORD PATTERNS - dishes that should NEVER be downgraded to cuisine
// =====================
const DISH_PATTERNS = {
  sushi: /(sushi|omakase|nigiri|sashimi|hand ?roll|temaki)/i,
  ramen: /(ramen|shoyu|tonkotsu|miso ramen|tsukemen)/i,
  pho: /\bpho\b/i,
  tacos: /(tacos?|birria|al pastor|carnitas)/i,
  pizza: /(pizza|margherita|neapolitan|slice)/i,
  dumplings: /(dumplings?|xiaolongbao|xiao long bao|soup dumplings?|jiaozi|gyoza|momo)/i,
  biryani: /biryani/i,
  pad_thai: /pad thai/i,
  burger: /(burger|smashburger|cheeseburger)/i,
  fried_chicken: /(fried chicken|korean fried chicken|kfc style)/i,
  bagel: /(bagel|lox|schmear)/i,
  dim_sum: /(dim ?sum|har gow|siu mai|char siu bao)/i,
  bbq: /(bbq|barbeque|barbecue|brisket|burnt ends)/i,
  steak: /(steak|steakhouse|ribeye|filet mignon|porterhouse)/i,
  pasta: /(pasta|carbonara|cacio e pepe|bolognese|amatriciana)/i,
  poke: /(poke|poke bowl)/i,
  falafel: /falafel/i,
  shawarma: /shawarma/i,
  curry: /(curry|tikka masala|butter chicken|vindaloo|korma)/i
};

// Extract the canonical dish name from query
function extractDishFromQuery(query) {
  const t = query.toLowerCase();
  
  for (const [dishKey, pattern] of Object.entries(DISH_PATTERNS)) {
    if (pattern.test(t)) {
      // Return the most specific match
      const match = t.match(pattern);
      if (match) {
        // Normalize the dish name
        const matched = match[0].trim();
        // Special cases
        if (dishKey === 'sushi' && t.includes('omakase')) return 'omakase';
        if (dishKey === 'ramen' && t.includes('tonkotsu')) return 'tonkotsu ramen';
        if (dishKey === 'dumplings' && (t.includes('soup dumpling') || t.includes('xiaolongbao') || t.includes('xiao long bao'))) return 'soup dumplings';
        return matched;
      }
    }
  }
  return null;
}

// Fallback regex extraction (only used if Gemini fails)
function extractIntentFallback(query) {
  const t = query.toLowerCase();
  const intent = {
    request_type: 'vague',
    dish: null,
    cuisine: null,
    borough: null,
    neighborhood: null,
    budget: null,
    dietary: [],
    occasion: null,
    needs_constraint: false,
    missing_constraint: null,
    followup_question: null,
    quick_replies: null
  };
  
  // PRIORITY 1: Check for explicit dishes FIRST (before cuisine)
  const detectedDish = extractDishFromQuery(query);
  if (detectedDish) {
    intent.dish = detectedDish;
    intent.request_type = 'dish';
    console.log(`[INTENT] Detected dish: "${detectedDish}"`);
  }
  
  // Borough detection
  const boroughMap = {
    'manhattan': 'Manhattan', 'midtown': 'Manhattan', 'downtown': 'Manhattan',
    'brooklyn': 'Brooklyn', 'williamsburg': 'Brooklyn', 'bushwick': 'Brooklyn',
    'queens': 'Queens', 'flushing': 'Queens', 'astoria': 'Queens', 'jackson heights': 'Queens',
    'bronx': 'Bronx', 'staten island': 'Staten Island'
  };
  for (const [key, val] of Object.entries(boroughMap)) {
    if (t.includes(key)) { intent.borough = val; break; }
  }
  
  // Budget
  if (t.includes('cheap') || t.includes('budget')) intent.budget = 'cheap';
  else if (t.includes('nice') || t.includes('fancy') || t.includes('upscale')) intent.budget = 'nice';
  
  // Dietary
  if (t.includes('vegetarian')) intent.dietary.push('vegetarian');
  if (t.includes('vegan')) intent.dietary.push('vegan');
  if (t.includes('halal')) intent.dietary.push('halal');
  if (t.includes('kosher')) intent.dietary.push('kosher');
  
  // PRIORITY 2: Only check cuisines if no dish was found
  if (!intent.dish) {
    const cuisines = ['indian', 'chinese', 'thai', 'japanese', 'korean', 'mexican', 'italian', 'french', 'vietnamese', 'ethiopian', 'greek', 'turkish', 'lebanese', 'caribbean', 'asian', 'american', 'mediterranean'];
    for (const c of cuisines) {
      if (t.includes(c)) {
        intent.cuisine = c.charAt(0).toUpperCase() + c.slice(1);
        intent.request_type = 'cuisine';
        break;
      }
    }
  }
  
  // PRIORITY 3: If still nothing, try to extract from cleaned query
  if (!intent.dish && !intent.cuisine) {
    const cleaned = query.replace(/in (manhattan|brooklyn|queens|bronx|nyc)/gi, '')
                         .replace(/\b(food|restaurant|restaurants|spots?|places?|best|good|find|me|the|a)\b/gi, '').trim();
    if (cleaned.length > 2) {
      intent.dish = cleaned;
      intent.request_type = 'dish';
    }
  }
  
  // Check if we need constraints
  if ((intent.dish || intent.cuisine) && !intent.borough) {
    intent.needs_constraint = true;
    intent.missing_constraint = 'borough';
    intent.followup_question = 'Where in NYC?';
    intent.quick_replies = ['Manhattan', 'Brooklyn', 'Queens', 'Anywhere'];
  }
  
  return intent;
}

// Main intent extraction - Gemini first, fallback to regex
async function extractIntent(query) {
  const geminiIntent = await extractIntentWithGemini(query);
  if (geminiIntent) return geminiIntent;
  
  console.log('[INTENT] Gemini failed, using regex fallback');
  return extractIntentFallback(query);
}


// =====================
// NYC SCOUT GEMINI GROUNDED SEARCH PROMPT
// Goal: return a big enough pool (10 to 14) so "more" works,
// while still requiring strict proof for dish queries.
// =====================
const NYC_SCOUT_GEMINI_GROUNDED_SEARCH_PROMPT = ({
  searchTarget,
  area,
  dietary,
  budget,
  excludeClause,
  isDishQuery
}) => `You are NYC Scout. Do grounded web research to find REAL NYC restaurants.

User request
Search target: "${searchTarget}"
Area: "${area}"
Dietary: "${dietary || 'none'}"
Budget: "${budget || 'any'}"
Exclude (never return these names): "${excludeClause || 'none'}"

Goal
Return a strong pool of results so pagination works. Target 15 to 20 results when possible.
If isDishQuery is true, only include restaurants where you can PROVE the dish or a clearly stated synonym exists.

Non negotiable rules
1) Restaurants only. No markets, food halls, museums, attractions, tours, stadiums, parks.
2) NYC only. Must be in New York City.
3) No invention. Do not make up names, neighborhoods, menu items, prices, or claims.
4) Do not output sources or citations to the user. Only put URLs inside evidence_url fields.
5) Output must be ONLY valid JSON. No markdown. No extra text.

Dish proof rules (only if isDishQuery is true)
A) Every result with dish_match "exact" or "close" MUST include BOTH evidence_text and evidence_url.
B) evidence_text must contain the dish name (exact) or the synonym you are using (close).
C) evidence_text should be short, about 8 to 30 words, quote like, and include the key dish phrase.
D) evidence_url must be the page where the evidence_text appears (official menu, ordering page, or a reliable listing).
E) If you cannot find proof, do not include that restaurant.
F) dish_match "cuisine_fallback" is allowed only if you truly cannot verify the dish anywhere. If used, explain in note.

How to work internally (do not output these steps)
Step 1) If the target is a dish, pick a canonical dish name and list common synonyms or alternate spellings you expect on menus.
Step 2) Find candidate restaurants in the requested area.
Step 3) Verify each candidate with high signal sources:
Official restaurant menu pages
Ordering menus (Toast, ChowNow, Olo, Square)
Delivery menus that show item text
Reliable review snippets that explicitly mention the dish at that restaurant
NYC food pubs only when they explicitly mention the dish at that restaurant
Step 4) Rank by match quality, clarity of evidence, and overall fit for the request.

Area rules
If Area is Manhattan, Brooklyn, Queens, Bronx, or Staten Island, stay inside it.
If Area is NYC or Anywhere, any borough is allowed.
If you find fewer than 3 verified matches in the requested borough, return what you found and use note to suggest the best boroughs to try next.

Return ONLY valid JSON with this exact structure:
{
  "results": [
    {
      "name": "Restaurant Name",
      "neighborhood": "Neighborhood or nearby area",
      "borough": "Manhattan|Brooklyn|Queens|Bronx|Staten Island",
      "price_range": "$15-25|$25-40|$40-70|$70+|unknown (use actual dollar ranges, not $ symbols)",
      "what_to_order": ["item1", "item2", "item3"],
      "why": "One sentence on why this place is a strong match",
      "vibe": "Casual|Trendy|Upscale|Hole-in-the-wall|Date-night",
      "confidence": 0.0${isDishQuery ? `,
      "dish_match": "exact|close|cuisine_fallback",
      "evidence_text": "Short proof snippet that includes the dish name or synonym",
      "evidence_url": "https://..."` : ``}
    }
  ],
  "note": "Optional note if results are limited or if cuisine_fallback is used"
}`;

// =====================
// NYC SCOUT GEMINI FORMATTER PROMPT
// Goal: clean IG DM output, never asks borough again,
// never mentions sources, never shows URLs.
// =====================
const NYC_SCOUT_GEMINI_FORMATTER_PROMPT = ({
  userRequest,
  area,
  note,
  resultsJson
}) => `You are NYC Scout, a friendly NYC restaurant guide for Instagram DMs.

User request: "${userRequest}"
Area: "${area}"

If there is a note, you MUST include it as a single short parenthesis line at the top.
Note: "${note || ''}"

Use ONLY the restaurants provided in the results. Do not add new restaurants. Do not mention sources. Do not include URLs.

Restaurants JSON:
${resultsJson}

Write the response in this exact structure:

One short opener line.

Then list each restaurant like:
1. NAME
📍 Neighborhood, Borough
💰 Price range
🍽️ Order: item1, item2
💡 Why line

Rules
No headers
No markdown
No "according to" or "based on"
Keep each restaurant to 4 lines max
Use simple language
Do NOT add any extra sentences like "Try X" or "Looking for Y" after the list
End with EXACTLY this line and nothing else after it: Reply "more" for different options.
`;

// =====================
// GEMINI WEB SEARCH (retriever with grounding)
// =====================
async function searchWithGemini(intent, excludeNames = []) {
  if (!GEMINI_API_KEY) return { results: [], error: 'No API key' };
  
  const searchTarget = intent.dish || intent.cuisine || intent.dish_or_cuisine || intent.query || 'restaurant';
  const area = (intent.borough && !['any', 'Any', 'Anywhere'].includes(intent.borough)) ? intent.borough : 'NYC';
  const excludeClause = excludeNames.length > 0 ? excludeNames.join(', ') : '';
  const isDishQuery = intent.request_type === 'dish';
  const dietary = (intent.dietary && intent.dietary.length) ? intent.dietary.join(', ') : 'none';
  const budget = intent.budget || 'any';

  const prompt = NYC_SCOUT_GEMINI_GROUNDED_SEARCH_PROMPT({ searchTarget, area, dietary, budget, excludeClause, isDishQuery });

  try {
    console.log(`[GEMINI SEARCH] "${searchTarget}" in ${area}`);
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.2 }
      },
      { params: { key: GEMINI_API_KEY } }
    );
    
    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[GEMINI SEARCH] Raw response:', text.substring(0, 400));
    
    // Clean markdown
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      let jsonText = match[0];
      let parsed;
      
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseErr) {
        // JSON is truncated - try to repair it
        console.log('[GEMINI SEARCH] JSON truncated, attempting repair...');
        parsed = repairTruncatedJSON(jsonText);
      }
      
      if (parsed && parsed.results) {
        const results = validateResults(parsed.results || [], isDishQuery, isDishQuery ? searchTarget : null);
        console.log(`[GEMINI SEARCH] Found ${results.length} valid restaurants for "${searchTarget}"`);
        return { results, note: parsed.note };
      }
    }
    return { results: [], error: 'No JSON in response' };
  } catch (err) {
    console.error('[GEMINI SEARCH] Failed:', err.message);
    return { results: [], error: err.message };
  }
}

// =====================
// VALIDATE RESULTS
// =====================
function validateResults(results, isDishQuery = false, dishName = null) {
  if (!Array.isArray(results)) return [];
  
  const badWords = ['museum', 'tour', 'attraction', 'grocery', 'supermarket', 'food hall', 'market'];
  
  // Build dish-specific evidence pattern if we have a dish name
  let dishEvidencePattern = null;
  if (dishName) {
    const dishLower = dishName.toLowerCase();
    // Create patterns for specific dish types
    if (DISH_PATTERNS.sushi?.test(dishLower) || dishLower.includes('sushi') || dishLower.includes('omakase')) {
      dishEvidencePattern = /(sushi|omakase|nigiri|sashimi|hand ?roll|temaki|maki|chirashi)/i;
    } else if (DISH_PATTERNS.ramen?.test(dishLower) || dishLower.includes('ramen')) {
      dishEvidencePattern = /(ramen|shoyu|tonkotsu|miso|tsukemen|noodle)/i;
    } else if (DISH_PATTERNS.dumplings?.test(dishLower) || dishLower.includes('dumpling')) {
      dishEvidencePattern = /(dumpling|xiaolongbao|xiao long bao|jiaozi|gyoza|momo|bao)/i;
    } else if (DISH_PATTERNS.tacos?.test(dishLower) || dishLower.includes('taco')) {
      dishEvidencePattern = /(taco|birria|al pastor|carnitas|carne asada)/i;
    } else if (dishLower) {
      // Generic pattern: look for the dish name in evidence
      dishEvidencePattern = new RegExp(dishLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }
  
  return results.filter(r => {
    if (!r.name || r.name.length < 2) return false;
    if (!r.neighborhood && !r.borough) return false;
    if (badWords.some(w => r.name.toLowerCase().includes(w))) return false;
    
    // For dish queries, require evidence for BOTH exact AND close matches
    // Only cuisine_fallback is allowed without evidence (and must be clearly labeled)
    if (isDishQuery) {
      const matchType = r.dish_match || 'cuisine_fallback';
      if (matchType === 'exact' || matchType === 'close') {
        if (!r.evidence_text || r.evidence_text.length < 5) {
          console.log(`[VALIDATE] Dropping ${r.name} - no evidence_text for ${matchType} dish match`);
          return false;
        }
        if (!r.evidence_url) {
          console.log(`[VALIDATE] Dropping ${r.name} - no evidence_url for ${matchType} dish match`);
          return false;
        }
        // Verify evidence_text actually contains dish-related keywords
        if (dishEvidencePattern && !dishEvidencePattern.test(r.evidence_text)) {
          console.log(`[VALIDATE] Dropping ${r.name} - evidence_text doesn't mention the dish (looking for ${dishName})`);
          return false;
        }
      }
    }
    
    return true;
  }).map(r => ({
    name: r.name,
    neighborhood: r.neighborhood,
    borough: r.borough,
    price_range: r.price_range,
    what_to_order: r.what_to_order,
    why: r.why,
    vibe: r.vibe,
    dedupeKey: createDedupeKey(r.name, r.neighborhood || r.borough),
    // Keep evidence internal - never expose to user
    _dish_match: r.dish_match,
    _evidence_text: r.evidence_text,
    _evidence_url: r.evidence_url
  }));
}


// =====================
// GEMINI FORMATTER (no sources in output)
// =====================
async function geminiFormatResponse(intent, results, note = null) {
  if (!results.length) {
    return `Couldn't find spots for "${intent.dish || intent.cuisine || 'that'}". Try a different area?`;
  }
  
  if (!GEMINI_API_KEY) return formatResultsFallback(intent, results);
  
  // Strip internal fields for formatting
  const cleanResults = results.slice(0, 5).map(r => ({
    name: r.name,
    neighborhood: r.neighborhood,
    borough: r.borough,
    price_range: r.price_range,
    why: r.why,
    what_to_order: r.what_to_order,
    vibe: r.vibe
  }));
  
  const userRequest = intent.dish || intent.cuisine || 'food';
  const area = intent.borough || 'NYC';
  const resultsJson = JSON.stringify(cleanResults);
  
  const prompt = NYC_SCOUT_GEMINI_FORMATTER_PROMPT({ userRequest, area, note, resultsJson });

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1000, temperature: 0.3 } },
      { params: { key: GEMINI_API_KEY } }
    );
    
    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Strip any URLs that slipped through
    text = text.replace(/https?:\/\/[^\s)]+/g, '').replace(/\[source\]/gi, '');
    
    if (text.length > 50) return text.trim();
  } catch (err) {
    console.error('[FORMAT] Gemini failed:', err.message);
  }
  
  return formatResultsFallback(intent, results);
}

function formatResultsFallback(intent, results) {
  if (!results.length) return `Couldn't find spots for "${intent.dish || intent.cuisine}". Try a different area?`;
  
  let text = '';
  results.slice(0, 5).forEach((r, i) => {
    text += `${i + 1}. ${(r.name || '').toUpperCase()}\n`;
    text += `📍 ${r.neighborhood || ''}, ${r.borough || ''}\n`;
    if (r.price_range) text += `💰 ${r.price_range}`;
    if (r.vibe) text += ` · ${r.vibe}`;
    text += '\n';
    if (r.what_to_order?.length) text += `🍽️ ${r.what_to_order.slice(0, 2).join(', ')}\n`;
    if (r.why) text += `💡 ${r.why}\n`;
    text += '\n';
  });
  text += 'Reply "more" for different options.';
  return text;
}

// =====================
// SPOTLIGHT SEARCH
// =====================
async function spotlightRestaurant(restaurantName, context = null) {
  if (!GEMINI_API_KEY) {
    return { text: `I don't have info on ${restaurantName}. Try Google Maps!`, isSpotlight: true };
  }
  
  const borough = context?.lastIntent?.borough || 'NYC';
  const prompt = `Research "${restaurantName}" restaurant in ${borough}.
Return JSON: {"found":true,"name":"","neighborhood":"","borough":"","cuisine":"","price_range":"$20-40","vibe":"","known_for":[],"tips":"","why_good":""}
If not found: {"found":false}`;

  try {
    const response = await apiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.1 }
      },
      { params: { key: GEMINI_API_KEY } }
    );
    
    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const info = JSON.parse(match[0]);
      if (!info.found) return { text: `Couldn't find "${restaurantName}" in NYC.`, isSpotlight: true };
      
      let r = `Here's what I found about ${info.name}:\n\n`;
      r += `📍 ${info.neighborhood}, ${info.borough}\n`;
      r += `🍽️ ${info.cuisine} · ${info.price_range} · ${info.vibe}\n`;
      if (info.known_for?.length) r += `🌟 Known for: ${info.known_for.join(', ')}\n`;
      if (info.why_good) r += `💡 ${info.why_good}\n`;
      if (info.tips) r += `📝 ${info.tips}\n`;
      r += `\nWant similar spots?`;
      return { text: r, isSpotlight: true };
    }
  } catch (err) {
    console.error('[SPOTLIGHT] Failed:', err.message);
  }
  return { text: `Trouble looking up ${restaurantName}. Try again?`, isSpotlight: true };
}


// =====================
// MAIN SEARCH FUNCTION
// =====================
async function searchRestaurants(userId, query, providedFilters = null, foodProfile = null, context = null, skipConstraintGate = false) {
  // 1. Spotlight check
  const spotlight = detectSpotlightQuery(query);
  if (spotlight.isSpotlight) {
    console.log(`[SPOTLIGHT] "${spotlight.restaurantName}"`);
    const result = await spotlightRestaurant(spotlight.restaurantName, context);
    return { 
      query, 
      intent: { query, spotlight: true, restaurantName: spotlight.restaurantName }, 
      results: [], 
      count: 0, 
      formattedResponse: result.text, 
      needsConstraints: false, 
      isSpotlight: true 
    };
  }
  
  // 2. Extract intent with Gemini
  let intent = await extractIntent(query);
  
  // 3. Apply provided filters
  if (providedFilters) {
    if (providedFilters.borough) intent.borough = providedFilters.borough;
    if (providedFilters.budget) intent.budget = providedFilters.budget;
    if (providedFilters.dish) intent.dish = providedFilters.dish;
    if (providedFilters.cuisine) intent.cuisine = providedFilters.cuisine;
  }
  
  // 4. Apply profile defaults
  if (foodProfile) {
    if (!intent.borough && foodProfile.borough) intent.borough = foodProfile.borough;
    if (!intent.budget && foodProfile.budget) intent.budget = foodProfile.budget;
  }
  
  // 5. Check if we need constraints (only if not skipping gate)
  if (!skipConstraintGate && intent.needs_constraint && intent.missing_constraint === 'borough') {
    return {
      query,
      intent,
      results: [],
      count: 0,
      needsConstraints: true,
      pendingFilters: { dish: intent.dish, cuisine: intent.cuisine },
      constraintQuestion: intent.followup_question || 'Where in NYC?',
      constraintReplies: (intent.quick_replies || ['Manhattan', 'Brooklyn', 'Queens', 'Anywhere']).map(r => ({
        title: r,
        payload: `BOROUGH_${r.toUpperCase().replace(' ', '_')}`
      }))
    };
  }
  
  // 6. Search with Gemini (grounded web search)
  const excludeNames = context?.shownNames || [];
  const { results, note, error } = await searchWithGemini(intent, excludeNames);
  
  // 7. Handle low/no results
  if (results.length === 0) {
    if (intent.borough && intent.borough !== 'any') {
      return {
        query,
        intent,
        results: [],
        count: 0,
        needsConstraints: false,
        formattedResponse: `Couldn't find "${intent.dish || intent.cuisine}" in ${intent.borough}. Want me to search all of NYC?`,
        lowResults: true,
        expandOption: true
      };
    }
    return {
      query,
      intent,
      results: [],
      count: 0,
      needsConstraints: false,
      formattedResponse: error || `Couldn't find spots for "${intent.dish || intent.cuisine}". Try something else?`
    };
  }
  
  // 8. Handle low results (< 3) in specific borough
  if (results.length < 3 && intent.borough && intent.borough !== 'any') {
    const formatted = await geminiFormatResponse(intent, results);
    return {
      query,
      intent,
      results,
      count: results.length,
      formattedResponse: `"${intent.dish || intent.cuisine}" is rare in ${intent.borough} - found ${results.length} spot${results.length === 1 ? '' : 's'}.\n\n${formatted}\n\nWant me to check other boroughs?`,
      pool: results,
      page: 0,
      shownKeys: results.map(r => r.dedupeKey),
      lowResults: true
    };
  }
  
  // 9. Format and return
  const top5 = results.slice(0, 5);
  let formatted = await geminiFormatResponse(intent, top5, note);
  
  return {
    query,
    intent,
    results: top5,
    count: top5.length,
    formattedResponse: formatted,
    needsConstraints: false,
    pool: results,
    page: 0,
    shownKeys: top5.map(r => r.dedupeKey),
    shownNames: top5.map(r => r.name),
    hasMore: results.length > 5
  };
}

// =====================
// FORMAT RESULTS (for message handler)
// =====================
function formatRestaurantResults(searchResult) {
  if (searchResult.needsConstraints) {
    return {
      text: searchResult.constraintQuestion || 'Where in NYC?',
      replies: searchResult.constraintReplies || [],
      isQuestion: true,
      pendingFilters: searchResult.pendingFilters
    };
  }
  
  if (searchResult.lowResults && searchResult.expandOption) {
    return {
      text: searchResult.formattedResponse,
      replies: [
        { title: 'Yes, search all NYC', payload: 'BOROUGH_ANY' },
        { title: 'Try different dish', payload: 'RESET_SEARCH' }
      ],
      isQuestion: true
    };
  }
  
  if (searchResult.lowResults) {
    return {
      text: searchResult.formattedResponse,
      replies: [
        { title: 'Yes, check other boroughs', payload: 'BOROUGH_ANY' },
        { title: 'These are fine', payload: 'KEEP_RESULTS' }
      ],
      isQuestion: false
    };
  }
  
  return {
    text: searchResult.formattedResponse || "What are you craving?",
    replies: [],
    isQuestion: false
  };
}

// =====================
// DB SEARCH (optional fallback)
// =====================
async function searchRestaurantsDB(filters, limit = 20) {
  const collection = await connectToRestaurants();
  if (!collection) return [];

  const query = {};
  if (filters.cuisine) {
    query.cuisineDescription = { $regex: new RegExp(filters.cuisine, 'i') };
  }
  if (filters.borough && !['any', 'Any', 'Anywhere'].includes(filters.borough)) {
    query.fullAddress = { $regex: new RegExp(filters.borough, 'i') };
  }

  try {
    const results = await collection.find(query)
      .sort({ rating: -1, userRatingsTotal: -1 })
      .limit(limit)
      .toArray();
      
    return results.map(r => ({
      name: r.name,
      fullAddress: r.fullAddress,
      rating: r.rating,
      cuisineDescription: r.cuisineDescription,
      dedupeKey: createDedupeKey(r.name, r.fullAddress)
    }));
  } catch (err) {
    console.error('DB search failed:', err.message);
    return [];
  }
}

// =====================
// EXPORTS
// =====================
module.exports = {
  searchRestaurants,
  formatRestaurantResults,
  extractIntent,
  extractIntentWithGemini,
  detectSpotlightQuery,
  spotlightRestaurant,
  createDedupeKey,
  normalizeForDedupe,
  searchRestaurantsDB,
  searchWithGemini,
  geminiFormatResponse,
  validateResults,
  RESTAURANT_SYSTEM_PROMPT
};
