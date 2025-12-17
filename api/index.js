const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.TOKEN || 'token';

// Store recent DMs in memory (in production, use a database)
let recentDMs = [];

// Homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>Instagram Webhook Server for nyc_scout</h1>
    <p>Server is running and ready to receive DMs!</p>
    <h2>Recent DMs (${recentDMs.length})</h2>
    <pre>${JSON.stringify(recentDMs.slice(-10), null, 2)}</pre>
    <p><a href="/test">Test webhook</a></p>
    <p><a href="/privacy-policy">Privacy Policy</a> | <a href="/terms-of-service">Terms of Service</a></p>
  `);
});

// Privacy Policy
app.get('/privacy-policy', (req, res) => {
  const privacyPath = path.join(__dirname, '..', 'privacy-policy.html');
  if (fs.existsSync(privacyPath)) {
    res.sendFile(privacyPath);
  } else {
    res.status(404).send('Privacy Policy not found');
  }
});

// Terms of Service
app.get('/terms-of-service', (req, res) => {
  const termsPath = path.join(__dirname, '..', 'terms-of-service.html');
  if (fs.existsSync(termsPath)) {
    res.sendFile(termsPath);
  } else {
    res.status(404).send('Terms of Service not found');
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Webhook server is running',
    environment: {
      hasPageToken: !!process.env.PAGE_ACCESS_TOKEN && process.env.PAGE_ACCESS_TOKEN !== 'YOUR_INSTAGRAM_PAGE_ACCESS_TOKEN_HERE',
      hasPageId: !!process.env.INSTAGRAM_PAGE_ID && process.env.INSTAGRAM_PAGE_ID !== 'YOUR_NYC_SCOUT_PAGE_ID_HERE',
      verifyToken: process.env.TOKEN
    },
    recentDMCount: recentDMs.length
  });
});

// Webhook verification
app.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive Instagram DMs
app.post('/instagram', (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body, null, 2));

  const entry = req.body.entry?.[0];

  // Handle "changes" format (Instagram uses this)
  const change = entry?.changes?.[0];
  if (change?.field === 'messages' && change?.value) {
    console.log('New IG DM received (changes format)');
    console.log('Data:', JSON.stringify(change.value, null, 2));
    
    // Process the DM
    processDM(change.value);
  }

  // Handle "messaging" format (Messenger style)
  const messaging = entry?.messaging?.[0];
  if (messaging) {
    const senderId = messaging.sender?.id;
    const messageText = messaging.message?.text;
    const recipientId = messaging.recipient?.id;
    
    console.log('New IG DM received (messaging format)');
    console.log('From:', senderId);
    console.log('To:', recipientId);
    console.log('Message:', messageText);
    
    // Process the DM
    processDM({
      sender: { id: senderId },
      recipient: { id: recipientId },
      message: { text: messageText }
    });
  }

  res.sendStatus(200);
});

// Function to process incoming DMs
function processDM(dmData) {
  console.log('Processing DM:', dmData);
  
  // Store the DM
  const dmRecord = {
    timestamp: new Date().toISOString(),
    senderId: dmData.sender?.id,
    recipientId: dmData.recipient?.id,
    messageText: dmData.message?.text,
    rawData: dmData
  };
  
  recentDMs.push(dmRecord);
  
  // Keep only last 50 DMs in memory
  if (recentDMs.length > 50) {
    recentDMs = recentDMs.slice(-50);
  }
  
  // Log important DM details
  if (dmData.sender?.id) {
    console.log(`DM received from user ${dmData.sender.id}`);
    
    if (dmData.message?.text) {
      console.log(`Message content: ${dmData.message.text}`);
      
      // Keyword detection
      const messageText = dmData.message.text.toLowerCase();
      if (messageText.includes('scout') || messageText.includes('nyc')) {
        console.log('🚨 DM contains scout/nyc keywords - flagging for attention');
        dmRecord.flagged = true;
      }
      
      // Add more keyword detection as needed
      const keywords = ['help', 'info', 'question', 'booking', 'event'];
      const foundKeywords = keywords.filter(keyword => messageText.includes(keyword));
      if (foundKeywords.length > 0) {
        console.log(`📝 DM contains keywords: ${foundKeywords.join(', ')}`);
        dmRecord.keywords = foundKeywords;
      }
    }
  }
  
  // Here you can add:
  // - Database storage
  // - Automated responses
  // - Notifications
}

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
