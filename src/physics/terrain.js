// Terrain data for physics: loads Forma's heightmap + surface map (or the labelled placeholder), answers
// heightAt(x,z) / surfaceAt(x,z) and builds the Rapier heightfield collider.
//
// FILE CONTRACT (what Forma exports, documented in physics/README.md):
//   <assets>/terrain/terrain.json    meta: sizeX,sizeZ (m), originX,originZ, samplesX,samplesZ, heightMin,heightMax,
//                                    waterLevel (m), optional surfaceMap {type:'index'|'splat', channels:[names]}
//   <assets>/terrain/heightmap.png   16-bit greyscale; 0..65535 -> heightMin..heightMax; row j = z index, column i = x index
//   <assets>/terrain/surfacemap.png  8-bit: type 'index' = pixel value is a surfaces id; type 'splat' = RGBA channels
//                                    named in surfaceMap.channels, strongest channel wins
// If <assets>/terrain/terrain.json is missing the loader falls back to <assets>/placeholder-terrain/ (flagged PLACEHOLDER).
import RAPIER from '@dimforge/rapier3d-compat';
import { readBytes, readText, exists } from './io.js';
import { decodePng } from './png.js';
import { SURFACE_NAMES_BY_ID } from './surfaces.js';

const join = (a, b) => a.replace(/\/+$/, '') + '/' + b;

/** Build a terrain object from decoded arrays. heights: Float32Array(samplesX*samplesZ) in metres; surf: Uint8Array of surface ids. */
export function createTerrain(meta, heights, surf) {
  const { sizeX, sizeZ, samplesX: nx, samplesZ: nz } = meta, ox = meta.originX || 0, oz = meta.originZ || 0;
  const cx = sizeX / (nx - 1), cz = sizeZ / (nz - 1);
  const x0 = ox - sizeX / 2, z0 = oz - sizeZ / 2;
  function heightAt(x, z) { // bilinear (placeholder) or exact triangle interpolation (Forma: cell split along (i,j)-(i+1,j+1))
    if (meta.triangulation === 'diag') {
      let fx = (x - x0) / cx, fz = (z - z0) / cz;
      fx = Math.min(nx - 1.0001, Math.max(0, fx)); fz = Math.min(nz - 1.0001, Math.max(0, fz));
      const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, k = j * nx + i;
      const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + nx], h11 = heights[k + nx + 1];
      return u >= w ? h00 + (h10 - h00) * u + (h11 - h10) * w : h00 + (h11 - h01) * u + (h01 - h00) * w;
    }
    let fx = (x - x0) / cx, fz = (z - z0) / cz;
    fx = Math.min(nx - 1.0001, Math.max(0, fx)); fz = Math.min(nz - 1.0001, Math.max(0, fz));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * nx + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + nx] * (1 - tx) + heights[k + nx + 1] * tx) * tz;
  }
  const names = SURFACE_NAMES_BY_ID;
  function surfaceAt(x, z) { // nearest
    const i = Math.min(nx - 1, Math.max(0, Math.round((x - x0) / cx))), j = Math.min(nz - 1, Math.max(0, Math.round((z - z0) / cz)));
    return surf ? (names[surf[j * nx + i]] || 'dirt') : 'dirt';
  }
  surfaceAt.waterLevel = meta.waterLevel ?? -Infinity;
  return { meta, heights, surf, heightAt, surfaceAt, waterLevel: surfaceAt.waterLevel, sizeX, sizeZ, originX: ox, originZ: oz, placeholder: !!meta.PLACEHOLDER };
}

/** Terrain from plain functions (tests, procedural). Samples at `cell` metres. */
export function createFunctionTerrain({ sizeX = 500, sizeZ = 500, cell = 1, heightAt, surfaceAt, waterLevel = -Infinity, originX = 0, originZ = 0 }) {
  const nx = Math.round(sizeX / cell) + 1, nz = Math.round(sizeZ / cell) + 1;
  const heights = new Float32Array(nx * nz), surf = new Uint8Array(nx * nz);
  const ids = Object.fromEntries(Object.entries(SURFACE_NAMES_BY_ID).map(([id, n]) => [n, +id]));
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = originX - sizeX / 2 + i * cell, z = originZ - sizeZ / 2 + j * cell, h = heightAt(x, z);
    heights[j * nx + i] = h; surf[j * nx + i] = ids[surfaceAt(x, z, h)] ?? 0;
  }
  return createTerrain({ sizeX, sizeZ, originX, originZ, samplesX: nx, samplesZ: nz, waterLevel }, heights, surf);
}

/** Load terrain from `${assetsUrl}/terrain` (real) or `${assetsUrl}/placeholder-terrain`. Returns terrain with .source = 'real'|'placeholder'. */
export async function loadTerrain(assetsUrl) {
  let dir = join(assetsUrl, 'terrain'), source = 'real';
  if (!(await exists(join(dir, 'terrain.json')))) { dir = join(assetsUrl, 'placeholder-terrain'); source = 'placeholder'; }
  const meta = JSON.parse(await readText(join(dir, 'terrain.json')));
  const hm = await decodePng(await readBytes(join(dir, meta.heightmap || 'heightmap.png')));
  if (hm.channels !== 1) throw new Error('heightmap must be greyscale');
  const max = hm.depth === 16 ? 65535 : 255, range = meta.heightMax - meta.heightMin;
  const n = hm.width * hm.height, heights = new Float32Array(n);
  for (let k = 0; k < n; k++) heights[k] = meta.heightMin + (hm.data[k] / max) * range;
  meta.samplesX = meta.samplesX || hm.width; meta.samplesZ = meta.samplesZ || hm.height;
  if (hm.width !== meta.samplesX || hm.height !== meta.samplesZ) throw new Error('heightmap size does not match terrain.json');
  let surf = null;
  try {
    const sm = await decodePng(await readBytes(join(dir, meta.surfacemap || 'surfacemap.png')));
    if (sm.width !== hm.width || sm.height !== hm.height) throw new Error('surfacemap size must match heightmap');
    surf = new Uint8Array(n);
    if (meta.surfaceMap?.type === 'splat') {
      const ch = meta.surfaceMap.channels, ids = Object.fromEntries(Object.entries(SURFACE_NAMES_BY_ID).map(([id, nm]) => [nm, +id]));
      for (let k = 0; k < n; k++) { let b = 0, bv = -1; for (let c = 0; c < ch.length; c++) { const v = sm.data[k * sm.channels + c]; if (v > bv) { bv = v; b = c; } } surf[k] = ids[ch[b]] ?? 0; }
    } else for (let k = 0; k < n; k++) surf[k] = sm.data[k * sm.channels];
  } catch (e) { if (source === 'real') throw e; }
  const t = createTerrain(meta, heights, surf);
  t.source = source; t.dir = dir;
  return t;
}

/**
 * Load Forma's real world: <worldUrl>/world.json + chunks/chunk_<ix>_<iz>.height.png / .surface.png (129x129 each,
 * adjacent chunks share edges), merged into one grid. Surface ids are translated through world.json's surfaceMap.ids
 * into the physics surface names. The collider is a trimesh built with Forma's exact diagonal ("each chunk's height PNG
 * is the exact collider"). Returns the terrain plus .world (the parsed world.json: spawns, track, waterLevel).
 */
export async function loadWorld(worldDir) {
  const wj = JSON.parse(await readText(join(worldDir, 'world.json')));
  const S = wj.samplesPerChunkSide, C = wj.chunksPerSide, n = C * (S - 1) + 1, hm = wj.heightmap;
  const heights = new Float32Array(n * n), surf = new Uint8Array(n * n);
  const idToName = Object.fromEntries(Object.entries(wj.surfaceMap.ids).map(([nm, id]) => [id, nm]));
  const ours = Object.fromEntries(Object.entries(SURFACE_NAMES_BY_ID).map(([id, nm]) => [nm, +id]));
  const lut = new Uint8Array(256); for (let id = 0; id < 256; id++) lut[id] = ours[idToName[id]] ?? ours.dirt;
  for (let iz = 0; iz < C; iz++) for (let ix = 0; ix < C; ix++) {
    const base = join(worldDir, `chunks/chunk_${ix}_${iz}`);
    const h = await decodePng(await readBytes(base + '.height.png')), sm = await decodePng(await readBytes(base + '.surface.png'));
    if (h.width !== S || h.height !== S || h.channels !== 1 || sm.width !== S || sm.height !== S) throw new Error(`chunk ${ix}_${iz}: expected ${S}x${S} greyscale`);
    const max = h.depth === 16 ? 65535 : 255;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = (iz * (S - 1) + j) * n + ix * (S - 1) + i;
      heights[k] = hm.minHeight + (h.data[j * S + i] / max) * hm.heightRange;
      surf[k] = lut[sm.data[(j * S + i) * sm.channels]];
    }
  }
  const meta = { sizeX: wj.worldSize, sizeZ: wj.worldSize, originX: wj.worldSize / 2, originZ: wj.worldSize / 2, samplesX: n, samplesZ: n,
    waterLevel: wj.waterLevel, triangulation: 'diag', name: wj.name };
  const t = createTerrain(meta, heights, surf);
  t.source = 'real'; t.dir = worldDir; t.world = wj;
  return t;
}

/** Trimesh collider using Forma's diagonal (i,j)-(i+1,j+1); exact match to the render/height data. */
export function createTerrainTrimesh(world, terrain, friction = 0.9) {
  const { samplesX: nx, samplesZ: nz } = terrain.meta, cx = terrain.sizeX / (nx - 1), cz = terrain.sizeZ / (nz - 1);
  const x0 = terrain.originX - terrain.sizeX / 2, z0 = terrain.originZ - terrain.sizeZ / 2;
  const verts = new Float32Array(nx * nz * 3), idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = (j * nx + i) * 3; verts[k] = x0 + i * cx; verts[k + 1] = terrain.heights[j * nx + i]; verts[k + 2] = z0 + j * cz; }
  let o = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; // a=(i,j) b=(i+1,j) c=(i,j+1) d=(i+1,j+1); counter-clockwise seen from +Y
    idx[o++] = a; idx[o++] = d; idx[o++] = b;
    idx[o++] = a; idx[o++] = c; idx[o++] = d;
  }
  const flags = RAPIER.TriMeshFlags ? RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES : undefined;
  const desc = (flags !== undefined ? RAPIER.ColliderDesc.trimesh(verts, idx, flags) : RAPIER.ColliderDesc.trimesh(verts, idx)).setFriction(friction);
  return world.createCollider(desc);
}

/** Rapier collider for the terrain: exact trimesh for Forma's world (meta.triangulation 'diag'), heightfield otherwise. */
export function createTerrainCollider(world, terrain, friction = 0.9) {
  if (terrain.meta.triangulation === 'diag') return createTerrainTrimesh(world, terrain, friction);
  const { samplesX: nx, samplesZ: nz } = terrain.meta;
  // Rapier heights are column-major: index = col*(nrows+1)+row, columns along X, rows along Z.
  const h = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) h[i * nz + j] = terrain.heights[j * nx + i];
  const desc = RAPIER.ColliderDesc.heightfield(nz - 1, nx - 1, h, { x: terrain.sizeX, y: 1, z: terrain.sizeZ })
    .setFriction(friction).setTranslation(terrain.originX, 0, terrain.originZ);
  return world.createCollider(desc);
}


// ======================================================================================================================
// STREAMING TERRAIN (free roaming / large worlds): per-chunk heightfield colliders added and removed on demand.
//
// Chunk convention (Forma): chunk (ix, iz) covers x in [ix*chunkSize, (ix+1)*chunkSize], z likewise (x east, z south/+Z), ix,iz >= 0.
// Each chunk is `samplesPerChunkSide` (129) samples per side, vertex-aligned, edges shared exactly with the neighbours, so the
// seams are continuous by construction. Data files: world.json `chunks[].files.heightmap|surfaceMap` (or chunks/chunk_<ix>_<iz>.height.png).
//
// Collider: ONE Rapier heightfield per chunk (about 1.5 ms to create, ~0 to remove; a trimesh of the same chunk costs 10-25 ms). The
// heightfield is rotated 90 deg about Y so that Rapier's cell diagonal equals Forma's (i,j)-(i+1,j+1): the collider is an exact match
// of the heightmap (verified to < 1e-4 m against heightAt()). Height/surface data are decoded and the collider buffer is prepared
// OFF the hot path (loadChunk is async); addChunk() only builds the collider.
//
// Safety net: world.js (createPhysicsWorld({ground}) / pw.ground = terrain) holds any vehicle whose ground neighbourhood is not
// ready (zero velocity, gravity off, no suspension update) and releases it with its old velocity once isGroundReady() is true.
// ======================================================================================================================
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const Q_HF = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
const keyOf = (ix, iz) => ix + ',' + iz;
const tstats = (a) => { if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 }; const b = [...a].sort((x, y) => x - y); return { n: b.length, mean: b.reduce((x, y) => x + y, 0) / b.length, p95: b[Math.min(b.length - 1, Math.floor(0.95 * b.length))], max: b[b.length - 1] }; };

/**
 * Chunk data store (no physics): reads world.json, lazily loads/decodes chunks, answers heightAt/surfaceAt for loaded chunks.
 * `opts.provider(ix, iz) -> Promise<{heights: Float32Array(S*S) row-major (row = z), surf: Uint8Array(S*S) physics surface ids}>` overrides
 * file loading (used by tests for a synthetic tiled world). `opts.world` = parsed world.json object when no directory is used.
 */
export async function createChunkStore(worldDir, opts = {}) {
  const wj = opts.world || JSON.parse(await readText(join(worldDir, opts.worldFile || 'world.json')));
  const CS = wj.chunkSize, S = wj.samplesPerChunkSide, cell = CS / (S - 1), hm = wj.heightmap;
  const listed = new Map((wj.chunks || []).map((c) => [keyOf(c.ix, c.iz), c]));
  const nx = wj.chunksX ?? (listed.size ? Math.max(...[...listed.values()].map((c) => c.ix)) + 1 : wj.chunksPerSide);
  const nz = wj.chunksZ ?? (listed.size ? Math.max(...[...listed.values()].map((c) => c.iz)) + 1 : wj.chunksPerSide);
  const idToName = wj.surfaceMap ? Object.fromEntries(Object.entries(wj.surfaceMap.ids).map(([nm, id]) => [id, nm])) : {};
  const ours = Object.fromEntries(Object.entries(SURFACE_NAMES_BY_ID).map(([id, nm]) => [nm, +id]));
  const lut = new Uint8Array(256); for (let id = 0; id < 256; id++) lut[id] = ours[idToName[id]] ?? ours.dirt;
  const exact = opts.exactDiagonal !== false; // default: collider triangulated exactly like Forma's render mesh (see header); false = native Rapier diagonal (no hairline cracks, up to metres off at cliffs)
  const data = new Map(), loading = new Map(), loadMs = [];
  const fileProvider = async (ix, iz) => {
    const c = listed.get(keyOf(ix, iz)), base = `chunks/chunk_${ix}_${iz}`;
    const hf = join(worldDir, c?.files?.heightmap || base + '.height.png'), sf = join(worldDir, c?.files?.surfaceMap || base + '.surface.png');
    const [hb, sb] = await Promise.all([readBytes(hf), readBytes(sf)]);
    const h = await decodePng(hb), sm = await decodePng(sb);
    if (h.width !== S || h.height !== S || h.channels !== 1 || sm.width !== S || sm.height !== S) throw new Error(`chunk ${ix}_${iz}: expected ${S}x${S} greyscale PNGs`);
    const max = h.depth === 16 ? 65535 : 255, heights = new Float32Array(S * S), surf = new Uint8Array(S * S);
    for (let k = 0; k < S * S; k++) { heights[k] = hm.minHeight + (h.data[k] / max) * hm.heightRange; surf[k] = lut[sm.data[k * sm.channels]]; }
    let water = null; // per-texel water SURFACE height (0 in the PNG = no water) -> -Infinity; only the 2 km world has waterMap
    if (c?.files?.waterMap) {
      const w = await decodePng(await readBytes(join(worldDir, c.files.waterMap)));
      if (w.width !== S || w.height !== S) throw new Error(`chunk ${ix}_${iz}: water map size`);
      water = new Float32Array(S * S); for (let k = 0; k < S * S; k++) water[k] = w.data[k] === 0 ? -Infinity : hm.minHeight + (w.data[k] / max16(w)) * hm.heightRange;
    }
    return { heights, surf, water };
  };
  const max16 = (img) => (img.depth === 16 ? 65535 : 255);
  const provider = opts.provider || fileProvider;
  const inWorld = (ix, iz) => ix >= 0 && iz >= 0 && ix < nx && iz < nz;
  const store = {
    world: wj, dir: worldDir, chunkSize: CS, samples: S, cell, chunksX: nx, chunksZ: nz, sizeX: nx * CS, sizeZ: nz * CS, waterLevel: wj.waterLevel ?? -Infinity,
    exactDiagonal: exact, inWorld, hasData: (ix, iz) => data.has(keyOf(ix, iz)), loadTimes: loadMs, loadingCount: () => loading.size,
    chunkAt: (x, z) => ({ ix: Math.min(nx - 1, Math.max(0, Math.floor(x / CS))), iz: Math.min(nz - 1, Math.max(0, Math.floor(z / CS))) }),
    /** Async: fetch + decode + prepare collider buffer. Idempotent; concurrent calls share one load. Resolves to the chunk data. */
    loadChunk(ix, iz) {
      const k = keyOf(ix, iz);
      if (!inWorld(ix, iz)) return Promise.reject(new Error(`chunk ${k} is outside the world (${nx}x${nz})`));
      if (data.has(k)) return Promise.resolve(data.get(k));
      if (loading.has(k)) return loading.get(k);
      const t0 = nowMs();
      const lat = typeof opts.latencyMs === 'function' ? opts.latencyMs(ix, iz) : (opts.latencyMs || 0); // test hook: simulated network latency
      const pr = (lat > 0 ? new Promise((r) => setTimeout(r, lat)) : Promise.resolve()).then(() => provider(ix, iz)).then((d) => {
        // collider buffer (rotated 90 deg about Y, see header): h[a*S+b] = H[(S-1-a)*S + b]
        const hf = new Float32Array(S * S);
        if (exact) { for (let a = 0; a < S; a++) { const row = (S - 1 - a) * S; for (let b = 0; b < S; b++) hf[a * S + b] = d.heights[row + b]; } }
        else { for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) hf[a * S + b] = d.heights[b * S + a]; }
        const rec = { ix, iz, heights: d.heights, surf: d.surf, water: d.water || null, hf, refs: 0 };
        data.set(k, rec); loading.delete(k); loadMs.push(nowMs() - t0); if (loadMs.length > 5000) loadMs.shift(); return rec;
      }, (e) => { loading.delete(k); throw e; });
      loading.set(k, pr); return pr;
    },
    evictData(ix, iz) { const r = data.get(keyOf(ix, iz)); if (r && r.refs === 0) { data.delete(keyOf(ix, iz)); return true; } return false; },
    /** Ground height (exact triangle interpolation on Forma's diagonal) from loaded data; NaN where the chunk data is not loaded. */
    heightAt(x, z) {
      const ix = Math.min(nx - 1, Math.max(0, Math.floor(x / CS))), iz = Math.min(nz - 1, Math.max(0, Math.floor(z / CS)));
      const d = data.get(keyOf(ix, iz)); if (!d) return NaN;
      let fx = (x - ix * CS) / cell, fz = (z - iz * CS) / cell;
      fx = Math.min(S - 1.0001, Math.max(0, fx)); fz = Math.min(S - 1.0001, Math.max(0, fz));
      const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, k = j * S + i, H = d.heights;
      return u >= w ? H[k] + (H[k + 1] - H[k]) * u + (H[k + S + 1] - H[k + 1]) * w : H[k] + (H[k + S + 1] - H[k + S]) * u + (H[k + S] - H[k]) * w;
    },
    surfaceAt(x, z) {
      const ix = Math.min(nx - 1, Math.max(0, Math.floor(x / CS))), iz = Math.min(nz - 1, Math.max(0, Math.floor(z / CS)));
      const d = data.get(keyOf(ix, iz)); if (!d) return 'dirt';
      const i = Math.min(S - 1, Math.max(0, Math.round((x - ix * CS) / cell))), j = Math.min(S - 1, Math.max(0, Math.round((z - iz * CS) / cell)));
      return SURFACE_NAMES_BY_ID[d.surf[j * S + i]] || 'dirt';
    },
    /** Water SURFACE height at (x,z) (rivers slope: per texel in the 2 km world's waterMap; the test world's constant waterLevel) or -Infinity if none / chunk not loaded. */
    waterAt(x, z) {
      const ix = Math.min(nx - 1, Math.max(0, Math.floor(x / CS))), iz = Math.min(nz - 1, Math.max(0, Math.floor(z / CS)));
      const d = data.get(keyOf(ix, iz)); if (!d) return -Infinity;
      if (!d.water) return store.waterLevel;
      const i = Math.min(S - 1, Math.max(0, Math.round((x - ix * CS) / cell))), j = Math.min(S - 1, Math.max(0, Math.round((z - iz * CS) / cell)));
      return d.water[j * S + i];
    },
    _data: data,
  };
  store.surfaceAt.waterLevel = store.waterLevel; store.surfaceAt.waterAt = store.waterAt;
  return store;
}

/**
 * createStreamingTerrain(worldDir | store, physicsWorld, opts) -> terrain streaming controller.
 *   opts.store        share an existing chunk store (data cache) between physics worlds
 *   opts.friction     collider friction (default 0.9)
 *   opts.provider/opts.world   see createChunkStore
 */
export async function createStreamingTerrain(worldDirOrStore, physicsWorld, opts = {}) {
  const store = typeof worldDirOrStore === 'string' ? await createChunkStore(worldDirOrStore, opts) : worldDirOrStore;
  return attachStreamingTerrain(store, physicsWorld, opts);
}

/** Synchronous variant for an existing chunk store (no await needed): same controller as createStreamingTerrain. */
export function attachStreamingTerrain(store, physicsWorld, opts = {}) {
  const { chunkSize: CS, samples: S } = store, friction = opts.friction ?? 0.9;
  const ready = new Map(); // key -> collider
  const addMs = [], removeMs = [], errors = [], failedAt = new Map();
  // background load that never throws: failures are recorded in t.errors and retried after retryMs (a missing/broken chunk must not spam fetches every frame)
  const loadBg = (ix, iz) => {
    const k = keyOf(ix, iz), f = failedAt.get(k); if (f !== undefined && nowMs() - f < (opts.retryMs ?? 2000)) return;
    store.loadChunk(ix, iz).then(() => failedAt.delete(k), (e) => { failedAt.set(k, nowMs()); errors.push({ ix, iz, message: String(e && e.message || e) }); if (errors.length > 50) errors.shift(); });
  };
  const t = {
    ...store, store, physicsWorld, errors,
    /** Is chunk (ix,iz)'s collider in the physics world? */
    isChunkReady: (ix, iz) => ready.has(keyOf(ix, iz)),
    /**
     * Is there solid ground in every chunk overlapping the square [x-r, x+r] x [z-r, z+r]? Chunks outside the world are ignored
     * (the world edge itself is the game's job), so a car at the edge is not held forever.
     */
    isGroundReady(x, z, radius = 0) {
      const i0 = Math.floor((x - radius) / CS), i1 = Math.floor((x + radius) / CS), j0 = Math.floor((z - radius) / CS), j1 = Math.floor((z + radius) / CS);
      let any = false;
      for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) { if (!store.inWorld(ix, iz)) continue; any = true; if (!ready.has(keyOf(ix, iz))) return false; }
      return true;
    },
    /**
     * Sync, on the hot path (about 1.5 ms): create the collider from preloaded data. Returns true when the collider exists afterwards.
     * Returns false (and starts loading in the background) if the chunk data is not loaded yet; call again later or use addChunkAsync.
     */
    addChunk(ix, iz) {
      const k = keyOf(ix, iz); if (ready.has(k)) return true;
      const d = store._data.get(k);
      if (!d) { if (store.inWorld(ix, iz)) loadBg(ix, iz); return false; }
      const t0 = nowMs();
      const desc = RAPIER.ColliderDesc.heightfield(S - 1, S - 1, d.hf, { x: CS, y: 1, z: CS }).setFriction(friction).setTranslation((ix + 0.5) * CS, 0, (iz + 0.5) * CS);
      if (store.exactDiagonal) desc.setRotation(Q_HF);
      const col = physicsWorld.createCollider(desc); d.refs++; ready.set(k, col);
      addMs.push(nowMs() - t0); if (addMs.length > 5000) addMs.shift(); return true;
    },
    /** Async variant: load (off-thread I/O + decode) then add. Resolves true. */
    async addChunkAsync(ix, iz) { await store.loadChunk(ix, iz); return t.addChunk(ix, iz); },
    /** Remove the collider (cost ~0). Data stays cached unless evict=true. Vehicles standing on it are held by the safety net. */
    removeChunk(ix, iz, evict = false) {
      const k = keyOf(ix, iz), col = ready.get(k); if (!col) return false;
      const t0 = nowMs(); physicsWorld.removeCollider(col, true); ready.delete(k); const d = store._data.get(k); if (d) d.refs--;
      removeMs.push(nowMs() - t0); if (removeMs.length > 5000) removeMs.shift(); if (evict) store.evictData(ix, iz); return true;
    },
    readyChunks: () => [...ready.keys()].map((k) => k.split(',').map(Number)),
    /**
     * Streaming manager, call once per frame (cheap when nothing changes). points = [{x,z}, ...] (all cars + cameras).
     *   loadRadius   (default 128 m)  chunks whose rectangle is within this distance of any point are wanted (loaded + collider added)
     *   hysteresis   (default 64 m)   wanted radius for REMOVAL is loadRadius + hysteresis, so chunks do not flap at a border
     *   budgetMs     (default 3)      stop adding colliders for this call once exceeded (the nearest chunk is always added)
     *   maxLoads     (default 4)      concurrent async loads
     *   dataKeepRadius (default loadRadius + 2*chunkSize) cached data beyond this is evicted
     * Returns { added: [[ix,iz]...], removed: [...], pending (wanted but not ready), loading }.
     */
    update(points, o = {}) {
      const load = o.loadRadius ?? 128, unload = load + (o.hysteresis ?? 64), budget = o.budgetMs ?? 3, maxLoads = o.maxLoads ?? 4, keep = o.dataKeepRadius ?? load + 2 * CS;
      const rectDist = (p, ix, iz) => { const dx = Math.max(ix * CS - p.x, 0, p.x - (ix + 1) * CS), dz = Math.max(iz * CS - p.z, 0, p.z - (iz + 1) * CS); return Math.hypot(dx, dz); };
      const want = new Map();
      for (const p of points) {
        const i0 = Math.max(0, Math.floor((p.x - load) / CS)), i1 = Math.min(store.chunksX - 1, Math.floor((p.x + load) / CS)), j0 = Math.max(0, Math.floor((p.z - load) / CS)), j1 = Math.min(store.chunksZ - 1, Math.floor((p.z + load) / CS));
        for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) { const d = rectDist(p, ix, iz); if (d <= load) { const k = keyOf(ix, iz), old = want.get(k); if (!old || d < old.d) want.set(k, { ix, iz, d }); } }
      }
      const todo = [...want.values()].filter((c) => !ready.has(keyOf(c.ix, c.iz))).sort((a, b) => a.d - b.d);
      const added = [], t0 = nowMs(); let loadsStarted = 0;
      for (const c of todo) {
        const k = keyOf(c.ix, c.iz);
        if (store._data.has(k)) { if (added.length === 0 || nowMs() - t0 < budget) { t.addChunk(c.ix, c.iz); added.push([c.ix, c.iz]); } }
        else if (store.loadingCount() < maxLoads && loadsStarted < maxLoads) { loadsStarted++; loadBg(c.ix, c.iz); }
      }
      const removed = [];
      for (const [k] of [...ready]) {
        const [ix, iz] = k.split(',').map(Number); let dmin = Infinity; for (const p of points) dmin = Math.min(dmin, rectDist(p, ix, iz));
        if (dmin > unload) { t.removeChunk(ix, iz); removed.push([ix, iz]); }
      }
      for (const [k, d] of [...store._data]) if (d.refs === 0 && !want.has(k)) { let dmin = Infinity; for (const p of points) dmin = Math.min(dmin, rectDist(p, d.ix, d.iz)); if (dmin > keep) store._data.delete(k); }
      return { added, removed, pending: todo.length - added.length, loading: store.loadingCount() };
    },
    /** Await until every chunk the update() would want around `points` has a collider (loading, bounded by maxWaitMs). For spawns/teleports. */
    async preload(points, o = {}) {
      const t0 = nowMs();
      for (;;) { const r = t.update(points, { ...o, budgetMs: 1e9 }); if (r.pending === 0 && r.loading === 0) return r; if (nowMs() - t0 > (o.maxWaitMs ?? 20000)) throw new Error('terrain preload timed out'); await new Promise((res) => setTimeout(res, 1)); }
    },
    timings: () => ({ addMs: tstats(addMs), removeMs: tstats(removeMs), loadMs: tstats(store.loadTimes) }),
    resetTimings() { addMs.length = 0; removeMs.length = 0; },
    heightAt: store.heightAt, surfaceAt: store.surfaceAt, waterAt: store.waterAt, waterLevel: store.waterLevel,
  };
  return t;
}
