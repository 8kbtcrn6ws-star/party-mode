// TV party lobby (Prism's party-lobby.html, DESIGN.md section 5). Plain ES module, no build step.
//   import { createLobby } from './src/ui/lobby.js';
//   const lobby = createLobby(document.body, host, { onStart, onLeave });   // host = PartyHost (or anything with the same events, see below)
//   await host.open();                                                       // the lobby also works BEFORE open() resolves
// Page needs: the import map entry "qrcode-generator" (same pinned map as index.html) and nothing else; CSS is pulled in by this module.
//
// Host contract (all provided by net/PartyHost): host.code, host.joinUrl, host.status, host.players() -> [{id, slot, name, colour, vehicle, ready, connected}],
//   host.on(event, fn) for: open, join, leave, disconnect, reconnect, lobby, status, restore, restore-progress, error, session-in-use;
//   optional: host.startGame(), host.kick(id), host.end(), host.constructor.peekSavedSession(), host.lobby.graceMs.
import qrcode from 'qrcode-generator';
import { createStage } from './tv-stage.js';
import { createFocusManager } from './tv-focus.js';
import { ensureIcons, icon } from './icons.js';
import { SCENE_LOBBY_SVG } from './scene-lobby.js';

const css = new URL('./tv.css', import.meta.url).href;
function ensureCss(doc) {
  if (doc.querySelector(`link[data-pm-css="tv"]`)) return;
  const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = css; l.dataset.pmCss = 'tv'; doc.head.appendChild(l);
}

import { SEATS, SEAT_STYLE, SHAPES } from './badges.js';
export { SEATS, SEAT_STYLE, SHAPES };
const ghostPath = { // dashed outlines for the empty slot
  circle: '<circle cx="40" cy="40" r="36"/>', triangle: '<path d="M40 8 L74 70 L6 70Z" stroke-linejoin="round"/>', square: '<rect x="6" y="6" width="68" height="68" rx="16"/>', diamond: '<path d="M40 6 L74 40 L40 74 L6 40Z"/>',
};
const ghostTy = { circle: 53, triangle: 59, square: 53, diamond: 53 };

function badgeSvg(i, filled) {
  const st = SEAT_STYLE[i], sh = SHAPES[st.shape];
  if (filled) return `<svg viewBox="0 0 80 80" width="80" height="80" fill="var(--p)" role="img" aria-label="Player ${i + 1}, ${st.label}">${sh.d}<text x="40" y="${sh.ty}" text-anchor="middle" font-family="Sora,Inter,sans-serif" font-weight="700" font-size="${sh.fs || 34}" fill="var(--color-on-player)">${i + 1}</text></svg>`;
  return `<svg viewBox="0 0 80 80" width="80" height="80" fill="none" stroke="var(--color-border-strong)" stroke-width="4" stroke-dasharray="3 8" stroke-linecap="round" role="img" aria-label="Player ${i + 1} slot, ${st.label}">${ghostPath[st.shape]}<text x="40" y="${ghostTy[st.shape]}" text-anchor="middle" font-family="Sora,Inter,sans-serif" font-weight="700" font-size="34" stroke="none" fill="var(--color-text-3)">${i + 1}</text></svg>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prettyVehicle = (id) => String(id || '').replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** "https://host/path/play.html#peer=pm-..." -> "host/path/play.html" (the part a person can type; the QR carries the rest). */
export const displayUrl = (u) => { try { const x = new URL(u); return x.host + x.pathname.replace(/\/$/, ''); } catch { return String(u || ''); } };

/** Draws joinUrl as a crisp SVG QR: `modules` squares plus a 2-module quiet border, dark #0B0F17 on the white tile (both themes). */
export function qrSvg(text, { ecc = 'M', border = 2, size = 336 } = {}) {
  const qr = qrcode(0, ecc); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), dim = n + border * 2; let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) { if (!qr.isDark(r, c)) { c++; continue; } let e = c; while (e < n && qr.isDark(r, e)) e++; d += `M${c + border} ${r + border + 0.5}h${e - c}`; c = e; }
  }
  return { modules: n, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code to join" data-modules="${n}"><path stroke="#0B0F17" stroke-width="1" d="${d}"/></svg>` };
}

const NET = { // network chip states. Copy for Ready/blocked/lost is Prism's; the others are marked "gap" in the hand-off notes.
  opening: { cls: 'info', ic: 'wifi', text: 'Opening party\u2026' },
  restoring: { cls: 'warn', ic: 'wifi', text: 'Restoring party\u2026' },
  reconnecting: { cls: 'warn', ic: 'wifi', text: 'Reconnecting\u2026' },
  ready: { cls: 'good', ic: 'wifi', text: 'Same Wi-Fi \u00b7 Ready' },
  blocked: { cls: 'warn', ic: 'wifi', text: 'Wi-Fi is blocking phones - use the same network' },
  lost: { cls: 'danger', ic: 'wifi', text: 'Connection lost' },
  'in-use': { cls: 'warn', ic: 'wifi', text: 'Party is open in another tab' },
};

/**
 * @param {HTMLElement} parent  container (the stage scales to fit it)
 * @param {object} host         PartyHost or compatible
 * @param {object} [opts]
 * @param {'dark'|'day'} [opts.theme='dark']
 * @param {'players'|'host-ready'} [opts.startRule='players']  'players': Start is enabled with >= 1 joined seat (task brief). 'host-ready': Prism's rule (seat 1 must be Ready).
 * @param {(player)=>string} [opts.vehicleLabel]  text for a Ready seat ("Trailrunner 4x4 - Dune"); default = prettified vehicle id
 * @param {number} [opts.graceMs]  seat hold time for the reconnect countdown (default host.lobby.graceMs or 90000)
 * @param {object|null|(()=>object|null)} [opts.peek]  saved-session preview (default: host.constructor.peekSavedSession); pass null to disable
 * @param {(info)=>void} [opts.onStart]  default host.startGame()
 * @param {()=>void} [opts.onLeave]      called after the Leave confirm; default host.end() (ends the party for everyone and forgets the saved session)
 * @param {(playerId)=>void} [opts.onKick]  called after the Remove confirm; default host.kick(id)
 * @param {string} [opts.subtitle]
 * @param {number} [opts.hideCursorMs=3000]
 * @returns {{el,stage,state,focus,on,destroy,refresh}}
 */
export function createLobby(parent, host, opts = {}) {
  const doc = parent.ownerDocument; ensureCss(doc); ensureIcons(doc);
  const S = createStage(parent, { theme: opts.theme, hideCursorMs: opts.hideCursorMs ?? 3000 });
  const screen = S.screen; screen.dataset.screen = 'party-lobby';
  screen.innerHTML = `
    <div class="pm-scene" aria-hidden="true">${SCENE_LOBBY_SVG}</div>
    <div class="pm-scrim"></div>
    <div class="pm-safe">
      <div class="pm-abs" style="left:0;right:0;top:0;height:72px;display:flex;justify-content:space-between;align-items:center">
        <button type="button" class="pm-btn ghost sm" data-focus="leave" data-spec="leave">${icon('back')}Leave party</button>
        <div class="pm-chip info" data-spec="net-chip" role="status" aria-live="polite"></div>
      </div>
      <h1 class="pm-h1 pm-abs" style="left:0;top:100px;margin:0" data-spec="title">Party Mode</h1>
      <p class="pm-body-lg pm-abs" style="left:0;top:188px;width:1100px;color:var(--color-text-2);margin:0" data-spec="subtitle"></p>
      <div class="pm-qr pm-abs" style="left:0;top:262px" data-spec="qr" role="img" aria-label="QR code to join"></div>
      <div class="pm-abs" style="left:0;top:690px;width:600px">
        <div class="pm-eyebrow" data-spec="code-label">Room code</div>
        <div class="pm-code" data-spec="room-code" aria-label="Room code"></div>
        <div class="pm-url" data-spec="join-url"></div>
      </div>
      <div class="pm-abs" data-spec="slots" role="list" aria-label="Players" style="left:664px;top:262px;width:1064px;display:flex;flex-direction:column;gap:16px"></div>
      <div class="pm-body pm-abs pm-count" data-spec="count" aria-live="polite" style="left:664px;top:846px"></div>
      <div class="pm-caption pm-abs" data-spec="start-caption" style="right:512px;bottom:32px;width:560px"></div>
      <button type="button" class="pm-btn primary pm-abs" data-focus="start" data-spec="start" style="right:0;bottom:0;width:480px;height:96px"><svg class="ic" aria-hidden="true"><use href="#i-accelerate" style="transform:rotate(90deg);transform-origin:12px 12px"/></svg>Start drive</button>
      <div class="pm-hints pm-abs" data-spec="hints" style="left:0;bottom:0">
        <div class="pm-hint"><span class="pm-keycap" aria-hidden="true">${icon('back', '', 'transform:rotate(90deg)')}${icon('back', '', 'transform:rotate(-90deg)')}</span>Move</div>
        <div class="pm-hint"><span class="pm-keycap" aria-hidden="true">OK</span>Select</div>
        <div class="pm-hint"><span class="pm-keycap" aria-hidden="true">Back</span>Leave</div>
      </div>
    </div>
    <div class="pm-modal" data-spec="modal" hidden></div>`;
  const q = (s) => screen.querySelector(s);
  const el = { net: q('[data-spec="net-chip"]'), sub: q('[data-spec="subtitle"]'), qr: q('[data-spec="qr"]'), code: q('[data-spec="room-code"]'), url: q('[data-spec="join-url"]'), slots: q('[data-spec="slots"]'), count: q('[data-spec="count"]'), cap: q('[data-spec="start-caption"]'), start: q('[data-spec="start"]'), leave: q('[data-spec="leave"]'), modal: q('[data-spec="modal"]') };
  el.sub.textContent = opts.subtitle || 'Scan with your phone camera, then hold it sideways like a steering wheel.';

  const handlers = new Map(); const emit = (ev, ...a) => { for (const f of handlers.get(ev) || []) { try { f(...a); } catch (e) { queueMicrotask(() => { throw e; }); } } };
  const grace = () => opts.graceMs ?? host.lobby?.graceMs ?? 90000;
  const now = () => (opts.now ? opts.now() : Date.now());

  // ---- state --------------------------------------------------------------------------------------------------------------
  const away = new Map();           // playerId -> time the seat was first seen disconnected
  let net = 'opening', netNote = ''; let restoring = false, restoredSeats = false, peeked = null, lastQr = null, destroyed = false, modalOpen = false;
  const peek = () => { if (opts.peek === null) return null; try { return (typeof opts.peek === 'function' ? opts.peek() : opts.peek) ?? host.constructor?.peekSavedSession?.({ transport: host.kind, namespace: host.ns, storage: host.storage }) ?? null; } catch { return null; } };

  function seatsNow() {
    let list = []; try { list = host.players?.() ?? host.lobby?.list?.() ?? []; } catch {}
    const seats = Array(SEATS).fill(null);
    for (const p of list) { const i = Number.isInteger(p.slot) ? p.slot : -1; if (i >= 0 && i < SEATS && !seats[i]) seats[i] = { ...p, preview: false }; }
    if (!list.length && !host.opened && peeked) { // TV reload: show the saved seats (not connected yet) until the real lobby is back
      peeked.seats.forEach((p, k) => { const i = Number.isInteger(p.slot) ? p.slot : k; if (i < SEATS && !seats[i]) seats[i] = { id: p.id, slot: i, name: p.name, vehicle: p.vehicle, ready: false, connected: false, preview: true }; });
    }
    return seats;
  }
  const seatKind = (p) => (!p ? 'empty' : !p.connected ? 'away' : p.ready ? 'ready' : 'joined');
  const vehLabel = (p) => (opts.vehicleLabel ? opts.vehicleLabel(p) : prettyVehicle(p.vehicle));
  function view() {
    const seats = seatsNow(); const joined = seats.filter(Boolean);
    const ready = joined.filter((p) => p.connected && p.ready).length;
    const startRule = opts.startRule || 'players';
    const canStart = startRule === 'host-ready' ? !!(seats[0] && seats[0].connected && seats[0].ready) : joined.length > 0;
    const code = host.code || peeked?.code || null, joinUrl = host.joinUrl || peeked?.joinUrl || null;
    // After a TV reload the room is back before the phones are: "Waiting for phones 1/2" until every restored seat has reconnected
    let nd = net, nn = netNote;
    if (restoredSeats && net === 'ready') {
      const c = joined.filter((p) => p.connected).length;
      if (joined.length && c < joined.length) { nd = 'restoring'; nn = `Waiting for phones ${c}/${joined.length}`; } else if (joined.length) restoredSeats = false;
    }
    return { seats, joined: joined.length, ready, canStart, code, joinUrl, net: nd, netNote: nn, restoring, started: !!peeked?.started && !host.opened };
  }

  // ---- render -------------------------------------------------------------------------------------------------------------
  const slotEls = Array.from({ length: SEATS }, (_, i) => {
    const d = doc.createElement('div'); d.className = 'pm-slot'; d.setAttribute('role', 'listitem'); d.dataset.spec = `slot-${i + 1}`; d.dataset.seat = String(i + 1); d.tabIndex = -1;
    d.style.setProperty('--p', SEAT_STYLE[i].color); el.slots.appendChild(d); return d;
  });
  const slotKey = new Array(SEATS).fill('');
  function renderSlot(i, p, nowMs) {
    const d = slotEls[i], kind = seatKind(p);
    const remain = kind === 'away' && !p.preview ? Math.max(0, Math.ceil((grace() - (nowMs - (away.get(p.id) ?? nowMs))) / 1000)) : null;
    const key = [kind, p?.name, p?.vehicle, p ? vehLabel(p) : '', remain, p?.preview].join('|');
    if (key === slotKey[i]) return; slotKey[i] = key;
    d.classList.toggle('is-empty', kind === 'empty'); d.classList.toggle('is-away', kind === 'away');
    if (kind === 'empty') {
      d.removeAttribute('data-focus'); d.setAttribute('aria-label', `Player ${i + 1}, empty`);
      d.innerHTML = `<div class="badge">${badgeSvg(i, false)}</div><div class="who"><div class="name">Waiting for player ${i + 1}</div><div class="meta">Scan the code to join</div></div><span class="pm-chip ghost" data-spec="slot-${i + 1}-status">Empty</span>`;
      return;
    }
    const host1 = i === 0, nm = esc(p.name || `Player ${i + 1}`);
    let meta = '', chip = '', status = '';
    if (kind === 'ready') { meta = esc(vehLabel(p)); chip = `<span class="pm-chip ok" data-spec="slot-${i + 1}-status">${icon('check')}Ready</span>`; status = 'Ready'; }
    else if (kind === 'away') { const t = remain == null ? 'Reconnecting' : `Reconnecting ${remain} s`; meta = 'Waiting for the phone to come back'; chip = `<span class="pm-chip warn" data-spec="slot-${i + 1}-status">${icon('wifi')}${t}</span>`; status = t; }
    else { meta = 'Choosing a vehicle<span class="pm-dots" aria-hidden="true"><i></i><i></i><i></i></span>'; chip = `<span class="pm-chip" data-spec="slot-${i + 1}-status">Joined</span>`; status = 'Joined'; }
    d.dataset.focus = `slot-${i + 1}`;
    d.setAttribute('aria-label', `Player ${i + 1}, ${p.name || ''}${host1 ? ', host' : ''}, ${status}`);
    d.innerHTML = `<div class="badge">${badgeSvg(i, true)}</div><div class="who"><div class="name"><span>${nm}</span>${host1 ? icon('crown', '', '') .replace('aria-hidden="true"', 'role="img" aria-label="Host"') : ''}</div><div class="meta">${meta}</div></div>${chip}`;
  }
  let netKey = '';
  function renderNet(v) {
    const n = NET[v.net] || NET.ready; const key = v.net + '|' + v.netNote; if (key === netKey) return; netKey = key;
    el.net.className = `pm-chip ${n.cls}`; el.net.innerHTML = `${icon(n.ic)}${esc(v.netNote || n.text)}`;
  }
  function renderQr(v) {
    const sig = v.joinUrl || ''; if (sig === lastQr) { el.qr.classList.toggle('is-stale', !host.opened && !!v.joinUrl); return; } lastQr = sig;
    if (!v.joinUrl) { el.qr.innerHTML = `<div class="pm-qr-wait">Opening the party\u2026</div>`; el.qr.dataset.modules = ''; return; }
    try { const r = qrSvg(v.joinUrl); el.qr.innerHTML = r.svg; el.qr.dataset.modules = String(r.modules); el.qr.dataset.url = v.joinUrl; }
    catch (e) { el.qr.innerHTML = `<div class="pm-qr-wait">Could not draw the code. Type the room code on the phone.</div>`; }
    el.qr.classList.toggle('is-stale', !host.opened && !!v.joinUrl);
  }
  function render() {
    if (destroyed) return; const v = view(), t = now();
    renderNet(v); renderQr(v);
    el.code.textContent = v.code ? String(v.code).toUpperCase() : '\u00b7\u00b7\u00b7\u00b7'; el.code.classList.toggle('is-wait', !v.code);
    el.url.textContent = v.joinUrl ? displayUrl(v.joinUrl) : ''; el.url.title = v.joinUrl || '';
    for (let i = 0; i < SEATS; i++) renderSlot(i, v.seats[i], t);
    const txt = `${v.joined} of ${SEATS} joined \u00b7 ${v.ready} ready`; if (el.count.textContent !== txt) el.count.textContent = txt;
    const dis = !v.canStart; el.start.classList.toggle('is-disabled', dis); el.start.setAttribute('aria-disabled', String(dis));
    const cap = dis ? 'Waiting for the host to get ready' : ''; if (el.cap.textContent !== cap) el.cap.textContent = cap;
    ensureFocus();
    emit('render', v);
  }
  let queued = false; const refresh = () => { if (queued || destroyed) return; queued = true; queueMicrotask(() => { queued = false; render(); }); };

  // ---- focus (DESIGN.md lobby focus graph) ----------------------------------------------------------------------------------
  const seatEls = () => slotEls.filter((d) => d.dataset.focus);
  const fm = createFocusManager(S.root, {
    keyTarget: doc,
    onBack: () => { if (modalOpen) closeModal(false); else confirmLeave(); },
    nav(cur, dir, items) {
      const slots = seatEls(); const isSlot = slots.includes(cur);
      if (modalOpen) return undefined;
      if (cur === el.leave) { if (dir === 'down') return slots[0] || el.start; if (dir === 'right' || dir === 'up' || dir === 'left') return null; }
      if (isSlot) {
        const k = slots.indexOf(cur);
        if (dir === 'down') return slots[k + 1] || el.start;
        if (dir === 'up') return slots[k - 1] || el.leave;
        if (dir === 'right') return el.start; if (dir === 'left') return null;
      }
      if (cur === el.start) { if (dir === 'up') return slots[slots.length - 1] || el.leave; return null; }
      return undefined;
    },
    activate(t) { t.click(); },
  });
  function ensureFocus() { if (modalOpen) return; const c = fm.current; if (!c || !S.root.contains(c) || !c.getClientRects().length || !c.hasAttribute('data-focus')) fm.focus(el.start); }

  // ---- confirm sheet (Leave party / Remove player) --------------------------------------------------------------------------
  let modalDone = null;
  function openModal({ title, body, confirm, cancel = 'Keep', onYes }) {
    el.modal.innerHTML = `<div class="pm-panel" role="alertdialog" aria-modal="true" aria-labelledby="pm-dlg-t" aria-describedby="pm-dlg-b"><h2 class="pm-h2" id="pm-dlg-t" style="margin-top:0">${esc(title)}</h2><p class="pm-body" id="pm-dlg-b">${esc(body)}</p><div class="row"><button type="button" class="pm-btn sm" data-focus="no" data-spec="confirm-no">${esc(cancel)}</button><button type="button" class="pm-btn primary sm" data-focus="yes" data-spec="confirm-yes">${esc(confirm)}</button></div></div>`;
    el.modal.hidden = false; modalOpen = true; requestAnimationFrame(() => el.modal.classList.add('is-open'));
    modalDone = onYes;
    const no = el.modal.querySelector('[data-focus="no"]'), yes = el.modal.querySelector('[data-focus="yes"]');
    no.onclick = () => closeModal(false); yes.onclick = () => closeModal(true);
    fm.trap(el.modal.firstElementChild, no);
    emit('modal', { open: true, title });
  }
  function closeModal(yes) {
    if (!modalOpen) return; const done = modalDone; modalOpen = false; modalDone = null;
    el.modal.classList.remove('is-open'); el.modal.hidden = true; el.modal.innerHTML = ''; fm.release(); emit('modal', { open: false });
    if (yes) done?.();
  }
  function confirmLeave() { openModal({ title: 'Leave party?', body: 'The room closes for everyone and the phones are disconnected.', confirm: 'Leave party', cancel: 'Stay', onYes: () => { emit('leave'); if (opts.onLeave) opts.onLeave(); else host.end?.(); } }); }
  function confirmKick(i) {
    const p = seatsNow()[i]; if (!p) return;
    openModal({ title: 'Remove player?', body: `${p.name || 'Player ' + (i + 1)} will be disconnected from the party.`, confirm: 'Remove', cancel: 'Keep', onYes: () => { emit('kick', p.id); if (opts.onKick) opts.onKick(p.id); else host.kick?.(p.id); } });
  }
  el.leave.addEventListener('click', confirmLeave);
  el.start.addEventListener('click', () => { const v = view(); if (!v.canStart) return; const info = { players: v.seats.filter(Boolean), code: v.code, joinUrl: v.joinUrl }; emit('start', info); if (opts.onStart) opts.onStart(info); else host.startGame?.(); });
  slotEls.forEach((d, i) => d.addEventListener('click', () => { if (i === 0 || !d.dataset.focus || modalOpen) return; confirmKick(i); })); // seat 1 is the host: nothing to remove

  // ---- host events --------------------------------------------------------------------------------------------------------
  const offs = [];
  const on = (ev, fn) => { if (typeof host.on === 'function') { const r = host.on(ev, fn); offs.push(typeof r === 'function' ? r : () => host.off?.(ev, fn)); } };
  on('open', () => { restoring = false; net = 'ready'; netNote = ''; refresh(); });
  on('join', (id, name, player, meta) => { if (meta?.restored) restoredSeats = true; if (net === 'blocked') { net = 'ready'; netNote = ''; } refresh(); });
  on('restored', (r) => { restoredSeats = !!r?.seats?.length; refresh(); });
  on('leave', (id) => { away.delete(id); refresh(); });
  on('disconnect', (id) => { away.set(id, now()); refresh(); });
  on('reconnect', (id) => { away.delete(id); refresh(); });
  on('lobby', () => refresh());
  on('restore-progress', (p) => { if (p && p.connected < p.seats) restoredSeats = true; refresh(); });
  on('restore', (r) => { if (r?.phase === 'start' || r?.phase === 'retry') { restoring = true; net = r.phase === 'start' ? 'restoring' : 'reconnecting'; } else if (r?.phase === 'done') { restoring = false; net = 'ready'; if (r.seats > 0) restoredSeats = true; } else if (r?.phase === 'failed') { net = 'opening'; } netNote = ''; refresh(); });
  on('status', (s) => {
    if (s === 'open' || s === 'broker-ok') { net = 'ready'; restoring = false; } else if (s === 'restoring') net = 'restoring'; else if (s === 'reconnecting') net = 'reconnecting';
    else if (s === 'broker-lost' || s === 'closed' || s === 'error' || s === 'disconnected') net = 'lost'; else if (s === 'session-in-use') net = 'in-use';
    netNote = ''; refresh();
  });
  on('session-in-use', () => { net = 'in-use'; refresh(); });
  on('error', (e) => { net = e?.code === 'ICE_FAILED' ? 'blocked' : 'lost'; netNote = ''; refresh(); });

  // initial state: already-open host, else the saved session preview (same code + QR after a TV reload)
  peeked = host.opened ? null : peek();
  if (host.opened) net = 'ready'; else if (host.status === 'restoring') net = 'restoring'; else if (peeked) net = 'restoring'; else if (host.status === 'session-in-use') net = 'in-use';
  render();
  fm.focus(el.start);
  const tick = setInterval(() => { for (const p of seatsNow()) if (p && !p.connected && !p.preview && !away.has(p.id)) away.set(p.id, now()); render(); }, 1000);

  return {
    el: S.root, stage: S.stage, screen,
    get state() { return view(); },
    /** Move focus: 'start' | 'leave' | 1..4 (seat) | an element. */
    focus(t = 'start') { const e = t === 'start' ? el.start : t === 'leave' ? el.leave : typeof t === 'number' ? slotEls[t - 1] : t; if (e) fm.focus(e); return fm.current; },
    get focused() { return fm.current?.dataset.focus || null; },
    on(ev, fn) { (handlers.get(ev) || handlers.set(ev, new Set()).get(ev)).add(fn); return () => handlers.get(ev)?.delete(fn); },
    refresh: render,
    destroy() { destroyed = true; clearInterval(tick); offs.forEach((o) => { try { o(); } catch {} }); fm.dispose(); S.dispose(); },
  };
}
