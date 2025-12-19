#1. Switch Instagram to Professional(Business)

#2. Connect Instagram to a Facebook Page 
    - Create Facebook Page first

#4. Create a Facebook app https://developers.facebook.com/apps/. 
     - For Use Case, select "Engage with Customers On Messenger From Meta"
     - For Buisness, Select Create a business Portolio and enter the info
     - After Submitting the info, hit verify which should take you to the business portfolio
     - Go to settings(bottom left)-> accounts. Go to instagram and add insta account. Go to pages and add facebook page you created earlier
     - Go back to creating an app

#5. Connect the instagram account to the facebbook page
   - Instagram ->Settings->Buisness Tools and Controls->Connect to a Facebook Page

#7. Go to Publish->Enage with Customers on Meta->Webhooks 
     - From products, Sleect a Product Dropdown select insagram 
     - In the webhook field, enter https://nycscout.vercel.app/instagram
     - Generate a random verify token and enter it in the verify token field
     - Subsribe to Messages Field

#7. Go to App_Settings->Basic
   1. Put this for privacy url ->https://nycscout.vercel.app/privacy-policy
   2. Put this for Terms of Service url ->https://nycscout.vercel.app/terms-of-service
   3. Add contact email
   4. Add Category 
   5. Hit publish bottom right 

# Deploy to Vercel

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





