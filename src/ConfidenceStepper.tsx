import { useEffect, useRef, useState } from 'react';
import { appIdle, onAppWake } from './idle';

/**
 * Confidence as a stepper: − and + around a big number, 0–10. The signal is a
 * glow behind the number — red (worry) / amber (shaky) / green (on track) /
 * hyperspace blue at 10 — breathing slowly when it's ≤2. Stepping up thumps the
 * number; stepping down shakes it. From 7 the whole key-result row flies at
 * warp speed, streaks growing longer and faster the higher it goes.
 */

export const dialColor = (v: number) => (v <= 3 ? '#ff3b30' : v <= 6 ? '#ff9500' : v < 10 ? '#34c759' : '#5aa2ff');

type Star = { x: number; y: number; speed: number; len: number; width: number; life: number };

export function ConfidenceStepper({ value, onChange, readOnly }: {
  value: number | undefined;
  onChange: (v: number) => void;
  readOnly?: boolean;
}) {
  const v = value ?? 0;
  const rated = value !== undefined;
  const [fx, setFx] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);

  const bump = (delta: number) => {
    const next = Math.max(0, Math.min(10, v + delta));
    if (next === v && rated) return;
    onChange(next);
    setFx((f) => ({ dir: delta > 0 ? 'up' : 'down', n: (f?.n ?? 0) + 1 }));
  };

  /* ── warp field ── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>([]);
  const hyperRef = useRef(false);
  hyperRef.current = v >= 10;
  const intRef = useRef(0); // 0 at 7 → 1 at 10: longer, faster streaks the higher it goes
  intRef.current = Math.max(0, Math.min(1, (v - 7) / 3));
  const warp = rated && v >= 7;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!warp) {
      stars.current = [];
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      return;
    }
    // the canvas spans the whole key-result row (CSS) — keep the bitmap in sync at 2x
    const fit = () => {
      const w = Math.round(c.clientWidth * 2), h = Math.round(c.clientHeight * 2);
      if (w && h && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    const spawn = (x: number, H: number) => ({
      x,
      y: H / 2 + (Math.random() + Math.random() - 1) * H * 0.46,
      speed: 1.6 + Math.random() * 3.2,
      len: 6 + Math.random() * 18,
      width: 1 + Math.random() * 1.4,
      life: 0,
    });
    // start with a field already in flight, not an empty screen filling up
    if (!stars.current.length) for (let i = 0; i < 20; i++) stars.current.push({ ...spawn(Math.random() * c.width, c.height), life: 1 });

    // The loop PARKS instead of running forever: it stops outright while the box is scrolled
    // out of view or the window has sat unfocused for a minute (the transparent mac window
    // never reports occlusion, so this is the only "nobody is watching" signal we get), and
    // it draws at 30fps — plenty for streaks, half the burn, and it no longer starves the
    // master-plan pan of frame time.
    let raf = 0;
    let dead = false;
    let last = 0;
    let onScreen = true;
    const start = () => { if (!dead && !raf) raf = requestAnimationFrame(step); };
    const park = () => { c.getContext('2d')?.clearRect(0, 0, c.width, c.height); };
    const step = (ts: number) => {
      raf = 0;
      if (dead) return;
      if (!onScreen || appIdle()) { park(); return; } // wake/scroll restarts us
      if (ts - last < 31) { start(); return; }
      // motion is normalized to TIME (120Hz frame units — the speed the effect was tuned
      // at), so drawing at 30fps keeps the same perceived velocity, just fewer samples
      const dt = last ? Math.min(6, (ts - last) / 8.33) : 1;
      last = ts;
      const ctx = c.getContext('2d')!;
      const W = c.width, H = c.height;
      const hyper = hyperRef.current;
      const t = intRef.current;
      // every level from 7 up is a big jump: far denser, faster, longer
      for (let i = 0; i < Math.round((1 + Math.round(t * 3)) * dt); i++) {
        if (stars.current.length < 12 + t * 45 && Math.random() < 0.7) stars.current.push(spawn(W + Math.random() * 40, H));
      }
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';
      // the warping box is always deep space — one bright palette; drawn as two solid
      // segments per streak (dim tail + bright head): no gradients, no shadowBlur, no lag
      const headCol = hyper ? '235, 243, 255' : '190, 240, 200';
      const tailCol = hyper ? '110, 170, 255' : '80, 205, 115';
      stars.current = stars.current.filter((s) => s.x + s.len + s.speed * 8 > -10);
      for (const s of stars.current) {
        s.x -= s.speed * (1 + t * 2.4) * dt;
        s.speed = Math.min(13, s.speed * Math.pow(1.008 + t * 0.01, dt)); // ever accelerating = warp
        s.life = Math.min(1, s.life + 0.08 * dt);
        const len = (s.len + s.speed * 2.2) * (1 + t * 2.6); // higher score = much longer streaks
        const head = s.x, tail = s.x + len;
        // gentle fade over ~15% of the box at BOTH ends, and toward top/bottom — nothing clips
        const fadeX = W * 0.15;
        const edge = Math.min(1, s.y / 10, (H - s.y) / 10, tail / fadeX, (W - head) / fadeX);
        const a = 0.7 * s.life * Math.max(0, edge);
        if (a <= 0.01) continue;
        const headLen = Math.min(len, 10 + s.speed);
        ctx.lineWidth = s.width;
        ctx.strokeStyle = `rgba(${tailCol}, ${a * 0.4})`;
        ctx.beginPath();
        ctx.moveTo(head + headLen, s.y);
        ctx.lineTo(tail, s.y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${headCol}, ${a})`;
        ctx.beginPath();
        ctx.moveTo(head, s.y);
        ctx.lineTo(head + headLen, s.y);
        ctx.stroke();
      }
      start();
    };
    start();
    const io = new IntersectionObserver((es) => { const e = es[es.length - 1]; onScreen = e.isIntersecting; if (e.isIntersecting) start(); }); // newest entry — a batched out-then-in must land on IN
    io.observe(c);
    const offWake = onAppWake(start);
    return () => { dead = true; if (raf) cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); offWake(); };
  }, [warp]);

  const danger = rated && v <= 3;

  return (
    <div className={`cstep${danger ? ' danger' : ''}${warp ? ` warp w${v}` : ''}`}>
      <canvas ref={canvasRef} className="cstep-canvas" />
      {!readOnly && <button className="cstep-btn" title="Less confident" disabled={rated && v <= 0} onClick={() => bump(-1)}>−</button>}
      <span
        key={fx?.n ?? 'still'}
        className={`cstep-value${rated ? '' : ' unrated'}${fx ? ` fx-${fx.dir}` : ''}`}
        style={rated ? { ['--gc' as string]: dialColor(v) } : undefined}
        onAnimationEnd={(e) => { if (e.animationName.startsWith('step-pop') || e.animationName.startsWith('step-shake')) setFx(null); }}
      >{rated ? v : '–'}</span>
      {!readOnly && <button className="cstep-btn" title="More confident" disabled={rated && v >= 10} onClick={() => bump(1)}>+</button>}
    </div>
  );
}
