// Vanta — PBR material library. Forma's glTFs keep their geometry; we only swap materials by slot name.
import * as THREE from 'three';

export function carPaint(colour = 0xc81e1e) {
  return new THREE.MeshPhysicalMaterial({
    color: colour, metalness: 0.55, roughness: 0.35,
    clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.2,
  });
}
export const glass = () => new THREE.MeshPhysicalMaterial({
  color: 0x0d1418, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.55,
  clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 1.5,
}); // transparent instead of transmission: much cheaper with 8 cars on screen
export const tyre = () => new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.92, metalness: 0 });
export const rim = () => new THREE.MeshStandardMaterial({ color: 0xbfc3c7, roughness: 0.25, metalness: 1 });
export const chrome = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 1 });
export const plasticTrim = () => new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
export const headlight = () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: 2.5 });
export const tailLight = () => new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 1.2 });

export const asphalt = () => new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.88, metalness: 0 });
export const wetAsphalt = () => new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.25, metalness: 0.1 });
export const roadLine = () => new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
export const concrete = () => new THREE.MeshStandardMaterial({ color: 0x9a9893, roughness: 0.85 });
export const grass = () => new THREE.MeshStandardMaterial({ color: 0x4e7a33, roughness: 1 });

// Slot names Forma should use in Blender (case-insensitive substring match).
const SLOT_RULES = [
  [/body|paint/, (c) => carPaint(c)],
  [/glass|window/, glass],
  [/tyre|tire/, tyre],
  [/rim|wheel_metal/, rim],
  [/chrome/, chrome],
  [/trim|plastic/, plasticTrim],
  [/headlight/, headlight],
  [/tail|brake_light/, tailLight],
];

export function applyCarMaterials(root, colour) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const name = (o.material?.name || o.name || '').toLowerCase();
    const rule = SLOT_RULES.find(([re]) => re.test(name));
    if (!rule) return; // unknown slot: keep Forma's original material
    if (!cache.has(rule)) cache.set(rule, rule[1](colour));
    o.material = cache.get(rule);
  });
  return root;
}

// Off-road surfaces (S1/S2). Physics grip lives in Pixel's code; these are the looks that match each surface.
export const mud = () => new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.35, metalness: 0 }); // wet sheen
export const dirt = () => new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.95 });
export const gravel = () => new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9 });
export const sand = () => new THREE.MeshStandardMaterial({ color: 0xd8bf8a, roughness: 0.97 });
export const snow = () => new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.55 });
export const rock = () => new THREE.MeshStandardMaterial({ color: 0x6d6a66, roughness: 0.85, flatShading: true });
export const water = () => new THREE.MeshPhysicalMaterial({
  color: 0x1d3a44, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.78,
  clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4,
});
// Terrain uses vertex colours so one mesh (one draw call) can blend grass, dirt, mud, rock and snow.
export const terrain = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
