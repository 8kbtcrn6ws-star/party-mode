// Ramming score for Party Mode: +1 point for the car that was moving faster INTO the other when two cars hit.
// A hit counts when two car colliders touch (Rapier contact manifold after the step) and the closing speed measured from the
// velocities BEFORE that step (i.e. before the impact was resolved) is above `minSpeed` (3 m/s). Each pair has a cooldown
// (2 s of simulated time) so one crash, a push or a slide never counts more than once. Pure game-side glue: no input is read or stored.
export function createScoring({ world, minSpeed = 3, cooldownS = 2, onHit = null } = {}) {
  const scores = new Map();         // car id -> points
  const lastHit = new Map();        // 'a|b' -> sim time of the last counted hit
  const pre = new Map();            // car id -> {x,y,z} velocity before the step
  let t = 0; const hits = [];
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const touching = (a, b) => { let n = 0; try { world.contactPair(a.v.collider, b.v.collider, (m) => { n += m.numContacts(); }); } catch { /* collider removed */ } return n > 0; };
  return {
    scores, hits,
    ensure(id) { if (!scores.has(id)) scores.set(id, 0); return scores.get(id); },
    forget(id) { scores.delete(id); pre.delete(id); for (const k of [...lastHit.keys()]) if (k.split('|').includes(id)) lastHit.delete(k); },
    /** Call right BEFORE world.step() (records velocities). */
    before(cars) { for (const c of cars) { const v = c.v.body.linvel(); pre.set(c.id, { x: v.x, y: v.y, z: v.z }); } },
    /** Call right AFTER world.step(), dt = fixed step. Returns the hits counted this step. */
    after(cars, dt) {
      t += dt; const out = [];
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const A = cars[i], B = cars[j], k = key(A.id, B.id);
        const last = lastHit.get(k); if (last !== undefined && t - last < cooldownS) continue;
        const pa = A.v.body.translation(), pb = B.v.body.translation();
        if (Math.hypot(pa.x - pb.x, pa.z - pb.z) > 6) continue;     // cheap reject: car length is about 4.5 m
        if (!touching(A, B)) continue;
        const va = pre.get(A.id), vb = pre.get(B.id); if (!va || !vb) continue;
        const rel = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z); if (rel <= minSpeed) continue;
        // who drove into whom: speed of each car along the line between them (towards the other = positive)
        let nx = pb.x - pa.x, nz = pb.z - pa.z; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        const sa = va.x * nx + va.z * nz, sb = -(vb.x * nx + vb.z * nz);
        const winner = sa >= sb ? A : B, other = winner === A ? B : A;
        lastHit.set(k, t);
        const pts = this.ensure(winner.id) + 1; scores.set(winner.id, pts);
        const h = { t: +t.toFixed(2), by: winner.id, hit: other.id, rel: +rel.toFixed(2), points: pts }; hits.push(h); if (hits.length > 200) hits.shift(); out.push(h);
        onHit?.(h);
      }
      return out;
    },
  };
}
