// Keyboard + gamepad (laptop / TV-side solo play and testing).
// W/↑ accelerate · S/↓ brake (hold at a standstill to reverse) · A/D steer · Q reverse toggle · Space handbrake · H horn · C camera · R reset · IJKL look
// Camera freedom: B look back (hold) · Z look left · X look right · C cycles the camera, V switches first/third person · mouse wheel or +/- zoom (third person)
import { blankInput, pulse, ZOOM_RATE } from './input.js';

export function createKeyboard(target = window) {
  const keys = new Set(), cam = pulse(), reset = pulse(), view = pulse();
  let wheelLn = 0; // pending mouse-wheel zoom (ln-units), spent as a rate by read()
  let rev = 0, steer = 0, lastPadReset = false, padCam = false;
  const down = (e) => {
    if (e.target?.closest?.('input,textarea,select')) return;
    if (!e.repeat) {
      if (e.code === 'KeyC') cam.fire();
      if (e.code === 'KeyR') reset.fire();
      if (e.code === 'KeyV') view.fire();
      if (e.code === 'KeyQ') rev = rev ? 0 : 1;
    }
    keys.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  };
  const up = (e) => keys.delete(e.code);
  const wheel = (e) => { if (e.target?.closest?.('input,textarea,select')) return; const px = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; wheelLn += Math.max(-300, Math.min(300, -e.deltaY * px)) * 0.0015; };
  const blur = () => keys.clear();
  target.addEventListener('wheel', wheel, { passive: true }); target.addEventListener('keydown', down); target.addEventListener('keyup', up); window.addEventListener('blur', blur);
  const has = (...c) => c.some((k) => keys.has(k));

  return {
    read(dt = 1 / 60) {
      const o = blankInput(); padCam = false;
      const want = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
      steer += Math.max(-dt * 4, Math.min(dt * 4, want - steer));       // eased so keys aren't all-or-nothing
      if (!want && Math.abs(steer) < 0.02) steer = 0;
      o.steer = steer;
      o.throttle = has('KeyW', 'ArrowUp') ? 1 : 0;
      o.brake = has('KeyS', 'ArrowDown') ? 1 : 0;
      o.hand = has('Space') ? 1 : 0;
      o.horn = has('KeyH') ? 1 : 0;
      o.rev = rev;
      const lx = (has('KeyL') ? 1 : 0) - (has('KeyJ') ? 1 : 0), ly = (has('KeyK') ? 1 : 0) - (has('KeyI') ? 1 : 0);
      if (lx || ly) o.look = { x: lx, y: ly };
      if (has('KeyB')) o.glance = 'back'; else if (has('KeyZ')) o.glance = 'left'; else if (has('KeyX')) o.glance = 'right';
      o.zoom = (has('Minus', 'NumpadSubtract') ? 1 : 0) - (has('Equal', 'NumpadAdd') ? 1 : 0); // + zooms in (-1), - zooms out (+1)
      if (wheelLn) { const r = Math.max(-1, Math.min(1, wheelLn / (ZOOM_RATE * dt))); o.zoom = Math.max(-1, Math.min(1, o.zoom - r)); wheelLn -= r * ZOOM_RATE * dt; if (Math.abs(wheelLn) < 1e-4) wheelLn = 0; }
      for (const p of navigator.getGamepads?.() || []) {
        if (!p) continue;
        const dz = (v) => (Math.abs(v || 0) < 0.12 ? 0 : v);
        if (dz(p.axes[0])) o.steer = dz(p.axes[0]);
        o.throttle = Math.max(o.throttle, p.buttons[7]?.value || 0);
        o.brake = Math.max(o.brake, p.buttons[6]?.value || 0);
        if (p.buttons[0]?.pressed) o.hand = 1;
        if (p.buttons[1]?.pressed) o.horn = 1;
        if (dz(p.axes[2]) || dz(p.axes[3])) o.look = { x: dz(p.axes[2]), y: dz(p.axes[3]) };
        if (p.buttons[11]?.pressed) o.glance = 'back'; else if (p.buttons[4]?.pressed) o.glance = 'left'; else if (p.buttons[5]?.pressed) o.glance = 'right';
        padCam = !!p.buttons[3]?.pressed; if (p.buttons[10]?.pressed) view.fire(); const r = !!p.buttons[8]?.pressed;
        if (r && !lastPadReset) reset.fire();
        lastPadReset = r;
        break;
      }
      o.cam = view.on ? 'view' : (cam.on || padCam) ? 'next' : null;
      o.reset = reset.on ? 1 : 0;
      return o;
    },
    get reverse() { return rev; },
    dispose() { target.removeEventListener('wheel', wheel); target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); window.removeEventListener('blur', blur); },
  };
}
