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

const MORE_PATTERNS = [
  /^more$/i,
  /^more please$/i,
  /^more options$/i,
  /^show more$/i,
  /^show me more$/i,
  /^different options$/i,
  /^other options$/i,
  /^next$/i,
  /^next options$/i,
  /^different ones$/i,
  /^other ones$/i,
  /^gimme more$/i,
  /^give me more$/i,
  /^any more$/i,
  /^anymore$/i,
  /^what else$/i
];

function isMoreRequest(text) {
  if (!text) return false;
  const cleaned = text.toLowerCase().trim();
  return MORE_PATTERNS.some(pattern => pattern.test(cleaned));
}

function getSenderId(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  const id = msg?.sender?.id;
  return (id && id !== 'null' && id !== 'undefined') ? String(id) : null;
}

function getIncomingTextOrPayload(body) {
  const entry = body?.entry?.[0];
  const msg = entry?.messaging?.[0];
  return {
    text: msg?.message?.text?.trim() || null,
    payload: msg?.message?.quick_reply?.payload || msg?.postback?.payload || null
  };
}

function parseBoroughFromPayload(payload) {
  const boroughMap = {
    'BOROUGH_MANHATTAN': 'Manhattan',
    'BOROUGH_BROOKLYN': 'Brooklyn',
    'BOROUGH_QUEENS': 'Queens',
    'BOROUGH_BRONX': 'Bronx',
    'BOROUGH_STATEN': 'Staten Island',
    'BOROUGH_ANY': 'any',
    'CONSTRAINT_BOROUGH_MANHATTAN': 'Manhattan',
    'CONSTRAINT_BOROUGH_BROOKLYN': 'Brooklyn',
    'CONSTRAINT_BOROUGH_QUEENS': 'Queens',
    'CONSTRAINT_BOROUGH_BRONX': 'Bronx',
    'CONSTRAINT_BOROUGH_STATEN': 'Staten Island',
    'CONSTRAINT_BOROUGH_ANYWHERE': 'any',
    'EVENT_BOROUGH_Manhattan': 'Manhattan',
    'EVENT_BOROUGH_Brooklyn': 'Brooklyn',
    'EVENT_BOROUGH_Queens': 'Queens',
    'EVENT_BOROUGH_Bronx': 'Bronx',
    'EVENT_BOROUGH_Staten Island': 'Staten Island',
    'EVENT_BOROUGH_any': 'any'
  };
  return boroughMap[payload];
}

function parseBoroughFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const boroughMap = {
    'manhattan': 'Manhattan', 'midtown': 'Manhattan', 'downtown': 'Manhattan',
    'uptown': 'Manhattan', 'harlem': 'Manhattan', 'soho': 'Manhattan',
    'brooklyn': 'Brooklyn', 'williamsburg': 'Brooklyn',
    'queens': 'Queens', 'flushing': 'Queens', 'astoria': 'Queens', 'jackson heights': 'Queens',
    'bronx': 'Bronx',
    'staten island': 'Staten Island', 'staten': 'Staten Island',
    'anywhere': 'any', 'any': 'any', 'all': 'any'
  };
  for (const [key, val] of Object.entries(boroughMap)) {
    if (t.includes(key)) return val;
  }
  return undefined;
}

async function sendMessage(recipientId, text, quickReplies = null) {
  const textStr = typeof text === 'string' ? text : String(text || '');
  const isTokenValid = PAGE_ACCESS_TOKEN && PAGE_ACCESS_TOKEN !== 'null' && PAGE_ACCESS_TOKEN !== 'undefined';

  if (!isTokenValid) {
    console.log('[DEV MODE] No valid PAGE_ACCESS_TOKEN. Recipient:', recipientId, 'Text:', textStr.substring(0, 50) + '...');
    return;
  }

  if (!recipientId || recipientId === 'null' || recipientId === 'undefined') {
    console.error('Cannot send message: recipientId is missing or invalid');
    return;
  }

  const safeText = textStr.length > 1000 ? textStr.substring(0, 997) + '...' : (textStr || '(Empty message)');
  const payload = { recipient: { id: recipientId }, message: { text: safeText } };

  if (quickReplies?.length) {
    payload.message.quick_replies = quickReplies.slice(0, 13).map(q => ({
      content_type: "text",
      title: (q.title || 'Option').substring(0, 20),
      payload: q.payload || 'DEFAULT_PAYLOAD'
    })).filter(q => q.title && q.payload);
  }

  console.log('📤 Sending to Instagram API:');
  console.log('   Recipient ID:', recipientId);
  console.log('   Text length:', safeText?.length || 0);
  console.log('   Quick replies:', quickReplies?.length || 0);

  try {
    await graphClient.post('https://graph.facebook.com/v18.0/me/messages', payload, {
      params: { access_token: PAGE_ACCESS_TOKEN }
    });
    console.log(`✅ Successfully sent message to ${recipientId}`);
  } catch (err) {
    const apiError = err.response?.data?.error;
    if (apiError) {
      console.error('❌ Instagram API Error:', apiError.message, `(Code: ${apiError.code}, Type: ${apiError.type})`);
    } else {
      console.error('❌ Send failed:', err.message);
    }
  }
}

module.exports = {
  graphClient,
  geminiClient,
  isMoreRequest,
  getSenderId,
  getIncomingTextOrPayload,
  parseBoroughFromPayload,
  parseBoroughFromText,
  sendMessage,
  GEMINI_API_KEY
};

