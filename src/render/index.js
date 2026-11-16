// Vanta — render module public API (see architecture.md "One repo, one build").
// Usage on the TV:
//   const r = createRenderer(canvas);            // also builds sky, sun, moon, fog on r.scene
//   setViews(2); setTimeOfDay(18.2); setWeather(0.3); setTier('medium');
//   each frame: renderFrame([cam1, cam2], [pos1, pos2], dt)
import * as THREE from 'three';
import { createRenderer as makeGL, createAutoQuality, QUALITY } from './render-setup.js';
import { createTimeOfDay } from './time-of-day.js';
import { createPost } from './post.js';
export * as materials from './materials.js';

const R = { gl: null, scene: null, tod: null, views: 1, hours: 12, weather: 0, tier: 'high', auto: null, autoOn: true, post: null, focus: new THREE.Vector3(), lastPR: 0 };

export function createRenderer(canvas, { scene = new THREE.Scene(), tier = 'high', hours = 12 } = {}) {
  R.tier = tier; R.hours = hours; R.scene = scene;
  R.gl = makeGL(canvas, tier);
  R.tod = createTimeOfDay(scene, R.gl);
  R.auto = createAutoQuality(R.gl, R.tod.sun);
  R.gl.setScissorTest(true);
  R.post = createPost(R.gl, tier);
  return { renderer: R.gl, scene, timeOfDay: R.tod };
}

export function setViews(n) { R.views = Math.max(1, Math.min(4, n | 0)); }
export function setTimeOfDay(h) { R.hours = ((h % 24) + 24) % 24; }
export function setWeather(w) { R.weather = THREE.MathUtils.clamp(w, 0, 1); }
export function setTier(t) {
  if (!QUALITY[t]) throw new Error(`Unknown tier ${t}`);
  R.tier = t; const q = QUALITY[t];
  R.gl.vantaTier = t;
  R.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioMax));
  R.gl.shadowMap.enabled = q.shadows;
  R.tod.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
  if (R.tod.sun.shadow.map) { R.tod.sun.shadow.map.dispose(); R.tod.sun.shadow.map = null; }
  R.post.setTier(t);
}
export function setAutoQuality(on) { R.autoOn = !!on; }
export const getState = () => ({ views: R.views, hours: R.hours, weather: R.weather, tier: R.tier });

// Split-screen layouts in CSS pixels: 1 full, 2 side by side, 3–4 a 2x2 grid (4th cell empty with 3 players).
function viewports(n, w, h) {
  if (n === 1) return [[0, 0, w, h]];
  if (n === 2) return [[0, 0, w / 2, h], [w / 2, 0, w / 2, h]];
  const cells = [[0, h / 2, w / 2, h / 2], [w / 2, h / 2, w / 2, h / 2], [0, 0, w / 2, h / 2], [w / 2, 0, w / 2, h / 2]];
  return cells.slice(0, n);
}

// cameras: one per view. focuses: player positions, focuses[i] belongs to cameras[i]. dt in seconds.
// The sun's shadow box is re-centred on each view's own car before that view draws, so 4 players far apart
// all get sharp shadows (one shadow pass per view on tiers with shadows).
const _sunOff = new THREE.Vector3();
export function renderFrame(cameras, focuses = [], dt = 1 / 60) {
  const gl = R.gl, size = gl.getSize(new THREE.Vector2());
  R.focus.set(0, 0, 0); focuses.forEach((p) => R.focus.add(p)); if (focuses.length) R.focus.divideScalar(focuses.length);
  R.tod.update(R.hours, R.focus, R.weather, dt);
  if (R.autoOn) R.auto(dt);
  if (gl.getPixelRatio() !== R.lastPR) { R.lastPR = gl.getPixelRatio(); R.post.setSize(size.x, size.y); }
  const n = Math.min(R.views, cameras.length), vps = viewports(R.views, size.x, size.y);
  const sun = R.tod.sun; _sunOff.subVectors(sun.position, sun.target.position);
  const draw = (target) => {
    const pr = target ? gl.getPixelRatio() : 1;
    gl.setRenderTarget(target);
    const setVS = (x, y, w, h) => {
      if (target) { target.viewport.set(x * pr, y * pr, w * pr, h * pr); target.scissor.set(x * pr, y * pr, w * pr, h * pr); target.scissorTest = true; }
      else { gl.setViewport(x, y, w, h); gl.setScissor(x, y, w, h); }
    };
    setVS(0, 0, size.x, size.y); gl.setClearColor(0x000000); gl.clear();
    for (let i = 0; i < n; i++) {
      const [x, y, w, h] = vps[i], cam = cameras[i];
      if (cam.aspect !== w / h) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
      const f = focuses[i] || R.focus; sun.target.position.copy(f); sun.position.copy(f).add(_sunOff);
      sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
      setVS(x, y, w, h);
      gl.render(R.scene, cam);
    }
    if (target) target.scissorTest = false;
  };
  gl.setViewport(0, 0, size.x, size.y); gl.setScissor(0, 0, size.x, size.y);
  if (R.post.active) R.post.render(draw, R.views === 1 ? [1, 1] : R.views === 2 ? [2, 1] : [2, 2]);
  else draw(null);
}

export function resize(w, h) { R.gl.setSize(w, h, false); R.post.setSize(w, h); }
