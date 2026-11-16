// Instanced props for the open world (CC0 Kenney Nature Kit prototypes in src/world/props/, see LICENSE.txt there).
// One InstancedMesh per prototype mesh part for the WHOLE world (about 50 prototypes -> ~100 draw calls however many chunks are
// near), rebuilt only when the set of detailed chunks changes or the cars have moved a good way. Per-instance distance culling:
// trees/rocks within `bigM` of any car, small plants/fences/crops only within `smallM`.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadGlb } from './world.js';

const SMALL = new Set(['fern', 'grass_clump', 'bush', 'bush_small', 'bush_tri', 'dry_scrub', 'wheat', 'corn', 'fence', 'fence_gate', 'log', 'log_stack', 'stump', 'rock_small_a', 'rock_small_b', 'sandstone_small', 'campfire', 'sign']);
const NO_SHADOW = new Set(['fern', 'grass_clump', 'wheat', 'corn', 'dry_scrub', 'bush_small']);

export function createProps(baseUrl, { bigM = 280, smallM = 110, capacity = 6000, moveM = 30 } = {}) {
  const group = new THREE.Group(); group.name = 'Props';
  const loader = new GLTFLoader();
  const manifestP = fetch(`${baseUrl}/props/props_manifest.json`).then((r) => r.json());
  const protos = new Map();           // id -> Promise<[{geometry, material}]>
  const resolved = new Map();         // id -> [{geometry, material, i}] once loaded
  const meshes = new Map();           // `${id}#${part}` -> InstancedMesh
  const chunkInst = new Map();        // chunk id -> [{proto, x,y,z, s, yaw}] (flat arrays per proto, built on load)
  let lastKey = '', lastPts = [], rebuilds = 0, instancesShown = 0, lastMs = 0;

  async function proto(id) {
    if (!protos.has(id)) {
      protos.set(id, (async () => {
        const man = (await manifestP).prototypes[id]; if (!man) return [];
        const g = await loadGlb(loader, `${baseUrl}/props/${man.file}`);
        g.scene.updateMatrixWorld(true);
        const parts = [];
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); geo.deleteAttribute('uv');
          parts.push({ geometry: geo, material: o.material });
        });
        parts.forEach((p, i) => { p.i = i; }); resolved.set(id, parts);
        return parts;
      })().catch((e) => { console.warn('props: proto', id, e.message); return []; }));
    }
    return protos.get(id);
  }
  function meshFor(id, part) {
    const key = `${id}#${part.i}`;
    let m = meshes.get(key); if (m) return m;
    m = new THREE.InstancedMesh(part.geometry, part.material, capacity);
    m.count = 0; m.frustumCulled = false; m.castShadow = !NO_SHADOW.has(id) && !SMALL.has(id); m.receiveShadow = !NO_SHADOW.has(id); m.name = 'prop_' + id;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    meshes.set(key, m); group.add(m); return m;
  }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

  return {
    group,
    /** Fetch a chunk's props.json (once). Resolves when its prototypes are ready too. */
    async loadChunk(c, propsFile) {
      if (chunkInst.has(c.id)) return;
      chunkInst.set(c.id, []); // reserve
      try {
        const j = await (await fetch(`${baseUrl}/${propsFile}`)).json();
        const list = [];
        for (const k of ['trees', 'rocks', 'objects']) for (const i of j[k] || []) list.push(i);
        const ids = [...new Set(list.map((i) => i.proto))];
        await Promise.all(ids.map(proto));
        chunkInst.set(c.id, list);
      } catch (e) { chunkInst.delete(c.id); console.warn('props: chunk', c.id, e.message); }
    },
    dropChunk(id) { chunkInst.delete(id); lastKey = ''; },
    /** Rebuild the instance buffers for the chunks in `active` (set of ids) around the cars `pts` [{x,z}]. Cheap when nothing changed. */
    update(active, pts, force = false) {
      const key = [...active].sort().join(',');
      const moved = lastPts.length !== pts.length || pts.some((p, i) => Math.hypot(p.x - lastPts[i].x, p.z - lastPts[i].z) > moveM);
      if (!force && key === lastKey && !moved) return;
      lastKey = key; lastPts = pts.map((p) => ({ x: p.x, z: p.z }));
      const t0 = performance.now();
      const per = new Map(); // key -> {mesh, n}
      const b2 = bigM * bigM, s2 = smallM * smallM;
      for (const cid of active) {
        for (const i of chunkInst.get(cid) || []) {
          let dmin = Infinity; for (const p of pts) { const dx = i.x - p.x, dz = i.z - p.z, d = dx * dx + dz * dz; if (d < dmin) dmin = d; }
          if (dmin > (SMALL.has(i.proto) ? s2 : b2)) continue;
          const parts = resolved.get(i.proto); if (!parts) continue;
          _q.setFromAxisAngle(_up, i.yaw); _p.set(i.x, i.y, i.z); _s.setScalar(i.scale); _m.compose(_p, _q, _s);
          for (let pi = 0; pi < parts.length; pi++) {
            const mesh = meshFor(i.proto, parts[pi]);
            let e = per.get(mesh); if (!e) per.set(mesh, e = { n: 0 });
            if (e.n < capacity) { mesh.setMatrixAt(e.n++, _m); }
          }
        }
      }
      instancesShown = 0;
      for (const m of meshes.values()) { const e = per.get(m); m.count = e ? e.n : 0; m.instanceMatrix.needsUpdate = true; instancesShown += m.count; }
      rebuilds++; lastMs = performance.now() - t0;
    },
    stats: () => ({ rebuilds, instancesShown, lastMs, meshes: meshes.size, chunksWithProps: chunkInst.size }),
  };
}
