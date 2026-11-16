// Fixed-timestep driver: accumulator (physics 60 Hz independent of render rate), vehicle updates, and a
// small stats collector for the step time. The game's core/loop.js may use createFixedStepper directly.
import RAPIER from '@dimforge/rapier3d-compat';

export const PHYSICS_HZ = 60;

/** Load the Rapier WASM (call once). Resolves to the RAPIER namespace. */
export async function initPhysics() { await RAPIER.init(); return RAPIER; }

/** Accumulator. advance(frameDt, stepFn) calls stepFn(fixedDt) 0..maxSteps times; returns {steps, alpha}. */
export function createFixedStepper(hz = PHYSICS_HZ, maxSteps = 5) {
  const dt = 1 / hz; let acc = 0;
  return {
    dt, get alpha() { return acc / dt; },
    advance(frameDt, stepFn) {
      acc += Math.min(frameDt, dt * maxSteps); let steps = 0;
      while (acc >= dt - 1e-9 && steps < maxSteps) { stepFn(dt); acc -= dt; steps++; }
      if (acc < 0) acc = 0;
      return { steps, alpha: acc / dt };
    },
  };
}

/**
 * createPhysicsWorld({ gravity }) -> { world, add(vehicle), remove(vehicle), advance(frameDt, surfaceAt), alpha, stepMs }
 * Per fixed step: every vehicle.update(dt, surfaceAt), then world.step().
 */
export function createPhysicsWorld({ hz = PHYSICS_HZ, gravity = { x: 0, y: -9.81, z: 0 }, maxSteps = 5, ground = null, holdBaseM = 6, holdLookaheadS = 0.8 } = {}) {
  const world = new RAPIER.World(gravity); world.timestep = 1 / hz;
  const vehicles = new Set(), stepper = createFixedStepper(hz, maxSteps);
  const stepMs = []; const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const pw = {
    RAPIER, world, vehicles, stepper, stepMs, ground, holdBaseM, holdLookaheadS,
    add(v) { vehicles.add(v); return v; }, remove(v) { vehicles.delete(v); },
    get alpha() { return stepper.alpha; },
    /** Advance by a render frame. Returns number of fixed steps taken. */
    advance(frameDt, surfaceAt) {
      return stepper.advance(frameDt, (dt) => {
        const t0 = now();
        for (const v of vehicles) {
          // streaming safety net: a car whose ground (within holdBaseM + holdLookaheadS * speed) is not ready is frozen, then released unchanged
          const g = pw.ground;
          if (g) {
            const p = v.body.translation(), sp = v.held ? Math.hypot(v.heldVel.lin.x, v.heldVel.lin.z) : Math.hypot(v.body.linvel().x, v.body.linvel().z);
            const ok = g.isGroundReady(p.x, p.z, pw.holdBaseM + pw.holdLookaheadS * sp);
            if (!ok) { if (!v.held) v.hold(true); v.holdStep(); continue; }
            if (v.held) v.hold(false);
          }
          v.update(dt, surfaceAt);
        }
        world.step();
        stepMs.push(now() - t0); if (stepMs.length > 600) stepMs.shift();
      }).steps;
    },
  };
  return pw;
}
