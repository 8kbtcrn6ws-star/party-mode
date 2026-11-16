// Chunk level-of-detail choice (Parrot, src/core). Same signature as Vanta's planned render/pickLod:
//   pickLod(chunk, playerPositions[]) -> 0 (full detail) | 1 (lod1) | -1 (not loaded)
// chunk = { ix, iz, size } as in world.json (chunk covers x in [ix*size,(ix+1)*size], z likewise). A plain distance check from each
// player to the nearest point of the chunk's square. index.html uses render/index.js's pickLod if that module exports one.
// Physics collision is NOT streamed: the whole terrain is one collider, so collision radius >= full-detail radius always holds.
export const FULL_DETAIL_M = 300, LOD1_M = 650, UNLOAD_HYSTERESIS_M = 40;

export function pickLod(chunk, positions, current = -1) {
  const x0 = chunk.ix * chunk.size, z0 = chunk.iz * chunk.size, x1 = x0 + chunk.size, z1 = z0 + chunk.size;
  let best = Infinity;
  for (const p of positions) {
    const dx = Math.max(x0 - p.x, 0, p.x - x1), dz = Math.max(z0 - p.z, 0, p.z - z1);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  const h = (lod) => (current === lod ? UNLOAD_HYSTERESIS_M : 0);  // avoid flicker at the radius
  if (best <= FULL_DETAIL_M + h(0)) return 0;
  if (best <= LOD1_M + h(1)) return 1;
  return -1;
}
