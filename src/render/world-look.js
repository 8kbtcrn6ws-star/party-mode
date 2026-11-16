// Vanta — dresses Forma's terrain chunks with CC0 Poly Haven PBR textures (assets/LICENSES.md) and real water.
// Usage: const look = createWorldLook(renderer); look.dressChunk(gltf.scene); each frame look.update(dt).
import * as THREE from 'three';

const BASE = new URL('./textures/', import.meta.url).href;
// surface -> [texture set, tile size in metres, tint]
const SURFACES = {
  Surface_Grass:  ['leafy_grass', 5, 0x86b45a], // leaf-litter texture, tinted to meadow green
  Surface_Dirt:   ['rocky_trail', 6, 0xffffff],
  Surface_Mud:    ['brown_mud_03', 4, 0xd8d0c8],
  Surface_Gravel: ['gravel_floor_02', 3, 0xffffff],
  Surface_Sand:   ['sand_01', 5, 0xffffff],
  Surface_Snow:   ['snow_02', 6, 0xffffff],
  Surface_Ice:    ['snow_02', 8, 0xcfe4ff],
  Surface_Water:  ['rock_boulder_dry', 4, 0x8a8a80], // river bed under the water plane
};

// Splat-blended terrain: Forma's splat_a (grass,dirt,mud,gravel) + splat_b (sand,snow,ice,water) per chunk,
// 129x129 texels vertex-aligned (texel i at local x = 2i). Layers live in texture arrays to stay well under 16 samplers.
const LAYERS = ['Surface_Grass','Surface_Dirt','Surface_Mud','Surface_Gravel','Surface_Sand','Surface_Snow','Surface_Water'];
const LAYER_RES = 512;
const TEST_CHUNK_BASE = new URL('../world/chunks/', import.meta.url).href;

// opts.chunkBase: folder holding chunk_<ix>_<iz>.splat_a/b.png (default: the 512 m test world). opts.waterLevel: constant river level for the
// wet-bank effect (test world); the 2 km world passes Infinity-like (rivers sit at many heights) and the water depth comes from the water mesh itself.
export function createWorldLook(renderer, { waterLevel = 5.3, chunkBase = TEST_CHUNK_BASE } = {}) {
  const CHUNK_BASE = chunkBase;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const texCache = new Map(), matCache = new Map();
  function tex(set, kind, srgb) {
    const key = set + kind;
    if (!texCache.has(key)) {
      const t = loader.load(`${BASE}${set}/${set}_${kind}_1k.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      texCache.set(key, t);
    }
    return texCache.get(key);
  }
  function surfaceMaterial(name) {
    if (!matCache.has(name)) {
      const [set, , tint] = SURFACES[name];
      const arm = tex(set, 'arm', false); // R = ambient occlusion, G = roughness, B = metalness
      matCache.set(name, new THREE.MeshStandardMaterial({
        color: tint, map: tex(set, 'diff', true), normalMap: tex(set, 'nor_gl', false),
        roughnessMap: arm, metalnessMap: arm, aoMap: arm, aoMapIntensity: 0.8, roughness: 1, metalness: 1,
        normalScale: new THREE.Vector2(1, 1),
      }));
    }
    return matCache.get(name);
  }

  // ---- texture arrays (diffuse sRGB, GL normal, ARM) ----
  const N = LAYERS.length, px = LAYER_RES * LAYER_RES * 4;
  const mkArray = (srgb) => {
    const t = new THREE.DataArrayTexture(new Uint8Array(px * N), LAYER_RES, LAYER_RES, N);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const arrays = { diff: mkArray(true), nor_gl: mkArray(false), arm: mkArray(false) };
  const cnv = document.createElement('canvas'); cnv.width = cnv.height = LAYER_RES;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  let pending = N * 3; const ready = { value: 0 }; // until all layers decode, terrain draws in flat tints, not a black mirror
  LAYERS.forEach((name, li) => {
    const set = SURFACES[name][0];
    for (const kind of ['diff', 'nor_gl', 'arm']) {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        ctx.clearRect(0, 0, LAYER_RES, LAYER_RES); ctx.drawImage(img, 0, 0, LAYER_RES, LAYER_RES);
        arrays[kind].image.data.set(ctx.getImageData(0, 0, LAYER_RES, LAYER_RES).data, li * px);
        if (--pending === 0) { for (const a of Object.values(arrays)) a.needsUpdate = true; ready.value = 1; }
      };
      img.onerror = () => { console.warn('world-look: missing texture', set, kind); if (--pending === 0) { for (const a of Object.values(arrays)) a.needsUpdate = true; ready.value = 1; } };
      img.src = `${BASE}${set}/${set}_${kind}_1k.jpg`;
    }
  });
  const tiles = LAYERS.map((n) => 1 / SURFACES[n][1]);
  const tints = LAYERS.map((n) => new THREE.Color(SURFACES[n][2]));
  const iceTint = new THREE.Color(SURFACES.Surface_Ice[2]);

  const splatLoader = new THREE.TextureLoader();
  function splatTex(url) {
    const t = splatLoader.load(url); t.flipY = false; t.generateMipmaps = false;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace; return t;
  }

  function splatMaterial(ix, iz) {
    const key = `splat_${ix}_${iz}`;
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    const u = {
      uSplatA: { value: splatTex(`${CHUNK_BASE}chunk_${ix}_${iz}.splat_a.png`) },
      uSplatB: { value: splatTex(`${CHUNK_BASE}chunk_${ix}_${iz}.splat_b.png`) },
      uDiff: { value: arrays.diff }, uNor: { value: arrays.nor_gl }, uArm: { value: arrays.arm },
      uTile: { value: tiles }, uTint: { value: tints }, uIceTint: { value: iceTint }, uReady: ready,
      uOrigin: { value: new THREE.Vector2(ix * 256, iz * 256) }, uWaterLevel: { value: waterLevel },
    };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos; varying vec3 vVT; varying vec3 vVB; varying vec3 vVN;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vLocalPos = position;
          vec3 n0 = normalize(normal);
          vVT = normalMatrix * normalize(vec3(1.0, 0.0, 0.0) - n0 * n0.x);
          vVB = normalMatrix * normalize(vec3(0.0, 0.0, 1.0) - n0 * n0.z);
          vVN = normalMatrix * n0;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          precision highp sampler2DArray;
          varying vec3 vLocalPos; varying vec3 vVT; varying vec3 vVB; varying vec3 vVN;
          uniform sampler2D uSplatA, uSplatB; uniform sampler2DArray uDiff, uNor, uArm;
          uniform float uTile[${N}]; uniform vec3 uTint[${N}]; uniform vec3 uIceTint; uniform float uReady;
          uniform vec2 uOrigin; uniform float uWaterLevel;
          float vh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(vh(i), vh(i+vec2(1,0)), f.x), mix(vh(i+vec2(0,1)), vh(i+vec2(1,1)), f.x), f.y); }
          float wetF;
          vec3 tAlb; vec3 tNor; vec3 tArm;
          void addLayer(int li, float w, vec3 tint) {
            if (w < 0.004) return;
            if (uReady < 0.5) { tAlb += w * tint * 0.35; tNor += w * vec3(0.0, 0.0, 1.0); tArm += w * vec3(1.0, 0.9, 0.0); return; }
            vec2 uv = vLocalPos.xz * uTile[li];
            tAlb += w * texture(uDiff, vec3(uv, float(li))).rgb * tint;
            tNor += w * (texture(uNor, vec3(uv, float(li))).rgb * 2.0 - 1.0);
            tArm += w * texture(uArm, vec3(uv, float(li))).rgb;
          }`)
        .replace('#include <map_fragment>', `
          vec2 sUV = (vLocalPos.xz * 0.5 + 0.5) / 129.0;
          vec4 wa = texture2D(uSplatA, sUV), wb = texture2D(uSplatB, sUV);
          float wsum = max(dot(wa, vec4(1.0)) + dot(wb, vec4(1.0)), 1e-3);
          wa /= wsum; wb /= wsum;
          tAlb = vec3(0.0); tNor = vec3(0.0); tArm = vec3(0.0);
          addLayer(0, wa.r, uTint[0]); addLayer(1, wa.g, uTint[1]); addLayer(2, wa.b, uTint[2]); addLayer(3, wa.a, uTint[3]);
          addLayer(4, wb.r, uTint[4]); addLayer(5, wb.g, uTint[5]); addLayer(5, wb.b, uIceTint); addLayer(6, wb.a, uTint[6]);
          // Break up tiling with world-space low-frequency variation (seamless across chunks).
          vec2 wp = vLocalPos.xz + uOrigin;
          float macro = vn(wp * 0.011) * 0.6 + vn(wp * 0.043) * 0.4;
          tAlb *= mix(0.78, 1.14, macro);
          // Wet riverbank: darker and glossier where the (blurred) water weight says the river is close.
          wetF = smoothstep(0.02, 0.3, wb.a) * (1.0 - smoothstep(uWaterLevel + 0.3, uWaterLevel + 1.6, vLocalPos.y)); // only beside the river
          tAlb *= mix(1.0, 0.52, wetF);
          diffuseColor.rgb *= tAlb * mix(1.0, tArm.r, 0.8);`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(tArm.g * mix(1.0, 0.35, wetF), 0.08, 1.0);')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
        .replace('#include <normal_fragment_maps>', `{
          vec3 tn = normalize(vec3(tNor.xy, max(tNor.z, 0.2)));
          normal = normalize(normalize(vVT) * tn.x + normalize(vVB) * tn.y + normalize(vVN) * tn.z);
          if (!gl_FrontFacing) normal = -normal;
        }`);
    };
    m.customProgramCacheKey = () => 'vanta-splat-terrain';
    matCache.set(key, m);
    return m;
  }

  const waters = [];
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: 0x183a40, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.8,
    clearcoat: 0.6, clearcoatRoughness: 0.05, envMapIntensity: 0.75,
    normalMap: tex('rock_boulder_dry', 'nor_gl', false), normalScale: new THREE.Vector2(0.15, 0.15),
  });
  // Own copy of the normal map so it can scroll without moving the river-bed texture.
  waterMat.normalMap = waterMat.normalMap.clone(); waterMat.normalMap.repeat.set(0.08, 0.08);

  function addWorldUVs(geo, tile) {
    const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / tile; uv[i * 2 + 1] = p.getZ(i) / tile; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  // dressChunk(root, {ix, iz}?) — pass the chunk index; if omitted it is read from root.position (place the chunk first).
  // {splat:false} falls back to the old one-material-per-surface look.
  function dressChunk(root, opts = {}) {
    const ix = opts.ix ?? Math.round(root.position.x / 256), iz = opts.iz ?? Math.round(root.position.z / 256);
    const useSplat = opts.splat !== false;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.name.replace(/_\d+$/, '');
      if (SURFACES[n] && useSplat) {
        o.material = splatMaterial(ix, iz); o.receiveShadow = true; o.castShadow = false;
      } else if (SURFACES[n]) {
        // Chunk vertices are chunk-local x,z in [0,256]; 256 divides every tile size, so seams line up.
        addWorldUVs(o.geometry, SURFACES[n][1]);
        o.material = surfaceMaterial(n); o.receiveShadow = true; o.castShadow = false;
      } else if (/^Water/.test(n)) {
        addWorldUVs(o.geometry, 1); o.material = waterMaterial(root, ix, iz); o.receiveShadow = true; waters.push(o);
      } else if (/^Props/.test(n)) {
        o.castShadow = true; o.receiveShadow = true;
      }
    });
    return root;
  }

  // River depth per texel, read straight from the chunk's own render vertices (exact, no 16-bit PNG decode needed).
  function heightTexture(root) {
    const H = new Float32Array(129 * 129).fill(-100);
    root.traverse((o) => {
      if (!o.isMesh || !SURFACES[o.name.replace(/_\d+$/, '')]) return;
      const p = o.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const i = Math.round(p.getX(k) / 2), j = Math.round(p.getZ(k) / 2);
        if (i >= 0 && i < 129 && j >= 0 && j < 129) H[j * 129 + i] = Math.max(H[j * 129 + i], p.getY(k));
      }
    });
    // LOD1 chunks only have every 4th vertex: interpolate the gaps (rows, then columns) so the depth is not -100 m between them
    for (let j = 0; j < 129; j++) { let a = -1; for (let i = 0; i < 129; i++) { if (H[j * 129 + i] > -99) { if (a >= 0 && i - a > 1) for (let k = a + 1; k < i; k++) H[j * 129 + k] = H[j * 129 + a] + (H[j * 129 + i] - H[j * 129 + a]) * (k - a) / (i - a); a = i; } } }
    for (let i = 0; i < 129; i++) { let a = -1; for (let j = 0; j < 129; j++) { if (H[j * 129 + i] > -99) { if (a >= 0 && j - a > 1) for (let k = a + 1; k < j; k++) H[k * 129 + i] = H[a * 129 + i] + (H[j * 129 + i] - H[a * 129 + i]) * (k - a) / (j - a); a = j; } } }
    const half = new Uint16Array(H.length); for (let k = 0; k < H.length; k++) half[k] = THREE.DataUtils.toHalfFloat(H[k]);
    const t = new THREE.DataTexture(half, 129, 129, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
  }
  const waterUniforms = { uTime: { value: 0 } };
  function waterMaterial(root, ix, iz) {
    const m = waterMat.clone(); m.normalMap = waterMat.normalMap; // shared scrolling normal map
    m.color.set(0xffffff); m.opacity = 1;
    const hTex = heightTexture(root);
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uH: { value: hTex }, uWL: { value: waterLevel }, uTime: waterUniforms.uTime,
        uOrigin: { value: new THREE.Vector2(ix * 256, iz * 256) } });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWLocal = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          varying vec3 vWLocal; uniform sampler2D uH; uniform float uWL, uTime; uniform vec2 uOrigin;
          float wh(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(wh(i), wh(i+vec2(1,0)), f.x), mix(wh(i+vec2(0,1)), wh(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float depth = (vWLocal.y + 0.03) - texture2D(uH, (vWLocal.xz * 0.5 + 0.5) / 129.0).r; // water mesh height (rivers slope) minus terrain
          vec3 shallow = vec3(0.09, 0.075, 0.04), deep = vec3(0.008, 0.025, 0.022);   // silty shallows, murky green-teal depths
          diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 1.0, depth));
          vec2 wp = vWLocal.xz + uOrigin;
          float foamN = wn(wp * 1.7 + vec2(uTime * 0.6, 0.0)) * 0.6 + wn(wp * 4.3 - vec2(0.0, uTime * 0.4)) * 0.4;
          float foam = (1.0 - smoothstep(0.02, 0.16, depth)) * smoothstep(0.35, 0.75, foamN);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.8, 0.76), foam * 0.7);
          diffuseColor.a = smoothstep(-0.02, 0.25, depth) * mix(0.78, 0.97, smoothstep(0.0, 0.9, depth));`);
    };
    m.customProgramCacheKey = () => 'vanta-river-water';
    return m;
  }

  let t = 0;
  function update(dt) { t += dt; waterUniforms.uTime.value = t; waterMat.normalMap.offset.set(t * 0.012, t * 0.02); } // river drifts west to east
  return { dressChunk, update, surfaceMaterial };
}
