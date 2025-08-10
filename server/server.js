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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const CANVAS_W = 320; // 320x320 = 102400 px
const CANVAS_H = 320;
const COOLDOWN_MS = 15 * 60 * 1000;
const BOARD_FILE = path.join(__dirname, 'board.json');

app.use(cors({ origin: ['http://localhost:5173'], credentials: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// In-memory users (will persist board; users ephemeral unless you add DB)
const users = new Map(); // googleId -> { id, displayName, lastPaint, pixelsPlaced }

// Load or init board
let board = {}; // keys "x,y" -> { color, paintedBy, ts }
function loadBoard() {
  if (fs.existsSync(BOARD_FILE)) {
    try {
      const raw = fs.readFileSync(BOARD_FILE, 'utf8');
      board = JSON.parse(raw) || {};
      console.log('Board loaded. Pixels:', Object.keys(board).length);
    } catch (e) {
      console.error('Error loading board.json:', e);
      board = {};
    }
  } else {
    board = {};
  }
}
function saveBoard() {
  try {
    fs.writeFileSync(BOARD_FILE, JSON.stringify(board));
  } catch (e) {
    console.error('Error saving board.json:', e);
  }
}
loadBoard();

// Passport Google OAuth
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const u = users.get(id) || null;
  done(null, u);
});

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
}, (accessToken, refreshToken, profile, cb) => {
  let u = users.get(profile.id);
  if (!u) {
    u = { id: profile.id, displayName: profile.displayName, lastPaint: 0, pixelsPlaced: 0 };
    users.set(profile.id, u);
  }
  return cb(null, u);
}));

// Auth routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/failure' }),
  (req, res) => {
    // redirect to client
    res.redirect(process.env.CLIENT_ORIGIN || 'http://localhost:5173');
  }
);

app.get('/auth/failure', (req, res) => {
  res.status(401).send('Auth failed');
});

app.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  // send back user info (do NOT expose sensitive tokens)
  res.json({ id: req.user.id, displayName: req.user.displayName, lastPaint: req.user.lastPaint, pixelsPlaced: req.user.pixelsPlaced });
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect(process.env.CLIENT_ORIGIN || 'http://localhost:5173');
  });
});

// Serve board state
app.get('/pixels', (req, res) => {
  // return array of painted pixels (sparse)
  const arr = [];
  for (const k of Object.keys(board)) {
    const [x, y] = k.split(',').map(Number);
    const { color, paintedBy, ts } = board[k];
    arr.push({ x, y, color, paintedBy, ts });
  }
  res.json({ w: CANVAS_W, h: CANVAS_H, pixels: arr });
});

// Paint endpoint
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
  saveBoard();
  user.lastPaint = now;
  user.pixelsPlaced = (user.pixelsPlaced || 0) + 1;

  // Emit to all clients
  io.emit('pixel_update', { x, y, color, paintedBy: user.id, ts: now });

  res.json({ ok: true });
});

// Serve production client (if you build client into server/public)
const STATIC_DIR = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get('*', (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

io.on('connection', socket => {
  // simple logging; socket auth not implemented here
  // clients get initial state via HTTP /pixels
  // you could emit diffs here if desired
  // console.log('socket connected', socket.id);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
