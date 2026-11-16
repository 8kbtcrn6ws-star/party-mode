// TV focus manager (DESIGN.md "Interaction rules / TV and remote"): one focused element at all times; D-pad (arrow keys) moves to the
// nearest focusable in that direction, OK (Enter / Space / gamepad A) activates, Back (Escape / Backspace / XF86Back) goes up a level.
// Mouse hover mirrors focus, click activates. Focus visual = class `is-focus` (ring + lift + scale come from tv.css) plus real DOM focus.
//   const fm = createFocusManager(rootEl, { onBack, nav, activate });
//   fm.focus(el | null) / fm.current / fm.move('up'|'down'|'left'|'right') / fm.trap(containerEl) / fm.release() / fm.dispose()
// Focusables are `[data-focus]` elements that are visible. `nav(el, dir, candidates)` may return an element (jump), null (blocked) or undefined (use geometry).
export function createFocusManager(root, { onBack, nav, activate, keyTarget } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  let cur = null, scope = null; const scopes = [];
  const inScope = () => scope || root;
  const list = () => [...inScope().querySelectorAll('[data-focus]')].filter((e) => !e.hasAttribute('data-focus-skip') && e.getClientRects().length > 0);

  function focus(el, { fromPointer = false } = {}) {
    if (el && !inScope().contains(el)) return;
    if (cur === el) return;
    cur?.classList.remove('is-focus'); cur?.removeAttribute('aria-current');
    cur = el || null;
    if (cur) { cur.classList.add('is-focus'); cur.setAttribute('aria-current', 'true'); if (!fromPointer) cur.focus?.({ preventScroll: true }); }
  }
  function geometric(from, dir, items) {
    const c = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; };
    const a = c(from); let best = null, bestScore = Infinity;
    for (const e of items) {
      if (e === from) continue; const b = c(e);
      const dx = b.x - a.x, dy = b.y - a.y;
      const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
      if (along <= 4) continue;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (across > along * 1.6 + Math.max(a.h, a.w) / 2) continue; // outside a ~58 degree cone
      const score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }
  function move(dir) {
    const items = list(); if (!items.length) return null;
    if (!cur || !items.includes(cur)) { focus(items[0]); return cur; }
    let next = nav ? nav(cur, dir, items) : undefined;
    if (next === undefined) next = geometric(cur, dir, items);
    if (next) focus(next);
    return next || null;
  }
  const KEY = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  function key(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (KEY[e.key]) { e.preventDefault(); move(KEY[e.key]); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      if (!cur) return; e.preventDefault(); press(cur); return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'XF86Back') { e.preventDefault(); onBack?.(); }
  }
  function press(el) {
    el.classList.add('is-pressed'); setTimeout(() => el.classList.remove('is-pressed'), 120);
    if (el.getAttribute('aria-disabled') === 'true') return;
    if (activate) activate(el); else el.click?.();
  }
  const tgt = keyTarget || doc;
  const keyup = (e) => { if (e.key === ' ' && cur && root.contains(e.target)) e.preventDefault(); }; // Firefox fires the button click on Space keyup
  tgt.addEventListener('keydown', key); tgt.addEventListener('keyup', keyup);

  // Mouse / touch on the TV browser: hover mirrors focus, click activates (native click on <button>/[data-focus]).
  const onOver = (e) => { const t = e.target.closest?.('[data-focus]'); if (t && inScope().contains(t) && !t.hasAttribute('data-focus-skip')) focus(t, { fromPointer: true }); };
  const onClick = (e) => { const t = e.target.closest?.('[data-focus]'); if (!t || !inScope().contains(t)) return; if (t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopPropagation(); } };
  root.addEventListener('pointerover', onOver); root.addEventListener('click', onClick, true);

  // Gamepad (TV browsers map the remote D-pad to arrows already; this covers a plain controller). Poll only while a pad is connected.
  let gpTimer = 0, gpPrev = {};
  const pollPad = () => {
    const pads = navigator.getGamepads?.() || []; const p = [...pads].find(Boolean); if (!p) return;
    const b = (i) => !!p.buttons[i]?.pressed; const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    const now = { up: b(12) || ay < -.6, down: b(13) || ay > .6, left: b(14) || ax < -.6, right: b(15) || ax > .6, ok: b(0), back: b(1) };
    for (const k of Object.keys(now)) if (now[k] && !gpPrev[k]) { if (k === 'ok') cur && press(cur); else if (k === 'back') onBack?.(); else move(k); }
    gpPrev = now;
  };
  const onPad = () => { if (!gpTimer) gpTimer = setInterval(pollPad, 90); };
  win.addEventListener('gamepadconnected', onPad); if ((navigator.getGamepads?.() || []).some(Boolean)) onPad();

  return {
    get current() { return cur; },
    focus, move, list,
    /** Restrict focus to a container (modal). Focus moves to its first focusable (or `initial`). */
    trap(container, initial) { scopes.push({ scope, cur }); scope = container; cur?.classList.remove('is-focus'); cur = null; focus(initial || list()[0]); },
    release() { const s = scopes.pop(); scope = s ? s.scope : null; cur?.classList.remove('is-focus'); cur = null; focus(s?.cur && root.contains(s.cur) && s.cur.getClientRects().length ? s.cur : list()[0]); },
    press,
    dispose() { tgt.removeEventListener('keydown', key); tgt.removeEventListener('keyup', keyup); root.removeEventListener('pointerover', onOver); root.removeEventListener('click', onClick, true); win.removeEventListener('gamepadconnected', onPad); clearInterval(gpTimer); },
  };
}
