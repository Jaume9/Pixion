import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const W = 320, H = 320;
const COOLDOWN_MS = 15 * 60 * 1000;

export default function App() {
  const canvasRef = useRef(null);
  const [boardMap, setBoardMap] = useState(new Map());
  const [user, setUser] = useState(null);
  const [color, setColor] = useState('#ff0000');
  const [lastPaint, setLastPaint] = useState(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [shopOpen, setShopOpen] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    // fetch user
    fetch('/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => { if (u) { setUser(u); setLastPaint(u.lastPaint || 0); } })
      .catch(()=>{});

    // load board
    fetch('/pixels')
      .then(r => r.json())
      .then(data => {
        const m = new Map();
        data.pixels.forEach(p => m.set(`${p.x},${p.y}`, p.color));
        setBoardMap(m);
      });

    // connect socket explicitly to backend origin
    const s = io('http://localhost:3000', { withCredentials: true });
    socketRef.current = s;
    s.on('connect', () => { /* console.log('socket connected', s.id) */ });
    s.on('pixel_update', ({ x, y, color }) => {
      setBoardMap(prev => {
        const copy = new Map(prev);
        copy.set(`${x},${y}`, color);
        return copy;
      });
    });
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setCooldownRemaining(Math.max(0, COOLDOWN_MS - (Date.now() - lastPaint)));
    }, 1000);
    return () => clearInterval(t);
  }, [lastPaint]);

  useEffect(() => {
    // draw
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const styleMax = Math.min(window.innerWidth - 32, window.innerHeight - 120);
    const pixelSize = Math.floor(styleMax / Math.max(W, H));
    const displaySize = pixelSize * Math.max(W, H);
    canvas.style.width = `${displaySize}px`;
    canvas.style.height = `${displaySize}px`;

    canvas.width = W * ratio;
    canvas.height = H * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    for (const [k, c] of boardMap.entries()) {
      const [x, y] = k.split(',').map(Number);
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 1, 1);
    }
  }, [boardMap]);

  function pixelFromEvent(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const styleW = rect.width;
    const styleH = rect.height;
    const px = Math.floor(((e.clientX - rect.left) / styleW) * W);
    const py = Math.floor(((e.clientY - rect.top) / styleH) * H);
    return { x: px, y: py };
  }

  async function handleClick(e) {
    if (!user) { window.location.href = '/auth/google'; return; }
    if (cooldownRemaining > 0) {
      if (!confirm(`Cooldown activo: ${Math.ceil(cooldownRemaining/1000)}s\n¿Quieres comprar placement instantáneo?`)) return;
      // create stripe checkout (paid placement)
      const { x, y } = pixelFromEvent(e);
      try {
        const resp = await fetch('/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ x, y, color })
        });
        const data = await resp.json();
        if (data.url) {
          window.location.href = data.url; // redirect to Stripe Checkout
        } else {
          alert('No se pudo crear sesión de pago.');
        }
      } catch (err) {
        alert('Error creando sesión de pago.');
      }
      return;
    }
    const { x, y } = pixelFromEvent(e);
    // optimistic
    setBoardMap(prev => { const c = new Map(prev); c.set(`${x},${y}`, color); return c; });
    try {
      const r = await fetch('/paint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ x, y, color })
      });
      if (!r.ok) {
        const err = await r.json().catch(()=>({error:'unknown'}));
        alert('Error: ' + (err.error || 'unknown'));
        // reload board to sync
        const boardResp = await fetch('/pixels'); const data = await boardResp.json();
        const m = new Map(); data.pixels.forEach(p => m.set(`${p.x},${p.y}`, p.color)); setBoardMap(m);
      } else {
        setLastPaint(Date.now());
      }
    } catch (e) {
      alert('Network error');
    }
  }

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column'}}>
      <div style={{height:64, background:'#111', color:'#fff', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px'}}>
        <div style={{display:'flex', gap:12, alignItems:'center'}}>
          <strong>r/place Clone</strong>
          <span style={{fontSize:12, color:'#ddd'}}>Grid: {W}×{H}</span>
          <button style={{marginLeft:12}} onClick={()=>setShopOpen(true)}>Shop</button>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          {!user ? <a style={{background:'#2563eb', color:'#fff', padding:'6px 10px', borderRadius:6}} href="/auth/google">Iniciar sesión</a> :
            <>
              <div style={{color:'#fff'}}>{user.displayName}</div>
              <div style={{color:'#fff'}}>{Math.ceil(cooldownRemaining/1000)}s</div>
              <button style={{background:'#2563eb', color:'#fff', padding:'6px 10px', borderRadius:6}} onClick={()=>window.location.href='/auth/logout'}>Cerrar sesión</button>
            </>
          }
          <input type="color" value={color} onChange={e=>setColor(e.target.value)} />
        </div>
      </div>

      <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:'#222', padding:8}}>
        <canvas ref={canvasRef} onClick={handleClick} style={{border:'1px solid #333', imageRendering:'pixelated', cursor:'crosshair'}} />
      </div>

      {shopOpen && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center'}} onClick={()=>setShopOpen(false)}>
          <div style={{background:'#fff', padding:20, borderRadius:8, width:'90%', maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <h3>Tienda</h3>
            <p>Aquí puedes comprar placement instantáneo (sandbox con Stripe). Al pulsar crearás una sesión de pago.</p>
            <div style={{display:'flex', justifyContent:'flex-end', gap:8}}>
              <button onClick={()=>setShopOpen(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
