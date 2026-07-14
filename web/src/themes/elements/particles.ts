// Per-element 2D particle field for the SP themes. Each element gets a
// bespoke motion signature (embers rising for fire, bubbles + ripples for
// water, streaks/leaves for wind, sinking blocks + dust for earth, pulsing
// glow orbs for night, a faint twinkle field for the starry theme) so the
// six SP themes read as different worlds rather than one recoloured drift.
//
// One canvas, one requestAnimationFrame loop, DPR-aware, capped particle
// count, and a hard opt-out under prefers-reduced-motion — the WebGL crystal
// drift already carries the "signature geometry"; this layer is the life.

export type ParticleKind = "ember" | "bubble" | "leaf" | "dust" | "orb" | "spark";

export interface ParticleConfig {
  kind: ParticleKind;
  /** CSS colour strings sampled per particle. */
  colors: string[];
  /** Rough target of live particles; the spawner tops up toward this. */
  density: number;
}

interface P {
  x: number; y: number; vx: number; vy: number;
  size: number; life: number; ttl: number;
  rot: number; vrot: number; seed: number; ci: number;
}

// A ripple ring, water-only, spawned occasionally.
interface Ring { x: number; y: number; r: number; ttl: number; life: number; }

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function mountParticles(host: HTMLElement, config: ParticleConfig): () => void {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.createElement("canvas");
  canvas.className = "el-particle-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const remove = () => canvas.remove();
  if (reduce) return remove;

  const ctx = canvas.getContext("2d");
  if (!ctx) return remove;

  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  let w = 0, h = 0;
  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  const parts: P[] = [];
  const rings: Ring[] = [];
  const additive = config.kind === "ember" || config.kind === "orb" || config.kind === "spark";

  function spawn(prime = false): P {
    const k = config.kind;
    const ci = (Math.random() * config.colors.length) | 0;
    // `prime` scatters the initial fill across the whole viewport so the
    // field doesn't visibly "boot up" from one edge on theme switch.
    if (k === "ember") {
      return { x: rand(0, w), y: prime ? rand(0, h) : rand(h * 0.82, h + 20), vx: rand(-8, 8), vy: rand(-46, -22), size: rand(1.4, 3.6), life: 0, ttl: rand(2.6, 5.2), rot: 0, vrot: 0, seed: rand(0, TAU), ci };
    }
    if (k === "bubble") {
      return { x: rand(0, w), y: prime ? rand(0, h) : rand(h * 0.9, h + 20), vx: 0, vy: rand(-30, -14), size: rand(2.5, 7), life: 0, ttl: rand(4, 8), rot: 0, vrot: 0, seed: rand(0, TAU), ci };
    }
    if (k === "leaf") {
      return { x: prime ? rand(0, w) : rand(-40, 0), y: rand(0, h * 0.9), vx: rand(26, 64), vy: rand(-4, 10), size: rand(3, 8), life: 0, ttl: rand(5, 10), rot: rand(0, TAU), vrot: rand(-1.6, 1.6), seed: rand(0, TAU), ci };
    }
    if (k === "dust") {
      // Half sinking blocks (from the top), half slow floating motes.
      const block = Math.random() < 0.45;
      return block
        ? { x: rand(0, w), y: prime ? rand(0, h) : rand(-30, 0), vx: rand(-4, 4), vy: rand(8, 20), size: rand(5, 12), life: 0, ttl: rand(6, 12), rot: rand(0, TAU), vrot: rand(-0.5, 0.5), seed: -1, ci }
        : { x: rand(0, w), y: rand(0, h), vx: rand(-10, 10), vy: rand(-6, 6), size: rand(1, 2.6), life: 0, ttl: rand(4, 9), rot: 0, vrot: 0, seed: rand(0, TAU), ci };
    }
    if (k === "orb") {
      return { x: rand(0, w), y: rand(0, h), vx: rand(-7, 7), vy: rand(-7, 7), size: rand(10, 26), life: 0, ttl: rand(5, 10), rot: 0, vrot: 0, seed: rand(0, TAU), ci };
    }
    // spark — a still twinkle field
    return { x: rand(0, w), y: rand(0, h), vx: rand(-3, 3), vy: rand(-3, 3), size: rand(0.7, 2), life: 0, ttl: rand(3, 7), rot: 0, vrot: 0, seed: rand(0, TAU), ci };
  }

  for (let i = 0; i < config.density; i++) parts.push(spawn(true));

  let raf = 0;
  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx!.clearRect(0, 0, w, h);
    ctx!.globalCompositeOperation = additive ? "lighter" : "source-over";

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      const t = p.life / p.ttl;
      if (t >= 1 || p.x < -60 || p.x > w + 60 || p.y < -60 || p.y > h + 60) {
        parts.splice(i, 1);
        continue;
      }
      // fade in/out envelope
      const fade = Math.min(1, t / 0.15) * Math.min(1, (1 - t) / 0.25);
      const color = config.colors[p.ci];
      drawParticle(ctx!, config.kind, p, now, fade, color);
    }
    // top up toward density
    while (parts.length < config.density) parts.push(spawn());

    if (config.kind === "bubble") {
      ctx!.globalCompositeOperation = "source-over";
      if (Math.random() < dt * 0.9) rings.push({ x: rand(w * 0.1, w * 0.9), y: rand(h * 0.2, h * 0.85), r: 2, ttl: rand(1.6, 2.8), life: 0 });
      for (let i = rings.length - 1; i >= 0; i--) {
        const rg = rings[i];
        rg.life += dt;
        const rt = rg.life / rg.ttl;
        if (rt >= 1) { rings.splice(i, 1); continue; }
        rg.r += dt * 34;
        ctx!.beginPath();
        ctx!.globalAlpha = (1 - rt) * 0.55;
        ctx!.strokeStyle = config.colors[1];
        ctx!.lineWidth = 1.6;
        ctx!.arc(rg.x, rg.y, rg.r, 0, TAU);
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;
    }

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    remove();
  };
}

function drawParticle(ctx: CanvasRenderingContext2D, kind: ParticleKind, p: P, now: number, fade: number, color: string) {
  const t = p.life / p.ttl;
  // integrate motion
  const sway = Math.sin(now / 1000 * (kind === "ember" ? 2.4 : kind === "leaf" ? 1.6 : 1) + p.seed);
  const dt = 1 / 60;
  if (kind === "ember") { p.x += (p.vx + sway * 18) * dt; p.y += p.vy * dt; p.vy *= 0.998; }
  else if (kind === "bubble") { p.x += sway * 10 * dt; p.y += p.vy * dt; }
  else if (kind === "leaf") { p.x += p.vx * dt; p.y += (p.vy + sway * 22) * dt; p.rot += p.vrot * dt; }
  else if (kind === "dust") { p.x += (p.vx + (p.seed === -1 ? 0 : sway * 6)) * dt; p.y += p.vy * dt; p.rot += p.vrot * dt; }
  else if (kind === "orb") { p.x += p.vx * dt; p.y += p.vy * dt; }
  else { p.x += p.vx * dt; p.y += p.vy * dt; }

  ctx.save();
  if (kind === "ember") {
    const flick = 0.6 + 0.4 * Math.sin(now / 90 + p.seed);
    const s = p.size * (1 - t * 0.5);
    ctx.globalAlpha = fade * flick * 0.9;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, s * 3);
    g.addColorStop(0, color); g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, s * 3, 0, TAU); ctx.fill();
    ctx.globalAlpha = fade * flick;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, s, 0, TAU); ctx.fill();
  } else if (kind === "bubble") {
    ctx.globalAlpha = fade * 0.32;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    ctx.globalAlpha = fade * 0.85;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.stroke();
    ctx.globalAlpha = fade * 0.9;
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.beginPath(); ctx.arc(p.x - p.size * 0.32, p.y - p.size * 0.32, p.size * 0.26, 0, TAU); ctx.fill();
  } else if (kind === "leaf") {
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.globalAlpha = fade * 0.72;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, TAU);
    ctx.fill();
  } else if (kind === "dust") {
    if (p.seed === -1) {
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = fade * 0.5;
      ctx.fillStyle = color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    } else {
      ctx.globalAlpha = fade * 0.5;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    }
  } else if (kind === "orb") {
    const pulse = 0.7 + 0.5 * Math.sin(now / 1400 + p.seed);
    const s = p.size * (0.6 + pulse * 0.6);
    ctx.globalAlpha = fade * 0.34 * pulse;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, s);
    g.addColorStop(0, color); g.addColorStop(0.5, color); g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, s, 0, TAU); ctx.fill();
  } else {
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(now / 700 + p.seed * 3));
    ctx.globalAlpha = fade * tw;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
  }
  ctx.restore();
}
