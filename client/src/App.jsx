import React, {useEffect, useRef, useState} from 'react';
import io from 'socket.io-client';

const W = 500, H = 500; // debe coincidir con servidor
const PIXEL_SIZE = 2; // tamaño en canvas para mostrar
const COOLDOWN_MS = 15 * 60 * 1000;

export default function App(){
  const canvasRef = useRef(null);
  const [pixelsMap, setPixelsMap] = useState(new Map());
  const [color, setColor] = useState('#ff0000');
  const [userId] = useState(() => 'u_' + Math.random().toString(36).slice(2));
  const [lastPaint, setLastPaint] = useState(0);
  const [socket, setSocket] = useState(null);

  useEffect(()=>{
    fetch('/pixels').then(r=>r.json()).then(data=>{
      const m = new Map();
      data.pixels.forEach(p => m.set(`${p.x},${p.y}`, p.color));
      setPixelsMap(m);
    });

    const s = io();
    setSocket(s);
    s.on('pixel_update', ({x,y,color})=>{
      setPixelsMap(prev=>{ const copy=new Map(prev); copy.set(`${x},${y}`, color); return copy;});
    });
    return ()=>s.disconnect();
  },[]);

  useEffect(()=>{
    // draw
    const canvas = canvasRef.current; if(!canvas) return;
    canvas.width = W * PIXEL_SIZE; canvas.height = H * PIXEL_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for (const [k,c] of pixelsMap.entries()){
      const [x,y]=k.split(',').map(Number);
      ctx.fillStyle = c;
      ctx.fillRect(x*PIXEL_SIZE, y*PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
    }
  },[pixelsMap]);

  function tryPaint(x,y,paidToken){
    fetch('/paint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,y,color,userId,paidToken})})
    .then(async r=>{
      if (!r.ok){
        const err = await r.json();
        if (err.error==='cooldown'){
          alert('Cooldown activo. Espera '+Math.ceil(err.waitMs/1000)+'s o compra placement instantáneo.');
        } else alert('Error: '+err.error);
        return;
      }
      // success -> server emits socket event which updates client
      setLastPaint(Date.now());
    }).catch(e=>{alert('network error')});
  }

  function handleClick(e){
    const rect = e.target.getBoundingClientRect();
    const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
    const x = Math.floor(cx / PIXEL_SIZE); const y = Math.floor(cy / PIXEL_SIZE);
    // check cooldown locally for snappier UX
    if (Date.now() - lastPaint < COOLDOWN_MS){
      if (!confirm('Estás en cooldown. ¿Quieres comprar placement instantáneo?')) return;
      // Create checkout session (demo)
      fetch('/create-checkout-session',{method:'POST',headers:{'Content-Type':'application/json'}})
      .then(r=>r.json()).then(data=>{
        // For demo: get mock token and call /paint with it
        const token = data.sessionId;
        tryPaint(x,y,token);
      });
    } else {
      tryPaint(x,y,null);
    }
  }

  return (
    <div className="p-4">
      <h1 className="text-2xl mb-2">r/place Clone — Demo</h1>
      <div className="flex items-center gap-2 mb-2">
        <input type="color" value={color} onChange={e=>setColor(e.target.value)} />
        <div>User: {userId}</div>
        <div>Cooldown: {Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now()-lastPaint))/1000))}s</div>
      </div>
      <div>
        <canvas ref={canvasRef} onClick={handleClick} style={{border:'1px solid #ccc',imageRendering:'pixelated'}} />
      </div>
      <p className="mt-2 text-sm text-gray-600">Haz click para pintar. Si estás en cooldown, te ofreceremos comprar placement instantáneo.</p>
    </div>
  );
}