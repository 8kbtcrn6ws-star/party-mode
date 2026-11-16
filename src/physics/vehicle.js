// Raycast-vehicle physics on Rapier (DynamicRayCastVehicleController). SpaceX.
//
// Ported from Pixel's S1 prototype (drive/src/vehicle.js: chassis setup, speed-sensitive steering, brake-to-reverse
// logic, rolling resistance + sinkage, water drag and buoyancy, per-axle torque split, tuned numbers). Changes made here:
// no three.js dependency (own quaternion maths, runs headless), the catalogue-JSON stats + torque-curve gearbox,
// surface lookup passed in per step, real centre of mass, fixed-step safe, wading stall + safe respawn, hill hold,
// flip recovery, aero drag, correct wheel spin poses, interpolated pose().
//
// Frames (glTF convention, matches Forma's model and architecture.md): chassis local +Z forward, +Y up, +X LEFT
// (right = -X). pose().quaternion applies directly to the shipped glb (modelForward "+Z", no visual offset);
// stats.appearance.modelForward = "+X" adds a -90 deg yaw offset in visualQuaternion for a +X-facing glb.
// Spawn/reset heading = yaw about +Y: forward = (sin h, 0, cos h)  (same as Forma's world.json spawns' yawRad).
// NOTE: this differs from Pixel's prototype (+X forward, heading = (cos h, sin h)).
// Units: metres, kg, newtons, seconds, radians.
//
// Public API (Parrot's contract):
//   const v = createVehicle(world, stats, spawn?)   // v.applyInput(state) ; v.update(dt, surfaceAt) ; v.pose() ; v.wheelPoses() ; v.reset()
//   surfaceAt(x, z, y) -> 'dirt'|'mud'|...  (optionally with a .waterLevel property in metres)
// Prototype-style API kept: new Vehicle(RAPIER, world, spec, spawn); v.step(input, dt); v.forward(); v.speed(); v.telemetry().
import RAPIER from '@dimforge/rapier3d-compat';
import { SURFACES, surfaceBaseMu } from './surfaces.js';
import { toSpec, PHYSICS_DEFAULTS } from './stats.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// --- tiny quaternion helpers (x,y,z,w) ---
const qMul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qAxis = (x, y, z, ang) => { const s = Math.sin(ang / 2); return { x: x * s, y: y * s, z: z * s, w: Math.cos(ang / 2) }; };
const qRot = (q, x, y, z) => { // rotate vector by quaternion
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + (q.y * tz - q.z * ty), y: y + q.w * ty + (q.z * tx - q.x * tz), z: z + q.w * tz + (q.x * ty - q.y * tx) };
};
const qSlerp = (a, b, t) => {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (d > 0.9995) { s0 = 1 - t; s1 = t; } else { const th = Math.acos(d), sn = Math.sin(th); s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn; }
  const q = { x: a.x * s0 + bx * s1, y: a.y * s0 + by * s1, z: a.z * s0 + bz * s1, w: a.w * s0 + bw * s1 };
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1; q.x /= n; q.y /= n; q.z /= n; q.w /= n; return q;
};
const Q_IDENTITY = { x: 0, y: 0, z: 0, w: 1 };                 // glb faces +Z (shipped): no offset
const Q_MODEL_X = qAxis(0, 1, 0, -Math.PI / 2);              // glb faces +X: body quaternion * Q_MODEL_X (maps model +X onto physics +Z)
const STEER_SIGN = 1;                                          // Rapier wheel steering angle per +yaw about +Y (verified by tests: right input turns toward -X)

let defaultLookup = null; // set by setDefaultSurfaceLookup for step(input, dt) compatibility
/** For the prototype-style `step(input, dt)`: the lookup used when none is passed. */
export function setDefaultSurfaceLookup(fn) { defaultLookup = fn; }

export class Vehicle {
  /**
   * new Vehicle(world, stats, spawn?, options?)  or prototype style  new Vehicle(RAPIER, world, stats, spawn)
   * spawn: {x, z, y?, heading?} (heading = yaw about +Y, forward = (sin h, cos h)).
   */
  constructor(a, b, c, d, e) {
    let world, stats, spawn, opts, R = RAPIER;
    if (a && a.RigidBodyDesc) { R = a; world = b; stats = c; spawn = d; opts = e; } else { world = a; stats = b; spawn = c; opts = d; }
    spawn = spawn || { x: 0, z: 0, heading: 0, y: 3 };
    this.R = R; this.world = world;
    this.spec = toSpec(stats); this.stats = stats;
    const s = this.spec, P = (this.P = { ...PHYSICS_DEFAULTS, ...(s.physics || {}), ...(opts || {}) });
    this.mu0 = surfaceBaseMu() * s.tyreGrip;

    const h = s.half, m = s.massKg, com = s.centreOfMass;
    this.body = world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y ?? 3, spawn.z).setCanSleep(false).setLinearDamping(P.linearDamping).setAngularDamping(P.angularDamping));
    // Collider carries no mass; mass, true centre of mass and box inertia are set explicitly.
    this.collider = world.createCollider(R.ColliderDesc.cuboid(h.z, h.y, h.x).setDensity(0).setFriction(0.4).setRestitution(0.05), this.body);
    const L = 2 * h.x, H = 2 * h.y, B = 2 * h.z; // length (Z), height (Y), width (X); h.x is the half length
    this.body.setAdditionalMassProperties(m, { x: com.x, y: com.y, z: com.z },
      { x: (m / 12) * (H * H + L * L), y: (m / 12) * (L * L + B * B), z: (m / 12) * (B * B + H * H) }, { x: 0, y: 0, z: 0, w: 1 }, true); // principal inertia: pitch about X, yaw about Y, roll about Z
    this.setHeading(spawn.heading || 0);

    this.ctrl = world.createVehicleController(this.body);
    const zr = s.wheelZRear ?? s.wheelZ;
    // 0 front-left, 1 front-right, 2 rear-left, 3 rear-right (left = +X, front = +Z)
    // wheelX = half wheelbase (along Z), wheelZ = half track (along X; left = +X)
    this.wheelLocal = (s.wheelPos
      ? s.wheelPos.map((p) => ({ x: p.x, y: s.wheelY, z: p.z })) // from the model descriptor, already physics frame
      : [[s.wheelZ, s.wheelX], [-s.wheelZ, s.wheelX], [zr, -s.wheelX], [-zr, -s.wheelX]].map(([x, z]) => ({ x, y: s.wheelY, z })));
    if (!['+Z', '+X'].includes(s.modelForward)) throw new Error('modelForward must be "+Z" or "+X"');
    this.qModel = s.modelForward === '+X' ? Q_MODEL_X : Q_IDENTITY;
    for (const p of this.wheelLocal) this.ctrl.addWheel(p, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, s.restLength, s.wheelRadius); // axle -X: axle x suspension dir = +Z drive
    this.ctrl.indexUpAxis = 1; this.ctrl.setIndexForwardAxis = 2;
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, s.stiffness);
      this.ctrl.setWheelSuspensionCompression(i, s.compression);
      this.ctrl.setWheelSuspensionRelaxation(i, s.relaxation);
      this.ctrl.setWheelMaxSuspensionTravel(i, s.travel);
      this.ctrl.setWheelMaxSuspensionForce(i, s.maxSuspensionForce ?? 200000);
    }
    this.mass = s.massKg; // body.mass() is only valid after the first world step
    this.input = { steer: 0, throttle: 0, brake: 0, rev: false, hand: false };
    this.surfaceAt = opts?.surfaceAt || null;
    this._resetState();
    this.driverEye = { ...s.driverEye }; this.modelOffset = { ...s.modelOffset };
    this.prev = this._snapshot(); this.curr = this._snapshot();
    this.events = []; this.onEvent = opts?.onEvent || null;
    this.lastSafe = { x: spawn.x, y: spawn.y ?? 3, z: spawn.z, heading: spawn.heading || 0 }; this._safeT = 0;
  }

  _resetState() {
    this.steer = 0; this.reverse = false;
    this.gear = 1; this.shiftT = 0; this.sinceShift = 1; this.rpm = this.spec.engine?.idleRpm ?? 900;
    this.surfaces = ['grass', 'grass', 'grass', 'grass'];
    this.inWater = 0; this.wadeDepth = 0; this.floodT = 0; this.stalled = false; this.stallT = 0;
    this.flipT = 0; this.flipped = false;
    this.spin = [0, 0, 0, 0]; this.spinRate = [0, 0, 0, 0]; this.sinkM = [0, 0, 0, 0];
    this.slip = [0, 0, 0, 0]; this.drive = 0; this.brakeApplied = 0; this.lastDriveWheel = 0;
  }

  setHeading(a) { // yaw about +Y: forward (+Z) points along (sin a, cos a) in XZ
    const q = qAxis(0, 1, 0, a); this.body.setRotation(q, true);
  }
  _quat() { const r = this.body.rotation(); return { x: r.x, y: r.y, z: r.z, w: r.w }; }
  forward(out) { const f = qRot(this._quat(), 0, 0, 1); if (out) { out.x = f.x; out.y = f.y; out.z = f.z; return out; } return f; }
  upVec() { return qRot(this._quat(), 0, 1, 0); }
  speed() { const v = this.body.linvel(), f = this.forward(); return v.x * f.x + v.y * f.y + v.z * f.z; } // signed m/s

  /** Latest input. Accepts {steer,throttle,brake,rev|reverse,hand|handbrake}; extra fields (horn, cam, look, reset) are ignored. */
  applyInput(st) {
    const i = this.input;
    i.steer = clamp(+st.steer || 0, -1, 1); i.throttle = clamp(+st.throttle || 0, 0, 1); i.brake = clamp(+st.brake || 0, 0, 1);
    i.rev = !!(st.rev ?? st.reverse); i.hand = !!(st.hand ?? st.handbrake);
    if (st.reset) this.reset();
  }
  /** Prototype-compatible: apply input then one update with the default/assigned surface lookup. */
  step(input, dt, surfaceAt) { this.applyInput(input); this.update(dt, surfaceAt); }

  /** Streaming safety net: freeze the car (gravity off, zero velocity, no suspension update) until its ground is ready. */
  hold(on) {
    if (on === !!this.held) return;
    const b = this.body;
    if (on) { this.heldVel = { lin: { ...b.linvel() }, ang: { ...b.angvel() } }; b.setGravityScale(0, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true); this.held = true; this.holdCount = (this.holdCount || 0) + 1; this._emit('held'); }
    else { b.setGravityScale(1, true); b.setLinvel(this.heldVel.lin, true); b.setAngvel(this.heldVel.ang, true); this.held = false; this.heldVel = null; this._emit('released'); }
  }
  /** One fixed step while held: keep still, keep the interpolation snapshots current. */
  holdStep() {
    const b = this.body; b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.heldSteps = (this.heldSteps || 0) + 1; this.prev = this.curr; this.curr = this._snapshot();
  }

  _engineForce(thr, v) { // total tractive force (N) at the wheels, +forward; also updates rpm/gear
    const s = this.spec, e = s.engine, P = this.P;
    if (!e) { return thr * s.engineN * Math.max(0, 1 - Math.pow(Math.max(0, v) / s.topSpeed, 2)); } // legacy simple model
    const R = s.wheelRadius, ratios = e.gearRatios, fd = e.finalDrive, eff = e.efficiency ?? 0.9;
    const tq = (rpm) => { const c = e.torqueCurve; if (rpm <= c[0][0]) return c[0][1]; for (let i = 1; i < c.length; i++) if (rpm <= c[i][0]) { const [r0, t0] = c[i - 1], [r1, t1] = c[i]; return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0); } return c[c.length - 1][1]; };
    const av = Math.max(0, v);
    let rpm = (av / R) * ratios[this.gear - 1] * fd * 60 / (2 * Math.PI);
    // automatic gearbox
    if (this.shiftT <= 0 && this.sinceShift > P.minShiftGapS) {
      if (this.gear < ratios.length && rpm > e.redlineRpm * P.upshiftRpmFrac) { this.gear++; this.shiftT = P.shiftTimeS; this.sinceShift = 0; this._emit('shift', this.gear); }
      else if (this.gear > 1 && rpm < (thr > 0.85 ? P.downshiftRpm * 1.4 : P.downshiftRpm)) { this.gear--; this.shiftT = P.shiftTimeS * 0.6; this.sinceShift = 0; this._emit('shift', this.gear); }
      rpm = (av / R) * ratios[this.gear - 1] * fd * 60 / (2 * Math.PI);
    }
    const slipRpm = Math.max(rpm, Math.min(P.launchRpm, e.redlineRpm)); // clutch slip at low speed
    this.rpm = Math.max(e.idleRpm, rpm);
    if (this.shiftT > 0) return 0;
    if (rpm >= e.redlineRpm) return 0; // rev limiter
    const F = (thr * tq(slipRpm) * ratios[this.gear - 1] * fd * eff) / R;
    return F * Math.max(0, 1 - Math.pow(av / s.topSpeed, 2));
  }
  _reverseForce(pedal, v) {
    const s = this.spec, e = s.engine, absV = Math.abs(v);
    const fade = Math.max(0, 1 - absV / s.reverseTop);
    if (!e) return -pedal * s.engineN * 0.7 * fade;
    const peak = Math.max(...e.torqueCurve.map((p) => p[1]));
    this.rpm = Math.max(e.idleRpm, Math.min(e.redlineRpm, (absV / s.wheelRadius) * e.reverseRatio * e.finalDrive * 60 / (2 * Math.PI)));
    return -(pedal * peak * 0.85 * e.reverseRatio * e.finalDrive * (e.efficiency ?? 0.9)) / s.wheelRadius * fade;
  }
  _emit(type, data) { const ev = { type, data, t: this.simTime || 0 }; this.events.push(ev); if (this.events.length > 64) this.events.shift(); if (this.onEvent) this.onEvent(ev); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  _snapshot() { const t = this.body.translation(), r = this.body.rotation(); return { p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w }, steer: this.steer, spin: [...this.spin] }; }

  update(dt, surfaceAt) {
    surfaceAt = surfaceAt || this.surfaceAt || defaultLookup || (() => 'dirt');
    const s = this.spec, c = this.ctrl, P = this.P, inp = this.input;
    this.simTime = (this.simTime || 0) + dt;
    this.prev = this.curr;
    const q = this._quat(), fwd = qRot(q, 0, 0, 1), upv = qRot(q, 0, 1, 0);
    const lv = this.body.linvel(), av = this.body.angvel();
    const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z, absV = Math.abs(v);
    const waterY = surfaceAt.waterLevel ?? -Infinity, waterAt = surfaceAt.waterAt; // waterAt(x,z): per-point water surface height (sloping rivers); else the constant waterLevel
    this.sinceShift += dt; if (this.shiftT > 0) this.shiftT -= dt;

    // speed-sensitive, rate-limited steering
    const lock = lerp(s.maxSteer, s.highSpeedSteer, Math.min(1, absV / P.highSpeedSteerMs));
    const target = -inp.steer * lock;
    const rate = (Math.abs(target) < Math.abs(this.steer) ? s.steerRate * P.steerReturnScale : s.steerRate) * dt;
    this.steer += clamp(target - this.steer, -rate, rate);
    c.setWheelSteering(0, STEER_SIGN * this.steer); c.setWheelSteering(1, STEER_SIGN * this.steer); // this.steer = wheel yaw about +Y (negative = right)

    // pedals -> gear direction (explicit reverse, or hold brake nearly stopped)
    const thr = inp.throttle, brk = inp.brake, bI = s.brakeImpulse / DT_REF * dt, hI = s.handImpulse / DT_REF * dt;
    if (inp.rev) this.reverse = true;
    else if (thr > 0.05 && v > -1) this.reverse = false;
    else if (brk > 0.3 && absV < P.reverseEngageMps && !thr) this.reverse = true; // brake pedal on a (nearly) stopped car selects reverse
    let drive = 0, brake = 0;
    if (this.reverse) {
      const pedal = inp.rev ? Math.max(0.6, thr) : brk;
      if (v > P.reverseEngageMps) brake = Math.max(brk, 0.5) * bI; // still rolling forward (e.g. down a slope): keep braking until it is really stopped
      else if (!inp.rev && thr > 0.05 && v < -1) brake = Math.max(thr, 0.5) * bI; // throttle while rolling backwards: brake first, then go forward
      else drive = this._reverseForce(pedal, v);
    } else { drive = this._engineForce(thr, v); brake = brk * bI; }
    // hill hold / parking: gentle brake when stopped with no pedal, so the car does not creep down slopes
    if (!thr && !brk && !inp.rev && !inp.hand) {
      let hold = 1 - smooth01((absV - 0.6) / 1.4);
      // rolling the wrong way for the selected gear (e.g. sliding back down a slope in a forward gear): hold harder, up to ~10 m/s
      const wrongWay = (!this.reverse && v < -0.5) || (this.reverse && v > 0.5);
      if (wrongWay) hold = Math.max(hold, 1 - smooth01((absV - 4) / 6));
      brake += (wrongWay ? 1 : P.parkHoldFraction) * hold * bI;
    }
    // engine braking: lifting off with no pedals slows the car (gear drag), so long descents do not run away
    if (!thr && !brk && !inp.rev && !inp.hand && P.engineBrake > 0 && !this.stalled) {
      brake += P.engineBrake * (0.5 + 0.5 * Math.min(1, absV / s.topSpeed)) * smooth01((absV - 1.0) / 1.0) * bI;
    }
    if (this.stalled) drive = 0;
    this.drive = drive;

    // per-wheel surface, grip, drive, brakes
    let rollN = 0, sinkSum = 0, inContact = 0, wadeMax = 0, wadeSum = 0, wadeN = 0, driveEff = 0;
    const slowF = 1 - smooth01((absV - 3) / 9) * 0.65; // sand sinks mostly when slow
    for (let i = 0; i < 4; i++) {
      const p = c.wheelContactPoint(i), contact = c.wheelIsInContact(i);
      let key = this.forceSurface;
      if (!key) key = contact && p ? surfaceAt(p.x, p.z, p.y + 0.02) : this.surfaces[i];
      if (!SURFACES[key]) key = 'dirt';
      this.surfaces[i] = key;
      const sf = SURFACES[key];
      const mu = this.mu0 * sf.grip * (s.surfaceGrip[key] ?? 1);
      c.setWheelFrictionSlip(i, mu);
      const hand = i >= 2 && inp.hand;
      c.setWheelSideFrictionStiffness(i, sf.side * s.tyreSideGrip * (hand ? P.handbrakeSideScale : 1));
      const sink = sf.sink * (sf.sinkSlowOnly ? slowF : 1);
      const bias = this.spec.driveFront; const share = (i < 2 ? bias : 1 - bias) / 2;
      // Rapier lets the tyre transmit roughly 2x mu*N longitudinally, so cap the drive force at the nominal friction circle here:
      // that is what makes low-grip surfaces (snow, ice, mud) visibly weaker at launching and climbing.
      const N = contact ? (c.wheelSuspensionForce(i) || this.mass * 9.81 / 4) : 0;
      const want = drive * share * (1 - sink * 2), cap = P.tractionScale * mu * N;
      c.setWheelEngineForce(i, clamp(want, -cap, cap)); driveEff += clamp(want, -cap, cap);
      c.setWheelBrake(i, brake + (hand ? hI : 0));
      this.sinkM[i] += (sink * 0.5 * (contact ? 1 : 0) - this.sinkM[i]) * Math.min(1, dt * 6);
      if (contact) {
        inContact++; rollN += sf.roll * (this.mass / 1000) / 4 * s.rollingScale; sinkSum += sink;
        if (key === 'water' && p) { const d = Math.max(0, (waterAt ? waterAt(p.x, p.z) : waterY) - p.y); if (d > wadeMax) wadeMax = d; wadeSum += d; wadeN++; }
      }
    }

    // rolling resistance + sinkage drag (Pixel's tuned law), plus aero
    const hv = Math.hypot(lv.x, lv.z);
    if (hv > 0.05) {
      let f = 0;
      if (rollN > 0) f += rollN * Math.min(hv, 6) / 6 + rollN * hv * 0.04 * (1 + sinkSum * 10);
      f += 0.5 * P.rho * s.dragCoefficient * s.frontalArea * hv * hv;
      f = Math.min(f, this.mass * hv / dt * 0.5);
      this.body.applyImpulse({ x: -lv.x / hv * f * dt, y: 0, z: -lv.z / hv * f * dt }, true);
    }

    // water: drag + buoyancy by how deep the chassis sits; wading stall past the fording depth
    const t = this.body.translation();
    const wet = this.surfaces.includes('water'); // only where the surface map says water (low ground elsewhere is not a lake)
    const depth = wet ? clamp((waterAt ? waterAt(t.x, t.z) : waterY) - (t.y - s.half.y - 0.2), 0, P.waterDepthMax) : 0;
    this.inWater = depth; this.wadeDepth = wadeMax;
    if (depth > 0) {
      const k = P.waterDragK * depth;
      // linear (Pixel's tuned law) + bow-wave drag that grows with speed^2 and wheel wading depth
      const kq = P.waterQuadK * (wadeN ? wadeSum / wadeN : 0) * hv;
      this.body.applyImpulse({ x: -lv.x * (k + kq) * dt, y: (this.mass * 9.81 * P.waterBuoyancy * depth - lv.y * k * 0.5) * dt, z: -lv.z * (k + kq) * dt }, true);
    }
    if (wadeMax > s.wadeDepth + P.wadeToleranceM) this.floodT += dt; else this.floodT = Math.max(0, this.floodT - dt);
    if (!this.stalled && this.floodT > P.stallAfterS) { this.stalled = true; this.stallT = 0; this._emit('stalled', wadeMax); }
    if (this.stalled) {
      this.stallT += dt;
      if (this.stallT > P.stallRespawnS) this.resetToSafe();
      else if (wadeMax < s.wadeDepth * 0.5 && this.stallT > 1) { this.stalled = false; this._emit('restarted'); }
    }

    // slip estimate before the step uses last step's solved impulses
    for (let i = 0; i < 4; i++) {
      const N = c.wheelSuspensionForce(i) || 0, mu = c.wheelFrictionSlip(i) || 1;
      const fx = c.wheelForwardImpulse(i) || 0, fy = c.wheelSideImpulse(i) || 0;
      this.slip[i] = N > 1 ? Math.min(2, Math.hypot(fx, fy) / (mu * N * dt)) : 0;
    }

    // static park hold: with the handbrake, or no pedals, a (nearly) stopped car is pinned to the ground the way static friction would:
    // cancel the velocity along the ground plane and the gravity component pulling it down the slope, up to holdMuScale * mu * N.
    // Without this the raycast-vehicle brake creeps (~6 cm/s on a 7 deg slope). Past the friction limit (tan(slope) > mu) the car slides.
    this.parkHolding = false; let holdActive = false;
    // The same hold also keeps the car from sliding back while the driver is on the throttle but the tyres cannot pull it up the slope (hill start).
    const baseWant = inp.hand || (!thr && !brk && !inp.rev), thrustWant = !inp.hand && (thr > 0.05 || inp.rev) && absV < 1.0;
    if (P.staticHold && !this.held && (baseWant || thrustWant)) {
      const fade = 1 - smooth01((absV - 0.5) / 1.0);
      if (fade > 0) {
        let nx = 0, ny = 0, nz = 0, Ns = 0, muN = 0, nc = 0;
        for (let i = 0; i < 4; i++) {
          if (!c.wheelIsInContact(i)) continue;
          const N = c.wheelSuspensionForce(i) || 0, nn = c.wheelContactNormal(i); if (!nn) continue;
          nx += nn.x * N; ny += nn.y * N; nz += nn.z * N; Ns += N; muN += (c.wheelFrictionSlip(i) || 0) * N; nc++;
        }
        const nl = Math.hypot(nx, ny, nz);
        if (nc >= 2 && Ns > 1 && nl > 1e-6) {
          nx /= nl; ny /= nl; nz /= nl;
          const g = 9.81, lvx = lv.x, lvy = lv.y, lvz = lv.z, vn = lvx * nx + lvy * ny + lvz * nz, gn = -g * ny; // g = (0,-g,0)
          const tx = lvx - vn * nx, ty = lvy - vn * ny, tz = lvz - vn * nz; // velocity along the ground plane
          const gx = -gn * nx, gy = -g - gn * ny, gz = -gn * nz;             // gravity component along the ground plane
          // anchor spring: the solver leaks ~3 cm/s of creep per step, so pull the car back to where it stopped (time constant holdAnchorS)
          const tp = this.body.translation(); if (!this.holdAnchor) this.holdAnchor = { x: tp.x, y: tp.y, z: tp.z };
          let ex = tp.x - this.holdAnchor.x, ey = tp.y - this.holdAnchor.y, ez = tp.z - this.holdAnchor.z; const en = ex * nx + ey * ny + ez * nz; ex -= en * nx; ey -= en * ny; ez -= en * nz;
          const el = Math.hypot(ex, ey, ez), ek = el > 0 ? Math.min(P.holdAnchorMaxMps, el / P.holdAnchorS) / el : 0;
          const m = this.mass;
          let engaged = true;
          if (!baseWant) { // throttle held: hold only while the drive force cannot beat gravity along the heading (net force would push the car backwards)
            const dir = this.reverse ? -1 : 1, net = driveEff + m * (gx * fwd.x + gy * fwd.y + gz * fwd.z);
            engaged = dir * net < 0.02 * m * g;
          }
          if (!engaged) { /* the car is pulling away */ } else {
          const cap = P.holdMuScale * (inp.hand ? 1 : P.autoHoldFraction) * (muN / Ns) * Ns * dt; // max friction impulse this step
          const jgx = m * gx * dt, jgy = m * gy * dt, jgz = m * gz * dt, jg = Math.hypot(jgx, jgy, jgz);         // impulse that cancels gravity along the ground
          const jvx = m * (tx + ex * ek), jvy = m * (ty + ey * ek), jvz = m * (tz + ez * ek), jv = Math.hypot(jvx, jvy, jvz);
          let jx, jy, jz;
          if (jg <= cap) { // static: friction can carry the weight component -> pin the car (the velocity part is limited to what is left of the friction budget unless it is tiny)
            const snap = m * P.holdSnapMps, room = Math.max(cap - jg, 0.05 * cap), kv = jv <= snap ? 1 : Math.min(1, room / jv);
            jx = -(jvx * kv + jgx); jy = -(jvy * kv + jgy); jz = -(jvz * kv + jgz); holdActive = kv === 1;
          } else { // steeper than the tyres can hold: kinetic friction opposes the motion (or the slope direction when stationary)
            const dl = jv > 1e-6 ? jv : jg, dx = (jv > 1e-6 ? jvx : jgx) / dl, dy = (jv > 1e-6 ? jvy : jgy) / dl, dz = (jv > 1e-6 ? jvz : jgz) / dl;
            jx = -dx * cap; jy = -dy * cap; jz = -dz * cap;
          }
          this.body.applyImpulse({ x: jx * fade, y: jy * fade, z: jz * fade }, true);
          this.parkHolding = holdActive;
          }
        }
      }
    }

    if (!holdActive) this.holdAnchor = null;
    c.updateVehicle(dt);

    // wheel spin from hub ground speed along each wheel's heading (positive = rolling forward)
    const q2 = this._quat(), w2 = this.body.angvel(), lv2 = this.body.linvel();
    for (let i = 0; i < 4; i++) {
      const lp = this.wheelLocal[i], r = qRot(q2, lp.x, lp.y - (c.wheelSuspensionLength(i) ?? s.restLength) - 0 + 0, lp.z);
      const hub = { x: lv2.x + (w2.y * r.z - w2.z * r.y), y: 0, z: lv2.z + (w2.z * r.x - w2.x * r.z) };
      const st = i < 2 ? this.steer : 0; // wheel yaw about +Y; heading in chassis frame = (sin st, 0, cos st)
      const wf = qRot(q2, Math.sin(st), 0, Math.cos(st));
      const vr = hub.x * wf.x + hub.z * wf.z;
      const rate = c.wheelIsInContact(i) ? vr / s.wheelRadius : this.spinRate[i] * Math.max(0, 1 - dt * 0.8);
      this.spinRate[i] = rate; this.spin[i] += rate * dt;
    }

    // flip + safe-spot tracking
    const t2 = this.body.translation(), up2 = qRot(q2, 0, 1, 0);
    this.upY = up2.y;
    this.flipped = up2.y < P.flipUpY;
    if (this.flipped && Math.hypot(lv2.x, lv2.y, lv2.z) < 1) { this.flipT += dt; if (this.flipT > P.flipResetS) { this._emit('flip-reset'); this.reset(); } } else this.flipT = 0;
    this._safeT += dt;
    if (this._safeT > 0.5) {
      this._safeT = 0;
      const wet = this.surfaces.includes('water');
      if (inContact === 4 && !wet && up2.y > 0.8 && !this.stalled) {
        const f = qRot(q2, 0, 0, 1); this.lastSafe = { x: t2.x, y: t2.y, z: t2.z, heading: Math.atan2(f.x, f.z) };
      }
    }
    this.curr = this._snapshot();
  }

  /** Right the car and drop it back (prototype semantics: spawn = {x,z,y,heading}; y is raised 2 m). No spawn: in place, keeping heading. */
  reset(spawn) {
    const t = spawn || this.body.translation();
    const f = this.forward();
    this.body.setTranslation({ x: t.x, y: (spawn ? spawn.y ?? 0 : t.y) + 2, z: t.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true); this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.setHeading(spawn && spawn.heading !== undefined ? spawn.heading : Math.atan2(f.x, f.z));
    const sp = this.spin; this._resetState(); this.spin = sp;
    this.prev = this.curr = this._snapshot();
    this._emit('reset');
  }
  /** Back to the last place all four wheels were on dry ground. */
  resetToSafe() { const s = this.lastSafe; this.reset({ x: s.x, z: s.z, y: s.y - 2 + 0.3, heading: s.heading }); this._emit('respawned', s); }

  /** Chassis pose, interpolated between the last two fixed steps (alpha 0..1; default latest). */
  pose(alpha = 1) {
    const a = this.prev, b = this.curr, t = clamp(alpha, 0, 1);
    const position = { x: lerp(a.p.x, b.p.x, t), y: lerp(a.p.y, b.p.y, t), z: lerp(a.p.z, b.p.z, t) };
    const quaternion = qSlerp(a.q, b.q, t);
    const lv = this.body.linvel(), f = qRot(quaternion, 0, 0, 1), e = this.driverEye, ew = qRot(quaternion, e.x, e.y, e.z);
    return {
      position, quaternion, visualQuaternion: qMul(quaternion, this.qModel),
      forward: f, up: qRot(quaternion, 0, 1, 0), right: qRot(quaternion, -1, 0, 0), left: qRot(quaternion, 1, 0, 0),
      velocity: { x: lv.x, y: lv.y, z: lv.z }, speed: lv.x * f.x + lv.y * f.y + lv.z * f.z,
      modelPosition: (() => { const o = qRot(quaternion, this.modelOffset.x, this.modelOffset.y, this.modelOffset.z); return { x: position.x + o.x, y: position.y + o.y, z: position.z + o.z }; })(),
      driverEye: { ...e }, driverEyeWorld: { x: position.x + ew.x, y: position.y + ew.y, z: position.z + ew.z },
    };
  }

  /** Four wheel poses (FL, FR, RL, RR): world hub position, orientation (steer + spin), suspension, contact, surface. */
  wheelPoses(alpha = 1) {
    const a = this.prev, b = this.curr, t = clamp(alpha, 0, 1), c = this.ctrl, s = this.spec;
    const q = qSlerp(a.q, b.q, t), p = { x: lerp(a.p.x, b.p.x, t), y: lerp(a.p.y, b.p.y, t), z: lerp(a.p.z, b.p.z, t) };
    const out = [];
    for (let i = 0; i < 4; i++) {
      const lp = this.wheelLocal[i], len = c.wheelSuspensionLength(i) ?? s.restLength;
      const local = { x: lp.x, y: lp.y - len, z: lp.z };
      const w = qRot(q, local.x, local.y, local.z);
      const steer = i < 2 ? lerp(a.steer, b.steer, t) : 0, spin = lerp(a.spin[i], b.spin[i], t);
      const quaternion = qMul(qMul(q, qAxis(0, 1, 0, steer)), qAxis(1, 0, 0, spin)); // rolling forward (+Z) = positive rotation about the +X axle (Forma: spin about local X)
      out.push({
        index: i, position: { x: p.x + w.x, y: p.y + w.y, z: p.z + w.z }, local, quaternion, visualQuaternion: qMul(quaternion, this.qModel),
        steer, spin, suspensionLength: len, compression: s.restLength - len, contact: c.wheelIsInContact(i), surface: this.surfaces[i],
        sinkM: this.sinkM[i], slip: this.slip[i], radius: s.wheelRadius,
      });
    }
    return out;
  }

  telemetry() {
    const c = this.ctrl, lv = this.body.linvel(), f = this.forward();
    const rt = qRot(this._quat(), -1, 0, 0); // right = -X local
    const vl = lv.x * f.x + lv.y * f.y + lv.z * f.z, vlat = lv.x * rt.x + lv.z * rt.z; // lateral velocity toward the right
    return {
      speed: vl, reverse: this.reverse, steer: this.steer, inWater: this.inWater, wadeDepth: this.wadeDepth,
      rpm: this.rpm, gear: this.reverse ? -1 : this.gear, stalled: this.stalled, flipped: this.flipped,
      surfaces: [...this.surfaces],
      contact: [0, 1, 2, 3].map((i) => c.wheelIsInContact(i)),
      susp: [0, 1, 2, 3].map((i) => c.wheelSuspensionLength(i)),
      suspForce: [0, 1, 2, 3].map((i) => c.wheelSuspensionForce(i) || 0),
      slip: [...this.slip], sinkM: [...this.sinkM],
      sideSlipDeg: (Math.atan2(vlat, Math.max(Math.abs(vl), 0.5)) * 180) / Math.PI,
      upright: this.upY ?? this.upVec().y, driveForce: this.drive,
    };
  }
}
const DT_REF = 1 / 60; // tuned brake impulses are per 1/60 s step

/** Parrot's contract: createVehicle(world, stats, spawn?) -> vehicle with applyInput/update/pose/wheelPoses/reset. */
export function createVehicle(world, stats, spawn, options) { return new Vehicle(world, stats, spawn, options); }
