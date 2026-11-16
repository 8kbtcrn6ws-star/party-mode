// Mode B phone steering wheel (S4), built to Prism's phone-wheel spec (ui/DESIGN.md section 1). Landscape; tilt the phone like a wheel. Uses Forge's TiltSteering for the sensor maths.
//   const wheel = createWheelControls(document.body, settings.controls, { onFallback: (reason, text) => switchToTouch(text), onPause, onLeave, player: { slot, name, code } });
//   each tick: const input = wheel.read();      // same object as keyboard/touch; neutral in portrait and while reconnecting
//   on host feedback: wheel.feedback(fb);       // hub speed/gear, camera toast, rumble -> vibration, or a rim pulse where vibration isn't supported (iPhone)
// Tilt readings are only turned into the steer value that goes to the party host. Nothing is stored or logged here.
import { blankInput, pulse, haptic } from './input.js';
import { TiltSteering } from '../net/index.js';
import { DEFAULT_SETTINGS } from '../data/settings.js';
import { ensureIcons, icon, mq, createRamp, createCamButton, createGlance, createPinch, GLANCE_ICON, createFrame, createRotatePrompt, createToast, createRim, createConnection, playerDot, esc } from './phone-ui.js';

export const FALLBACK_TEXT = {
  denied: 'Motion access was turned down, so you are on touch controls. To use the wheel, allow Motion & Orientation for this site and reload.',
  'no-sensor': "This phone isn't sending tilt readings, so you are on touch controls.",
  insecure: 'Tilt steering needs a secure (https) page, so you are on touch controls.',
  unsupported: "This browser doesn't support tilt steering, so you are on touch controls.",
};
const CAM_LABEL = { chase: 'Chase', closeChase: 'Close chase', cab: 'Cab', freeLook: 'Free look' };
const GEAR = (g) => (typeof g === 'string' ? g : g < 0 ? 'R' : g === 0 ? 'N' : 'D');
const TICK_SVG = [[-59.4, -59.4, -65.1, -65.1, 2], [-42.0, -72.7, -45.0, -77.9, 2], [-21.7, -81.1, -23.3, -86.9, 2], [0, -84, 0, -92, 3], [21.7, -81.1, 23.3, -86.9, 2], [42.0, -72.7, 45.0, -77.9, 2], [59.4, -59.4, 65.1, -65.1, 2]]
  .map(([a, b, c, d, w]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="var(--color-text-3)" stroke-width="${w}" stroke-linecap="round"/>`).join('');

const ROTOR_SVG = `<svg viewBox="-118 -118 236 236" width="236" height="236" aria-hidden="true">
  <circle r="107" fill="none" stroke="var(--color-surface-high)" stroke-width="22"/>
  <circle r="117" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1.5"/>
  <circle r="97" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1.5"/>
  <path d="M90.7 -56.7 A107 107 0 0 1 90.7 56.7" stroke="#34435F" stroke-width="22" fill="none"/><path d="M-90.7 56.7 A107 107 0 0 1 -90.7 -56.7" stroke="#34435F" stroke-width="22" fill="none"/>
  <path d="M90.7 -56.7 A107 107 0 0 1 90.7 56.7" stroke="rgba(0,0,0,.35)" stroke-width="22" stroke-dasharray="1.6 5.2" fill="none"/><path d="M-90.7 56.7 A107 107 0 0 1 -90.7 -56.7" stroke="rgba(0,0,0,.35)" stroke-width="22" stroke-dasharray="1.6 5.2" fill="none"/>
  <rect x="-100" y="-10" width="200" height="20" rx="6" fill="var(--color-surface-high)"/>
  <rect x="-10" y="20" width="20" height="80" rx="6" fill="var(--color-surface-high)"/>
  <rect x="-5" y="-118" width="10" height="26" rx="3" fill="var(--color-accent)"/>
</svg>`;
const FIXED_SVG = `<svg viewBox="-118 -118 236 236" width="236" height="236" role="img" aria-label="Steering wheel">
  <defs><radialGradient id="pw-hubg" cx=".5" cy=".38" r=".7"><stop offset="0" stop-color="#1F2A40"/><stop offset="1" stop-color="#0E1420"/></radialGradient></defs>
  <g>${TICK_SVG}</g><circle r="54" fill="url(#pw-hubg)" stroke="var(--color-border-strong)" stroke-width="2"/>
</svg>`;

export function createWheelControls(parent, controls = DEFAULT_SETTINGS.controls, { onFallback, onPause, onLeave, player = null, autoEnable = false } = {}) {
  ensureIcons(parent.ownerDocument);
  let cfg = structuredClone(controls);
  const w = () => cfg.wheel;
  const tilt = new TiltSteering({ lockDeg: w().fullLockDeg, deadzoneDeg: w().deadZoneDeg, smoothingMs: w().smoothing * 150, invert: w().invert });

  const root = document.createElement('div');
  root.className = 'pc-root pc-wheel';
  root.setAttribute('role', 'application'); root.setAttribute('aria-label', 'Steering wheel controller');
  parent.appendChild(root);
  const f = createFrame(root); f.classList.add('is-live'); f.removeAttribute('aria-hidden');
  const A = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); const n = t.content.firstChild; f.appendChild(n); return n; };
  const abs = (css) => `position:absolute;${css}`;
  A(`<button type="button" class="pc-el pc-btn" data-ctl="pause" aria-label="Pause" style="${abs('left:12px;top:6px;width:48px;height:48px')}">${icon('pause')}</button>`);
  // DEVIATION (Requirement 4): one extra 48x48 button in the free top-row slot right of Pause (glance). Not in Prism's spec; needs Prism/Kimi approval.
  A(`<button type="button" class="pc-el pc-btn" data-ctl="glance" aria-label="Look back (hold; drag left or right to glance to a side)" style="${abs('left:68px;top:6px;width:48px;height:48px')}">${GLANCE_ICON}</button>`);
  const topc = A(`<div class="pw-topc" style="${abs('')}"><div class="pc-tag" data-spec="player-tag"></div></div>`);
  const tag = topc.firstChild;
  const toast = createToast(topc, 'compact');
  A(`<button type="button" class="pc-el pc-btn" data-ctl="camera" aria-label="Change camera (hold to switch first or third person)" style="${abs('right:122px;top:6px;width:48px;height:48px')}">${icon('camera')}</button>`);
  A(`<button type="button" class="pc-el pc-btn" data-ctl="calibrate" aria-label="Centre steering" style="${abs('right:12px;top:6px;width:104px;height:48px')}">${icon('calibrate')}Centre</button>`);
  const wheelEl = A(`<div class="pw-wheel" data-ctl="wheel" aria-label="Steering wheel (tilt to steer; drag as fallback)" style="${abs('left:calc(50% - 118px);top:calc(50% - 118px)')}">${ROTOR_SVG}${FIXED_SVG}<div class="pw-hub" data-spec="hub"><div class="pc-label gear">N</div><div class="pc-speed spd" data-spec="speed">0</div><div class="pc-caption unit">km/h</div></div></div>`);
  const readout = A(`<div class="pc-caption pw-readout" data-spec="tilt-readout" aria-hidden="true" style="${abs('left:calc(50% - 40px);bottom:42px')}">0\u00b0</div>`);
  const tiltBar = A(`<div class="pw-tilt" data-spec="tilt" aria-hidden="true" style="${abs('left:calc(50% - 130px);bottom:12px')}"><span class="pc-caption t l">L</span><span class="pc-caption t r">R</span><div class="track"></div><div class="dz"></div><div class="tick"></div><div class="knob" data-spec="tilt-knob"></div></div>`);
  A(`<button type="button" class="pc-el pc-btn round" data-ctl="horn" aria-label="Horn" style="${abs('left:12px;bottom:243px;width:56px;height:56px')}">${icon('horn', '', 'font-size:26px')}</button>`);
  A(`<button type="button" class="pc-el pc-btn" data-ctl="reverse" aria-label="Reverse" aria-pressed="false" style="${abs('left:76px;bottom:243px;width:112px;height:56px')}">${icon('reverse')}Reverse</button>`);
  A(`<button type="button" class="pc-el pc-pedal brake" data-ctl="brake" aria-label="Brake" aria-pressed="false" style="${abs('left:12px;bottom:12px;width:176px;height:215px')}">${icon('brake')}Brake</button>`);
  A(`<button type="button" class="pc-el pc-btn danger" data-ctl="hand" aria-label="Handbrake" aria-pressed="false" style="${abs('right:12px;bottom:243px;width:176px;height:56px')}">${icon('handbrake')}Handbrake</button>`);
  A(`<button type="button" class="pc-el pc-pedal gas" data-ctl="throttle" aria-label="Accelerator" aria-pressed="false" style="${abs('right:12px;bottom:12px;width:176px;height:215px')}">${icon('accelerate')}Accelerate</button>`);

  const gate = document.createElement('div'); gate.className = 'pw-gate';
  gate.innerHTML = `<div class="pw-sheet" role="dialog" aria-labelledby="pw-gate-t"><h2 class="pc-h2" id="pw-gate-t">Turn on motion steering</h2><p class="pc-body">Hold the phone sideways like a steering wheel. Your phone will ask to use motion sensors; that's only used to read the tilt.</p><button type="button" class="pc-btn primary">Allow motion</button></div>`;
  root.appendChild(gate);
  const rim = createRim(root), conn = createConnection(root);
  createRotatePrompt(root);
  const q = (c) => f.querySelector(`[data-ctl="${c}"]`);
  const rotor = wheelEl.querySelector('svg'), gearEl = wheelEl.querySelector('.gear'), spdEl = wheelEl.querySelector('.spd'), knobEl = tiltBar.querySelector('.knob');
  const mqPortrait = mq('(orientation: portrait)');

  function setPlayer(p) {
    player = p;
    if (!p) { tag.style.display = 'none'; return; }
    tag.style.display = '';
    tag.innerHTML = `${playerDot(p.slot)}<span>P${(p.slot | 0) + 1} ${esc(p.name || '')}</span>${p.code ? `<span class="sep">\u00b7</span><span class="code">${esc(p.code)}</span>` : ''}`;
    tag.setAttribute('aria-label', `Player ${(p.slot | 0) + 1}${p.name ? ', ' + p.name : ''}${p.code ? ', room ' + p.code : ''}`);
  }
  setPlayer(player);

  const st = { throttle: 0, brake: 0, rev: 0, hand: 0, horn: 0 };
  const camBtn = createCamButton(), reset = pulse(), ramp = createRamp(250), glance = createGlance(), pinch = createPinch();
  let look = null; // orbit by dragging empty background (the wheel screen has no look pad in Prism's spec: DEVIATION, invisible surface); two fingers there pinch to zoom
  let status = 'idle', lastCam = null, thr = 0;

  // autoEnable: the join flow already asked for motion permission (phone-join-motion), so skip this sheet and start the sensor straight away
  if (autoEnable) queueMicrotask(async () => {
    status = await tilt.enable();
    gate.remove();
    if (status === 'granted') { tilt.calibrate(); } else { onFallback?.(status, FALLBACK_TEXT[status] || FALLBACK_TEXT.unsupported); syncDrag(); }
  });
  gate.querySelector('button').addEventListener('click', async () => {
    status = await tilt.enable();
    if (status === 'granted') { gate.remove(); tilt.calibrate(); haptic(15, cfg.vibration); }
    else { gate.remove(); onFallback?.(status, FALLBACK_TEXT[status] || FALLBACK_TEXT.unsupported); syncDrag(); }
  });
  tilt.on((ev) => { if (ev === 'mode') { if (tilt.mode === 'manual' && status === 'granted') { status = tilt.reason; onFallback?.(status, FALLBACK_TEXT[status] || FALLBACK_TEXT.unsupported); } syncDrag(); } });
  // sensors unavailable: the wheel itself becomes draggable (pointer angle)
  const syncDrag = () => wheelEl.classList.toggle('is-drag', tilt.mode === 'manual');

  const owners = new Map();
  let dragO = null;
  const angleAt = (x, y) => { const r = wheelEl.getBoundingClientRect(); return (Math.atan2(x - (r.left + r.width / 2), -(y - (r.top + r.height / 2))) * 180) / Math.PI; };
  const wrap = (d) => ((d + 540) % 360) - 180;
  function press(ctl, on) {
    const el = q(ctl) || root.querySelector(`[data-ctl="${ctl}"]`);
    el?.classList.toggle('is-pressed', on);
    if (el?.hasAttribute('aria-pressed') && ctl !== 'reverse') el.setAttribute('aria-pressed', String(on));
    if (on) haptic(8, cfg.vibration);
    switch (ctl) {
      case 'throttle': thr = on ? 1 : 0; break;
      case 'brake': st.brake = on ? 1 : 0; break;
      case 'hand': st.hand = on ? 1 : 0; q('hand').classList.toggle('is-on', on); break;
      case 'horn': st.horn = on ? 1 : 0; break;
      case 'reverse': if (on) { st.rev = st.rev ? 0 : 1; const b = q('reverse'); b.classList.toggle('is-on', !!st.rev); b.setAttribute('aria-pressed', String(!!st.rev)); q('throttle').querySelector('.ic').classList.toggle('flip', !!st.rev); } break;
      case 'camera': if (on) camBtn.down(); else camBtn.up(); break; // tap = 'next' on release, hold 0.5 s = one 'view' pulse (first/third person)
      case 'glance': if (on) glance.start(0); else glance.end(); break; // keyboard activation; pointers use the owner path
      case 'calibrate': if (on) { tilt.calibrate(); toast.show('', 'Centred', { ic: 'calibrate', ms: 1000 }); root.classList.add('has-toast'); setTimeout(() => root.classList.remove('has-toast'), 1100); } break;
      case 'pause': if (on) onPause?.(); break;
      case 'leave': if (on) onLeave?.(); break;
    }
  }
  const lookFrom = (o, x, y) => { const k = 70 / cfg.lookSensitivity; look = { x: Math.max(-1, Math.min(1, (x - o.x0) / k)), y: Math.max(-1, Math.min(1, (y - o.y0) / k)) }; };
  root.addEventListener('pointerdown', (e) => {
    const t = e.target.closest?.('[data-ctl]');
    if (!t) { // empty background: look pad
      if (conn.lost || e.target.closest?.('.pw-gate, .pc-rotate') || mqPortrait.matches) return;
      e.preventDefault(); root.setPointerCapture?.(e.pointerId);
      const o = { ctl: 'look', id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY }; owners.set(e.pointerId, o);
      pinch.add(o.id, o.x, o.y); if (pinch.active) look = null; else lookFrom(o, o.x, o.y);
      return;
    }
    const ctl = t.dataset.ctl; if (conn.lost && ctl !== 'leave') return;
    if (ctl === 'wheel' && tilt.mode !== 'manual') return;
    e.preventDefault(); root.setPointerCapture?.(e.pointerId);
    const o = { ctl, id: e.pointerId, x0: e.clientX, y0: e.clientY }; owners.set(e.pointerId, o);
    if (ctl === 'wheel') { dragO = { id: e.pointerId, base: wrap(angleAt(e.clientX, e.clientY) - tilt.angleDeg), prev: angleAt(e.clientX, e.clientY), cur: tilt.angleDeg }; wheelEl.style.cursor = 'grabbing'; }
    else if (ctl === 'glance') { glance.start(e.clientX); haptic(8, cfg.vibration); t.classList.add('is-pressed'); }
    else press(ctl, true);
  });
  root.addEventListener('pointermove', (e) => {
    const o = owners.get(e.pointerId);
    if (o?.ctl === 'look') { o.x = e.clientX; o.y = e.clientY; pinch.move(o.id, o.x, o.y); if (pinch.active) look = null; else lookFrom(o, o.x, o.y); return; }
    if (o?.ctl === 'glance') { glance.move(e.clientX); return; }
    if (!dragO || e.pointerId !== dragO.id) return;
    const a = angleAt(e.clientX, e.clientY); dragO.cur += wrap(a - dragO.prev); dragO.prev = a;
    tilt.setManual(Math.max(-1, Math.min(1, dragO.cur / w().fullLockDeg)));
  });
  const release = (o) => {
    if (o.ctl === 'look') { pinch.remove(o.id); look = null; const rest = [...owners.values()].find((n) => n !== o && n.ctl === 'look'); if (rest) { rest.x0 = rest.x; rest.y0 = rest.y; } return; }
    if (o.ctl === 'glance') { glance.end(); q('glance').classList.remove('is-pressed'); return; }
    if (o.ctl === 'wheel') { dragO = null; tilt.setManual(0); wheelEl.style.cursor = ''; } else press(o.ctl, false); };
  const up = (e) => { const o = owners.get(e.pointerId); if (!o) return; owners.delete(e.pointerId); release(o); };
  root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  const keyOwner = new Set();
  root.addEventListener('keydown', (e) => { const t = e.target.closest?.('button[data-ctl]'); if (!t || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); keyOwner.add(t.dataset.ctl); press(t.dataset.ctl, true); });
  root.addEventListener('keyup', (e) => { const t = e.target.closest?.('button[data-ctl]'); if (!t || !keyOwner.has(t.dataset.ctl)) return; e.preventDefault(); keyOwner.delete(t.dataset.ctl); press(t.dataset.ctl, false); });
  function releaseAll() { for (const o of owners.values()) release(o); owners.clear(); keyOwner.clear(); Object.assign(st, { brake: 0, hand: 0, horn: 0 }); look = null; camBtn.cancel(); glance.end(); pinch.clear(); thr = 0; ramp.reset(); root.querySelectorAll('.is-pressed').forEach((n) => n.classList.remove('is-pressed')); q('hand')?.classList.remove('is-on'); }
  const onOrient = () => { if (mqPortrait.matches) releaseAll(); };
  mqPortrait.addEventListener?.('change', onOrient);

  let lastReadout = '', pulseT = 0;
  return {
    root, tilt,
    get status() { return status; },
    read() {
      const o = blankInput();
      const neutral = mqPortrait.matches || conn.lost;
      const steer = tilt.read();
      const lock = w().fullLockDeg;
      rotor.style.transform = `rotate(${steer * lock}deg)`;      // rotor turns 1:1 with the tilt (clockwise = right)
      knobEl.style.transform = `translateX(${steer * 99}px)`;      // travel +-99 = steer -1..1
      const deg = Math.round(Math.abs(steer * lock)), txt = deg === 0 ? '0\u00b0' : `${steer > 0 ? 'R' : 'L'} ${deg}\u00b0`;
      if (txt !== lastReadout) { lastReadout = txt; readout.textContent = txt; }
      if (neutral) { ramp.step(0); return o; }
      o.steer = steer;
      Object.assign(o, { throttle: ramp.step(thr), brake: st.brake, rev: st.rev, hand: st.hand, horn: st.horn });
      o.look = look ? { ...look } : null;
      if (o.look && cfg.invertLookY) o.look.y = -o.look.y;
      o.glance = glance.value; o.zoom = pinch.take();
      o.cam = camBtn.read();
      o.reset = reset.on ? 1 : 0;
      return o;
    },
    feedback(fb) {
      if (!fb) return;
      if (fb.speed !== undefined) { spdEl.textContent = Math.round(Math.max(0, +fb.speed || 0)); wheelEl.setAttribute('aria-label', `Steering wheel, speed ${spdEl.textContent} kilometres per hour`); }
      if (fb.gear !== undefined) gearEl.textContent = GEAR(fb.gear);
      if (fb.cam && fb.cam !== lastCam) { if (lastCam) { toast.show('Camera', CAM_LABEL[fb.cam] || fb.cam, { ic: 'camera', ms: 1200 }); root.classList.add('has-toast'); setTimeout(() => root.classList.remove('has-toast'), 1300); } lastCam = fb.cam; }
      const r = +fb.rumble || 0;
      if (r <= 0.3) return;
      if (navigator.vibrate && cfg.vibration) haptic(Math.round(r * 30), true);
      else if (performance.now() - pulseT > 250) { pulseT = performance.now(); rim.pulse(r); root.classList.add('pw-rim-pulse'); setTimeout(() => root.classList.remove('pw-rim-pulse'), 240); }
    },
    update(controls) {
      cfg = structuredClone(controls);
      Object.assign(tilt, { lockDeg: w().fullLockDeg, deadzoneDeg: w().deadZoneDeg, smoothingMs: w().smoothing * 150, invert: w().invert });
    },
    setPlayer,
    /** 'ok' | 'reconnecting' (+ seconds left): 40 % opacity, chip banner, inputs ignored (the host brakes the car). */
    setConnection(state, seconds) { if (state === 'reconnecting') releaseAll(); conn.set(state, seconds); },
    /** Reset vehicle has no button on this screen (Prism): call this from the pause sheet. */
    fireReset() { reset.fire(); },
    toast(label, name, o) { toast.show(label, name, o); },
    show(on) { root.style.display = on ? '' : 'none'; },
    dispose() { mqPortrait.removeEventListener?.('change', onOrient); tilt.disable(); root.remove(); },
  };
}
