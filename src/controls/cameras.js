// Camera rig: chase, close chase, cab (first person) and free-look. Spring-damped, no shake.
// Look input (input.look {x,y} -1..1) turns the view; after 2 s with no look input it eases back behind the car.
//   const rig = createCameraRig(camera, { forward: new THREE.Vector3(0,0,1) }   // the physics body's forward axis: +Z (Kimi's final call, glTF standard));
//   each frame: rig.update(dt, pose, input.look);  pose = { position: {x,y,z}, quaternion: {x,y,z,w} } (physics pose())
//   on input.cam rising edge: rig.next();   keep it above the ground: rig.update(dt, pose, look, heightAt)
// Full freedom of camera (BRIEF Requirement 4):
//   orbit    look.x turns the view a full 360 deg around the car, look.y pitches it (PITCH_MIN..PITCH_MAX). chase/closeChase/cab ease back behind the car after 2 s idle; freeLook never does.
//   glance   rig.update(dt, pose, look, heightAt, { glance: 'back'|'left'|'right'|null }): while held the view swings to that side (spring, ~0.2 s) and returns when released.
//   zoom     rig.update(..., { zoom: -1..1 }) is a rate, same sign as net protocol.js (-1 = in/close, +1 = out/far, ZOOM_RATE ln-units/s); rig.zoomBy(ln) for one-shot wheel/pinch steps. Third-person only, clamped to ZOOM_MIN..ZOOM_MAX x the mode's distance.
//   fp/tp    rig.camInput(input.cam) each frame: 'next' cycles the cameras, 'view' toggles first/third person (cab <-> the last third-person mode), one action per pulse edge.
//            rig.toggleFirstPerson() / rig.next() are the direct calls.
import * as THREE from 'three';
import { CAMERA_MODES } from '../data/settings.js';
import { ZOOM_RATE } from './input.js';

export { CAMERA_MODES };
export const CAMERA_LABELS = { chase: 'Chase', closeChase: 'Close chase', cab: 'First person', freeLook: 'Free look' };
const RIG = { chase: { dist: 9, height: 3, aim: 1.2, fov: 60 }, closeChase: { dist: 5.6, height: 1.9, aim: 1.0, fov: 65 }, freeLook: { dist: 10, height: 1.5, aim: 1.0, fov: 60 } };
const RETURN_AFTER = 2; // seconds of no look input before the view eases back
export const PITCH_MIN = -0.6, PITCH_MAX = 1.1;          // radians of orbit pitch (third person: camera elevation = 0.2 + pitch)
export const ZOOM_MIN = 0.6, ZOOM_MAX = 2.2;             // third-person distance scale (1 = the mode's default distance)
export const GLANCE_YAW = { back: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 }; // view direction relative to the car's heading
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// critically damped spring step (no overshoot, so no wobble/shake)
function spring(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, det = 1 / (f + hhoo);
  const nx = (f * x + dt * v + hhoo * target) * det, nv = (v + hoo * (target - x)) * det;
  return [nx, nv];
}

export function createCameraRig(camera, { forward = new THREE.Vector3(0, 0, 1), driverEye = new THREE.Vector3(0, 1.35, 0.1), mode: m0 = 'chase', fov = 70 } = {}) {
  let mode = CAMERA_MODES.includes(m0) ? m0 : 'chase';
  let yaw = 0, pitch = 0, idle = 99, heading = 0, first = true, baseFov = fov, zoom = 1, gy = 0, gv = 0, lastThird = mode === 'cab' ? 'chase' : mode;
  const pos = new THREE.Vector3(), vel = new THREE.Vector3(), aim = new THREE.Vector3();
  const q = new THREE.Quaternion(), fwd = new THREE.Vector3(), tmp = new THREE.Vector3(), target = new THREE.Vector3();
  let hv = 0, lastCam = null;

  return {
    get mode() { return mode; }, get label() { return CAMERA_LABELS[mode]; },
    setMode(m) { if (CAMERA_MODES.includes(m)) { mode = m; if (m !== 'cab') lastThird = m; yaw = 0; pitch = 0; first = true; } return mode; },
    /** First person (cab) <-> the last third-person mode you were in (chase by default). Returns the new mode. */
    toggleFirstPerson() { return this.setMode(mode === 'cab' ? lastThird : 'cab'); },
    get firstPerson() { return mode === 'cab'; },
    /** Feed input.cam every frame (the host does the same): one action per rising edge, also when the value switches next <-> view. 'next' -> next(), 'view' -> toggleFirstPerson(). Returns what it did. */
    camInput(cam) {
      const edge = (cam === 'next' || cam === 'view') && cam !== lastCam; lastCam = cam || null;
      if (!edge) return null;
      if (cam === 'view') { this.toggleFirstPerson(); return 'view'; }
      this.next(); return 'next';
    },
    /** Third-person distance scale, ZOOM_MIN..ZOOM_MAX (1 = default). Ignored in cab. */
    get zoom() { return zoom; },
    setZoom(z) { zoom = THREE.MathUtils.clamp(+z || 1, ZOOM_MIN, ZOOM_MAX); return zoom; },
    /** One-shot zoom in ln-units (positive = in): a mouse-wheel notch is ~0.15, a pinch adds its own. */
    zoomBy(ln) { return this.setZoom(zoom * Math.exp(-ln)); },
    /** Orbit state for tests and HUD: yaw (rad, 0 = straight behind/ahead, unbounded), pitch (rad), glance offset (rad). */
    get view() { return { yaw, pitch, glance: gy }; },
    next() { return this.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(mode) + 1) % CAMERA_MODES.length]); },
    setFov(f) { baseFov = f; },
    /** Mouse drag on a laptop: radians. */
    lookBy(dYaw, dPitch) { yaw -= dYaw; pitch = THREE.MathUtils.clamp(pitch + dPitch, PITCH_MIN, PITCH_MAX); idle = 0; },
    snap() { first = true; },
    update(dt, pose, look = null, heightAt = null, { zoom: zoomRate = 0, glance = null } = {}) {
      dt = Math.min(dt, 0.1);
      if (look && (look.x || look.y)) { yaw -= look.x * dt * 2.4; pitch = THREE.MathUtils.clamp(pitch + look.y * dt * 1.6, PITCH_MIN, PITCH_MAX); idle = 0; }
      else idle += dt;
      if (idle > RETURN_AFTER && mode !== 'freeLook') { yaw = wrapPi(yaw); const k = 1 - Math.exp(-dt * 2.2); yaw -= yaw * k; pitch -= pitch * k; } // shortest way back; free-look stays where you left it
      if (zoomRate && mode !== 'cab') { const r = THREE.MathUtils.clamp(+zoomRate || 0, -1, 1); zoom = THREE.MathUtils.clamp(zoom * Math.exp(r * ZOOM_RATE * dt), ZOOM_MIN, ZOOM_MAX); }
      const gt = glance && glance in GLANCE_YAW ? GLANCE_YAW[glance] : 0; // glance swings the view without touching the orbit state
      if (first) { gy = gt; gv = 0; } else [gy, gv] = spring(gy, gv, gt, 16, dt);

      const p = pose.position; q.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
      fwd.copy(forward).applyQuaternion(q);
      const h = Math.atan2(fwd.z, fwd.x);
      if (first) { heading = h; hv = 0; }
      else { // spring the heading so quick wiggles don't swing the camera
        let d = h - heading; d = Math.atan2(Math.sin(d), Math.cos(d));
        [heading, hv] = spring(heading, hv, heading + d, 4.5, dt);
      }

      if (mode === 'cab') {
        pos.copy(driverEye).applyQuaternion(q).add(tmp.set(p.x, p.y, p.z));
        camera.position.copy(pos);
        const pitch0 = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
        const a = h + yaw + gy, el = pitch0 - pitch * 0.8;
        aim.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).add(pos);
        camera.up.set(0, 1, 0); camera.lookAt(aim);
        camera.fov = baseFov + 4; camera.near = 0.05;
      } else {
        const r = RIG[mode];
        const a = heading + Math.PI + yaw + gy, el = 0.2 + pitch, dist = r.dist * zoom;
        target.set(p.x + Math.cos(a) * Math.cos(el) * dist, p.y + r.height * zoom + Math.sin(el) * dist * 0.5, p.z + Math.sin(a) * Math.cos(el) * dist);
        if (first) { pos.copy(target); vel.set(0, 0, 0); }
        else for (const k of ['x', 'y', 'z']) [pos[k], vel[k]] = spring(pos[k], vel[k], target[k], 7, dt);
        if (heightAt) { const gy = heightAt(pos.x, pos.z) + 0.6; if (pos.y < gy) { pos.y = gy; vel.y = Math.max(0, vel.y); } }
        camera.position.copy(pos);
        camera.up.set(0, 1, 0); camera.lookAt(aim.set(p.x, p.y + r.aim, p.z));
        camera.fov = r.fov * (baseFov / 70); camera.near = 0.1;
      }
      camera.updateProjectionMatrix();
      first = false;
    },
  };
}
