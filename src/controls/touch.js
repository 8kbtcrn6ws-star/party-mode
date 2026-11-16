// Mode A touch controls (S3), built to Prism's phone-hud spec (ui/DESIGN.md section 3). Landscape. Left half = camera look area; right half = driving.
// Positions come from Prism's edge anchors (frame-relative px, exact sizes); settings.controls.layout fractions still apply: an element the player
// has moved (x/y differ from the defaults) is placed at its saved fraction, and every element's size is Prism's size x layout.scale. Mirror swaps the halves.
//   const touch = createTouchControls(document.body, settings.controls, { onLayoutChange, onPause, onLeave, player: { slot } });
//   each tick: const input = touch.read();                     // {steer, throttle, brake, rev, hand, horn, look, cam, reset}; neutral in portrait / while reconnecting
//   host feedback: touch.feedback(fb)                         // fb {speed km/h, gear, cam, rumble}: speed plate, camera toast, haptic or rim pulse
//   HUD data (optional): touch.setHud({ heading, waypointBearing, players: [{ slot, right, ahead }], radiusM })  touch.toast('Place discovered', 'Hollow Ridge Viewpoint')
import { blankInput, pulse, haptic } from './input.js';
import { DEFAULT_SETTINGS, DEFAULT_TOUCH_LAYOUT, TOUCH_ELEMENTS } from '../data/settings.js';
import { ensureIcons, icon, mq, isPortrait, createRamp, createCamButton, createGlance, createPinch, GLANCE_ICON, createFrame, createRotatePrompt, createToast, createRim, createConnection, esc } from './phone-ui.js';

// Prism's boxes: w x h, anchor in frame px: l/r = from left/right edge, t/b = from top/bottom edge, cx = centred. (frame = safe area, 750x369 on iPhone 14/15)
const SPEC = {
  look: { w: 120, h: 120, a: { l: 70, t: 132 } },
  pause: { w: 48, h: 48, a: { l: 12, t: 6 } },
  camera: { w: 48, h: 48, a: { l: 68, t: 6 } },
  reset: { w: 48, h: 48, a: { l: 124, t: 6 } },
  glance: { w: 48, h: 48, a: { l: 12, t: 66 } },          // DEVIATION (Requirement 4): not in Prism's HUD; left column under Pause, clear of the look ring (x 70+)
  horn: { w: 56, h: 56, a: { l: 180, t: 6 } },            // GAP: Prism's HUD has no horn; style/size from the wheel screen's horn, placed in the free slot after Reset
  speed: { w: 156, h: 60, a: { l: 12, b: 12 } },
  compass: { w: 240, h: 36, a: { cx: 1, t: 8 } },
  toast: { w: 368, h: 56, a: { cx: 1, t: 54 } },
  minimap: { w: 96, h: 96, a: { r: 12, t: 6 } },
  hand: { w: 160, h: 48, a: { r: 200, b: 116 } },
  reverse: { w: 72, h: 48, a: { r: 116, b: 116 } },
  steer: { w: 160, h: 96, a: { r: 200, b: 12 } },
  brake: { w: 72, h: 96, a: { r: 116, b: 12 } },
  throttle: { w: 96, h: 156, a: { r: 12, b: 12 } },
};
const SETTING = new Set(TOUCH_ELEMENTS);
const CONTROLS = ['pause', 'camera', 'reset', 'glance', 'horn', 'hand', 'reverse', 'brake', 'throttle', 'steer'];
const TRAVEL = 52, HOLD_MS = 600, LOOK_HINT_MS = 8000;
const CAM_LABEL = { chase: 'Chase', closeChase: 'Close chase', cab: 'Cab', freeLook: 'Free look' };
const GEAR = (g) => (typeof g === 'string' ? g : g < 0 ? 'R' : g === 0 ? 'N' : 'D');
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function createTouchControls(parent, controls = DEFAULT_SETTINGS.controls, { onLayoutChange, onPause, onLeave, player = null } = {}) {
  ensureIcons(parent.ownerDocument);
  let cfg = structuredClone(controls);
  const root = document.createElement('div');
  root.className = 'pc-root pc-touch';
  root.setAttribute('role', 'application'); root.setAttribute('aria-label', 'Touch driving controls');
  parent.appendChild(root);
  const scrim = document.createElement('div'); scrim.className = 'pc-scrim'; root.appendChild(scrim);
  const zone = document.createElement('div'); zone.className = 'pc-zone'; root.appendChild(zone);
  const frame = createFrame(root);

  const st = { steer: 0, throttle: 0, brake: 0, rev: 0, hand: 0, horn: 0, look: null };
  const camBtn = createCamButton(), reset = pulse(), ramp = createRamp(250), glance = createGlance(), pinch = createPinch();
  const els = {}; let editing = false;

  function mk(name, tag, cls, html, aria, extra = {}) {
    const el = document.createElement(tag); el.className = `pc-el ${cls}`; el.dataset.ctl = name;
    if (aria) el.setAttribute('aria-label', aria);
    if (tag === 'button') el.type = 'button';
    el.innerHTML = html; Object.entries(extra).forEach(([k, v]) => el.setAttribute(k, v));
    root.appendChild(el); els[name] = el; return el;
  }
  const plate = (name, cls, html, aria) => { const el = document.createElement('div'); el.className = `pc-el pc-plate ${cls}`; el.style.pointerEvents = 'none'; el.dataset.hud = name; el.setAttribute('role', 'img'); el.setAttribute('aria-label', aria); el.innerHTML = html; root.appendChild(el); els[name] = el; return el; };

  // look hint (Prism: dashed 120x120 ring + "Drag to look", first 8 s). The whole left half is the drag surface (zone).
  mk('look', 'div', 'pc-look-hint', `<svg class="ring" viewBox="0 0 120 120" fill="none" aria-hidden="true"><circle cx="60" cy="60" r="56" stroke="rgba(255,255,255,.55)" stroke-width="2.5" stroke-dasharray="3 9" stroke-linecap="round"/><g stroke="#fff" stroke-opacity=".85" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M60 34l-7 8M60 34l7 8M60 86l-7-8M60 86l7-8M34 60l8-7M34 60l8 7M86 60l-8-7M86 60l-8 7"/></g></svg><span class="pc-caption pc-plate">Drag to look</span>`, 'Camera look: drag on the left half of the screen', { 'aria-hidden': 'true' });
  mk('pause', 'button', 'pc-btn glass', icon('pause'), 'Pause');
  mk('camera', 'button', 'pc-btn glass', icon('camera'), 'Change camera (hold to switch first or third person)');
  mk('reset', 'button', 'pc-btn glass', `${icon('reset')}<svg class="pc-hold" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22"/></svg>`, 'Reset vehicle (hold)');
  mk('glance', 'button', 'pc-btn glass', GLANCE_ICON, 'Look back (hold; drag left or right to glance to a side)');
  mk('horn', 'button', 'pc-btn glass round', icon('horn', '', 'font-size:26px'), 'Horn');
  plate('speed', 'pc-speedplate', `<span class="pc-speed val" data-v>0</span><span class="pc-caption unit">km/h</span><span class="gear" data-g>N</span>`, 'Speed');
  plate('compass', 'pc-compass', '', 'Compass');
  plate('minimap', 'pc-minimap', '', 'Minimap'); els.minimap.classList.remove('pc-plate');
  mk('hand', 'button', 'pc-btn glass danger', `${icon('handbrake')}Handbrake`, 'Handbrake');
  mk('reverse', 'button', 'pc-btn glass stack', `${icon('reverse')}Rev`, 'Reverse');
  mk('steer', 'div', 'pc-plate pc-edge pc-steer', `${icon('back', 'chev l')}${icon('chevron', 'chev r')}<div class="pc-knob"></div><div class="pc-label lab">Steer</div>`, 'Steer', { role: 'slider', 'aria-valuemin': '-1', 'aria-valuemax': '1', 'aria-valuenow': '0', tabindex: '0' });
  mk('brake', 'button', 'pc-pedal sm brake glassy', `${icon('brake')}Brake`, 'Brake');
  mk('throttle', 'button', 'pc-pedal sm gas', `${icon('accelerate')}Gas`, 'Accelerator');
  ['reverse', 'hand', 'brake', 'throttle'].forEach((n) => els[n].setAttribute('aria-pressed', 'false'));
  // 'arrows' steering style (not in Prism's mocks): the steer pad footprint split into two halves
  const arrows = ['steerLeft', 'steerRight'].map((n, i) => mk(n, 'button', 'pc-btn glass pc-arrow', icon(i ? 'chevron' : 'back'), i ? 'Steer right' : 'Steer left'));
  const [arrowL, arrowR] = arrows;
  const knob = els.steer.querySelector('.pc-knob');
  const toastEl = createToast(root, ''); els.toast = toastEl.el; toastEl.el.classList.add('pc-el'); toastEl.el.style.pointerEvents = 'none';
  const tagToast = toastEl;
  const rim = createRim(root), conn = createConnection(root);
  createRotatePrompt(root);
  const mqPortrait = mq('(orientation: portrait)');

  // ---- layout ---------------------------------------------------------------------------------------------------
  const geo = {};
  const isCustom = (n) => { const p = cfg.layout?.[n], d = DEFAULT_TOUCH_LAYOUT[n]; return !!(p && d && (Math.abs(p.x - d.x) > 1e-3 || Math.abs(p.y - d.y) > 1e-3)); };
  const mx = (x) => (cfg.mirror ? 1 - x : x);
  function place(name, el) {
    const sp = SPEC[name], fr = frame.getBoundingClientRect();
    const sc = SETTING.has(name) ? (cfg.layout?.[name]?.scale ?? 1) : 1, w = sp.w * sc, h = sp.h * sc;
    let x, y;
    if (SETTING.has(name) && isCustom(name)) { const p = cfg.layout[name]; x = mx(p.x) * innerWidth - w / 2; y = p.y * innerHeight - h / 2; }
    else {
      const a = sp.a;
      x = a.cx ? fr.left + (fr.width - w) / 2 : a.l != null ? fr.left + a.l : fr.right - a.r - w;
      y = a.t != null ? fr.top + a.t : fr.bottom - a.b - h;
      if (cfg.mirror && !a.cx) x = fr.left + fr.right - x - w;
    }
    Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); geo[name] = { x, y, w, h, s: sc };
  }
  function layout() {
    for (const [name, el] of Object.entries(els)) if (SPEC[name]) place(name, el);
    const s = geo.steer, isArrows = cfg.steerStyle === 'arrows';
    els.steer.style.display = isArrows ? 'none' : '';
    arrows.forEach((a, i) => {
      a.style.display = isArrows ? '' : 'none';
      const w = (s.w - 8) / 2; Object.assign(a.style, { left: s.x + i * (w + 8) + 'px', top: s.y + 'px', width: w + 'px', height: s.h + 'px' });
    });
    zone.style.left = cfg.mirror ? '50%' : '0'; zone.style.right = cfg.mirror ? '0' : '50%';
    root.classList.toggle('pc-editing', editing);
    // settings.controls.opacity is relative to its default (0.8 = Prism's opaque look); lower dims the controls only, never the HUD plates.
    const eff = Math.max(0.3, Math.min(1, cfg.opacity / DEFAULT_SETTINGS.controls.opacity));
    for (const n of CONTROLS) els[n].style.opacity = eff < 1 ? String(eff) : '';
    arrows.forEach((a) => { a.style.opacity = eff < 1 ? String(eff) : ''; });
  }
  addEventListener('resize', layout); addEventListener('orientationchange', layout);

  // ---- HUD plates ----------------------------------------------------------------------------------------------
  const hud = { heading: 0, wp: null, players: [], radiusM: 150, speed: 0, gear: 'N' };
  function renderCompass() {
    const h = ((hud.heading % 360) + 360) % 360; let s = '';
    const base = Math.round(h / 5) * 5;
    for (let k = -18; k <= 18; k++) {
      const a = base + k * 5, x = 120 + (a - h) * 3; if (x < 0 || x > 240) continue;
      const aa = ((a % 360) + 360) % 360, major = aa % 15 === 0;
      s += `<line x1="${x.toFixed(1)}" y1="${major ? 26 : 29}" x2="${x.toFixed(1)}" y2="33" stroke="var(--color-text-2)" stroke-width="${major ? 2 : 1.5}" stroke-linecap="round"/>`;
      if (aa % 45 === 0) s += `<text x="${x.toFixed(1)}" y="21" text-anchor="middle" font-family="Inter" font-weight="700" font-size="13" fill="var(--color-text)">${CARD[aa / 45]}</text>`;
    }
    s += `<path d="M120 4l-5-5h10z" fill="var(--color-accent)" transform="translate(0 4)"/>`;
    if (hud.wp != null) {
      let d = ((hud.wp - h + 540) % 360) - 180; const x = Math.max(12, Math.min(228, 120 + d * 3));
      s += `<g transform="translate(${(x - 9).toFixed(1)} 3)" color="var(--color-accent)" style="--icon-fill:var(--color-accent)"><svg width="18" height="18" viewBox="0 0 24 24" class="ic"><use href="#i-flag"/></svg></g>`;
    }
    els.compass.innerHTML = `<svg width="240" height="36" viewBox="0 0 240 36" aria-hidden="true">${s}</svg>`;
    els.compass.setAttribute('aria-label', `Compass, heading ${Math.round(h)} degrees`);
  }
  function renderMinimap() {
    const h = hud.heading, me = player ? ((player.slot | 0) % 4) + 1 : 2;
    let dots = '';
    for (const p of hud.players) {
      let x = (p.right / hud.radiusM) * 40, y = -(p.ahead / hud.radiusM) * 40; const m = Math.hypot(x, y); if (m > 40) { x *= 40 / m; y *= 40 / m; }
      dots += `<circle cx="${(48 + x).toFixed(1)}" cy="${(48 + y).toFixed(1)}" r="5" fill="var(--color-player-${((p.slot | 0) % 4) + 1})" stroke="#0B0F17" stroke-width="2"/>`;
    }
    let wp = '';
    if (hud.wp != null) { const a = ((hud.wp - h) * Math.PI) / 180, x = 48 + Math.sin(a) * 36, y = 48 - Math.cos(a) * 36; wp = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="#0B0F17" fill-opacity=".85"/><g transform="translate(${(x - 8).toFixed(1)} ${(y - 8).toFixed(1)})" style="--icon-fill:var(--color-accent)" color="var(--color-accent)"><svg width="16" height="16" viewBox="0 0 24 24" class="ic"><use href="#i-flag"/></svg></g>`; }
    els.minimap.innerHTML = `<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true"><defs><clipPath id="pc-mm"><circle cx="48" cy="48" r="46"/></clipPath></defs><g clip-path="url(#pc-mm)"><rect width="96" height="96" fill="var(--color-map-forest)"/><circle cx="48" cy="48" r="30" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1.5"/><circle cx="48" cy="48" r="15" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1.5"/></g><circle cx="48" cy="48" r="46" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/>${dots}<path d="M48 36l8 16-8-4-8 4z" fill="var(--color-player-${me})" stroke="#0B0F17" stroke-width="2.5" stroke-linejoin="round"/>${wp}<g transform="rotate(${(-h).toFixed(1)} 48 48)"><circle cx="48" cy="12" r="9" fill="#0B0F17" fill-opacity=".9"/><text x="48" y="16.5" text-anchor="middle" font-family="Inter" font-weight="700" font-size="12" fill="#fff">N</text></g></svg>`;
    els.minimap.setAttribute('aria-label', `Minimap, ${hud.players.length} player${hud.players.length === 1 ? '' : 's'}`);
  }
  function setSpeed(v, g) { const sp = Math.round(Math.max(0, +v || 0)); els.speed.querySelector('[data-v]').textContent = sp; if (g !== undefined) els.speed.querySelector('[data-g]').textContent = GEAR(g); els.speed.setAttribute('aria-label', `Speed ${sp} kilometres per hour`); }
  renderCompass(); renderMinimap(); setSpeed(0, 0);
  layout();

  let lookHintTimer = setTimeout(() => els.look.classList.add('is-hidden'), LOOK_HINT_MS);

  // ---- pointer handling (multi-touch: each finger is captured by the control it started on) ---------------------------------
  const owners = new Map(); // pointerId -> { ctl, x0, y0 }
  let held = { throttle: 0 }, holdT = 0;
  const setPressed = (ctl, on) => {
    const el = ctl === 'steerLeft' ? arrowL : ctl === 'steerRight' ? arrowR : els[ctl];
    el?.classList.toggle('is-pressed', on);
    if (el && el.hasAttribute('aria-pressed') && ctl !== 'reverse') el.setAttribute('aria-pressed', String(on));
  };
  function press(ctl, on) {
    setPressed(ctl, on);
    if (on) haptic(8, cfg.vibration);
    switch (ctl) {
      case 'throttle': held.throttle = on ? 1 : 0; break;
      case 'brake': st.brake = on ? 1 : 0; break;
      case 'hand': st.hand = on ? 1 : 0; els.hand.classList.toggle('is-on', on); break;
      case 'horn': st.horn = on ? 1 : 0; break;
      case 'reverse': if (on) { st.rev = st.rev ? 0 : 1; els.reverse.classList.toggle('is-on', !!st.rev); els.reverse.setAttribute('aria-pressed', String(!!st.rev)); } break;
      case 'camera': if (on) camBtn.down(); else camBtn.up(); break; // tap = 'next' on release, hold 0.5 s = one 'view' pulse (first/third person)
      case 'glance': if (on) glance.start(0); else glance.end(); break; // keyboard activation; pointers use the owner path
      case 'pause': if (on) onPause?.(); break;
      case 'leave': if (on) onLeave?.(); break;
      case 'reset':
        clearTimeout(holdT); els.reset.classList.toggle('is-holding', on);
        if (on) holdT = setTimeout(() => { reset.fire(); haptic(20, cfg.vibration); els.reset.classList.remove('is-holding'); }, HOLD_MS);
        break;
      case 'steerLeft': arrowHeld.l = on; break;
      case 'steerRight': arrowHeld.r = on; break;
    }
  }
  const arrowHeld = { l: false, r: false };
  let arrowSteer = 0, arrowT = performance.now();

  function steerFromX(x) {
    const g = geo.steer, cx = g.x + g.w / 2, trav = TRAVEL * g.s;
    const off = Math.max(-trav, Math.min(trav, x - cx));
    st.steer = Math.max(-1, Math.min(1, (off / trav) * cfg.steerSensitivity));
    knob.style.transform = `translateX(${off}px)`; els.steer.setAttribute('aria-valuenow', st.steer.toFixed(2));
  }
  function lookFrom(o, x, y) {
    const k = 70 / cfg.lookSensitivity; // px of drag for full look rate
    st.look = { x: Math.max(-1, Math.min(1, (x - o.x0) / k)), y: Math.max(-1, Math.min(1, (y - o.y0) / k)) };
  }
  const targetOf = (e) => { const t = e.target.closest?.('[data-ctl]'); return t ? { ctl: t.dataset.ctl, el: t } : e.target === zone ? { ctl: 'look', el: zone } : null; };

  function down(e) {
    const t = targetOf(e); if (!t) return;
    if (conn.lost && t.ctl !== 'leave') return;
    e.preventDefault();
    if (editing) return t.ctl === 'look' && t.el === zone ? undefined : editDown(e, t.ctl);
    root.setPointerCapture?.(e.pointerId);
    const o = { ctl: t.ctl, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY }; owners.set(e.pointerId, o);
    if (t.ctl === 'look') { els.look.classList.add('on'); pinch.add(o.id, o.x, o.y); if (pinch.active) st.look = null; else lookFrom(o, e.clientX, e.clientY); }
    else if (t.ctl === 'glance') { glance.start(e.clientX); els.glance.classList.add('is-pressed'); haptic(8, cfg.vibration); }
    else if (t.ctl === 'steer') { els.steer.classList.add('is-held', 'is-pressed'); steerFromX(e.clientX); }
    else press(t.ctl, true);
  }
  function move(e) {
    if (editing) return editMove(e);
    const o = owners.get(e.pointerId); if (!o) return;
    o.x = e.clientX; o.y = e.clientY;
    if (o.ctl === 'look') { pinch.move(o.id, o.x, o.y); if (pinch.active) st.look = null; else lookFrom(o, o.x, o.y); } else if (o.ctl === 'steer') steerFromX(e.clientX); else if (o.ctl === 'glance') glance.move(e.clientX);
  }
  function release(o) {
    if (o.ctl === 'look') {
      pinch.remove(o.id); st.look = null;
      const rest = [...owners.values()].find((n) => n !== o && n.ctl === 'look');
      if (rest) { rest.x0 = rest.x; rest.y0 = rest.y; } else els.look.classList.remove('on'); // the finger left over starts a fresh orbit from where it is
    }
    else if (o.ctl === 'glance') { glance.end(); els.glance.classList.remove('is-pressed'); }
    else if (o.ctl === 'steer') { st.steer = 0; els.steer.classList.remove('is-held', 'is-pressed'); knob.style.transform = ''; els.steer.setAttribute('aria-valuenow', '0'); }
    else press(o.ctl, false);
  }
  function up(e) { if (editing) return editUp(e); const o = owners.get(e.pointerId); if (!o) return; owners.delete(e.pointerId); release(o); }
  root.addEventListener('pointerdown', down); root.addEventListener('pointermove', move); root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  // keyboard (accessibility; phone buttons get a ring on keyboard focus)
  const keyOwner = new Set();
  root.addEventListener('keydown', (e) => { const t = e.target.closest?.('button[data-ctl]'); if (!t || e.repeat || (e.key !== 'Enter' && e.key !== ' ') || editing) return; e.preventDefault(); keyOwner.add(t.dataset.ctl); press(t.dataset.ctl, true); });
  root.addEventListener('keyup', (e) => { const t = e.target.closest?.('button[data-ctl]'); if (!t || !keyOwner.has(t.dataset.ctl)) return; e.preventDefault(); keyOwner.delete(t.dataset.ctl); press(t.dataset.ctl, false); });
  function releaseAll() {
    for (const o of owners.values()) release(o); owners.clear(); keyOwner.clear();
    Object.assign(st, { steer: 0, brake: 0, hand: 0, horn: 0, look: null }); glance.end(); pinch.clear(); held.throttle = 0; ramp.reset(); arrowHeld.l = arrowHeld.r = false; arrowSteer = 0;  camBtn.cancel();
    root.querySelectorAll('.is-pressed').forEach((n) => n.classList.remove('is-pressed')); clearTimeout(holdT); els.reset.classList.remove('is-holding');
  }
  const onOrient = () => { if (mqPortrait.matches) releaseAll(); layout(); };
  mqPortrait.addEventListener?.('change', onOrient);

  // ---- layout editing: drag a control to move it; double-tap to cycle its size ---------------------------------------------------
  let drag = null, lastTap = { ctl: null, t: 0 };
  function editDown(e, ctl) {
    if (!SETTING.has(ctl) || !els[ctl]) return;
    const now = performance.now();
    if (lastTap.ctl === ctl && now - lastTap.t < 350) {
      const p = cfg.layout[ctl], steps = [0.8, 1, 1.2, 1.4];
      p.scale = steps[(steps.findIndex((s) => Math.abs(s - p.scale) < 0.05) + 1) % steps.length];
      layout(); onLayoutChange?.(structuredClone(cfg.layout)); lastTap = { ctl: null, t: 0 }; return;
    }
    lastTap = { ctl, t: now };
    drag = { ctl, id: e.pointerId }; root.setPointerCapture?.(e.pointerId);
  }
  function editMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const x = Math.max(0.04, Math.min(0.96, e.clientX / innerWidth)), y = Math.max(0.06, Math.min(0.94, e.clientY / innerHeight));
    cfg.layout[drag.ctl] = { ...cfg.layout[drag.ctl], x: cfg.mirror ? 1 - x : x, y };
    layout();
  }
  function editUp(e) { if (drag && e.pointerId === drag.id) { drag = null; onLayoutChange?.(structuredClone(cfg.layout)); } }

  let lastCam = null;
  return {
    root,
    read() {
      const o = blankInput();
      if (mqPortrait.matches || conn.lost) { ramp.step(0); return o; }
      if (cfg.steerStyle === 'arrows') {
        const n = performance.now(), dt = Math.min(0.1, (n - arrowT) / 1000), want = (arrowHeld.r ? 1 : 0) - (arrowHeld.l ? 1 : 0);
        arrowT = n; arrowSteer += Math.max(-dt * 3.5 * cfg.steerSensitivity, Math.min(dt * 3.5 * cfg.steerSensitivity, want - arrowSteer));
        if (!want && Math.abs(arrowSteer) < 0.02) arrowSteer = 0;
        o.steer = arrowSteer;
      } else o.steer = st.steer;
      Object.assign(o, { throttle: ramp.step(held.throttle), brake: st.brake, rev: st.rev, hand: st.hand, horn: st.horn });
      o.look = st.look ? { ...st.look } : null;
      if (o.look && cfg.invertLookY) o.look.y = -o.look.y;
      o.cam = camBtn.read();
      o.reset = reset.on ? 1 : 0;
      o.glance = glance.value;
      o.zoom = pinch.take();
      return o;
    },
    /** Apply new settings.controls (sensitivity, mirror, opacity, style, layout) live. */
    update(controls) { cfg = structuredClone(controls); layout(); },
    setEditing(on) { editing = !!on; releaseAll(); layout(); },
    /** Feedback from the host: {speed km/h, gear, cam, rumble 0..1}. Speed plate, camera toast (1.2 s), buzz on Android or a rim pulse on iPhone. */
    feedback(fb) {
      if (!fb) return;
      if (fb.speed !== undefined) setSpeed(fb.speed, fb.gear);
      if (fb.cam && fb.cam !== lastCam) { if (lastCam) tagToast.show('Camera', CAM_LABEL[fb.cam] || fb.cam, { ic: 'camera', ms: 1200 }); lastCam = fb.cam; }
      if (fb.rumble > 0.5) { if (navigator.vibrate && cfg.vibration) haptic(Math.round(fb.rumble * 30), true); else rim.pulse(fb.rumble); }
    },
    /** HUD data: heading (deg, 0 = north, clockwise), waypointBearing (deg|null), players [{slot, right, ahead}] in metres in YOUR frame, radiusM, speed, gear. */
    setHud(d = {}) {
      if ('heading' in d) hud.heading = +d.heading || 0; if ('waypointBearing' in d) hud.wp = d.waypointBearing == null ? null : +d.waypointBearing;
      if (d.players) hud.players = d.players; if (d.radiusM) hud.radiusM = d.radiusM;
      if ('speed' in d) setSpeed(d.speed, d.gear);
      renderCompass(); renderMinimap();
    },
    /** Toast under the compass: ('Place discovered', 'Hollow Ridge Viewpoint') stays 4 s; any text via opts {ic, ms}. */
    toast(label, name, { ic = 'sparkle', ms = 4000 } = {}) { tagToast.show(label, name, { ic, ms }); },
    /** 'ok' | 'reconnecting' (+ seconds left): dims the controls to 40 %, shows the banner, ignores input (the host brakes the car). */
    setConnection(state, seconds) { if (state === 'reconnecting') releaseAll(); conn.set(state, seconds); },
    /** Press-and-hold reset is the only reset path on this screen; the pause sheet can call this as well. */
    fireReset() { reset.fire(); },
    showLookHint() { clearTimeout(lookHintTimer); els.look.classList.remove('is-hidden'); lookHintTimer = setTimeout(() => els.look.classList.add('is-hidden'), LOOK_HINT_MS); },
    show(on) { root.style.display = on ? '' : 'none'; },
    dispose() { removeEventListener('resize', layout); removeEventListener('orientationchange', layout); mqPortrait.removeEventListener?.('change', onOrient); clearTimeout(holdT); clearTimeout(lookHintTimer); root.remove(); },
  };
}
