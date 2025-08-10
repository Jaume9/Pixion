const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
// Optional: const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(bodyParser.json());

// Config
const CANVAS_W = 500; // ajustar
const CANVAS_H = 500;
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutos
const PORT = process.env.PORT || 3000;

// In-memory storage (para producción usar Redis / DB)
let pixels = new Map(); // key `${x},${y}` -> { color, ts, userId }
let lastPaint = new Map(); // userId -> timestamp of last free paint

// Helper
function key(x,y){return `${x},${y}`}

// Endpoint: obtener estado del canvas
app.get('/pixels', (req,res)=>{
  // return simple JSON array of painted pixels
  const arr = [];
  for (const [k,v] of pixels.entries()){
    const [x,y]=k.split(',').map(Number);
    arr.push({x,y,color:v.color});
  }
  res.json({w:CANVAS_W,h:CANVAS_H,pixels:arr});
});

// Endpoint: pago -> se usa para crear session (placeholder)
app.post('/create-checkout-session', async (req,res)=>{
  // Aquí integrarías Stripe Checkout / PaymentIntent
  // Por ahora devolvemos un token de ejemplo que el cliente puede usar para "paid placement".
  // En producción: crea PaymentIntent y verifica con webhook antes de conceder placement.
  const mockPaymentToken = 'MOCK_PAID_TOKEN_' + Math.random().toString(36).slice(2);
  // Guardar token ephemeral si quieres (o devolver para demo)
  res.json({sessionId: mockPaymentToken});
});

// Endpoint: pintar (servidor valida cooldown y optionally pago)
app.post('/paint', (req,res)=>{
  /* body: { x, y, color, userId, paidToken (optional) } */
  const {x,y,color,userId,paidToken} = req.body;
  if (x<0||y<0||x>=CANVAS_W||y>=CANVAS_H) return res.status(400).json({error:'out_of_bounds'});

  const now = Date.now();
  // Check if user is allowed: free cooldown or paid token
  const last = lastPaint.get(userId) || 0;
  if (paidToken){
    // In demo: accept any MOCK token that startsWith
    if (!String(paidToken).startsWith('MOCK_PAID_TOKEN_')){
      return res.status(400).json({error:'invalid_paid_token'});
    }
    // Paid placement allowed instantly. (In real: verify server-side with Stripe webhook.)
  } else {
    if (now - last < COOLDOWN_MS){
      const wait = COOLDOWN_MS - (now-last);
      return res.status(429).json({error:'cooldown', waitMs:wait});
    }
    // update lastPaint
    lastPaint.set(userId, now);
  }

  // Set pixel
  pixels.set(key(x,y), {color, ts:now, userId});

  // Broadcast to all clients
  io.emit('pixel_update', {x,y,color});

  res.json({ok:true});
});

// Basic static serve for client build (if deploy together)
app.use(express.static('public'));

io.on('connection', socket => {
  console.log('socket connected', socket.id);
  // Could attach userId after auth
  socket.on('hello', data => {
    // no-op
  });

  socket.on('disconnect', () => {});
});

server.listen(PORT, ()=>console.log('Server listening on',PORT));