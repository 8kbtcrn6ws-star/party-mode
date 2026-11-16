// Tilt steering helper (phone held in landscape like a steering wheel). Framework-free, browser ESM.
//
//   const wheel = new TiltSteering({ lockDeg: 45 });
//   button.onclick = async () => { const r = await wheel.enable(); /* 'granted' | 'denied' | 'no-sensor' | 'insecure' */ if (r !== 'granted') useTouch(r); };
//   calibrateBtn.onclick = () => wheel.calibrate();
//   every frame / input tick:  const steer = wheel.read();   // -1..1, deadzone + smoothing applied
//
// How the angle is computed (gimbal-safe, works for landscape-left AND landscape-right):
// DeviceOrientation (alpha,beta,gamma) gives the direction of gravity in the phone's own axes. We project it onto the
// *screen* axes (which depend on screen.orientation.angle) and take the in-plane angle: that is exactly how far the
// phone is rotated like a wheel. If the phone is held flat (gravity almost perpendicular to the screen) we blend to a
// roll-based angle so it still steers by tilting left/right.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap180 = d => ((((d + 180) % 360) + 360) % 360) - 180;

/** Screen orientation angle in degrees (0,90,180,270): modern API first, legacy window.orientation as fallback. */
export function screenAngle() {
  const a = globalThis.screen?.orientation?.angle;
  if (typeof a === 'number') return ((a % 360) + 360) % 360;
  if (typeof globalThis.orientation === 'number') return ((globalThis.orientation % 360) + 360) % 360;
  return 0;
}

/**
 * Wheel angle in degrees, clockwise-positive (turn right = positive) from DeviceOrientation beta/gamma + screen angle.
 * Pure function (unit-tested).
 */
export function wheelAngleDeg(beta, gamma, angle) {
  const b = beta * D2R, g = gamma * D2R;
  // direction of "world up" expressed in device axes (x right, y up the screen in natural portrait, z out of the screen)
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  // device-axis vectors for the user's screen right / up, given how the screen is rotated
  const a = ((Math.round(angle / 90) % 4) + 4) % 4;
  const R = [[1, 0], [0, -1], [-1, 0], [0, 1]][a];  // screen-right in device (x,y)
  const U = [[0, 1], [1, 0], [0, -1], [-1, 0]][a];  // screen-up in device (x,y)
  const upR = ux * R[0] + uy * R[1], upU = ux * U[0] + uy * U[1];
  const planar = Math.hypot(upR, upU);                // 1 = phone upright like a wheel, 0 = lying flat
  const wheel = Math.atan2(-upR, upU) * R2D;          // rotation in the screen plane
  const flat = Math.asin(clamp(-upR, -1, 1)) * R2D;   // right edge down = positive
  const w = clamp((planar - 0.25) / 0.25, 0, 1);      // blend 0.25..0.5
  void uz;
  return w * wheel + (1 - w) * flat;
}

export class TiltSteering {
  /**
   * @param {object} [o]
   * @param {number} [o.lockDeg=45]       wheel rotation that gives full lock (architecture: 25..60, default 45)
   * @param {number} [o.deadzoneDeg=3]
   * @param {number} [o.smoothingMs=60]   time constant of the exponential filter (0 = off)
   * @param {boolean} [o.invert=false]
   * @param {()=>number} [o.getAngle]     override screen angle source (tests)
   * @param {()=>number} [o.now]
   */
  constructor(o = {}) {
    this.lockDeg = o.lockDeg ?? 45; this.deadzoneDeg = o.deadzoneDeg ?? 3; this.smoothingMs = o.smoothingMs ?? 60; this.invert = !!o.invert;
    this.getAngle = o.getAngle || screenAngle; this.now = o.now || (() => performance.now());
    this.mode = 'idle';          // 'idle' | 'tilt' | 'manual' (fallback)
    this.reason = null;          // why we are not in tilt mode
    this.rawDeg = 0; this.zeroDeg = 0; this.have = false; this._v = 0; this._t = 0; this._manual = 0;
    this._lastAngle = null; this._onEvt = e => this.#onOrientation(e);
    this._onRot = () => { this.have = false; this.zeroDeg = 0; this._needCal = true; };
    this._listeners = new Set();
  }
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  #emit(ev) { for (const f of this._listeners) { try { f(ev, this); } catch {} } }

  /**
   * MUST be called from a user tap (iOS asks for permission only inside a gesture).
   * Returns 'granted' | 'denied' | 'no-sensor' | 'insecure' | 'unsupported'. Anything but 'granted' switches to manual mode
   * (use setManual() from an on-screen slider / touch pad).
   */
  async enable() {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return this.#fallback('unsupported');
    if (window.isSecureContext === false) return this.#fallback('insecure');
    const DOE = window.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      let res;
      try { res = await DOE.requestPermission(); } catch { return this.#fallback('denied'); } // throws if not from a gesture too
      if (res !== 'granted') return this.#fallback('denied');
    }
    window.addEventListener('deviceorientation', this._onEvt);
    window.addEventListener('orientationchange', this._onRot);
    globalThis.screen?.orientation?.addEventListener?.('change', this._onRot);
    // Desktop browsers fire one event with null angles; a real sensor streams numbers.
    const got = await new Promise(res => { const t = setTimeout(() => res(false), 1200); const off = this.on(ev => { if (ev === 'sample') { clearTimeout(t); off(); res(true); } }); if (this.have) { clearTimeout(t); off(); res(true); } });
    if (!got) { this.#stopListening(); return this.#fallback('no-sensor'); }
    this.mode = 'tilt'; this.reason = null; this.#emit('mode');
    return 'granted';
  }
  #stopListening() { window.removeEventListener('deviceorientation', this._onEvt); window.removeEventListener('orientationchange', this._onRot); globalThis.screen?.orientation?.removeEventListener?.('change', this._onRot); }
  #fallback(reason) { this.mode = 'manual'; this.reason = reason; this.#emit('mode'); return reason; }
  disable() { this.#stopListening(); this.mode = 'idle'; }

  #onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    this.rawDeg = wheelAngleDeg(e.beta, e.gamma, this.getAngle());
    this.have = true;
    if (this._needCal) { this.zeroDeg = this.rawDeg; this._needCal = false; } // orientation changed: re-centre on the new pose
    this.#emit('sample');
  }

  /** "Centre the wheel": the current pose becomes straight ahead. */
  calibrate() { this.zeroDeg = this.rawDeg; this._v = 0; this.#emit('calibrated'); }

  /** Manual/fallback steering from an on-screen control, -1..1. */
  setManual(v) { this._manual = clamp(+v || 0, -1, 1); }

  /** Current wheel angle relative to centre, degrees (positive = right). */
  get angleDeg() { return this.mode === 'tilt' ? wrap180(this.rawDeg - this.zeroDeg) : this._manual * this.lockDeg; }

  /** Steering -1..1: deadzone, lock scaling and smoothing applied. Call at your input rate. */
  read() {
    let target;
    if (this.mode === 'tilt') {
      let a = this.angleDeg;
      const dz = this.deadzoneDeg;
      a = Math.abs(a) <= dz ? 0 : Math.sign(a) * (Math.abs(a) - dz);          // remove the dead zone but keep the output continuous
      target = clamp(a / Math.max(1, this.lockDeg - dz), -1, 1);
    } else target = this._manual;
    if (this.invert) target = -target;
    const t = this.now(), dt = this._t ? t - this._t : 16; this._t = t;
    const k = this.smoothingMs > 0 ? 1 - Math.exp(-dt / this.smoothingMs) : 1;
    this._v += (target - this._v) * k;
    if (Math.abs(this._v) < 0.001) this._v = 0;
    return this._v;
  }
  get steer() { return this.read(); }
}
