#1. Switch Instagram to Professional(Business)

#2. Connect Instagram to a Facebook Page 
    - Create Facebook Page first

#3. Create a Facebook app https://developers.facebook.com/apps/. 
     - For Use Case, select "Engage with Customers On Messenger From Meta"
     - For Buisness, Select Create a business Portolio and enter the info
     - After Submitting the info, hit verify which should take you to the business portfolio
     - Go to settings(bottom left)-> accounts. Go to instagram and add insta account. Go to pages and add facebook page you created earlier
     - Go back to creating an app

#4. Connect the instagram account to the facebbook page
   - Instagram ->Settings->Buisness Tools and Controls->Connect to a Facebook Page

#5. Go to Publish->Enage with Customers on Meta->Webhooks 
     - From products, Sleect a Product Dropdown select insagram 
     - In the webhook field, enter https://nycscout.vercel.app/instagram
     - Generate a random verify token and enter it in the verify token field
     - Subsribe to Messages Field

#6. Go to App_Settings->Basic
   1. Put this for privacy url ->https://nycscout.vercel.app/privacy-policy
   2. Put this for Terms of Service url ->https://nycscout.vercel.app/terms-of-service
   3. Add contact email
   4. Add Category 
   5. Hit publish bottom right 

# Deploy to Vercel

> **Important:** Vercel automatically deploys from your main branch. Every time you push changes to GitHub, your production app will update immediately. 

## Quick Deploy
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/YOUR_REPO_NAME)

## Manual Deployment Steps

1. **Deploy to Vercel:**
   - Go to [vercel.com](https://vercel.com)
   - Click "Add New Project"
   - Import your repository from GitHub
   - Click "Deploy"

2. **Set up Environment Variables:**
   After deployment, go to your Vercel project dashboard → Settings → Environment Variables and add:
   
   - `APP_SECRET` - Found in Settings → Basic of your Facebook app
   - `TOKEN` - The verify token you generated earlier
   - `GEMINI_API_KEY` - Your Google Gemini API key
   - `PAGE_ACCESS_TOKEN` - Get this from Facebook Graph Explorer:
     - Go to [Graph Explorer](https://developers.facebook.com/tools/explorer/)
     - Select your app and user token
     - Add permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages`
     - Click "Generate Access Token"
     - Type `me/accounts` and hit submit to get your page access token
   - `MONGODB_URI` - MongoDB connection string (required for restaurant answers)

3. **Update webhook URL** in your Facebook app to point to your new Vercel deployment URL

## Alternative: Vercel CLI
```bash
npm i -g vercel
vercel
```

---

# How It Works

## Architecture

```bash
Instagram DM → Facebook Webhook → Vercel (api/api.js) 
                                      ↓
                            helpers/message_handler.js
                                      ↓
                            helpers/query_router.js 
                              (AI Classification) 
                                      ↓
                    ┌─────────────────┼─────────────────┐
                    ↓                 ↓                 ↓
             RESTAURANT            EVENT             OTHER
          helpers/restaurants.js  helpers/events.js  (Restricted)
                    ↓                 ↓                 ↓
          ┌──────────────────┐  ┌──────────────────┐   │
          │ Filter Extraction│  │ Filter Extraction│   │
          │ (Gemini AI)      │  │ (Gemini AI)      │   │
          │ • cuisine        │  │ • category       │   │
          │ • borough        │  │ • date           │   │
          │ • priceLevel     │  │ • borough        │   │
          │ • searchTerm     │  │ • searchTerm     │   │
          └────────┬─────────┘  └────────┬─────────┘   │
                   ↓                      ↓            │
          ┌──────────────────┐  ┌──────────────────┐   │
          │ Apply Filters to │  │ Apply Filters to │   │
          │ MongoDB Query    │  │ NYC APIs Data    │   │
          └────────┬─────────┘  └────────┬─────────┘   │
                   ↓                      ↓             ↓
               Results?              Results?     "I only help with
                   ↓                      ↓        restaurants..."
               If no results          If no results     ↓
                   ↓                      ↓         Response
          ┌──────────────────┐  ┌──────────────────┐    │
          │ Gemini Web Search│  │ Gemini Web Search│    │
          │                  │  │                  │    │
          └────────┬─────────┘  └────────┬─────────┘    │
                   ↓                      ↓             │
                   └──────────────────────┴─────────────┘
                                  ↓
                     Instagram DM Response
```   

## Data Sources

The application uses multiple data sources with intelligent fallbacks:

### Primary Data Sources
- **NYC Permitted Events**: Live data on parades, street fairs, block parties, and film shoots.
  - Source: [NYC Open Data - NYC Permitted Event Listings](https://data.cityofnewyork.us/City-Government/NYC-Permitted-Event-Listings/tvpp-9vvx)
- **NYC Parks Events**: Live feed of activities including concerts, tours, kids programs, and fitness classes in NYC parks.
  - Source: [NYC Parks - Events RSS Feed](https://catalog.data.gov/dataset/nyc-parks-public-events-upcoming-14-days/resource/0ef56b88-24ce-46b9-b45b-7af20021c0ed)
- **NYC Restaurants**: Curated database of NYC restaurants with cuisine types, ratings, and locations.
  - Source: [NYC DOHMH Restaurant Inspections](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j) (Managed via MongoDB)

### Fallback: Gemini Web Search (Google Search Grounding)
When local data sources return no results, the bot automatically uses **Gemini 2.0 Flash with Google Search** to find real-time information from the web. This ensures users always get helpful responses, even for queries outside the primary datasets.

## File Structure

- **`api/api.js`** - Express server, webhook verification, and route handlers
- **`helpers/message_handler.js`** - **Central DM processor**: routes messages and handles Instagram messaging
- **`helpers/query_router.js`** - AI-powered intent classifier (RESTAURANT vs EVENT vs OTHER)
- **`helpers/events.js`** - Event search with filter extraction and web search fallback
- **`helpers/restaurants.js`** - MongoDB restaurant search with AI filter extraction
- **`data/`** - Contains `event_filters.json` and `restaurant_filters.json` 
- **`scripts/`** - Data extraction scripts for populating/refreshing filters

## Message Processing Flow

1. **User sends DM** to your Instagram account.
2. **Facebook webhook** delivers the message to `api/api.js`.
3. **Message Handler** (`message_handler.js`) receives and processes the DM.
4. **Intent Classification**: The query is sent to **Gemini AI** (`query_router.js`) to determine if the user is looking for a restaurant, an event, or something else.
5. **Entity Extraction & Search**:
   - **If RESTAURANT**: 
     - Gemini extracts `cuisine`, `borough`, `priceLevel`, and `searchTerm`
     - Searches MongoDB database for matching restaurants
     - **Fallback**: If no results, uses Gemini Web Search with extracted filters
   - **If EVENT**: 
     - Gemini extracts `category`, `date`, `borough`, and `searchTerm`
     - Fetches live data from NYC Permitted Events and NYC Parks APIs
     - Applies extracted filters to find matching events
     - **Fallback**: If no results, uses Gemini Web Search with extracted filters
    - **If OTHER**: 
      - The bot informs the user that it only supports NYC restaurant and event searches.
6. **Response sent** back to the user via Instagram DM (handled by `message_handler.js`).

## Filtering System

The app extracts valid filters directly from the sources and uses Gemini to map user queries to those filters.

### Extraction Scripts - Gets the filters from the sources and writes them to a file
- `node scripts/extract_restaurant_filters.js`: Scans restaurant data to find all cuisines and boroughs.
- `node scripts/extract_event_filters.js`: Scans NYC Open Data to find active event categories and boroughs.

### Restaurant Search Filters
Supported fields extracted by Gemini:
- **Cuisine**: Matches the user's intent to one of 100+ detected cuisines.
- **Borough**: Validates against the 5 NYC boroughs.
- **Price Level**: Maps "cheap", "fancy", etc., to "Inexpensive", "Expensive", etc.
- **Search Term**: Captures specific names (e.g., "Lucali"), food items (e.g., "shrimp"), or neighborhoods. It acts as a catch-all for terms that don't fit into broad categories.

### Event Search Filters
Supported fields extracted by Gemini:
- **Date**: Handles specific dates, ranges, or months.
- **Category**: Maps query to real NYC event types (e.g., "Concerts", "Street Event").
- **Search Term**: Captures specific keywords (e.g., "Yoga", "Jazz", "Central Park") for fuzzy matching across name, type, and location.

### How searchTerm Works
The `searchTerm` is the logic that makes the bot flexible. Instead of only matching exact categories, it performs a broad text search:
- **For Restaurants**: It scans the restaurant's **Name**, **Cuisine Type**, and **Review Summary** in the database.
- **For Events**: It scans the **Event Name**, **Event Type**, and **Location** fields in the NYC API data.
- **As a Fallback**: If Gemini cannot find a matching borough or official category, it puts the user's keywords into the `searchTerm` to try and find a match anyway.

### Example Queries

- "Show me Italian restaurants in Manhattan"
  ```javascript
  {
    cuisineDescription: /italian/i,
    fullAddress: /manhattan/i
  }
  ```

- "Best pizza under $20"
  ```javascript
  {
    cuisineDescription: /pizza/i,
    priceLevel: { $lte: 2 },
    rating: { $gte: 4 }
  }
  ```

- "Free concerts this weekend"
  ```javascript
  {
    category: /music|concert|live music/i,
    isFree: true,
    date: { $gte: startOfWeekend, $lte: endOfWeekend }
  }
  ```

## Supported Queries

### Event Queries
- "What concerts are in Brooklyn this weekend?"
- "Any parades in Manhattan?"
- "Events in Queens tomorrow"
- "Show me festivals in December"
- "Free yoga classes in Central Park"
- "Art exhibitions this month" *(uses web search if not in local data)*

### Restaurant Queries
- "Best sushi in Manhattan"
- "Any cheap pizza spots in Brooklyn?"
- "Italian restaurants near Times Square"
- "Vegan options in Williamsburg"
- "Top-rated steakhouses" *(uses web search if not in database)*

### Other Queries (Rejected)
- "What's the weather like today?" 
- "Tell me about the Statue of Liberty" 
- "Who is the president?"
*(Bot will respond: "I'm sorry, I can only help you find restaurants and events in NYC...")*

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/instagram` | GET | Webhook verification |
| `/instagram` | POST | Receive DMs |
| `/events/search?q=...` | GET | Search events (for testing) |
| `/privacy-policy` | GET | Privacy policy page |
| `/terms-of-service` | GET | Terms of service page |





