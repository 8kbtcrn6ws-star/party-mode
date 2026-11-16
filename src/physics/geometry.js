// Reads Forma's per-model geometry descriptor (e.g. game/vehicles/offroad_4x4.json) and folds it into a vehicle stats
// object, so wheel positions, wheel radius, collider box and eye point come from the asset instead of being hardcoded.
//
// Model facing switch (one line per vehicle): stats.appearance.modelForward = "+Z" | "+X"
//   "+Z" : the glb (and its descriptor) faces +Z, left = +X          (DEFAULT: glTF standard, architecture.md, shipped file)
//   "+X" : the glb (and its descriptor) faces +X, left = -Z          (variant forma/variants/offroad_4x4_plusX.glb)
// The physics chassis is always +Z forward, +Y up, +X left. modelForward does two things:
//   1. maps descriptor vectors (hubs, collider, eye) from the glb frame into the physics frame (this file);
//   2. sets the visual yaw offset applied in pose().visualQuaternion / wheelPoses()[i].visualQuaternion (vehicle.js):
//      "+Z" = identity (use pose().quaternion directly), "+X" = -90 deg yaw.
import { readText } from './io.js';

export const MODEL_FORWARDS = ['+Z', '+X'];

/** glb-frame vector -> physics-frame vector. */
export function modelToPhysics(v, modelForward = '+Z') {
  if (modelForward === '+Z') return { x: v[0], y: v[1], z: v[2] };
  if (modelForward === '+X') return { x: -v[2], y: v[1], z: v[0] }; // model forward +X -> physics +Z ; model left -Z -> physics +X
  throw new Error(`modelForward must be "+Z" or "+X", got ${modelForward}`);
}

/**
 * Returns a copy of `stats` with wheels/body/appearance filled from `desc` (Forma's descriptor JSON object).
 * Throws if, after mapping with stats.appearance.modelForward, the front hubs are not at the front (+X) of the chassis:
 * that means the descriptor and the declared facing disagree (e.g. glb re-exported but JSON not, or the reverse).
 */
export function applyGeometryDescriptor(stats, desc) {
  const out = JSON.parse(JSON.stringify(stats));
  const fwd = out.appearance?.modelForward || '+Z';
  const g = desc.suspensionGeometry, hubsRaw = g?.wheelHubLocal;
  if (!hubsRaw) throw new Error('descriptor has no suspensionGeometry.wheelHubLocal');
  const order = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
  const hubs = order.map((n) => modelToPhysics(hubsRaw[n], fwd));
  const [fl, fr, rl, rr] = hubs;
  if (!(fl.z > 0 && fr.z > 0 && rl.z < 0 && rr.z < 0) || !(fl.x > 0 && fr.x < 0 && rl.x > 0 && rr.x < 0)) {
    throw new Error(`geometry descriptor does not match modelForward "${fwd}": front hubs map to z=${fl.z.toFixed(2)},${fr.z.toFixed(2)} (should be >0), left hubs to x=${fl.x.toFixed(2)} (should be >0). `
      + `Descriptor axes say: ${JSON.stringify(desc.axes || {})}`);
  }
  out.wheels = {
    ...out.wheels,
    radius: g.wheelRadius ?? out.wheels.radius,
    wheelbase: fl.z - rl.z, trackFront: fl.x - fr.x, trackRear: rl.x - rr.x,
    hubs: hubs.map((h) => ({ x: h.x, z: h.z })), // horizontal positions of the four wheel centres, FL FR RL RR
  };
  if (desc.collider?.halfExtents) {
    const he = modelToPhysics(desc.collider.halfExtents, fwd), c = modelToPhysics(desc.collider.centre || [0, 0, 0], fwd);
    out.body = { ...out.body, size: { length: 2 * Math.abs(he.z), height: 2 * Math.abs(he.y), width: 2 * Math.abs(he.x) } };
    out.appearance = { ...(out.appearance || {}), modelOffset: { x: -c.x, y: -c.y, z: -c.z } };
    if (desc.firstPersonEye) { const e = modelToPhysics(desc.firstPersonEye, fwd); out.appearance.driverEye = { x: e.x - c.x, y: e.y - c.y, z: e.z - c.z }; }
  }
  out.appearance = { ...(out.appearance || {}), geometryFrameChecked: fwd };
  return out;
}

/** Fetch/read a vehicle stats JSON and, when appearance.geometry names a descriptor next to it, apply it. */
export async function loadVehicleStats(url) {
  const stats = JSON.parse(await readText(url));
  const gf = stats.appearance?.geometry;
  if (!gf) return stats;
  const base = String(url).replace(/[^/\\]*$/, '');
  return applyGeometryDescriptor(stats, JSON.parse(await readText(base + gf)));
}
