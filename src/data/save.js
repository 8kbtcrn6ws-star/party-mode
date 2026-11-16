// Versioned save: profiles (name + settings + garage + exploration) in one localStorage key.
// Everything stays on the device. Corrupt or too-new data is quarantined to a side key (never silently lost) and
// the player gets safe defaults. Older versions are migrated step by step, with the original kept as a backup.
//
//   const data = createSaveManager({ pois });     // storage defaults to localStorage, else memory
//   const report = data.load();                   // { status, fromVersion, warnings }
//   data.profile.settings / .garage / .explored   // live objects for the active profile
//   data.markDirty(); data.flush();               // or data.startAutosave()
import { isObj, isId, cleanName, createEmitter, deepClone } from './util.js';
import { autoStorage } from './storage.js';
import { sanitizeSettings, mergeSettings, defaultSettings } from './settings.js';
import { Garage, defaultVehicleCatalogue } from './garage.js';
import { Explored } from './explored.js';
import { defaultCatalogue } from './customisation.js';

export const SAVE_VERSION = 2;
export const SAVE_KEY = 'pm.save';
export const MAX_PROFILES = 8;            // party play: a handful of local players on one host device
export const DEFAULT_PROFILE_NAME = 'Player';

// ---- migrations --------------------------------------------------------------------------------
// Each step takes the old raw object and returns the next version's raw object. Keep them pure, and never edit one
// once shipped: add a new step and bump SAVE_VERSION.
//   v0: unversioned early blob  { playerName, vehicle, colour }
//   v1: single player, flat     { version:1, name, settings:{ steerSensitivity, fullLockDeg, camera, quality },
//                                 garage:{ owned[], selected, paints{id:'#rrggbb'} }, explored:{ chunks:[[cx,cz]...], pois[] } }
//   v2: profiles (current)      { version:2, activeProfile, profiles:[ { id, name, createdAt, updatedAt, settings, garage, explored } ] }
export const MIGRATIONS = [
  {
    from: 0, to: 1,
    up(o) {
      return {
        version: 1,
        name: o.playerName ?? o.name,
        settings: {},
        garage: { owned: o.vehicle ? [o.vehicle] : [], selected: o.vehicle, paints: o.vehicle && o.colour ? { [o.vehicle]: o.colour } : {} },
        explored: { chunks: [], pois: [] },
      };
    },
  },
  {
    from: 1, to: 2,
    up(o) {
      const s = isObj(o.settings) ? o.settings : {};
      const g = isObj(o.garage) ? o.garage : {};
      const customisation = {};
      if (isObj(g.paints)) for (const [id, hex] of Object.entries(g.paints)) if (isId(id)) customisation[id] = { paint: hex };
      const e = isObj(o.explored) ? o.explored : {};
      const ex = new Explored();                         // legacy visited chunks had no fog data: treat them as fully revealed
      for (const c of Array.isArray(e.chunks) ? e.chunks : []) if (Array.isArray(c)) ex.revealChunk(c[0], c[1]);
      const exJson = ex.toJSON();
      exJson.pois = Array.isArray(e.pois) ? e.pois : [];
      const id = 'p1';
      return {
        version: 2,
        activeProfile: id,
        profiles: [{
          id, name: o.name, createdAt: o.createdAt, updatedAt: o.updatedAt,
          settings: {
            controls: { steerSensitivity: s.steerSensitivity, wheel: { fullLockDeg: s.fullLockDeg } },
            camera: { mode: s.camera },
            graphics: { qualityTier: s.quality },
          },
          garage: { owned: g.owned, unlocked: g.owned, selected: g.selected, customisation },
          explored: exJson,
        }],
      };
    },
  },
];

/** Version of a parsed blob: its `version` field, or 0 for an unversioned object, or NaN if not an object. */
export function detectVersion(o) {
  if (!isObj(o)) return NaN;
  if (o.version === undefined) return 0;
  return Number.isInteger(o.version) && o.version >= 0 ? o.version : NaN;
}

/** Run migrations from `from` up to SAVE_VERSION. Throws if a step is missing. */
export function migrate(raw, from = detectVersion(raw)) {
  let v = from, o = deepClone(raw);
  while (v < SAVE_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) throw new Error(`No migration from save version ${v}`);
    o = step.up(o); v = step.to;
  }
  return o;
}

// ---- manager -----------------------------------------------------------------------------------
let idCounter = 0;
function defaultRandomId() {
  const c = globalThis.crypto;
  if (c?.getRandomValues) { const b = new Uint8Array(5); c.getRandomValues(b); return 'p' + [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  return 'p' + Date.now().toString(36) + (idCounter++).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export function createSaveManager({
  storage = autoStorage(), key = SAVE_KEY, vehicleCatalogue = defaultVehicleCatalogue(), customisation = defaultCatalogue(),
  pois = [], now = () => Date.now(), randomId = defaultRandomId, setInterval: si = globalThis.setInterval, clearInterval: ci = globalThis.clearInterval,
} = {}) {
  const em = createEmitter();
  let poiList = pois;
  let profiles = new Map();      // id -> runtime profile
  let order = [];                // profile ids in display order
  let activeId = null;
  let dirty = false;
  let lastReport = { status: 'new', fromVersion: SAVE_VERSION, warnings: [] };
  let lastError = null;

  const markDirty = () => { dirty = true; };

  function buildProfile(raw) {
    const garage = new Garage(raw.garage, vehicleCatalogue, customisation);
    const explored = new Explored(raw.explored, { pois: poiList });
    const t = now();
    const p = {
      id: raw.id, name: cleanName(raw.name, DEFAULT_PROFILE_NAME),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : t, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : t,
      settings: sanitizeSettings(raw.settings), garage, explored,
    };
    garage.on('change', () => { markDirty(); em.emit('change', { what: 'garage', profileId: p.id }); });
    explored.on('change', () => { markDirty(); em.emit('change', { what: 'explored', profileId: p.id }); });
    return p;
  }

  function newProfile(name = DEFAULT_PROFILE_NAME) {
    let id; do { id = randomId(); } while (!isId(id) || profiles.has(id));
    return buildProfile({ id, name, settings: {}, garage: {}, explored: {} });
  }

  /** Turn any parsed blob of the current version into runtime state (sanitising everything). */
  function adopt(obj, warnings) {
    profiles = new Map(); order = [];
    const list = isObj(obj) && Array.isArray(obj.profiles) ? obj.profiles : [];
    for (const raw of list.slice(0, MAX_PROFILES)) {
      if (!isObj(raw) || !isId(raw.id) || profiles.has(raw.id)) { warnings.push('dropped an invalid or duplicate profile'); continue; }
      profiles.set(raw.id, buildProfile(raw)); order.push(raw.id);
    }
    if (!profiles.size) { const p = newProfile(); profiles.set(p.id, p); order.push(p.id); warnings.push('created a fresh profile'); }
    activeId = profiles.has(obj?.activeProfile) ? obj.activeProfile : order[0];
  }

  function quarantine(suffix, text) {
    try { storage.setItem(`${key}.${suffix}`, text); return true; } catch { return false; }
  }

  /** Core of load()/importJSON(): parse -> version check -> migrate -> sanitise -> adopt. */
  function ingest(text, { isImport = false } = {}) {
    const warnings = [];
    if (text === null || text === undefined) {
      adopt(null, warnings); dirty = true;
      return (lastReport = { status: 'new', fromVersion: SAVE_VERSION, warnings: [] });
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const ver = detectVersion(parsed);
    const fail = (status, why, suffix) => {
      if (!isImport) quarantine(suffix, String(text));
      warnings.push(why + (isImport ? '' : `; original kept under "${key}.${suffix}"`));
      adopt(null, warnings); dirty = true;
      return (lastReport = { status, fromVersion: Number.isNaN(ver) ? null : ver, warnings });
    };
    if (parsed === undefined || Number.isNaN(ver)) return fail('recovered', 'save data was corrupt', 'corrupt');
    if (ver > SAVE_VERSION) return fail('future', `save is from a newer game version (v${ver})`, 'future');
    let obj = parsed, status = 'ok';
    if (ver < SAVE_VERSION) {
      if (!isImport) quarantine(`v${ver}.bak`, String(text));            // keep the pre-migration original
      try { obj = migrate(parsed, ver); status = 'migrated'; }
      catch (e) { return fail('recovered', `migration failed (${e.message})`, 'corrupt'); }
    }
    adopt(obj, warnings);
    if (status === 'migrated') dirty = true;
    return (lastReport = { status, fromVersion: ver, warnings });
  }

  function serialise() {
    return JSON.stringify({
      version: SAVE_VERSION, savedAt: now(), activeProfile: activeId,
      profiles: order.map((id) => {
        const p = profiles.get(id);
        return { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, settings: p.settings, garage: p.garage.toJSON(), explored: p.explored.toJSON() };
      }),
    });
  }

  const api = {
    on: em.on, off: em.off,

    /** Load from storage (call once at start-up). Never throws. */
    load() {
      let text = null;
      try { text = storage.getItem(key); } catch (e) { lastError = e; }
      const r = ingest(text);
      em.emit('load', r);
      return r;
    },

    /** Write now. Returns { ok, error? } and never throws (quota/blocked storage just reports). */
    save() {
      const p = profiles.get(activeId);
      if (p) p.updatedAt = now();
      try { storage.setItem(key, serialise()); dirty = false; lastError = null; em.emit('save', { ok: true }); return { ok: true }; }
      catch (e) { lastError = e; em.emit('save', { ok: false, error: e }); return { ok: false, error: e }; }
    },

    markDirty,
    get dirty() { return dirty; },
    /** Save only if something changed. */
    flush() { return dirty ? api.save() : { ok: true, skipped: true }; },
    /** Flush every `intervalMs` and on page hide. Returns stop(). */
    startAutosave({ intervalMs = 10000, target = globalThis } = {}) {
      const t = si(() => api.flush(), intervalMs);
      const onHide = () => { if (target.document?.visibilityState === 'hidden' || !target.document) api.flush(); };
      target.addEventListener?.('pagehide', onHide);
      target.document?.addEventListener?.('visibilitychange', onHide);
      return () => { ci(t); target.removeEventListener?.('pagehide', onHide); target.document?.removeEventListener?.('visibilitychange', onHide); };
    },

    get status() { return lastReport; },
    get lastError() { return lastError; },
    get persistent() { return storage.persistent !== false; },
    get storageKind() { return storage.kind || 'custom'; },

    // ---- profiles ----
    get profile() { return profiles.get(activeId); },
    getProfile: (id) => profiles.get(id) || null,
    listProfiles: () => order.map((id) => ({ id, name: profiles.get(id).name, active: id === activeId, updatedAt: profiles.get(id).updatedAt })),
    createProfile(name = DEFAULT_PROFILE_NAME, { activate = true } = {}) {
      if (profiles.size >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles`);
      const p = newProfile(name);
      profiles.set(p.id, p); order.push(p.id);
      if (activate) activeId = p.id;
      markDirty(); em.emit('change', { what: 'profiles' });
      return p;
    },
    switchProfile(id) {
      if (!profiles.has(id)) throw new Error(`Unknown profile "${id}"`);
      activeId = id; markDirty(); em.emit('change', { what: 'profiles' }); return profiles.get(id);
    },
    renameProfile(id, name) {
      const p = profiles.get(id); if (!p) throw new Error(`Unknown profile "${id}"`);
      p.name = cleanName(name, p.name); markDirty(); em.emit('change', { what: 'profiles' }); return p.name;
    },
    /** The last remaining profile cannot be deleted. Returns true if removed. */
    deleteProfile(id) {
      if (!profiles.has(id)) return false;
      if (profiles.size === 1) throw new Error('Cannot delete the only profile');
      profiles.delete(id); order = order.filter((x) => x !== id);
      if (activeId === id) activeId = order[0];
      markDirty(); em.emit('change', { what: 'profiles' }); return true;
    },

    // ---- settings (plain object on the profile; always replaced, never mutated in place) ----
    /** updateSettings({ controls: { wheel: { fullLockDeg: 35 } } }) -> validated settings. */
    updateSettings(patch, id = activeId) {
      const p = profiles.get(id); if (!p) throw new Error(`Unknown profile "${id}"`);
      p.settings = mergeSettings(p.settings, patch); markDirty(); em.emit('change', { what: 'settings', profileId: id });
      return p.settings;
    },
    resetSettings(id = activeId) {
      const p = profiles.get(id); if (!p) throw new Error(`Unknown profile "${id}"`);
      p.settings = defaultSettings(); markDirty(); em.emit('change', { what: 'settings', profileId: id }); return p.settings;
    },

    /** Provide/replace the landmark list (from world/pois.json) for all profiles. */
    setPois(list) { poiList = list; for (const p of profiles.values()) p.explored.setPois(list); },

    // ---- backup ----
    exportJSON: () => serialise(),
    /** Replace everything from a backup string (migrates older ones). Returns the same report as load(). Does not write until save(). */
    importJSON(text) {
      const snap = { profiles, order, activeId, dirty };
      const r = ingest(String(text), { isImport: true });
      if (r.status === 'recovered' || r.status === 'future') {          // bad backup: keep the current data untouched
        ({ profiles, order, activeId, dirty } = snap);
        return (lastReport = { ...r, status: 'rejected' });
      }
      dirty = true; em.emit('load', r); return r;
    },
    /** Delete the save (and quarantine keys). The next load() starts fresh. */
    wipe() {
      try { for (const k of storage.keys ? storage.keys() : [key]) if (k === key || k.startsWith(key + '.')) storage.removeItem(k); }
      catch (e) { lastError = e; }
      ingest(null);
    },
  };
  return api;
}
