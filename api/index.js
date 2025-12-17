const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const app = express();

app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.TOKEN || 'token';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

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
async function processDM(dmData) {
  console.log('Processing DM:', dmData);
  
  const senderId = dmData.sender?.id;
  const messageText = dmData.message?.text;
  
  // Store the DM
  const dmRecord = {
    timestamp: new Date().toISOString(),
    senderId,
    recipientId: dmData.recipient?.id,
    messageText,
    rawData: dmData
  };
  
  recentDMs.push(dmRecord);
  
  // Keep only last 50 DMs in memory
  if (recentDMs.length > 50) {
    recentDMs = recentDMs.slice(-50);
  }
  
  // Generate and send response if we have a message
  if (senderId && messageText) {
    try {
      const aiResponse = await getGeminiResponse(messageText);
      await sendInstagramMessage(senderId, aiResponse);
      dmRecord.response = aiResponse;
    } catch (error) {
      console.error('Error processing DM:', error.message);
    }
  }
}

// Get response from Gemini API
async function getGeminiResponse(userMessage) {
  if (!GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY not set');
    return 'Thanks for your message! We will get back to you soon.';
  }

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{ text: `You are a helpful assistant responding to Instagram DMs. Keep responses brief and friendly. User message: ${userMessage}` }]
      }]
    }
  );

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Thanks for reaching out!';
}

// Send message via Instagram API
async function sendInstagramMessage(recipientId, messageText) {
  if (!PAGE_ACCESS_TOKEN) {
    console.log('PAGE_ACCESS_TOKEN not set - cannot send message');
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: recipientId },
      message: { text: messageText }
    }
  );
  
  console.log(`Message sent to ${recipientId}`);
}

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
