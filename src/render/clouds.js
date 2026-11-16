// Vanta — procedural cloud layer: one large dome, fbm noise projected onto a flat cloud deck ~1.5 km up.
// Lit by the sun colour with darker bases and silver edges toward the sun; coverage rises with weather.
import * as THREE from 'three';

export function createClouds(scene) {
  const uniforms = {
    uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.6, 0.7, 0.85) }, uCover: { value: 0.5 }, uDay: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99999; }`,
    fragmentShader: `uniform float uTime, uCover, uDay; uniform vec3 uSunDir, uSunCol, uAmbient; varying vec3 vDir;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float a = 0.5, s = 0.0; mat2 r = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 6; i++){ s += a * n(p); p = r * p; a *= 0.5; } return s; }
      void main(){
        vec3 d = normalize(vDir); if (d.y < 0.01) discard;
        vec2 p = d.xz / (d.y + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
        float base = fbm(p), detail = fbm(p * 3.1 + 7.0);
        float dens = smoothstep(1.0 - uCover, 1.0 - uCover + 0.32, base * 0.8 + detail * 0.28);
        if (dens < 0.003) discard;
        float lit = clamp(fbm(p + uSunDir.xz * 0.12) - base + 0.55, 0.0, 1.0);   // brighter on the sun side of each cloud
        float toSun = pow(max(dot(d, uSunDir), 0.0), 8.0);
        vec3 col = mix(mix(uAmbient, vec3(0.78, 0.8, 0.84), 0.6), uSunCol * (1.15 + 0.8 * toSun), lit) * mix(1.05, 0.7, dens * 0.6);
        col *= mix(0.06, 1.0, uDay);
        float horizon = smoothstep(0.01, 0.16, d.y);
        gl_FragColor = vec4(col, dens * horizon * 0.95);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4500, 48, 24), mat);
  dome.renderOrder = -1; dome.frustumCulled = false; scene.add(dome);
  return {
    mesh: dome,
    update(dt, focus, sunDir, sunCol, ambient, dayF, weather) {
      uniforms.uTime.value += dt; dome.position.copy(focus);
      uniforms.uSunDir.value.copy(sunDir); uniforms.uSunCol.value.copy(sunCol); uniforms.uAmbient.value.copy(ambient);
      uniforms.uDay.value = dayF; uniforms.uCover.value = THREE.MathUtils.lerp(0.5, 0.92, weather);
    },
  };
}
