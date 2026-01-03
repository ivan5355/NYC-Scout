const axios = require('axios');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const graphClient = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

async function sendMessage(recipientId, text, quickReplies = null) {
  // Ensure text is a string
  const textStr = typeof text === 'string' ? text : String(text || '');
  
  // Extra safety: Check if token is actually set and not the literal string "null"
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

  // DEBUG: Log exactly what we're sending
  console.log('📤 Sending to Instagram API:');
  console.log('   Recipient ID:', recipientId);
  console.log('   Text length:', safeText?.length || 0);
  console.log('   Quick replies:', quickReplies?.length || 0);
  console.log('   Full payload:', JSON.stringify(payload, null, 2));

  try {
    const res = await graphClient.post('https://graph.facebook.com/v18.0/me/messages', payload, { 
      params: { access_token: PAGE_ACCESS_TOKEN } 
    });
    console.log(`✅ Successfully sent message to ${recipientId}`);
  } catch (err) {
    const apiError = err.response?.data?.error;
    if (apiError) {
      console.error('❌ Instagram API Error:', apiError.message, `(Code: ${apiError.code}, Type: ${apiError.type})`);
      console.error('   Full error:', JSON.stringify(err.response?.data, null, 2));
    } else {
      console.error('❌ Send failed:', err.message);
    }
  }
}

module.exports = {
  sendMessage
};

