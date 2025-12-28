// Load environment variables from .env.local or .env (must be first!)
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config(); // Also load .env if .env.local doesn't exist
  console.log('✓ Environment variables loaded from .env.local or .env');
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.warn('⚠️  dotenv package not found. Install it with: npm install dotenv');
    console.warn('⚠️  Environment variables will only be loaded from system environment.');
  } else {
    console.warn('⚠️  Failed to load .env files:', err.message);
  }
}

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');

const { handleDM, processQuery } = require('../helpers/message_handler');
const { fetchAllEvents, searchEvents } = require('../helpers/events');

const app = express();
app.use(bodyParser.json());

// Serve static files from the frontend build
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
}

const VERIFY_TOKEN = process.env.TOKEN || 'token';

/* =====================
   WEB CHAT API (shared logic with Instagram DMs)
===================== */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, userId } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Use provided userId or generate a default for anonymous users
    const userIdentifier = userId || `web_${Date.now()}`;
    
    console.log(`Web chat from ${userIdentifier}: ${message}`);
    
    const { reply, category } = await processQuery(userIdentifier, message);
    
    res.json({ reply, category });
  } catch (err) {
    console.error('Chat API error:', err.message);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

/* =====================
   ROUTES
===================== */
app.get('/', (req, res) => {
  // If frontend is built, serve it
  const indexPath = path.join(frontendDistPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  // Fallback to simple status page
  res.send(`<h1>NYC Scout API</h1><p>API is running. Build the frontend to see the web app.</p>`);
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

app.get('/events/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query parameter "q"' });
  const result = await searchEvents(query);
  res.json(result);
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
  try {
    await handleDM(req.body);
  } catch (err) {
    console.error('handleDM failed:', err.message);
    // Still 200 so Meta doesn't keep retrying
  }
  res.sendStatus(200);
});

/* =====================
   SPA FALLBACK (for React Router)
===================== */
app.get('*', (req, res) => {
  // Skip API routes and known static files
  if (req.path.startsWith('/api/') || req.path.startsWith('/instagram')) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  const indexPath = path.join(frontendDistPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  
  res.status(404).send('Not found');
});

/* =====================
   SERVER START
===================== */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
