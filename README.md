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

> ⚠️ **Important:** Vercel automatically deploys from your main branch. Every time you push changes to GitHub, your production app will update immediately. 

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
   - `GEMINI_KEY` - Your Google Gemini API key
   - `PAGE_ACCESS_TOKEN` - Get this from Facebook Graph Explorer:
     - Go to [Graph Explorer](https://developers.facebook.com/tools/explorer/)
     - Select your app and user token
     - Add permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages`
     - Click "Generate Access Token"
     - Type `me/accounts` and hit submit to get your page access token

3. **Update webhook URL** in your Facebook app to point to your new Vercel deployment URL

## Alternative: Vercel CLI
```bash
npm i -g vercel
vercel
```

---

# How It Works

## Architecture

```
Instagram DM → Facebook Webhook → Vercel (index.js) → helpers.js → Response
```

## File Structure

- **`api/index.js`** - Express routes and webhook handlers
- **`api/helpers.js`** - Event fetching, filtering, and AI functions

## Flow

1. **User sends DM** to your Instagram account
2. **Facebook webhook** delivers the message to `POST /instagram`
3. **Query detection** checks if the message is about NYC events (keywords like "concert", "brooklyn", "this weekend")
4. **If event query:**
   - Fetches live data from NYC Open Data API + NYC Parks API
   - Uses Gemini AI to parse natural language into filters (date, category, borough)
   - Filters events and returns top 5 matches
5. **If general message:**
   - Sends to Gemini for a conversational response
6. **Response sent** back to user via Instagram DM

## Data Sources

| Source | API | Events |
|--------|-----|--------|
| NYC Permitted Events | `data.cityofnewyork.us/resource/tvpp-9vvx.json` | Parades, street fairs, film shoots |
| NYC Parks | `nycgovparks.org/xml/events_300_rss.json` | Park concerts, fitness classes, kids activities |

## Supported Queries

- "What concerts are in Brooklyn this weekend?"
- "Any parades in Manhattan?"
- "Events in Queens tomorrow"
- "Show me festivals in December"

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/instagram` | GET | Webhook verification |
| `/instagram` | POST | Receive DMs |
| `/events/search?q=...` | GET | Search events (for testing) |
| `/privacy-policy` | GET | Privacy policy page |
| `/terms-of-service` | GET | Terms of service page |





