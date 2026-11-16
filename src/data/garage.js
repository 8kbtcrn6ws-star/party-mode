// Garage: which vehicles a profile has unlocked/owns, which is selected, and each vehicle's customisation
// (paint, wheels, 3 accessory slots). Pure data + small API; serialisable via toJSON().
//   unlocked = found/earned through exploration (see unlock rules in vehicles.js), owned = sitting in the garage.
//   owned is always a subset of unlocked. There is no money: unlocking a vehicle puts it in the garage by default.
import { isObj, isId, createEmitter, deepClone } from './util.js';
import {
  ACCESSORY_SLOTS, defaultCatalogue, defaultCustomisation, sanitizeCustomisation, applyCustomisation, resolvePaint,
} from './customisation.js';
import { SAMPLE_VEHICLES } from './vehicle-samples.js';
import { createCatalogue } from './vehicles.js';

export const defaultVehicleCatalogue = () => createCatalogue(SAMPLE_VEHICLES, { strict: true });

/** First vehicle that unlocks at start (the starter car); falls back to the first vehicle. */
export function starterVehicleId(catalogue) {
  const list = catalogue.list();
  return (list.find((v) => v.unlock.type === 'start') || list[0] || {}).id || null;
}

/** Does `unlock` (from a vehicle) hold for this context { discoveredPois: string[]|Set, pois: [{id,region}], chunksVisited: n }? */
export function unlockMet(unlock, ctx = {}) {
  if (!unlock || unlock.type === 'start') return true;
  const found = new Set(ctx.discoveredPois || []);
  switch (unlock.type) {
    case 'poi': return found.has(unlock.poiId);
    case 'chunks': return (ctx.chunksVisited || 0) >= unlock.count;
    case 'pois': {
      if (!unlock.region) return found.size >= unlock.count;
      const inRegion = (ctx.pois || []).filter((p) => p.region === unlock.region && found.has(p.id)).length;
      return inRegion >= unlock.count;
    }
    default: return false;
  }
}

/** Clean raw garage data against a vehicle catalogue + customisation catalogue. Unknown vehicles are dropped. */
export function sanitizeGarage(raw, catalogue = defaultVehicleCatalogue(), cust = defaultCatalogue()) {
  const r = isObj(raw) ? raw : {};
  const uniq = (a) => [...new Set((Array.isArray(a) ? a : []).filter((id) => isId(id) && catalogue.has(id)))];
  const starter = starterVehicleId(catalogue);
  const owned = uniq(r.owned);
  const unlocked = uniq([...uniq(r.unlocked), ...owned]);     // owned implies unlocked
  if (starter) { if (!unlocked.includes(starter)) unlocked.push(starter); if (!owned.length) owned.push(starter); }
  const selected = owned.includes(r.selected) ? r.selected : (owned[0] || null);
  const customisation = {};
  const src = isObj(r.customisation) ? r.customisation : {};
  for (const id of owned) {
    if (Object.hasOwn(src, id)) customisation[id] = sanitizeCustomisation(src[id], catalogue.get(id), cust);
  }
  return { owned, unlocked, selected, customisation };
}

export class Garage {
  #cat; #cust; #d; #em = createEmitter();

  constructor(raw = null, catalogue = defaultVehicleCatalogue(), cust = defaultCatalogue()) {
    this.#cat = catalogue; this.#cust = cust;
    this.#d = sanitizeGarage(raw, catalogue, cust);
  }

  on(ev, fn) { return this.#em.on(ev, fn); }
  #changed(what, detail) { this.#em.emit('change', { what, ...detail }); }

  get selected() { return this.#d.selected; }
  owned() { return [...this.#d.owned]; }
  unlocked() { return [...this.#d.unlocked]; }
  isOwned(id) { return this.#d.owned.includes(id); }
  isUnlocked(id) { return this.#d.unlocked.includes(id); }
  /** Vehicles in the catalogue not yet unlocked (for the "Vehicles" screen's locked list). */
  locked() { return this.#cat.ids().filter((id) => !this.isUnlocked(id)); }

  #need(id) { if (!this.#cat.has(id)) throw new Error(`Unknown vehicle "${id}"`); }
  #needOwned(id) { this.#need(id); if (!this.isOwned(id)) throw new Error(`Vehicle "${id}" is not in the garage`); }

  /** Unlock a vehicle; puts it in the garage unless { own:false }. Returns true if anything changed. */
  unlock(id, { own = true } = {}) {
    this.#need(id);
    let changed = false;
    if (!this.isUnlocked(id)) { this.#d.unlocked.push(id); changed = true; }
    if (own && !this.isOwned(id)) { this.#d.owned.push(id); changed = true; }
    if (changed) this.#changed('unlock', { id });
    return changed;
  }
  /** Move an unlocked vehicle into the garage. */
  own(id) {
    this.#need(id);
    if (!this.isUnlocked(id)) throw new Error(`Vehicle "${id}" is locked`);
    if (this.isOwned(id)) return false;
    this.#d.owned.push(id); this.#changed('own', { id }); return true;
  }
  select(id) {
    this.#needOwned(id);
    if (this.#d.selected === id) return false;
    this.#d.selected = id; this.#changed('select', { id }); return true;
  }

  /** Check every vehicle's unlock rule against the exploration context; unlocks (and owns) the newly met ones. Returns their ids. */
  checkUnlocks(ctx) {
    const newly = [];
    for (const v of this.#cat.list()) if (!this.isUnlocked(v.id) && unlockMet(v.unlock, ctx)) { this.unlock(v.id); newly.push(v.id); }
    return newly;
  }

  // ---- customisation ----
  getCustomisation(id = this.#d.selected) {
    this.#needOwned(id);
    return deepClone(this.#d.customisation[id] || defaultCustomisation(this.#cat.get(id), this.#cust));
  }
  #set(id, next, what) {
    this.#d.customisation[id] = sanitizeCustomisation(next, this.#cat.get(id), this.#cust);
    this.#changed(what, { id });
  }
  /** paint: a paint id from the catalogue or a '#rrggbb' colour. */
  setPaint(id, paint) {
    this.#needOwned(id);
    if (!resolvePaint(paint, this.#cust)) throw new Error(`Unknown paint "${paint}"`);
    this.#set(id, { ...this.getCustomisation(id), paint }, 'paint');
  }
  setWheels(id, wheelId) {
    this.#needOwned(id);
    if (!this.#cust.wheels.some((w) => w.id === wheelId)) throw new Error(`Unknown wheels "${wheelId}"`);
    this.#set(id, { ...this.getCustomisation(id), wheels: wheelId }, 'wheels');
  }
  /** slot: 0..2 or 'roof'|'front'|'rear'; accessoryId null empties the slot. The accessory must fit that slot. */
  setAccessory(id, slot, accessoryId) {
    this.#needOwned(id);
    const i = typeof slot === 'number' ? slot : ACCESSORY_SLOTS.indexOf(slot);
    if (!Number.isInteger(i) || i < 0 || i >= ACCESSORY_SLOTS.length) throw new Error(`Unknown accessory slot "${slot}"`);
    if (accessoryId !== null) {
      const a = this.#cust.accessories.find((x) => x.id === accessoryId);
      if (!a) throw new Error(`Unknown accessory "${accessoryId}"`);
      if (a.slot !== ACCESSORY_SLOTS[i]) throw new Error(`"${accessoryId}" does not fit the ${ACCESSORY_SLOTS[i]} slot`);
    }
    const c = this.getCustomisation(id);
    c.accessories[i] = accessoryId;
    this.#set(id, c, 'accessory');
  }
  resetCustomisation(id) {
    this.#needOwned(id);
    delete this.#d.customisation[id]; this.#changed('reset', { id });
  }

  /** Final stats + appearance for a vehicle (default: the selected one) with customisation effects merged. */
  loadout(id = this.#d.selected) {
    this.#needOwned(id);
    return { id, ...applyCustomisation(this.#cat.get(id), this.#d.customisation[id], this.#cust) };
  }

  toJSON() { return deepClone(this.#d); }
}
