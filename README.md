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

#8. Go the Vercel Deploy Page of the App->Settings 

    - In the environmental variables section add the following variables
       -APP_SECRET(Found in Settings-Baisc of your app)
       -TOKEN(its the verify token that you generated earlier)
       -GEMINI_KEY
       -PAGE_ACESS_TOKEN
          - On the dashboard of ttps://developers.facebook.com/apps/ go to Tools->Graph Explorer
          - Select your app and select user token
          - Add the following permissions:
                pages_show_list
                pages_manage_metadata
                pages_messaging
                instagram_basic
                instagram_manage_messages
          - Click Generate Access Token
          - Type me/accounts to get page acess token
    

     





