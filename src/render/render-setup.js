// Vanta — TV render baseline for Party Mode (Three.js r170, free, no paid assets).
// Goal: good-looking real-time PBR on a big screen at a steady 60 fps with up to 8 cars.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export const QUALITY = {
  high:   { pixelRatioMax: 2,    shadowMap: 2048, shadows: true,  antialias: true },
  medium: { pixelRatioMax: 1.5,  shadowMap: 1024, shadows: true,  antialias: true },
  low:    { pixelRatioMax: 1,    shadowMap: 512,  shadows: false, antialias: false },
};

export function createRenderer(canvas, tier = 'high') {
  const q = QUALITY[tier];
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioMax));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.vantaTier = tier; // WebGLRenderer has no userData
  return renderer;
}

// Sky + sun + image-based lighting generated from the sky (no HDRI download needed).
export function setupLighting(scene, renderer, { elevation = 28, azimuth = 140 } = {}) {
  const q = QUALITY[renderer.vantaTier || 'high'];

  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms;
  u.turbidity.value = 6; u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth));
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // Bake the sky once into a PMREM environment map: gives reflections on paint/glass for free each frame.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow = q.shadows;
  sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  const s = sun.shadow.camera; s.left = -60; s.right = 60; s.top = 60; s.bottom = -60; s.near = 1; s.far = 400;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const fill = new THREE.HemisphereLight(0xbfd6ff, 0x4a3f33, 0.35);
  scene.add(fill);

  scene.fog = new THREE.Fog(0xc9d8e6, 150, 700);

  // Keep the shadow box centred on the action (e.g. the centroid of all cars) so one 2K map covers it sharply.
  function followShadows(focus) {
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 120);
  }
  return { sky, sun, fill, followShadows, sunDir };
}

// Drops resolution, then shadows, if the TV can't hold ~60 fps; recovers when there's headroom.
export function createAutoQuality(renderer, sun) {
  let acc = 0, frames = 0, scale = 1;
  const base = renderer.getPixelRatio();
  return function tick(dt) {
    acc += dt; frames++;
    if (acc < 1) return;
    const fps = frames / acc; acc = 0; frames = 0;
    if (fps < 55 && scale > 0.6) scale -= 0.1;
    else if (fps < 50 && !sun.userData.shadowsOff) { sun.userData.shadowsOff = true; sun.castShadow = false; }
    else if (fps > 59 && scale < 1) scale = Math.min(1, scale + 0.05);
    renderer.setPixelRatio(base * scale);
  };
}
