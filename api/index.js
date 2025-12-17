const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

const app = express();
app.use(bodyParser.json());

/* =====================
   ENV VARIABLES
===================== */
const VERIFY_TOKEN = process.env.TOKEN || 'token';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

/* =====================
   AXIOS CLIENTS
===================== */
const geminiClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const graphClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   IN-MEMORY STORAGE
===================== */
let recentDMs = [];

/* =====================
   ROUTES
===================== */

// Homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>Instagram Webhook Server</h1>
    <p>Status: Running</p>
    <h3>Recent DMs (${recentDMs.length})</h3>
    <pre>${JSON.stringify(recentDMs.slice(-10), null, 2)}</pre>
  `);
});

// Privacy Policy
app.get('/privacy-policy', (req, res) => {
  const file = path.join(__dirname, '..', 'privacy-policy.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Privacy Policy not found');
});

// Terms of Service
app.get('/terms-of-service', (req, res) => {
  const file = path.join(__dirname, '..', 'terms-of-service.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Terms not found');
});

// Health check
app.get('/test', (req, res) => {
  res.json({
    ok: true,
    hasPageToken: !!PAGE_ACCESS_TOKEN,
    hasGeminiKey: !!GEMINI_API_KEY,
    recentDMs: recentDMs.length,
  });
});

/* =====================
   WEBHOOK VERIFY
===================== */
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

/* =====================
   WEBHOOK RECEIVE
===================== */
app.post('/instagram', (req, res) => {
  // ACK immediately (VERY IMPORTANT for Vercel)
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging) return;

    // Ignore echo (messages sent by the page itself)
    if (messaging.message?.is_echo) {
      console.log('Ignoring echo message');
      return;
    }

    const senderId = messaging.sender?.id;
    const text = messaging.message?.text;

    if (!senderId || !text) return;

    processDM(senderId, text);
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }
});

/* =====================
   DM PROCESSING
===================== */
async function processDM(senderId, messageText) {
  console.log(`Incoming DM from ${senderId}: ${messageText}`);

  try {
    console.log('About to generate reply...');
    const reply = await getGeminiResponse(messageText);
    console.log('Generated reply:', reply);

    console.log('About to send reply...');
    await sendInstagramMessage(senderId, reply);
    console.log('Finished sendInstagramMessage call');
  } catch (err) {
    console.error('Error processing DM:', err.message);
  }
}


/* =====================
   GEMINI RESPONSE
===================== */
async function getGeminiResponse(userMessage) {
  if (!GEMINI_API_KEY) {
    return 'Thanks for your message! We’ll get back to you shortly.';
  }

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
      {
        contents: [{
          parts: [{
            text: `You are a helpful Instagram assistant. Keep replies short and friendly.\nUser: ${userMessage}`
          }]
        }]
      },
      {
        params: { key: GEMINI_API_KEY }
      }
    );

    return (
      response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      'Thanks for reaching out!'
    );
  } catch (err) {
    console.error('Gemini error:', err.code || err.message);
    return 'Thanks for your message! A team member will reply soon.';
  }
}

/* =====================
   SEND INSTAGRAM DM
===================== */
async function sendInstagramMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('PAGE_ACCESS_TOKEN missing');
    return;
  }

  try {
    await graphClient.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: recipientId },
        message: { text }
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN }
      }
    );
    console.log(`Reply sent to ${recipientId}`);
  } catch (err) {
    console.error(
      'Failed to send message:',
      err.response?.data || err.message
    );
  }
}

/* =====================
   SERVER START
===================== */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
