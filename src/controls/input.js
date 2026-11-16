// The one input object every control scheme produces (architecture.md "One repo, one build"):
// { steer -1..1 (+right), throttle 0..1, brake 0..1, rev 0|1, hand 0|1, horn 0|1, look {x,y}|null, cam 'next'|null, reset 0|1,
//   zoom -1..1 (rate; -1 = in/close, +1 = out/far, as net/protocol.js; default 0), glance 'back'|'left'|'right'|null (held) }
// zoom and glance are optional additions (Requirement 4); a host that ignores them behaves exactly as before.
// cam is 'next' | 'view' | null, each a ~200 ms pulse that the host reads as one edge. 'next' cycles the cameras, 'view' toggles first person (cab) <-> the last third-person mode.
// Phones: tap CAM = 'next' (sent on release), HOLD CAM >= CAM_HOLD_S = one 'view' pulse (the tap is NOT sent). Keyboard: C = 'next', V = 'view'.
// It is also the body of the phone's {t:'in'} message, so local play and Party Mode drive the car the same way.
export const blankInput = () => ({ steer: 0, throttle: 0, brake: 0, rev: 0, hand: 0, horn: 0, look: null, cam: null, reset: 0, zoom: 0, glance: null });
export const CAM_HOLD_S = 0.5; // hold CAM this long = 'view' instead of 'next'
/** Zoom rate unit: +-1 on input.zoom (+ = away) changes the third-person distance by this many ln-units per second (cameras.js). */
export const ZOOM_RATE = 1.2;
export const GLANCES = ['back', 'left', 'right'];

/** Merge several sources (e.g. keyboard + touch on a laptop): biggest magnitude wins per field. */
export function combineInputs(...list) {
  const o = blankInput();
  for (const s of list) {
    if (!s) continue;
    if (Math.abs(s.steer || 0) > Math.abs(o.steer)) o.steer = s.steer;
    for (const k of ['throttle', 'brake', 'rev', 'hand', 'horn', 'reset']) o[k] = Math.max(o[k], s[k] || 0);
    if (s.look && (!o.look || Math.hypot(s.look.x, s.look.y) > Math.hypot(o.look.x, o.look.y))) o.look = { ...s.look };
    if (s.cam === 'next' || s.cam === 'view') o.cam = s.cam;
    if (Math.abs(s.zoom || 0) > Math.abs(o.zoom)) o.zoom = Math.max(-1, Math.min(1, s.zoom));
    if (GLANCES.includes(s.glance)) o.glance = s.glance;
  }
  return o;
}

/** Turns a tap into a short pulse (~200 ms) so a 30 Hz sender and the host's rising-edge check both see it. */
export function pulse(ms = 200) {
  let until = 0;
  return { fire() { until = performance.now() + ms; }, get on() { return performance.now() < until; } };
}

export const haptic = (ms, enabled = true) => { if (enabled && navigator.vibrate) { try { navigator.vibrate(ms); } catch {} } };
