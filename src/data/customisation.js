// Customisation catalogue (paints, wheels, 3 accessory slots) and the helper that merges effects into vehicle stats.
//
// Asset-name convention proposed for Forma/Vanta (documented in README.md, to be confirmed by them):
//   paint    -> material "Body" colour (+ roughness/metalness from `finish`)
//   wheels   -> node "WheelVariant_<wheelId>" shown on all four Wheel_FL/FR/RL/RR hubs (stock = the model's default wheels)
//   accessory-> node "Acc_<accessoryId>", visible when fitted
import { HEX_RE, isObj, isId, deepClone } from './util.js';

export const ACCESSORY_SLOTS = ['roof', 'front', 'rear'];   // exactly 3 slots per vehicle (architecture.md)
export const PAINT_FINISHES = ['gloss', 'matte', 'metallic'];

export const PAINTS = Object.freeze([
  { id: 'forest',  name: 'Forest Green', hex: '#2f5d3a', finish: 'gloss' },
  { id: 'sand',    name: 'Dune Sand',    hex: '#c9ae7c', finish: 'matte' },
  { id: 'rust',    name: 'Rust Orange',  hex: '#b5541f', finish: 'gloss' },
  { id: 'ice',     name: 'Glacier White', hex: '#e8eef2', finish: 'gloss' },
  { id: 'sunset',  name: 'Sunset Red',   hex: '#c23a2b', finish: 'metallic' },
  { id: 'slate',   name: 'Slate Grey',   hex: '#4d555c', finish: 'matte' },
  { id: 'lake',    name: 'Lake Blue',    hex: '#2c6e9b', finish: 'metallic' },
  { id: 'night',   name: 'Night Black',  hex: '#16181b', finish: 'gloss' },
].map(Object.freeze));

// Effects: massKg (+/-), dragMult, wadeDepthAddM, gripMult, sideGripMult, rollingMult, topSpeedMult, radiusMult,
// surfaceGrip {surface: mult}. All optional; absent = neutral.
export const WHEELS = Object.freeze([
  { id: 'stock',       name: 'Stock',          effects: {} },
  { id: 'all-terrain', name: 'All-terrain',    effects: { massKg: 16, gripMult: 1.04, rollingMult: 1.04, radiusMult: 1.03 } },
  { id: 'mud-terrain', name: 'Mud-terrain',    effects: { massKg: 28, gripMult: 0.96, rollingMult: 1.12, radiusMult: 1.07, topSpeedMult: 0.97, surfaceGrip: { mud: 1.25, snow: 1.12, gravel: 1.05 } } },
  { id: 'sand-paddle', name: 'Wide sand',      effects: { massKg: 20, rollingMult: 0.9, surfaceGrip: { sand: 1.3 }, topSpeedMult: 0.98 } },
  { id: 'road-alloy',  name: 'Road alloy',     effects: { massKg: -12, gripMult: 1.05, rollingMult: 0.88, radiusMult: 0.96, surfaceGrip: { mud: 0.8, sand: 0.85, snow: 0.9 } } },
].map(Object.freeze));

export const ACCESSORIES = Object.freeze([
  { id: 'roof-rack',    slot: 'roof',  name: 'Roof rack',     effects: { massKg: 30, dragMult: 1.05 } },
  { id: 'light-bar',    slot: 'roof',  name: 'Light bar',     effects: { massKg: 8, dragMult: 1.01 } },
  { id: 'roof-tent',    slot: 'roof',  name: 'Roof tent',     effects: { massKg: 55, dragMult: 1.12, topSpeedMult: 0.98 } },
  { id: 'bull-bar',     slot: 'front', name: 'Bull bar',      effects: { massKg: 35, dragMult: 1.02 } },
  { id: 'winch',        slot: 'front', name: 'Winch',         effects: { massKg: 45 } },
  { id: 'snorkel',      slot: 'front', name: 'Snorkel',       effects: { massKg: 4, wadeDepthAddM: 0.3 } },
  { id: 'spare-wheel',  slot: 'rear',  name: 'Spare wheel',   effects: { massKg: 30, dragMult: 1.01 } },
  { id: 'jerry-cans',   slot: 'rear',  name: 'Jerry cans',    effects: { massKg: 25 } },
  { id: 'rear-ladder',  slot: 'rear',  name: 'Rear ladder',   effects: { massKg: 12, dragMult: 1.01 } },
].map(Object.freeze));

export const defaultCatalogue = () => ({ paints: PAINTS, wheels: WHEELS, accessories: ACCESSORIES });

const byId = (list) => new Map(list.map((x) => [x.id, x]));

/** Resolve a paint reference (catalogue id or '#rrggbb') -> { id|null, hex, finish, name } or null. */
export function resolvePaint(ref, cat = defaultCatalogue()) {
  if (typeof ref !== 'string') return null;
  const p = cat.paints.find((x) => x.id === ref);
  if (p) return { id: p.id, hex: p.hex, finish: p.finish, name: p.name };
  if (HEX_RE.test(ref)) return { id: null, hex: ref.toLowerCase(), finish: 'gloss', name: 'Custom' };
  return null;
}

/** Customisation for one vehicle as stored: { paint, wheels, accessories: [roof, front, rear] (id|null) }. */
export function defaultCustomisation(vehicle, cat = defaultCatalogue()) {
  const def = vehicle?.appearance?.defaultPaint;
  return { paint: cat.paints.some((p) => p.id === def) ? def : cat.paints[0].id, wheels: 'stock', accessories: [null, null, null] };
}

/** Make any input a valid customisation for `vehicle`: unknown/mismatched entries fall back to defaults. */
export function sanitizeCustomisation(raw, vehicle, cat = defaultCatalogue()) {
  const d = defaultCustomisation(vehicle, cat);
  const r = isObj(raw) ? raw : {};
  const paint = resolvePaint(r.paint, cat) ? (cat.paints.some((p) => p.id === r.paint) ? r.paint : r.paint.toLowerCase()) : d.paint;
  const wheels = cat.wheels.some((w) => w.id === r.wheels) ? r.wheels : d.wheels;
  const acc = byId(cat.accessories);
  const accessories = ACCESSORY_SLOTS.map((slot, i) => {
    const id = Array.isArray(r.accessories) ? r.accessories[i] : null;
    const a = isId(id) ? acc.get(id) : null;
    return a && a.slot === slot ? id : null;
  });
  return { paint, wheels, accessories };
}

/**
 * Merge a customisation's effects into a vehicle. Returns:
 *  { stats: <deep copy of vehicle with effects applied>, appearance: { paint, wheels:{id,node}, accessories:[{slot,id,node}] }, effects }
 * Mass adds up; tyre grip/rolling multiply; per-surface grip multiplies; drag multiplies; wade depth adds;
 * top speed multiplies; wheel radius multiplies (so launch force falls as tyres grow, as in real life).
 */
export function applyCustomisation(vehicle, custom, cat = defaultCatalogue()) {
  const c = sanitizeCustomisation(custom, vehicle, cat);
  const wheel = cat.wheels.find((w) => w.id === c.wheels);
  const accs = c.accessories.map((id) => (id ? cat.accessories.find((a) => a.id === id) : null));
  const all = [wheel.effects, ...accs.map((a) => a?.effects || {})];

  const total = { massKg: 0, dragMult: 1, wadeDepthAddM: 0, gripMult: 1, sideGripMult: 1, rollingMult: 1, topSpeedMult: 1, radiusMult: 1, surfaceGrip: {} };
  for (const e of all) {
    total.massKg += e.massKg || 0;
    total.wadeDepthAddM += e.wadeDepthAddM || 0;
    for (const k of ['dragMult', 'gripMult', 'sideGripMult', 'rollingMult', 'topSpeedMult', 'radiusMult']) total[k] *= e[k] ?? 1;
    for (const [s, m] of Object.entries(e.surfaceGrip || {})) total.surfaceGrip[s] = (total.surfaceGrip[s] ?? 1) * m;
  }

  const stats = deepClone(vehicle);
  stats.body.massKg = Math.max(1, stats.body.massKg + total.massKg);
  stats.wheels.radius *= total.radiusMult;
  stats.tyres.gripScale *= total.gripMult;
  stats.tyres.sideGripScale *= total.sideGripMult;
  stats.tyres.rollingResistanceScale *= total.rollingMult;
  for (const [s, m] of Object.entries(total.surfaceGrip)) stats.tyres.surfaceGrip[s] = (stats.tyres.surfaceGrip[s] ?? 1) * m;
  stats.aero.dragCoefficient *= total.dragMult;
  stats.wading.maxDepthM += total.wadeDepthAddM;
  stats.engine.topSpeedMps *= total.topSpeedMult;

  const paint = resolvePaint(c.paint, cat);
  return {
    stats,
    effects: total,
    customisation: c,
    appearance: {
      paint,
      wheels: { id: c.wheels, node: c.wheels === 'stock' ? null : `WheelVariant_${c.wheels}` },
      accessories: c.accessories.map((id, i) => ({ slot: ACCESSORY_SLOTS[i], id, node: id ? `Acc_${id}` : null })),
    },
  };
}
