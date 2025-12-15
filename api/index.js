/**
 * Instagram DM Webhook Handler
 */

var bodyParser = require('body-parser');
var express = require('express');
var app = express();

app.use(bodyParser.json());

var token = process.env.TOKEN || 'token';
var received_updates = [];

app.get('/', function(req, res) {
  res.send(`
    <html>
    <head><title>Instagram DMs</title></head>
    <body style="font-family: sans-serif; padding: 20px;">
      <h1>Instagram DMs</h1>
      <p>Received ${received_updates.length} messages</p>
      <pre style="background: #f4f4f4; padding: 15px; border-radius: 5px;">${JSON.stringify(received_updates, null, 2)}</pre>
    </body>
    </html>
  `);
});

app.get('/instagram', function(req, res) {
  if (
    req.query['hub.mode'] == 'subscribe' &&
    req.query['hub.verify_token'] == token
  ) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

app.post('/instagram', function(req, res) {
  console.log('Instagram webhook received:');
  console.log(JSON.stringify(req.body, null, 2));
  
  // Process Instagram DMs
  if (req.body.entry) {
    req.body.entry.forEach(entry => {
      if (entry.messaging) {
        entry.messaging.forEach(event => {
          if (event.message) {
            const dm = {
              sender_id: event.sender.id,
              recipient_id: event.recipient.id,
              timestamp: event.timestamp,
              message_text: event.message.text || null,
              message_id: event.message.mid,
              received_at: new Date().toISOString()
            };
            console.log('New Instagram DM:', dm);
            received_updates.unshift(dm);
          }
        });
      }
    });
  }
  
  res.sendStatus(200);
});

module.exports = app;
