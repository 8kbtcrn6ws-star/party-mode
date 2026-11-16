// Shared pieces of the phone controllers (touch HUD + wheel): Prism's tokens/icons, safe frame, rotate prompt, toast, rim pulse,
// player tag, "reconnecting" banner, throttle ramp. Not a public API of the controls (use touch.js / wheel.js); exported for those two.
import { ensureIcons, icon } from '../ui/icons.js';
import { pulse, CAM_HOLD_S } from './input.js';

export { ensureIcons, icon };
export const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
export const isPortrait = () => mq('(orientation: portrait)').matches;

/** Player identity shapes (1 circle, 2 triangle, 3 square, 4 diamond). slot is 0-based. */
export const SHAPE_CLASS = ['circle', 'triangle', 'square', 'diamond'];
export const playerDot = (slot) => `<i class="pc-dot ${SHAPE_CLASS[(slot | 0) % 4]}" style="--p:var(--color-player-${((slot | 0) % 4) + 1})"></i>`;

/** Throttle ramp: 0 -> 1 over ~250 ms while held, instant release (DESIGN.md "Phone touch"). */
export function createRamp(rampMs = 250) {
  let v = 0, t = performance.now();
  return { step(target) { const n = performance.now(), dt = Math.min(0.1, (n - t) / 1000); t = n; v = target > v ? Math.min(target, v + dt / (rampMs / 1000)) : target; return v; }, reset() { v = 0; t = performance.now(); }, get value() { return v; } };
}

/** Camera freedom helpers shared by touch.js and wheel.js (Requirement 4). */
export const GLANCE_DRAG_PX = 28;
/** Glance button: hold = look back; keep holding and drag left/right past 28 px = look left/right; release = back to normal. */
export function createGlance() {
  let g = null, x0 = 0;
  return { start(x) { x0 = x; g = 'back'; }, move(x) { if (g == null) return; const d = x - x0; g = d < -GLANCE_DRAG_PX ? 'left' : d > GLANCE_DRAG_PX ? 'right' : 'back'; }, end() { g = null; }, get value() { return g; } };
}
/** CAM button: tap (released before CAM_HOLD_S) = one 'next' pulse on release; hold >= CAM_HOLD_S = one 'view' pulse at that moment, nothing on release. read() gives input.cam. */
export function createCamButton(holdS = CAM_HOLD_S) {
  const next = pulse(), view = pulse(); let t = 0, fired = false;
  return {
    down() { clearTimeout(t); fired = false; t = setTimeout(() => { fired = true; view.fire(); }, holdS * 1000); },
    up() { clearTimeout(t); t = 0; if (!fired) next.fire(); fired = false; },
    cancel() { clearTimeout(t); t = 0; fired = false; },
    read() { return view.on ? 'view' : next.on ? 'next' : null; },
  };
}
/** Two-finger pinch on the look surface -> zoom rate -1..1 (spread = -1 = zoom in, same sign as net protocol.js). take() is called once per read(). */
export const PINCH_PX_PER_S = 300;
export function createPinch() {
  const pts = new Map(); let acc = 0, t = performance.now();
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  return {
    get active() { return pts.size >= 2; },
    add(id, x, y) { pts.set(id, { x, y }); },
    move(id, x, y) { const p = pts.get(id); if (!p) return; const d0 = pts.size >= 2 ? dist() : 0; p.x = x; p.y = y; if (pts.size >= 2) acc += dist() - d0; },
    remove(id) { pts.delete(id); },
    clear() { pts.clear(); acc = 0; },
    take() { const n = performance.now(), dt = Math.max(0.008, (n - t) / 1000); t = n; const r = pts.size >= 2 ? Math.max(-1, Math.min(1, -acc / dt / PINCH_PX_PER_S)) : 0; acc = 0; return r; },
  };
}
/** Two icons Prism's set does not have (24px grid, stroke 2, round): U-turn arrow = look back. Deviation, see DESIGN notes. */
export const GLANCE_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';

/** The "frame" the layouts anchor to: inset by the safe-area vars (tokens.css: max(env(safe-area-inset-*), 8px)). */
export function createFrame(root) {
  const f = document.createElement('div'); f.className = 'pc-frame'; f.setAttribute('aria-hidden', 'true'); root.appendChild(f); return f;
}

/** Rotate prompt (phone-wheel-rotate): shown whenever `orientation: portrait`, fades out in 220 ms when landscape. CSS does the show/hide. */
export function createRotatePrompt(root) {
  const d = document.createElement('div'); d.className = 'pc-rotate'; d.setAttribute('role', 'alert'); d.setAttribute('aria-live', 'polite');
  d.innerHTML = `
    <div class="pc-rotate-safe">
      <button type="button" class="pc-btn pc-leave" data-ctl="leave" aria-label="Leave party">${icon('back')}Leave</button>
      <div class="pc-rotate-body">
        <svg width="200" height="200" viewBox="0 0 200 200" fill="none" aria-hidden="true" class="pc-rotate-art">
          <rect x="62" y="22" width="76" height="136" rx="16" stroke="var(--color-border-strong)" stroke-width="4" stroke-dasharray="2 9" stroke-linecap="round"/>
          <rect x="40" y="62" width="136" height="76" rx="16" fill="var(--color-surface-high)" stroke="var(--color-text)" stroke-width="4"/>
          <circle cx="108" cy="100" r="24" stroke="var(--color-text-2)" stroke-width="5"/><circle cx="108" cy="100" r="6" fill="var(--color-text-2)"/><path d="M84 100h-18M132 100h18" stroke="var(--color-text-2)" stroke-width="5" stroke-linecap="round"/>
          <path d="M132 24a78 78 0 0 1 46 40" transform="translate(8 -12)" stroke="var(--color-accent)" stroke-width="5" stroke-linecap="round"/>
          <path d="M168 54l11 12-16 4" transform="translate(8 -12)" stroke="var(--color-accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h1 class="pc-h1">Turn your phone sideways</h1>
        <p class="pc-body">Hold it like a steering wheel with both hands. Tilt left and right to steer.</p>
        <div class="pc-hint-tag">${icon('rotate')}Rotation lock must be off</div>
      </div>
      <p class="pc-caption pc-rotate-note">Your car waits safely until you turn your phone.</p>
    </div>`;
  root.appendChild(d); return d;
}

/** Toast: scrim plate. mode 'camera' = single line, 'discover' = Prism's discovery toast (icon disc + label + name). */
export function createToast(root, cls = '') {
  const t = document.createElement('div'); t.className = `pc-toast ${cls}`; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); t.dataset.ctl2 = 'toast'; root.appendChild(t);
  let timer = 0;
  return {
    el: t,
    show(label, name, { ic = 'sparkle', ms = 1200 } = {}) {
      t.innerHTML = `<span class="pc-toast-disc">${icon(ic)}</span><span class="pc-toast-txt"><span class="pc-toast-label">${esc(label)}</span><span class="pc-toast-name">${esc(name)}</span></span>`;
      t.classList.remove('is-in'); void t.offsetWidth; t.classList.add('is-in'); clearTimeout(timer); timer = setTimeout(() => t.classList.remove('is-in'), ms);
    },
    hide() { clearTimeout(timer); t.classList.remove('is-in'); },
  };
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** iPhone has no Vibration API: pulse the rim (inner ring 120 ms). */
export function createRim(root) {
  const r = document.createElement('div'); r.className = 'pc-rim'; r.setAttribute('aria-hidden', 'true'); root.appendChild(r);
  let last = 0;
  return { el: r, pulse(strength = 1) { const n = performance.now(); if (n - last < 250) return; last = n; r.animate([{ opacity: Math.min(1, 0.35 + strength * 0.65) }, { opacity: 0 }], { duration: 120, easing: 'ease-out' }); } };
}

/** Disabled/"connection lost" state: 40% opacity, chip warn banner at top centre, inputs ignored (the host brakes the car). */
export function createConnection(root) {
  const b = document.createElement('div'); b.className = 'pc-banner'; b.setAttribute('role', 'status'); b.setAttribute('aria-live', 'polite'); root.appendChild(b);
  let lost = false;
  return {
    get lost() { return lost; },
    set(state, seconds) {
      lost = state === 'reconnecting';
      root.classList.toggle('is-lost', lost);
      b.innerHTML = lost ? `${icon('wifi')}Reconnecting\u2026${Number.isFinite(seconds) ? ` ${Math.max(0, Math.round(seconds))} s` : ''}` : '';
    },
  };
}
