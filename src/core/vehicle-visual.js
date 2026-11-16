// Visual side of a vehicle (Parrot, src/core): loads Forma's glb exactly as shipped (no rotation of our own) and poses it
// from SpaceX's physics outputs: pose().modelPosition + quaternion for the body, wheelPoses()[i] for the four wheels.
// +Z is forward in both the model and the physics (Kimi's final call), so there is no rotation helper: the pose is used as is.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { materials } from '../render/index.js';
import { loadGlb } from './world.js';

const WHEEL_NAMES = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
const cache = new Map();

export async function loadVehicleModel(url) {
  if (!cache.has(url)) cache.set(url, loadGlb(new GLTFLoader(), url).then((g) => g.scene));
  return cache.get(url);
}

const qv = new THREE.Quaternion(), qi = new THREE.Quaternion(), v3 = new THREE.Vector3();

export function createVehicleVisual(template, colour) {
  const root = template.clone(true);
  materials.applyCarMaterials(root, colour);
  const group = new THREE.Group(); group.name = 'Vehicle';
  group.add(root);
  const wheels = WHEEL_NAMES.map((n) => root.getObjectByName(n));
  const missing = WHEEL_NAMES.filter((n, i) => !wheels[i]);
  if (missing.length) console.warn('vehicle model is missing wheel nodes:', missing.join(', '));
  /** pose = vehicle.pose(alpha), wp = vehicle.wheelPoses(alpha) */
  function update(pose, wp) {
    group.position.set(pose.modelPosition.x, pose.modelPosition.y, pose.modelPosition.z);
    group.quaternion.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
    qi.copy(group.quaternion).invert();
    wheels.forEach((w, i) => {
      if (!w) return;
      const p = wp[i];
      v3.set(p.position.x - group.position.x, p.position.y - group.position.y, p.position.z - group.position.z).applyQuaternion(qi);
      // wheel nodes are children of `root` (identity transform), so group-local == root-local
      w.position.copy(v3);
      qv.set(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w);
      w.quaternion.copy(qi).multiply(qv);
    });
  }
  return { group, root, wheels, update, dispose() { group.removeFromParent(); } };
}
