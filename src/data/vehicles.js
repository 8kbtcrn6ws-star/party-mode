// Vehicle catalogue format: schema, validator, catalogue container, derived numbers, and an adapter that
// produces the flat spec drive/src/vehicle.js consumes today.
//
// Units: metres, kg, newtons, N·m, seconds, degrees in data (converted to radians by toDriveSpec).
// Axes follow the glTF asset contract: Y up, +Z forward, +X to the vehicle's LEFT (right-handed).
// A vehicle is plain JSON-serialisable data, so SpaceX/Forma can ship the same objects as vehicles/<id>.json.
import { ID_RE, isObj, isId, deepClone } from './util.js';

export const VEHICLE_SCHEMA = 1;
export const VEHICLE_CLASSES = ['suv', 'pickup', 'classic', 'expedition', 'buggy', 'utility', 'other'];
export const DRIVE_LAYOUTS = ['4WD', 'RWD', 'FWD'];
export const UNLOCK_TYPES = ['start', 'pois', 'poi', 'chunks'];
export const PHYSICS_DT = 1 / 60;   // fixed step (architecture.md); brake force -> Rapier brake impulse uses it

const rad = (d) => (d * Math.PI) / 180;

// ---- validation -------------------------------------------------------------------------------
function check(errors, path, v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${path}: must be a finite number`);
  else if (v < min || v > max) errors.push(`${path}: ${v} outside ${min}..${max}`);
}
function vec(errors, path, v, lim) {
  if (!isObj(v)) { errors.push(`${path}: must be {x,y,z}`); return; }
  for (const k of ['x', 'y', 'z']) check(errors, `${path}.${k}`, v[k], -lim, lim);
}
function sect(errors, root, name) {
  if (!isObj(root[name])) { errors.push(`${name}: missing section`); return null; }
  return root[name];
}

/**
 * Validate one vehicle definition. Returns { ok, errors[], vehicle } where `vehicle` is a deep-cloned copy with
 * optional fields defaulted (only when ok). Never throws on bad input.
 */
export function validateVehicle(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, errors: ['vehicle: must be an object'], vehicle: null };
  if (raw.schema !== undefined && raw.schema !== VEHICLE_SCHEMA) errors.push(`schema: unsupported version ${raw.schema}`);
  if (!isId(raw.id)) errors.push(`id: must match ${ID_RE}`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 40) errors.push('name: 1..40 characters');
  if (raw.class !== undefined && !VEHICLE_CLASSES.includes(raw.class)) errors.push(`class: one of ${VEHICLE_CLASSES.join(', ')}`);

  const body = sect(errors, raw, 'body');
  if (body) {
    check(errors, 'body.massKg', body.massKg, 300, 20000);
    if (!isObj(body.size)) errors.push('body.size: must be {length,width,height}');
    else {
      check(errors, 'body.size.length', body.size.length, 1, 12);
      check(errors, 'body.size.width', body.size.width, 0.8, 4);
      check(errors, 'body.size.height', body.size.height, 0.3, 4);
    }
    vec(errors, 'body.centreOfMass', body.centreOfMass, 3);
  }

  const wh = sect(errors, raw, 'wheels');
  if (wh) {
    check(errors, 'wheels.radius', wh.radius, 0.15, 1);
    check(errors, 'wheels.wheelbase', wh.wheelbase, 1, 8);
    check(errors, 'wheels.trackFront', wh.trackFront, 0.6, 3.5);
    check(errors, 'wheels.trackRear', wh.trackRear ?? wh.trackFront, 0.6, 3.5);
    check(errors, 'wheels.hubY', wh.hubY, -2, 2);
  }

  const su = sect(errors, raw, 'suspension');
  if (su) {
    check(errors, 'suspension.restLength', su.restLength, 0.05, 1.5);
    check(errors, 'suspension.travel', su.travel, 0.05, 1.5);
    check(errors, 'suspension.stiffness', su.stiffness, 1, 500);
    check(errors, 'suspension.compression', su.compression, 0, 50);
    check(errors, 'suspension.relaxation', su.relaxation, 0, 50);
    if (su.maxForceN !== undefined) check(errors, 'suspension.maxForceN', su.maxForceN, 1000, 5e6);
  }

  const st = sect(errors, raw, 'steering');
  if (st) {
    check(errors, 'steering.maxAngleDeg', st.maxAngleDeg, 5, 70);
    check(errors, 'steering.highSpeedAngleDeg', st.highSpeedAngleDeg, 1, 70);
    check(errors, 'steering.rateDegPerS', st.rateDegPerS, 10, 720);
    if (typeof st.maxAngleDeg === 'number' && typeof st.highSpeedAngleDeg === 'number' && st.highSpeedAngleDeg > st.maxAngleDeg) {
      errors.push('steering.highSpeedAngleDeg: must not exceed maxAngleDeg');
    }
  }

  const en = sect(errors, raw, 'engine');
  if (en) {
    const tc = en.torqueCurve;
    if (!Array.isArray(tc) || tc.length < 2 || tc.length > 32) errors.push('engine.torqueCurve: 2..32 points of [rpm, Nm]');
    else {
      let last = -Infinity;
      tc.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 2) { errors.push(`engine.torqueCurve[${i}]: must be [rpm, Nm]`); return; }
        check(errors, `engine.torqueCurve[${i}][0]`, p[0], 0, 20000);
        check(errors, `engine.torqueCurve[${i}][1]`, p[1], 0, 20000);
        if (p[0] <= last) errors.push(`engine.torqueCurve[${i}]: rpm must be strictly ascending`);
        last = p[0];
      });
    }
    check(errors, 'engine.idleRpm', en.idleRpm, 300, 3000);
    check(errors, 'engine.redlineRpm', en.redlineRpm, 2000, 20000);
    if (!Array.isArray(en.gearRatios) || en.gearRatios.length < 1 || en.gearRatios.length > 10) errors.push('engine.gearRatios: 1..10 ratios');
    else en.gearRatios.forEach((g, i) => check(errors, `engine.gearRatios[${i}]`, g, 0.3, 15));
    check(errors, 'engine.reverseRatio', en.reverseRatio, 0.5, 15);
    check(errors, 'engine.finalDrive', en.finalDrive, 1, 15);
    check(errors, 'engine.efficiency', en.efficiency ?? 0.9, 0.3, 1);
    check(errors, 'engine.topSpeedMps', en.topSpeedMps, 3, 120);
    check(errors, 'engine.reverseTopMps', en.reverseTopMps, 1, 40);
  }

  const br = sect(errors, raw, 'brakes');
  if (br) {
    check(errors, 'brakes.torqueNm', br.torqueNm, 100, 20000);
    check(errors, 'brakes.handbrakeTorqueNm', br.handbrakeTorqueNm, 0, 40000);
  }

  const dt = sect(errors, raw, 'drivetrain');
  if (dt) {
    if (!DRIVE_LAYOUTS.includes(dt.layout)) errors.push(`drivetrain.layout: one of ${DRIVE_LAYOUTS.join(', ')}`);
    if (dt.frontTorqueSplit !== undefined) check(errors, 'drivetrain.frontTorqueSplit', dt.frontTorqueSplit, 0, 1);
  }

  const ty = sect(errors, raw, 'tyres');
  if (ty) {
    check(errors, 'tyres.gripScale', ty.gripScale, 0.3, 3);
    check(errors, 'tyres.sideGripScale', ty.sideGripScale ?? 1, 0.3, 3);
    check(errors, 'tyres.rollingResistanceScale', ty.rollingResistanceScale ?? 1, 0.3, 3);
    if (ty.surfaceGrip !== undefined) {
      if (!isObj(ty.surfaceGrip)) errors.push('tyres.surfaceGrip: must be an object of surface id -> multiplier');
      else for (const [k, v] of Object.entries(ty.surfaceGrip)) {
        if (!ID_RE.test(k)) errors.push(`tyres.surfaceGrip.${k}: bad surface id`);
        check(errors, `tyres.surfaceGrip.${k}`, v, 0.3, 3);
      }
    }
  }

  if (raw.aero !== undefined) {
    if (!isObj(raw.aero)) errors.push('aero: must be an object');
    else { check(errors, 'aero.dragCoefficient', raw.aero.dragCoefficient, 0.1, 2); check(errors, 'aero.frontalAreaM2', raw.aero.frontalAreaM2, 0.5, 15); }
  }
  if (raw.wading !== undefined) {
    if (!isObj(raw.wading)) errors.push('wading: must be an object');
    else check(errors, 'wading.maxDepthM', raw.wading.maxDepthM, 0, 3);
  }

  const un = raw.unlock;
  if (un !== undefined) {
    if (!isObj(un) || !UNLOCK_TYPES.includes(un.type)) errors.push(`unlock.type: one of ${UNLOCK_TYPES.join(', ')}`);
    else {
      if (un.type === 'pois' || un.type === 'chunks') check(errors, 'unlock.count', un.count, 1, 100000);
      if (un.type === 'poi' && !isId(un.poiId)) errors.push('unlock.poiId: required id');
      if (un.type === 'pois' && un.region !== undefined && !isId(un.region)) errors.push('unlock.region: bad id');
    }
  }
  if (raw.appearance !== undefined && !isObj(raw.appearance)) errors.push('appearance: must be an object');

  if (errors.length) return { ok: false, errors, vehicle: null };
  const v = deepClone(raw);
  v.schema = VEHICLE_SCHEMA;
  v.class = v.class || 'other';
  v.blurb = typeof v.blurb === 'string' ? v.blurb : '';
  v.unlock = v.unlock || { type: 'start' };
  v.wheels.trackRear = v.wheels.trackRear ?? v.wheels.trackFront;
  v.suspension.maxForceN = v.suspension.maxForceN ?? 200000;
  v.engine.efficiency = v.engine.efficiency ?? 0.9;
  v.drivetrain.frontTorqueSplit = v.drivetrain.frontTorqueSplit ?? (v.drivetrain.layout === 'FWD' ? 1 : v.drivetrain.layout === 'RWD' ? 0 : 0.5);
  v.tyres.sideGripScale = v.tyres.sideGripScale ?? 1;
  v.tyres.rollingResistanceScale = v.tyres.rollingResistanceScale ?? 1;
  v.tyres.surfaceGrip = v.tyres.surfaceGrip || {};
  v.aero = v.aero || { dragCoefficient: 0.45, frontalAreaM2: 3 };
  v.wading = v.wading || { maxDepthM: 0.6 };
  v.appearance = v.appearance || {};
  return { ok: true, errors: [], vehicle: v };
}

// ---- derived numbers ----------------------------------------------------------------------------
/** Peak engine torque (N·m) from the curve. */
export const peakTorqueNm = (v) => Math.max(...v.engine.torqueCurve.map((p) => p[1]));

/** Torque at an rpm by linear interpolation of the curve (clamped at the ends). */
export function torqueAtRpm(v, rpm) {
  const c = v.engine.torqueCurve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) { const [r0, t0] = c[i - 1], [r1, t1] = c[i]; return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0); }
  }
  return c[c.length - 1][1];
}

/** Peak tractive force at the wheels in first gear (N): peak torque × 1st ratio × final drive × efficiency / wheel radius. */
export const launchForceN = (v) => (peakTorqueNm(v) * v.engine.gearRatios[0] * v.engine.finalDrive * v.engine.efficiency) / v.wheels.radius;

/** Per-wheel braking force (N) at the tyre contact patch. */
export const brakeForceN = (v) => v.brakes.torqueNm / v.wheels.radius;

export const mpsToKmh = (m) => m * 3.6;
export const mpsToMph = (m) => m * 2.2369362921;

// ---- catalogue ----------------------------------------------------------------------------------
/**
 * createCatalogue(rawList, { strict }) -> { get, has, list, ids, size, errors }
 * Invalid entries are skipped and described in `errors` ({id, errors[]}); with strict:true the first invalid entry throws.
 */
export function createCatalogue(rawList, { strict = false } = {}) {
  const map = new Map();
  const errors = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const r = validateVehicle(raw);
    if (!r.ok) {
      const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : '(no id)';
      if (strict) throw new Error(`Invalid vehicle ${id}: ${r.errors.join('; ')}`);
      errors.push({ id, errors: r.errors });
    } else if (map.has(r.vehicle.id)) {
      const e = { id: r.vehicle.id, errors: ['duplicate id'] };
      if (strict) throw new Error(`Duplicate vehicle id ${r.vehicle.id}`);
      errors.push(e);
    } else map.set(r.vehicle.id, Object.freeze(r.vehicle));
  }
  return {
    get: (id) => map.get(id) || null,
    has: (id) => map.has(id),
    list: () => [...map.values()],
    ids: () => [...map.keys()],
    get size() { return map.size; },
    errors,
  };
}

// ---- adapter for the current physics prototype ----------------------------------------------------
/**
 * Flat spec in the shape drive/src/vehicle.js (SPEC_4X4) reads. That prototype's chassis axes are +X forward, +Z right,
 * so lateral/forward are remapped from the glTF convention here. Extra fields (centreOfMass, tyre scales, wade depth,
 * drag) are ignored by the prototype but are what SpaceX's createVehicle(world, stats) is expected to read.
 */
export function toDriveSpec(v) {
  const s = v.steering, w = v.wheels, su = v.suspension, e = v.engine;
  return {
    name: v.name,
    massKg: v.body.massKg,
    half: { x: v.body.size.length / 2, y: v.body.size.height / 2, z: v.body.size.width / 2 },
    wheelRadius: w.radius, wheelX: w.wheelbase / 2, wheelZ: w.trackFront / 2, wheelZRear: w.trackRear / 2, wheelY: w.hubY,
    restLength: su.restLength, travel: su.travel, stiffness: su.stiffness, compression: su.compression, relaxation: su.relaxation,
    maxSuspensionForce: su.maxForceN,
    maxSteer: rad(s.maxAngleDeg), highSpeedSteer: rad(s.highSpeedAngleDeg), steerRate: rad(s.rateDegPerS),
    engineN: launchForceN(v), topSpeed: e.topSpeedMps, reverseTop: e.reverseTopMps,
    brakeImpulse: brakeForceN(v) * PHYSICS_DT,
    handImpulse: (v.brakes.handbrakeTorqueNm / w.radius) * PHYSICS_DT,
    driveFront: v.drivetrain.frontTorqueSplit,
    // extras
    layout: v.drivetrain.layout,
    centreOfMass: { x: v.body.centreOfMass.z, y: v.body.centreOfMass.y, z: -v.body.centreOfMass.x || 0 },
    tyreGrip: v.tyres.gripScale, tyreSideGrip: v.tyres.sideGripScale, rollingScale: v.tyres.rollingResistanceScale,
    surfaceGrip: { ...v.tyres.surfaceGrip },
    wadeDepth: v.wading.maxDepthM,
    dragCoefficient: v.aero.dragCoefficient, frontalArea: v.aero.frontalAreaM2,
  };
}
