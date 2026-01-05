const axios = require('axios');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const graphClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

const geminiClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/**
 * Get sender ID from webhook body
 */
function getSenderId(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  const id = msg?.sender?.id;
  return (id && id !== 'null' && id !== 'undefined') ? String(id) : null;
}

/**
 * Get incoming text from webhook body
 */
function getIncomingTextOrPayload(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  return {
    text: msg?.message?.text?.trim() || null
  };
}


/**
 * Send a text message via Instagram Graph API
 */
async function sendMessage(recipientId, text) {
  const textStr = String(text || '').trim();
  if (!textStr || !recipientId || recipientId === 'null') return;

  if (!PAGE_ACCESS_TOKEN || PAGE_ACCESS_TOKEN === 'null') {
    console.log('[DEBUG] No token. Message hint:', textStr.substring(0, 30));
    return;
  }

  // Instagram max 1000 characters
  const safeText = textStr.length > 1000 ? textStr.substring(0, 997) + '...' : textStr;
  const payload = { recipient: { id: recipientId }, message: { text: safeText } };

  try {
    await graphClient.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, payload);
    console.log(`Sent message to ${recipientId}`);
  } catch (err) {
    console.error('Instagram Error:', err.response?.data?.error?.message || err.message);
  }
}

module.exports = {
  graphClient,
  geminiClient,
  getSenderId,
  getIncomingTextOrPayload,
  parseBoroughFromText,
  sendMessage,
  GEMINI_API_KEY
};

