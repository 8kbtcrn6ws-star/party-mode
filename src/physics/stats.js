// Normalises a vehicle stats object into the flat internal spec the vehicle model reads.
// Accepts two shapes:
//  1. Catalogue JSON (game/vehicles/<id>.json, schema in src/data/vehicles.js): glTF frame (+Z forward, +X left),
//     degrees, torque curve + gear ratios. This is what the game ships.
//  2. Flat spec as used by Pixel's drive/ prototype (SPEC_4X4: half, wheelX, wheelZ, engineN, brakeImpulse...).
//     Chassis frame +Z forward, +Y up, +X left (glTF). Uses the simple engine model unless an `engine` section is present.
// Internal frame (glTF): +Z forward, +Y up, +X left. In this spec `half.x` is the HALF LENGTH, `half.z` the half width,
// `wheelX` the half wheelbase and `wheelZ` the half track (names kept from Pixel's prototype). Units: m, kg, N, s, radians.
const rad = (d) => (d * Math.PI) / 180;
const DT = 1 / 60;

export function toSpec(s) {
  if (!s || typeof s !== 'object') throw new Error('createVehicle: stats object required');
  if (s.body && s.wheels) return fromCatalogue(s);
  return fromFlat(s);
}

function fromCatalogue(v) {
  const w = v.wheels, su = v.suspension, st = v.steering, e = v.engine, t = v.tyres || {}, ap = v.appearance || {};
  const eye = ap.driverEye || { x: 0.4, y: v.body.size.height / 2 + 0.55, z: -0.1 }; // physics (= glTF) frame, relative to the body origin
  const com = v.body.centreOfMass || { x: 0, y: -0.35, z: 0 };
  return {
    id: v.id, name: v.name,
    massKg: v.body.massKg,
    half: { x: v.body.size.length / 2, y: v.body.size.height / 2, z: v.body.size.width / 2 },
    wheelRadius: w.radius, wheelX: w.wheelbase / 2, wheelZ: w.trackFront / 2, wheelZRear: (w.trackRear ?? w.trackFront) / 2, wheelY: w.hubY,
    restLength: su.restLength, travel: su.travel, stiffness: su.stiffness, compression: su.compression, relaxation: su.relaxation,
    maxSuspensionForce: su.maxForceN ?? 200000,
    maxSteer: rad(st.maxAngleDeg), highSpeedSteer: rad(st.highSpeedAngleDeg), steerRate: rad(st.rateDegPerS),
    engine: {
      torqueCurve: e.torqueCurve, gearRatios: e.gearRatios, finalDrive: e.finalDrive, efficiency: e.efficiency ?? 0.9,
      idleRpm: e.idleRpm, redlineRpm: e.redlineRpm, reverseRatio: e.reverseRatio,
    },
    // engine.topSpeedMps = MEASURED flat-dirt top speed (reporting/UI, scaled by customisation topSpeedMult).
    // The force taper 1-(v/topSpeed)^2 uses topSpeedMps * taperSpeedRatio, so changing the reported value never changes handling unless the ratio is changed too.
    topSpeed: e.topSpeedMps * (e.taperSpeedRatio ?? 1), reportedTopSpeed: e.topSpeedMps, reverseTop: e.reverseTopMps,
    brakeImpulse: (v.brakes.torqueNm / w.radius) * DT, handImpulse: ((v.brakes.handbrakeTorqueNm ?? 0) / w.radius) * DT,
    driveFront: v.drivetrain.frontTorqueSplit ?? (v.drivetrain.layout === 'FWD' ? 1 : v.drivetrain.layout === 'RWD' ? 0 : 0.5),
    layout: v.drivetrain.layout,
    centreOfMass: { x: com.x, y: com.y, z: com.z }, // catalogue frame = physics frame
    tyreGrip: t.gripScale ?? 1, tyreSideGrip: t.sideGripScale ?? 1, rollingScale: t.rollingResistanceScale ?? 1, surfaceGrip: { ...(t.surfaceGrip || {}) },
    wadeDepth: v.wading?.maxDepthM ?? 0.6,
    dragCoefficient: v.aero?.dragCoefficient ?? 0.45, frontalArea: v.aero?.frontalAreaM2 ?? 3,
    // appearance vectors are in the PHYSICS frame (+Z fwd, +Y up, +X left = glTF), relative to the body origin, whatever modelForward is
    driverEye: { ...eye },
    modelOffset: ap.modelOffset ? { ...ap.modelOffset } : { x: 0, y: 0, z: 0 }, // glb origin relative to body origin
    modelForward: ap.modelForward || '+Z', // facing of the glb: '+Z' (shipped) or '+X'; sets the visual yaw offset only
    wheelPos: Array.isArray(w.hubs) && w.hubs.length === 4 ? w.hubs.map((h) => ({ x: h.x, z: h.z })) : null,
    physics: { ...(v.physics || {}) },
  };
}

function fromFlat(f) {
  const s = {
    wheelZRear: f.wheelZ, maxSuspensionForce: 200000, centreOfMass: { x: 0, y: -0.35, z: 0 },
    tyreGrip: 1, tyreSideGrip: 1, rollingScale: 1, surfaceGrip: {}, wadeDepth: 0.9, dragCoefficient: 0.45, frontalArea: 3,
    driverEye: { x: 0.4, y: (f.half?.y ?? 0.45) + 0.55, z: 0.1 }, modelOffset: { x: 0, y: 0, z: 0 }, modelForward: '+Z', wheelPos: null, physics: {},
    ...f,
  };
  if (!s.engine && typeof s.engineN === 'number') s.engine = null; // simple model (legacy)
  return s;
}

/** Defaults for behaviour not in the catalogue schema; a vehicle JSON may override via its optional `physics` block. */
export const PHYSICS_DEFAULTS = {
  linearDamping: 0.05, angularDamping: 0.4,
  steerReturnScale: 1.6,        // wheel returns to centre this much faster than it turns away
  highSpeedSteerMs: 25,         // speed at which steering lock reaches highSpeedAngle
  parkHoldFraction: 0.35,       // fraction of brakeImpulse held when stopped with no input (hill hold)
  engineBrake: 0.12,            // coasting with no pedals: brake impulse fraction (about 0.07 g at low speed, 0.13 g near top speed)
  staticHold: true,             // park/hill hold: cancels creep when stopped with handbrake or no pedals, up to the tyre friction limit
  holdMuScale: 0.9,             // fraction of the tyres' friction (mu * normal load) the hold may use before the car slides
  holdSnapMps: 0.3, holdAnchorS: 0.15, holdAnchorMaxMps: 0.25, // anchor spring that cancels the solver's residual creep while held
  autoHoldFraction: 1,          // strength of the no-pedal hold relative to the handbrake hold
  handbrakeSideScale: 0.7,      // rear side-grip multiplier while the handbrake is held
  shiftTimeS: 0.22, minShiftGapS: 0.5, upshiftRpmFrac: 0.86, downshiftRpm: 1500, launchRpm: 1900,
  flipUpY: 0.2, flipResetS: 3,
  reverseEngageMps: 0.3,        // brake pedal below this speed selects reverse (above it, the pedal brakes)
  wadeToleranceM: 0.04,         // water depth over the tyre contact patch may exceed wading.maxDepthM by this much before the engine floods
  stallAfterS: 0.4, stallRespawnS: 2.5,
  waterDragK: 1600, waterQuadK: 190, waterBuoyancy: 0.18, waterDepthMax: 1.4,
  rho: 1.2,
  tractionScale: 1.0,           // drive force per wheel is capped at tractionScale * mu * normal load
};
