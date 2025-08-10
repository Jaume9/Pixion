import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';

const W = 320, H = 320; // canvas grid
const COOLDOWN_MS = 15 * 60 * 1000;

export default function App() {
  const canvasRef = useRef(null);
  const [socket, setSocket] = useState(null);
  const [boardMap, setBoardMap] = useState(new Map()); // "x,y" -> color
  const [user, setUser] = useState(null);
  const [color, setColor] = useState('#ff0000');
  const [lastPaint, setLastPaint] = useState(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [shopOpen, setShopOpen] = useState(false);

  // init: auth & board & socket
  useEffect(() => {
    // fetch user
    fetch('/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        if (u) {
          setUser(u);
          setLastPaint(u.lastPaint || 0);
        }
      })
      .catch(() => {});

    // load board
    fetch('/pixels')
      .then(r => r.json())
      .then(data => {
        const m = new Map();
        data.pixels.forEach(p => m.set(`${p.x},${p.y}`, p.color));
        setBoardMap(m);
      });

    // socket
    const s = io('/', { withCredentials: true });
    s.on('connect', () => {
      // console.log('socket connected', s.id);
    });
    s.on('pixel_update', ({ x, y, color }) => {
      setBoardMap(prev => {
        const copy = new Map(prev);
        copy.set(`${x},${y}`, color);
        return copy;
      });
    });
    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, []);

  // cooldown ticker
  useEffect(() => {
    const t = setInterval(() => {
      setCooldownRemaining(Math.max(0, COOLDOWN_MS - (Date.now() - lastPaint)));
    }, 1000);
    return () => clearInterval(t);
  }, [lastPaint]);

  // draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // compute pixel size so canvas fits screen but keeps grid
    // we'll set logical size to W x H, but style it to scale
    const ratio = window.devicePixelRatio || 1;
    const styleWidth = Math.min(window.innerWidth - 16, window.innerHeight - 100); // max square
    const pixelSize = Math.floor(styleWidth / Math.max(W, H));
    const displaySize = pixelSize * Math.max(W, H);
    canvas.style.width = `${displaySize}px`;
    canvas.style.height = `${displaySize}px`;

    canvas.width = W * ratio;
    canvas.height = H * ratio;

    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    // clear
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // draw pixels
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

  function handleClick(e) {
    if (!user) {
      window.location.href = '/auth/google';
      return;
    }
    if (cooldownRemaining > 0) {
      alert(`Cooldown activo: ${Math.ceil(cooldownRemaining / 1000)}s`);
      return;
    }
    const { x, y } = pixelFromEvent(e);
    // optimistic update (optional)
    setBoardMap(prev => {
      const copy = new Map(prev);
      copy.set(`${x},${y}`, color);
      return copy;
    });
    // send to server
    fetch('/paint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ x, y, color })
    }).then(async r => {
      if (!r.ok) {
        const err = await r.json().catch(()=>({error:'unknown'}));
        alert('Error: ' + (err.error || 'unknown'));
        // reload pixel from server to correct optimistic change
        fetch('/pixels').then(r => r.json()).then(data => {
          const m = new Map();
          data.pixels.forEach(p => m.set(`${p.x},${p.y}`, p.color));
          setBoardMap(m);
        });
      } else {
        setLastPaint(Date.now());
      }
    }).catch(() => {
      alert('Network error');
    });
  }

  return (
    <div className="app">
      <div className="header">
        <div style={{display:'flex', gap:12, alignItems:'center'}}>
          <strong>r/place Clone</strong>
          <span className="small" style={{marginLeft:8}}>Grid: {W}×{H}</span>
          <button className="button" onClick={()=>setShopOpen(true)} style={{marginLeft:12}}>Shop</button>
        </div>
        <div className="controls">
          {!user ? (
            <a className="button" href="/auth/google">Iniciar sesión</a>
          ) : (
            <div style={{display:'flex', gap:8, alignItems:'center'}}>
              <div className="small">Hola {user.displayName}</div>
              <div className="small">Cooldown: {Math.ceil(cooldownRemaining/1000)}s</div>
              <button className="button" onClick={()=> window.location.href='/auth/logout'}>Cerrar sesión</button>
            </div>
          )}
          <input type="color" value={color} onChange={e=>setColor(e.target.value)} style={{marginLeft:10}} />
        </div>
      </div>

      <div className="canvas-wrap">
        <canvas ref={canvasRef} onClick={handleClick} />
      </div>

      {shopOpen && (
        <div className="modal-bg" onClick={()=>setShopOpen(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <h3>Tienda</h3>
            <p>Por ahora no hay nada configurado. Aquí irán compras (p. ej. placement instantáneo).</p>
            <div style={{display:'flex', justifyContent:'flex-end', marginTop:12}}>
              <button className="button" onClick={()=>setShopOpen(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
