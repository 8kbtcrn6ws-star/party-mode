// Soft world boundary (glue, not physics). There is no wall at the edge of the 512 m test terrain, so without this a car just drives off the
// heightfield. Inside `margin` metres of any edge: the throttle fades (never below `floor` while the car points outward, so it can always turn
// around) and the steering is blended toward "head for the map centre". Beyond the edge (a launch, a bad reset) the car is put back inside.
// Pure functions of (input, pose); no input is stored or logged.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createSoftBoundary({ size = 512, margin = 20, floor = 0.3, assist = 0.85, backstop = 4 } = {}) {
  const c = size / 2;
  /** depth 0..1 (0 = margin metres from an edge or more, 1 = on the edge) and the outward unit vector there. */
  function depthAt(x, z) {
    const dx = Math.max(0, margin - x, x - (size - margin)), dz = Math.max(0, margin - z, z - (size - margin));
    const ox = x < margin ? -dx : x > size - margin ? dx : 0, oz = z < margin ? -dz : z > size - margin ? dz : 0;
    const len = Math.hypot(ox, oz);
    return { depth: clamp(Math.max(dx, dz) / margin, 0, 1), ox: len ? ox / len : 0, oz: len ? oz / len : 0 };
  }
  return {
    size, margin, depthAt,
    /** @returns the (possibly modified) input; same object when nothing changes. */
    apply(input, pose) {
      const p = pose.position, f = pose.forward, { depth, ox, oz } = depthAt(p.x, p.z);
      if (depth <= 0) return input;
      const fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
      const outward = clamp(fx * ox + fz * oz, -1, 1);                // +1 = pointing straight out of the map
      const reversing = !!input.rev;
      const dirOut = reversing ? -outward : outward;                  // reversing flips which way the car travels
      const fade = dirOut > 0 ? 1 - depth * (1 - floor) * Math.min(1, 0.4 + dirOut) : 1 - 0.3 * depth * (1 - Math.min(1, -dirOut));
      // desired travel direction = toward the centre
      const tx = c - p.x, tz = c - p.z, tl = Math.hypot(tx, tz) || 1;
      const want = Math.atan2(tx / tl, tz / tl) - Math.atan2(fx, fz);
      const a = Math.atan2(Math.sin(want), Math.cos(want));           // >0: centre is to the left (heading must increase)
      const toCentre = clamp(-a / (Math.PI / 2), -1, 1) * (reversing ? -1 : 1); // steer: +right
      const k = assist * depth;
      return { ...input, throttle: input.throttle * fade, steer: clamp(input.steer * (1 - k) + toCentre * k, -1, 1) };
    },
    /** Spawn-like position to reset to when the car is clearly outside the world, else null. */
    rescue(pose) {
      const p = pose.position, lim = -backstop, hi = size + backstop;
      if (p.x >= lim && p.x <= hi && p.z >= lim && p.z <= hi) return null;
      return { x: clamp(p.x, margin, size - margin), z: clamp(p.z, margin, size - margin) };
    },
  };
}
