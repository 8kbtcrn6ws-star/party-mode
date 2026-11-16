// World glue (Parrot, src/core): SpaceX's physics loadWorld() reads Forma's chunk maps into one terrain (surface codes already
// translated to the physics surface names); this file adds the render side: the chunk glbs placed at ix*256, 0, iz*256, and
// the spawns from world.json. There is no loadChunk() in src/world yet, so all chunks of the 2x2 test world load up front.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadWorld as loadPhysicsWorld, createTerrainCollider } from '../physics/index.js';
import { pickLod as defaultPickLod } from './lod.js';

/** fetch + parse instead of GLTFLoader.load(): three's FileLoader streams the body, and Chromium reports some of those
 *  streamed fetches as net::ERR_ABORTED (the data arrives fine) which trips request-failure checks in the test suite. */
export async function loadGlb(loader, url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return loader.parseAsync(await r.arrayBuffer(), url.replace(/[^/]*$/, ''));
}

/** Spawn from world.json (yawRad, forward = (sin yaw, 0, cos yaw)) -> physics spawn; the physics heading uses the same convention. */
export const spawnToPhysics = (s, lift = 1.1) => ({ x: s.x, z: s.z, y: s.y + lift, heading: s.yawRad });

export async function loadWorld(baseUrl, { physicsWorld, renderChunks = true, onChunk = null, pickLod = defaultPickLod, initialPositions = [] } = {}) {
  const terrain = await loadPhysicsWorld(baseUrl);
  const meta = terrain.world;
  const collider = physicsWorld ? createTerrainCollider(physicsWorld, terrain) : null; // whole world, always: collision is not streamed

  const group = new THREE.Group(); group.name = 'World';
  const loader = new GLTFLoader();
  const state = new Map(meta.chunks.map((c) => [c.id, { chunk: c, lod: -1, root: null, want: -1, busy: false }]));

  async function load(c, lod) {
    const file = lod === 0 ? c.files.render_lod0 : c.files.render_lod1;
    const gltf = await loadGlb(loader, `${baseUrl}/${file}`);
    const root = gltf.scene; root.name = `${c.id}_lod${lod}`; root.position.set(c.ix * meta.chunkSize, 0, c.iz * meta.chunkSize);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const isProp = /^Props_/.test(o.name) || /^Props_/.test(o.parent?.name || '');
      o.receiveShadow = o.name !== 'Water'; o.castShadow = isProp;
    });
    onChunk?.(root, { ix: c.ix, iz: c.iz, lod });   // Vanta's look.dressChunk(root, {ix, iz}); root is already placed at (ix*256, 0, iz*256)
    return root;
  }
  function drop(root) {
    group.remove(root);
    root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
  }
  async function settle(st) { // bring one chunk to its wanted LOD; loops if the wish changed while loading
    if (st.busy) return; st.busy = true;
    try {
      while (st.lod !== st.want) {
        const want = st.want;
        if (want === -1) { if (st.root) drop(st.root); st.root = null; st.lod = -1; continue; }
        const root = await load(st.chunk, want);
        if (st.root) drop(st.root);
        group.add(root); st.root = root; st.lod = want;
      }
    } finally { st.busy = false; }
  }
  /** Call every ~0.25 s with every car's position. Returns a promise for the loads started. */
  function stream(positions) {
    if (!renderChunks) return Promise.resolve();
    const jobs = [];
    for (const st of state.values()) {
      const c = { ...st.chunk, size: meta.chunkSize };
      st.want = pickLod(c, positions, st.lod);
      if (st.want !== st.lod) jobs.push(settle(st));
    }
    return Promise.all(jobs);
  }
  await stream(initialPositions.length ? initialPositions : meta.spawns);

  const spawns = meta.spawns.map((s) => ({ name: s.name, ...spawnToPhysics(s) }));
  return { meta, terrain, collider, heightAt: terrain.heightAt, surfaceAt: terrain.surfaceAt, group, spawns, size: terrain.sizeX, stream, chunkLods: () => Object.fromEntries([...state].map(([id, st]) => [id, st.lod])) };
}
