// server/server.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bodyParser = require('body-parser');
const cors = require('cors');

// Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['http://localhost:5173'], credentials: true }
});

const PORT = process.env.PORT || 3000;
const CANVAS_W = 320;
const CANVAS_H = 320;
const COOLDOWN_MS = 15 * 60 * 1000;

const BOARD_FILE = path.join(__dirname, 'board.json');
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(cors({ origin: ['http://localhost:5173'], credentials: true }));
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } })); // raw body for stripe webhook
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

/* -------------------------
   Utilities: read/write json
   ------------------------- */
function safeLoadJSON(filepath) {
  try {
    if (!fs.existsSync(filepath)) return {};
    const raw = fs.readFileSync(filepath, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error loading ${path.basename(filepath)}:`, e);
    return {};
  }
}
function safeSaveJSON(filepath, obj) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`Error saving ${path.basename(filepath)}:`, e);
  }
}

/* -------------------------
   Load board & users (persist)
   ------------------------- */
let board = safeLoadJSON(BOARD_FILE); // { "x,y": { color, paintedBy, ts } }
let usersData = safeLoadJSON(USERS_FILE); // { userId: { id, displayName, lastPaint, pixelsPlaced } }

// Wrap users in Map for runtime
const users = new Map(Object.entries(usersData || {}));

function persistBoard() {
  safeSaveJSON(BOARD_FILE, board);
}
function persistUsers() {
  // convert Map -> object
  const obj = {};
  for (const [k, v] of users.entries()) obj[k] = v;
  safeSaveJSON(USERS_FILE, obj);
}

/* -------------------------
   Passport Google OAuth
   ------------------------- */
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, users.get(id) || null));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
}, (accessToken, refreshToken, profile, cb) => {
  let u = users.get(profile.id);
  if (!u) {
    u = { id: profile.id, displayName: profile.displayName, lastPaint: 0, pixelsPlaced: 0 };
    users.set(profile.id, u);
    persistUsers();
  }
  return cb(null, u);
})) ;

/* -------------------------
   Auth routes
   ------------------------- */
app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/failure' }),
  (req, res) => res.redirect(process.env.CLIENT_ORIGIN || 'http://localhost:5173')
);
app.get('/auth/failure', (req, res) => res.status(401).send('Auth failed'));
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  const u = users.get(req.user.id);
  res.json({ id: u.id, displayName: u.displayName, lastPaint: u.lastPaint, pixelsPlaced: u.pixelsPlaced });
});
app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect(process.env.CLIENT_ORIGIN || 'http://localhost:5173'));
});

/* -------------------------
   Public API: pixels
   ------------------------- */
app.get('/pixels', (req, res) => {
  const arr = [];
  for (const k of Object.keys(board)) {
    const [x, y] = k.split(',').map(Number);
    const { color, paintedBy, ts } = board[k];
    arr.push({ x, y, color, paintedBy, ts });
  }
  res.json({ w: CANVAS_W, h: CANVAS_H, pixels: arr });
});

/* -------------------------
   Paint endpoint (free placement)
   ------------------------- */
app.post('/paint', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  const { x, y, color } = req.body;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) {
    return res.status(400).json({ error: 'out_of_bounds' });
  }
  const user = users.get(req.user.id);
  const now = Date.now();
  if (now - (user.lastPaint || 0) < COOLDOWN_MS) {
    const wait = COOLDOWN_MS - (now - user.lastPaint);
    return res.status(429).json({ error: 'cooldown', waitMs: wait });
  }

  const key = `${x},${y}`;
  board[key] = { color, paintedBy: user.id, ts: now };
  persistBoard();
  user.lastPaint = now;
  user.pixelsPlaced = (user.pixelsPlaced || 0) + 1;
  persistUsers();

  // Broadcast to all clients (immediate)
  io.emit('pixel_update', { x, y, color, paintedBy: user.id, ts: now });

  res.json({ ok: true });
});

/* -------------------------
   Stripe: create checkout session for paid placement
   - We create a checkout session and attach metadata {userId, x, y, color}
   - On webhook checkout.session.completed: place pixel server-side (verified)
   ------------------------- */
app.post('/create-checkout-session', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  const { x, y, color } = req.body;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) {
    return res.status(400).json({ error: 'out_of_bounds' });
  }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'stripe_not_configured' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Instant pixel placement' },
          unit_amount: 100, // $1.00 in cents (sandbox)
        },
        quantity: 1
      }],
      metadata: {
        userId: req.user.id,
        x: String(x),
        y: String(y),
        color: color
      },
      success_url: (process.env.CLIENT_ORIGIN || 'http://localhost:5173') + '?checkout=success',
      cancel_url: (process.env.CLIENT_ORIGIN || 'http://localhost:5173') + '?checkout=cancel'
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe create session error', e);
    res.status(500).json({ error: 'stripe_error' });
  }
});

// Stripe webhook endpoint to confirm payment and place pixel
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } else {
      // If no webhook secret provided in env (dev), parse body directly
      event = JSON.parse(req.rawBody.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const userId = metadata.userId;
    const x = parseInt(metadata.x, 10);
    const y = parseInt(metadata.y, 10);
    const color = metadata.color || '#000000';

    // Validate user exists server-side
    const user = users.get(userId);
    const now = Date.now();
    if (!user) {
      console.warn('Paid placement: user not found', userId);
      return res.json({ received: true });
    }

    // Place pixel immediately (paid -> no cooldown)
    const key = `${x},${y}`;
    board[key] = { color, paintedBy: userId, ts: now };
    persistBoard();
    user.pixelsPlaced = (user.pixelsPlaced || 0) + 1;
    persistUsers();

    io.emit('pixel_update', { x, y, color, paintedBy: userId, ts: now });
  }

  res.json({ received: true });
});

/* -------------------------
   Admin: export & import board (simple)
   - In production add auth/ACL for these endpoints
   ------------------------- */
app.get('/admin/export', (req, res) => {
  // Returns board.json file
  res.setHeader('Content-Disposition', 'attachment; filename=board.json');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(board, null, 2));
});

app.post('/admin/import', (req, res) => {
  // Expect body: { board: { "x,y": { color, paintedBy, ts } } }
  const body = req.body || {};
  if (!body.board) return res.status(400).json({ error: 'missing_board' });
  board = body.board;
  persistBoard();
  // Broadcast full board update (simple approach: emit many updates)
  for (const k of Object.keys(board)) {
    const [x, y] = k.split(',').map(Number);
    const { color, paintedBy, ts } = board[k];
    io.emit('pixel_update', { x, y, color, paintedBy, ts });
  }
  res.json({ ok: true, pixels: Object.keys(board).length });
});

/* -------------------------
   Serve client if built to ../client/dist
   ------------------------- */
const STATIC_DIR = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get('*', (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

/* -------------------------
   Socket connection (no auth socket-level here)
   ------------------------- */
io.on('connection', socket => {
  // nothing special needed; updates are sent via io.emit in endpoints
});

/* -------------------------
   Start
   ------------------------- */
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Board loaded: ${Object.keys(board).length} pixels; Users loaded: ${users.size}`);
});
