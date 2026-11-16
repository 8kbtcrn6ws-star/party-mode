// The 2 km open world (Forma's world_main.json: 8x8 chunks of 256 m). Streams around EVERY car:
//   physics  - one Rapier heightfield collider per chunk within `physRadius` of any car (src/physics/terrain.js streaming terrain)
//   render   - chunk glb LOD0 near any car, LOD1 farther, nothing beyond (the far-LOD mesh covers the horizon), instanced props
//   far LOD  - world_far.glb, the whole 2 km at 8 m spacing, always present, so distant mountains are visible and reachable
// Same return shape as core/world.js loadWorld (group, spawns, heightAt, surfaceAt, size, stream, meta) plus update() for physics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createChunkStore, attachStreamingTerrain, decodePng, readBytes } from '../physics/index.js';
import { loadGlb, spawnToPhysics } from './world.js';
import { createProps } from './props.js';

export const BIG = { fullM: 190, lod1M: 640, hystM: 40, capFull: 12, capLod1: 24, physRadius: 100, maxRenderLoads: 3 };
const rectDist = (p, ix, iz, CS) => Math.hypot(Math.max(ix * CS - p.x, 0, p.x - (ix + 1) * CS), Math.max(iz * CS - p.z, 0, p.z - (iz + 1) * CS));

export async function loadBigWorld(baseUrl, { worldFile = 'world_main.json', physicsWorld, onChunk = null, opts = {} } = {}) {
  const cfg = { ...BIG, ...opts };
  const store = await createChunkStore(baseUrl, { worldFile });
  const meta = store.world, CS = meta.chunkSize, size = meta.worldSize;
  const terrain = attachStreamingTerrain(store, physicsWorld);
  const group = new THREE.Group(); group.name = 'World';
  const loader = new GLTFLoader();
  const props = createProps(baseUrl);
  group.add(props.group);

  // ---- far LOD: heights for fallbacks + the horizon mesh ----
  const fl = meta.farLod, FS = fl.samples, fsp = fl.spacing;
  const fh = await decodePng(await readBytes(`${baseUrl}/${fl.heightmap.file}`));
  const farH = new Float32Array(FS * FS); for (let k = 0; k < FS * FS; k++) farH[k] = fl.heightmap.minHeight + (fh.data[k] / 65535) * fl.heightmap.heightRange;
  const farHeightAt = (x, z) => {
    const fx = Math.min(FS - 1.0001, Math.max(0, x / fsp)), fz = Math.min(FS - 1.0001, Math.max(0, z / fsp)), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, k = j * FS + i;
    return (farH[k] * (1 - u) + farH[k + 1] * u) * (1 - w) + (farH[k + FS] * (1 - u) + farH[k + FS + 1] * u) * w;
  };
  const rg = await decodePng(await readBytes(`${baseUrl}/${fl.regionMap.file}`)), regionIds = meta.regionIds;
  const regionAt = (x, z) => regionIds[rg.data[Math.min(FS - 1, Math.max(0, Math.round(z / fsp))) * FS + Math.min(FS - 1, Math.max(0, Math.round(x / fsp)))]] || null;
  const heightAt = (x, z) => { const h = store.heightAt(x, z); return Number.isNaN(h) ? farHeightAt(x, z) : h; };
  heightAt.exact = (x, z) => !Number.isNaN(store.heightAt(x, z));
  const surfaceAt = store.surfaceAt; // 'dirt' + waterAt -Infinity where the chunk is not loaded (cars are held until it is)

  const farGltf = await loadGlb(loader, `${baseUrl}/${fl.glb.file}`);
  const far = farGltf.scene; far.name = 'FarLod';
  far.position.y = -2.5; // sits under the chunk meshes (LOD1 has the same 8 m grid) so they never z-fight
  far.traverse((o) => {
    if (!o.isMesh) return;
    o.receiveShadow = false; o.castShadow = false; o.frustumCulled = false;
    const water = /^Water/.test(o.name);
    o.material = water ? new THREE.MeshStandardMaterial({ color: 0x1d4650, roughness: 0.15, transparent: true, opacity: 0.85 })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    if (!water) { o.material.polygonOffset = true; o.material.polygonOffsetFactor = 2; o.material.polygonOffsetUnits = 2; }
  });
  group.add(far);

  // ---- render chunks ----
  const state = new Map(meta.chunks.map((c) => [c.id, { chunk: c, lod: -1, root: null, want: -1, busy: false, d: Infinity }]));
  let inflight = 0; const stats = { loads: 0, drops: 0, loadMs: [] };
  async function load(c, lod) {
    const t0 = performance.now();
    const gltf = await loadGlb(loader, `${baseUrl}/${lod === 0 ? c.files.render_lod0 : c.files.render_lod1}`);
    const root = gltf.scene; root.name = `${c.id}_lod${lod}`; root.position.set(c.ix * CS, 0, c.iz * CS);
    root.traverse((o) => { if (o.isMesh) { o.receiveShadow = o.name !== 'Water'; o.castShadow = false; } });
    onChunk?.(root, { ix: c.ix, iz: c.iz, lod });
    stats.loads++; stats.loadMs.push(performance.now() - t0); if (stats.loadMs.length > 200) stats.loadMs.shift();
    return root;
  }
  function drop(root) { group.remove(root); root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); }); stats.drops++; }
  async function settle(st) {
    if (st.busy) return; st.busy = true; inflight++;
    try {
      while (st.lod !== st.want) {
        const want = st.want;
        if (want === -1) { if (st.root) drop(st.root); st.root = null; st.lod = -1; if (st.hadProps) { props.dropChunk(st.chunk.id); st.hadProps = false; } continue; }
        if (want === 0 && !st.hadProps) { await props.loadChunk(st.chunk, st.chunk.files.props); st.hadProps = true; }
        const root = await load(st.chunk, want);
        if (st.root) drop(st.root);
        group.add(root); st.root = root; st.lod = want;
        if (want === 1 && st.hadProps) { props.dropChunk(st.chunk.id); st.hadProps = false; }
      }
    } catch (e) { console.warn('bigworld: chunk', st.chunk.id, e.message); st.want = st.lod; st.failedAt = performance.now(); }
    finally { st.busy = false; inflight--; }
  }
  let lastPts = [{ x: 0, z: 0 }];
  /** Decide each chunk's wanted LOD around every car (union), capped, nearest first; start loads (max `maxRenderLoads` at once). */
  function stream(positions) {
    const pts = positions.length ? positions : lastPts; lastPts = pts;
    const order = [];
    for (const st of state.values()) { let d = Infinity; for (const p of pts) d = Math.min(d, rectDist(p, st.chunk.ix, st.chunk.iz, CS)); st.d = d; order.push(st); }
    order.sort((a, b) => a.d - b.d);
    let n0 = 0, n1 = 0;
    for (const st of order) {
      const h = (l) => (st.lod === l ? cfg.hystM : 0);
      let want = -1;
      if (st.d <= cfg.fullM + h(0) && n0 < cfg.capFull) { want = 0; n0++; }
      else if (st.d <= cfg.lod1M + h(1) && n1 < cfg.capLod1) { want = 1; n1++; }
      st.want = want;
    }
    for (const st of order) {
      if (st.want === st.lod || st.busy) continue;
      if (st.want === -1 && st.lod !== -1) { settle(st); continue; }                    // drops are free
      if (st.failedAt && performance.now() - st.failedAt < 3000) continue;
      if (inflight < cfg.maxRenderLoads) settle(st);
    }
    const active = new Set(order.filter((s) => s.lod === 0 && s.hadProps).map((s) => s.chunk.id));
    props.update(active, pts);
  }
  /** Physics streaming + readiness for a set of car positions; call every frame. */
  function update(positions) { return terrain.update(positions, { loadRadius: cfg.physRadius, hysteresis: 50, budgetMs: 3, maxLoads: 4 }); }
  /** Preload everything near the given points (physics colliders, render chunks LOD0) before the first frame / after a teleport. */
  async function preload(points) {
    await terrain.preload(points, { loadRadius: cfg.physRadius, maxWaitMs: 30000 });
    stream(points);
    for (let k = 0; k < 400 && (inflight > 0 || [...state.values()].some((s) => s.want !== s.lod && !s.failedAt)); k++) { await new Promise((r) => setTimeout(r, 25)); stream(points); }
  }
  const spawns = meta.spawns.map((s) => ({ name: s.name, ...spawnToPhysics(s) }));
  // up to 8 safe start slots on the flat start-hub pad: the 4 from Forma's map, then 4 more on a 17 m ring (pad radius is 30 m), same heading
  const hub = meta.startHub; await terrain.preload([{ x: hub.centre[0], z: hub.centre[1] }], { loadRadius: 40, maxWaitMs: 30000 });
  for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2, x = hub.centre[0] + Math.cos(a) * 17, z = hub.centre[1] + Math.sin(a) * 17; spawns.push({ name: `Spawn_${5 + k}`, x, z, y: heightAt(x, z) + 1.1, heading: hub.facingYawRad }); }
  return {
    meta, terrain, store, heightAt, surfaceAt, farHeightAt, regionAt, group, spawns, size, stream, update, preload, props, big: true,
    isGroundReady: terrain.isGroundReady,
    chunkLods: () => Object.fromEntries([...state].map(([id, st]) => [id, st.lod])),
    streamStats: () => ({ ...stats, loadedLod0: [...state.values()].filter((s) => s.lod === 0).length, loadedLod1: [...state.values()].filter((s) => s.lod === 1).length, colliders: terrain.readyChunks().length, inflight, props: props.stats(), meanLoadMs: stats.loadMs.length ? stats.loadMs.reduce((a, b) => a + b, 0) / stats.loadMs.length : 0, physErrors: terrain.errors.length }),
  };
}
