const express = require('express');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.TOKEN || 'token';

// Homepage
app.get('/', (req, res) => {
  res.send('Instagram Webhook Server is running!');
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
  const messaging = entry?.messaging?.[0];

  if (!messaging) {
    return res.sendStatus(200);
  }

  const senderId = messaging.sender?.id;
  const messageText = messaging.message?.text;

  console.log('New IG DM');
  console.log('From:', senderId);
  console.log('Message:', messageText);

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
