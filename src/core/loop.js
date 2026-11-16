// Fixed 60 Hz simulation step, render once per animation frame with interpolation (Parrot, src/core).
//   const loop = createLoop({ step(dt) { ...physics... }, render(alpha, frameDt) { ...draw... } }); loop.start();
// step() runs 0..maxSteps times per frame; alpha (0..1) is how far we are into the next step, for interpolated poses.
// If the device is too slow for maxSteps*60 Hz the simulation slows down instead of spiralling (frame dt is clamped).
import { PHYSICS_HZ } from './config.js';

export function createLoop({ step, render, hz = PHYSICS_HZ, maxSteps = 5, raf = globalThis.requestAnimationFrame?.bind(globalThis), now = () => performance.now() }) {
  const dt = 1 / hz;
  let acc = 0, last = 0, running = false, handle = 0;
  const stats = { frames: 0, steps: 0, simTime: 0, wallTime: 0, fps: 0, stepsLastFrame: 0 };
  let fpsFrames = 0, fpsT = 0;

  function frame(t) {
    if (!running) return;
    const frameDt = Math.min((t - last) / 1000, dt * maxSteps);
    last = t;
    acc += frameDt;
    let n = 0;
    while (acc >= dt - 1e-9 && n < maxSteps) { step(dt); acc -= dt; n++; stats.simTime += dt; }
    if (acc < 0) acc = 0;
    stats.steps += n; stats.stepsLastFrame = n; stats.frames++; stats.wallTime += frameDt;
    fpsFrames++; fpsT += frameDt; if (fpsT >= 0.5) { stats.fps = fpsFrames / fpsT; fpsFrames = 0; fpsT = 0; }
    render(acc / dt, frameDt);
    handle = raf(frame);
  }
  return {
    dt, stats, get alpha() { return acc / dt; },
    start() { if (running) return; running = true; last = now(); handle = raf((t) => { last = t; frame(t); }); },
    stop() { running = false; globalThis.cancelAnimationFrame?.(handle); },
    get running() { return running; },
  };
}
