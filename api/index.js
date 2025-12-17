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
  timeout: 30000, // ⬅️ FIX: increase timeout
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const graphClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* =====================
   ROUTES
===================== */

app.get('/', (req, res) => {
  res.send(`<h1>Instagram Webhook Running</h1>`);
});

app.get('/privacy-policy', (req, res) => {
  const file = path.join(__dirname, '..', 'privacy-policy.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Not found');
});

app.get('/terms-of-service', (req, res) => {
  const file = path.join(__dirname, '..', 'terms-of-service.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Not found');
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
app.post('/instagram', async (req, res) => {
  console.log('🚀 POST /instagram hit');

  const entry = req.body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  
  if (!messaging || messaging.message?.is_echo) {
    console.log('No message or echo, skipping');
    return res.sendStatus(200);
  }

  const senderId = messaging.sender?.id;
  const text = messaging.message?.text;

  if (!senderId || !text) {
    return res.sendStatus(200);
  }

  // Process BEFORE responding so Vercel doesn't kill the function
  await processDM(senderId, text);
  
  res.sendStatus(200);
});

/* =====================
   DM PROCESSING
===================== */
async function processDM(senderId, messageText) {
  console.log(`Incoming DM from ${senderId}: ${messageText}`);

  let reply;

  try {
    console.log('Calling Gemini...');
    reply = await getGeminiResponse(messageText);
    console.log('Gemini reply:', reply);
  } catch (err) {
    console.error('Gemini failed, using fallback');
    reply = 'Thanks for your message! We’ll get back to you shortly.';
  }

  await sendInstagramMessage(senderId, reply);
}

/* =====================
   GEMINI RESPONSE
===================== */
async function getGeminiResponse(userMessage) {
  if (!GEMINI_API_KEY) {
    return 'Thanks for reaching out!';
  }

  try {
    const response = await geminiClient.post(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
      {
        contents: [{
          parts: [{
            text: `You are a helpful Instagram assistant. Keep replies short (1-2 sentences max).\nUser: ${userMessage}`
          }]
        }],
        generationConfig: {
          maxOutputTokens: 100,
          temperature: 0.7
        }
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
    console.error('Gemini error:', err.response?.status, err.response?.data || err.message);
    throw err; // handled upstream
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
      'Send failed:',
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
