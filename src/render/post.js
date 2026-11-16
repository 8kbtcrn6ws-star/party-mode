// Vanta — full-screen post for split screen. All views render into ONE HDR target, then bloom + colour grade
// run once over the whole screen, so the post cost does not grow with the number of players.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Warm outdoor grade in linear HDR, before tone mapping: white balance, saturation, soft contrast, vignette.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uWarm: { value: new THREE.Vector3(1.04, 1.0, 0.94) }, uSat: { value: 1.1 },
    uContrast: { value: 1.06 }, uVignette: { value: 0.22 }, uGrid: { value: new THREE.Vector2(1, 1) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 uWarm; uniform float uSat, uContrast, uVignette; uniform vec2 uGrid; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb * uWarm;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = pow(max(c, 0.0) / 0.18, vec3(uContrast)) * 0.18;           // contrast pivoting on mid grey
      vec2 cell = fract(vUv * uGrid) - 0.5;                           // vignette per split-screen cell
      c *= 1.0 - uVignette * smoothstep(0.25, 0.75, dot(cell, cell) * 2.0);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

class ViewsPass extends Pass {
  constructor() { super(); this.needsSwap = false; this.draw = null; }
  render(renderer, writeBuffer, readBuffer) { this.draw(this.renderToScreen ? null : readBuffer); }
}

export const POST = {
  high:   { enabled: true, bloom: 0.22, bloomRes: 0.5, msaa: 4 },
  medium: { enabled: true, bloom: 0.18, bloomRes: 0.25, msaa: 0 },
  low:    { enabled: false },
};

export function createPost(renderer, tier = 'high') {
  let cfg = POST[tier], composer = null, views, bloom, grade;
  function build() {
    if (composer) { composer.dispose(); composer = null; }
    if (!cfg.enabled) return;
    const size = renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: cfg.msaa });
    composer = new EffectComposer(renderer, rt);
    views = new ViewsPass();
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x * cfg.bloomRes, size.y * cfg.bloomRes), cfg.bloom, 0.5, 2.2); // HDR threshold: only sun glints, sky near the sun and lights bloom
    grade = new ShaderPass(GradeShader);
    composer.addPass(views); composer.addPass(bloom); composer.addPass(grade); composer.addPass(new OutputPass());
    setSize(size.x, size.y);
  }
  function setSize(w, h) {
    if (!composer) return;
    composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h);
    bloom.resolution.set(w * cfg.bloomRes, h * cfg.bloomRes); bloom.setSize(w * cfg.bloomRes * renderer.getPixelRatio(), h * cfg.bloomRes * renderer.getPixelRatio());
  }
  build();
  return {
    get active() { return !!composer; },
    target() { return composer ? composer.readBuffer : null; },
    // draw(target) must render every view into `target` (null = screen); grid = split-screen cells for the vignette.
    render(draw, grid = [1, 1]) { views.draw = draw; grade.uniforms.uGrid.value.set(grid[0], grid[1]); composer.render(); },
    setSize, setTier(t) { cfg = POST[t]; build(); },
  };
}
