// Per-profile settings: control layout + sensitivity, phone-wheel tuning, camera, graphics quality, audio, units.
// sanitizeSettings() accepts anything (corrupt, partial, older) and always returns a complete, in-range object.
import { clamp, num, bool, oneOf, isObj, deepMerge } from './util.js';

export const CAMERA_MODES = ['chase', 'closeChase', 'cab', 'freeLook'];   // architecture.md: chase, close chase, first-person (cab), free-look
export const QUALITY_TIERS = ['low', 'medium', 'high'];                    // Vanta's tiers; 'auto' lets the game pick/step down
export const CONTROL_SCHEMES = ['auto', 'touch', 'wheel'];                 // 'auto' = wheel in Party Mode when motion permission is granted, else touch
export const STEER_STYLES = ['slide', 'arrows'];
export const UNITS = ['metric', 'imperial'];

export const WHEEL_LOCK_MIN = 25, WHEEL_LOCK_MAX = 60, WHEEL_LOCK_DEFAULT = 45;   // degrees of phone tilt for full steering lock
export const WHEEL_DEADZONE_DEFAULT = 3;                                           // ±3° (architecture.md)

/** Touch-control elements. x,y = element centre as a 0..1 fraction of the landscape screen; scale = size multiplier. */
export const TOUCH_ELEMENTS = ['look', 'steer', 'throttle', 'brake', 'reverse', 'hand', 'horn', 'camera', 'reset'];
export const DEFAULT_TOUCH_LAYOUT = Object.freeze({
  look:     { x: 0.22, y: 0.55, scale: 1 },     // left half: camera/look drag area
  steer:    { x: 0.62, y: 0.72, scale: 1 },
  brake:    { x: 0.76, y: 0.82, scale: 1 },
  throttle: { x: 0.90, y: 0.68, scale: 1 },
  reverse:  { x: 0.76, y: 0.50, scale: 1 },
  hand:     { x: 0.90, y: 0.38, scale: 1 },
  horn:     { x: 0.40, y: 0.14, scale: 1 },
  camera:   { x: 0.50, y: 0.14, scale: 1 },
  reset:    { x: 0.60, y: 0.14, scale: 1 },
});

export const DEFAULT_SETTINGS = Object.freeze({
  controls: {
    scheme: 'auto',
    mirror: false,                  // left-handed: swap the two halves of the touch layout
    steerStyle: 'slide',
    steerSensitivity: 1,            // touch steering gain, 0.3..2
    lookSensitivity: 1,             // camera drag gain, 0.3..2
    opacity: 0.8,                   // touch button opacity, 0.3..1
    vibration: true,
    layout: DEFAULT_TOUCH_LAYOUT,
    wheel: {
      fullLockDeg: WHEEL_LOCK_DEFAULT,   // 25..60: smaller = more sensitive. THE wheel sensitivity setting.
      deadZoneDeg: WHEEL_DEADZONE_DEFAULT,
      smoothing: 0.5,                    // 0 = raw, 0.95 = very smooth (exponential smoothing factor)
      invert: false,
      centreOffsetDeg: 0,                // last calibrate-centre result; runtime may recalibrate each session
    },
  },
  camera: {
    mode: 'chase',
    fov: 70,                        // vertical degrees, 50..100
    sharedCamera: false,            // Party Mode: one camera framing everybody instead of split screen
    invertLookY: false,
  },
  graphics: {
    qualityTier: 'auto',            // 'auto' | low | medium | high
    resolutionScale: 1,             // 0.5..1
  },
  audio: { master: 0.8, effects: 1, music: 0.5 },
  units: 'metric',
  hud: { minimap: true, speedometer: true },
});

function sanitizeElement(raw, def) {
  const r = isObj(raw) ? raw : {};
  return { x: num(r.x, def.x, 0, 1), y: num(r.y, def.y, 0, 1), scale: num(r.scale, def.scale, 0.6, 1.6) };
}

export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const c = isObj(r.controls) ? r.controls : {};
  const w = isObj(c.wheel) ? c.wheel : {};
  const cam = isObj(r.camera) ? r.camera : {};
  const g = isObj(r.graphics) ? r.graphics : {};
  const a = isObj(r.audio) ? r.audio : {};
  const h = isObj(r.hud) ? r.hud : {};
  const d = DEFAULT_SETTINGS;
  const layout = {};
  for (const el of TOUCH_ELEMENTS) layout[el] = sanitizeElement(isObj(c.layout) ? c.layout[el] : null, DEFAULT_TOUCH_LAYOUT[el]);
  return {
    controls: {
      scheme: oneOf(c.scheme, CONTROL_SCHEMES, d.controls.scheme),
      mirror: bool(c.mirror, d.controls.mirror),
      steerStyle: oneOf(c.steerStyle, STEER_STYLES, d.controls.steerStyle),
      steerSensitivity: num(c.steerSensitivity, d.controls.steerSensitivity, 0.3, 2),
      lookSensitivity: num(c.lookSensitivity, d.controls.lookSensitivity, 0.3, 2),
      opacity: num(c.opacity, d.controls.opacity, 0.3, 1),
      vibration: bool(c.vibration, d.controls.vibration),
      layout,
      wheel: {
        fullLockDeg: num(w.fullLockDeg, WHEEL_LOCK_DEFAULT, WHEEL_LOCK_MIN, WHEEL_LOCK_MAX),
        deadZoneDeg: num(w.deadZoneDeg, WHEEL_DEADZONE_DEFAULT, 0, 10),
        smoothing: num(w.smoothing, d.controls.wheel.smoothing, 0, 0.95),
        invert: bool(w.invert, false),
        centreOffsetDeg: num(w.centreOffsetDeg, 0, -45, 45),
      },
    },
    camera: {
      mode: oneOf(cam.mode, CAMERA_MODES, d.camera.mode),
      fov: num(cam.fov, d.camera.fov, 50, 100),
      sharedCamera: bool(cam.sharedCamera, false),
      invertLookY: bool(cam.invertLookY, false),
    },
    graphics: {
      qualityTier: oneOf(g.qualityTier, ['auto', ...QUALITY_TIERS], d.graphics.qualityTier),
      resolutionScale: num(g.resolutionScale, 1, 0.5, 1),
    },
    audio: {
      master: num(a.master, d.audio.master, 0, 1),
      effects: num(a.effects, d.audio.effects, 0, 1),
      music: num(a.music, d.audio.music, 0, 1),
    },
    units: oneOf(r.units, UNITS, d.units),
    hud: { minimap: bool(h.minimap, true), speedometer: bool(h.speedometer, true) },
  };
}

export const defaultSettings = () => sanitizeSettings({});

/** Apply a partial change (e.g. {controls:{wheel:{fullLockDeg:35}}}) and re-validate. Returns a new settings object. */
export const mergeSettings = (current, patch) => sanitizeSettings(deepMerge(sanitizeSettings(current), isObj(patch) ? patch : {}));

/**
 * Phone-wheel steering from the tilt angle (degrees, already corrected for screen orientation).
 * Applies calibration offset, dead zone and full lock; returns -1..1 (+ = right). Smoothing is the caller's per-frame job
 * (use smoothingAlpha()).
 */
export function wheelSteerFromAngle(angleDeg, wheel = DEFAULT_SETTINGS.controls.wheel) {
  const w = sanitizeSettings({ controls: { wheel } }).controls.wheel;
  let a = (Number.isFinite(angleDeg) ? angleDeg : 0) - w.centreOffsetDeg;
  const dz = w.deadZoneDeg;
  a = Math.abs(a) <= dz ? 0 : Math.sign(a) * (Math.abs(a) - dz);
  const s = clamp(a / Math.max(1, w.fullLockDeg - dz), -1, 1);
  return w.invert ? -s : s;
}

/** Exponential smoothing: value += (target - value) * alpha. Frame-rate independent for the given dt (seconds). */
export function smoothingAlpha(smoothing, dt) {
  const s = clamp(smoothing, 0, 0.95);
  return 1 - Math.pow(s, clamp(dt, 0, 1) * 60);
}
