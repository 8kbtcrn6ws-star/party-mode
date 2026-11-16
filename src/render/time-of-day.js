// Vanta — time of day for the open world: sky, sun, moon, stars, fog, exposure and sky reflections.
// One call per frame: tod.update(hours, focusPosition). Hours 0..24 (6 = sunrise, 12 = noon, 18.5 = sunset).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { QUALITY } from './render-setup.js';
import { createClouds } from './clouds.js';

const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp, smooth = THREE.MathUtils.smoothstep;
const C = (h) => new THREE.Color(h);
// Colour keys by sun elevation (degrees). Interpolated each frame.
const KEYS = [
  { e: -18, sun: C(0x000000), sky: C(0x05070f), fog: C(0x070a14), hemiS: C(0x1a2340), hemiG: C(0x05060a) },
  { e: -4,  sun: C(0x000000), sky: C(0x1b2440), fog: C(0x262c45), hemiS: C(0x2c3658), hemiG: C(0x0c0c12) },
  { e: 2,   sun: C(0xff7a3a), sky: C(0xf09a6a), fog: C(0xd99a7a), hemiS: C(0xf0a080), hemiG: C(0x3a2a22) },
  { e: 10,  sun: C(0xffb877), sky: C(0xe8c8a8), fog: C(0xd8c8b8), hemiS: C(0xcfd8f0), hemiG: C(0x4a3f33) },
  { e: 30,  sun: C(0xffe6c4), sky: C(0xbcd4ec), fog: C(0xc4d6e6), hemiS: C(0xbfd6ff), hemiG: C(0x4a3f33) },
  { e: 90,  sun: C(0xffffff), sky: C(0xa8c8ec), fog: C(0xbcd2e8), hemiS: C(0xbfd6ff), hemiG: C(0x4a3f33) },
];
function sample(e, key) {
  if (e <= KEYS[0].e) return KEYS[0][key].clone();
  for (let i = 1; i < KEYS.length; i++) if (e <= KEYS[i].e) {
    const a = KEYS[i - 1], b = KEYS[i]; return a[key].clone().lerp(b[key], (e - a.e) / (b.e - a.e));
  }
  return KEYS[KEYS.length - 1][key].clone();
}

export function createTimeOfDay(scene, renderer, { latitudeTilt = 35, haze = 0.00042 } = {}) {
  const q = QUALITY[renderer.vantaTier || 'high'];

  const sky = new Sky(); sky.scale.setScalar(10000); scene.add(sky);
  const su = sky.material.uniforms; su.mieDirectionalG.value = 0.82;

  // Stars: fixed points on a large dome, faded in at night. Cheap: one draw call.
  const starGeo = new THREE.BufferGeometry(); const N = 2500, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const v = new THREE.Vector3().randomDirection(); v.y = Math.abs(v.y); v.multiplyScalar(4000); pos.set([v.x, v.y, v.z], i * 3); }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(stars);

  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.castShadow = q.shadows;
  sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 500 }); // per-view box, see index.js
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  const moon = new THREE.DirectionalLight(0x9db4ff, 0); // soft blue moonlight, no shadows (saves a pass)
  const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x4a3f33, 0.35);
  scene.add(sun, sun.target, moon, moon.target, hemi);
  // Exponential haze: ~18% at 1 km, ~55% at 2 km, so distant mountains stay visible but read as far away.
  scene.fog = new THREE.FogExp2(0xc4d6e6, haze);
  const clouds = createClouds(scene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); const envSky = new Sky(); envSky.scale.setScalar(10000); envScene.add(envSky);
  let envRT = null, lastEnvElev = 999;
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
  const state = { hours: 12, elevation: 0, weather: 0 };

  function update(hours, focus = new THREE.Vector3(), weather = 0, dt = 1 / 60) {
    state.hours = hours; state.weather = weather; // weather 0 clear .. 1 overcast/rain (S7 hooks into this)
    const dayAngle = (hours - 6) / 24 * Math.PI * 2;      // 6h horizon east, 12h top, 18h horizon west
    const elev = Math.asin(Math.sin(dayAngle) * Math.cos(THREE.MathUtils.degToRad(latitudeTilt)));
    const elevDeg = THREE.MathUtils.radToDeg(elev); state.elevation = elevDeg;
    const az = Math.PI * 0.5 + dayAngle;                  // sweeps east to west
    sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev) * 0.6).normalize();
    moonDir.copy(sunDir).negate(); if (moonDir.y < 0.25) moonDir.y = 0.25; moonDir.normalize();

    const turb = lerp(elevDeg < 8 ? 10 : 3, 18, weather);
    su.turbidity.value = turb; su.rayleigh.value = lerp(elevDeg < 8 ? 2.6 : 1.4, 0.5, weather);
    su.mieCoefficient.value = lerp(0.004, 0.02, weather); su.sunPosition.value.copy(sunDir);

    const dayF = smooth(elevDeg, -6, 4);                   // 0 night, 1 day
    sun.color.copy(sample(elevDeg, 'sun'));
    sun.intensity = 3.8 * smooth(elevDeg, -1, 12) * lerp(1, 0.25, weather);
    sun.position.copy(focus).addScaledVector(sunDir, 150); sun.target.position.copy(focus);
    sun.castShadow = q.shadows && !sun.userData.shadowsOff && sun.intensity > 0.05;
    moon.intensity = 0.9 * (1 - dayF); moon.position.copy(focus).addScaledVector(moonDir, 150); moon.target.position.copy(focus);
    hemi.color.copy(sample(elevDeg, 'hemiS')); hemi.groundColor.copy(sample(elevDeg, 'hemiG'));
    hemi.intensity = lerp(0.4, 0.42, dayF) + 0.4 * weather;
    const fogC = sample(elevDeg, 'fog').lerp(C(0x8a9098).multiplyScalar(lerp(0.15, 1, dayF)), weather * 0.7);
    scene.fog.color.copy(fogC); scene.fog.density = lerp(haze, haze * 6, weather * weather);
    clouds.update(dt, focus, sunDir, sun.color.clone().multiplyScalar(1.2).lerp(C(0xffffff), 0.3), hemi.color, dayF, weather);
    sky.visible = dayF > 0.01; scene.background = sky.visible ? null : fogC; // Sky shader goes black-noisy below horizon
    stars.material.opacity = (1 - smooth(elevDeg, -12, -2)) * (1 - weather);
    renderer.toneMappingExposure = lerp(1.5, 0.62, dayF);   // let eyes 'adjust' at night so it's dark but readable

    // Re-bake sky reflections only when the sun moved ~1.5° (a full day = a few hundred bakes, not one per frame).
    if (Math.abs(elevDeg - lastEnvElev) > 1.5 || envRT === null) {
      const eu = envSky.material.uniforms; for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) eu[k].value = su[k].value;
      eu.sunPosition.value.copy(sunDir); envScene.background = sky.visible ? null : fogC; envSky.visible = sky.visible;
      const next = pmrem.fromScene(envScene, 0.03); if (envRT) envRT.dispose(); envRT = next;
      scene.environment = envRT.texture; scene.environmentIntensity = lerp(0.12, 0.55, dayF);
      lastEnvElev = elevDeg;
    }
  }
  return { update, sun, moon, hemi, sky, stars, clouds, state };
}
