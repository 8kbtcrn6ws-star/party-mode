// Exploration state: visited 256 m chunks, a fog-of-war reveal grid, discoverable landmarks (POIs) and a map destination.
//
// World coordinates are metres, X east, Z south (top-down map: north = -Z). Bearings are compass degrees, 0 = north, clockwise.
// Fog storage: each 256 m chunk is 8x8 fog cells of 32 m = 64 bits, held as two uint32 words, only for chunks ever touched.
// An empty world costs nothing; a fully explored 100-chunk area is ~100 small records. Serialises to compact JSON.
import { clamp, isObj, isId, num, createEmitter, cleanName } from './util.js';

export const CHUNK_SIZE = 256;                    // architecture.md: 256 m chunks (must equal world/ chunk size)
export const FOG_CELLS = 8;                       // fog cells per chunk side
export const FOG_CELL = CHUNK_SIZE / FOG_CELLS;   // 32 m
export const DEFAULT_REVEAL_RADIUS = 96;          // metres revealed around a car
export const ARRIVE_RADIUS = 25;                  // destination counts as reached within this many metres
const MAX_CHUNK = 32767;                          // |chunk index| limit (~8,400 km, far beyond any map)
const MAX_RECORDS = 200000;
const MAX_GRID_CELLS = 4_000_000;
const FULL = 0xffffffff;

const chunkKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
export const chunkOf = (v) => Math.floor(v / CHUNK_SIZE);
const cellOf = (v) => Math.floor(v / FOG_CELL);
const popcount32 = (n) => { n >>>= 0; n -= (n >>> 1) & 0x55555555; n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

export const distance2D = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
/** Compass bearing from (ax,az) to (bx,bz): 0 = north (-Z), 90 = east (+X), clockwise, in [0,360). */
export function bearingDeg(ax, az, bx, bz) {
  const d = (Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}
/** Smallest signed angle from `heading` to `bearing`, in (-180,180]; positive = turn right. */
export const relativeBearingDeg = (bearing, heading) => { let d = ((bearing - heading) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; };

/** Normalise one pois.json entry. Accepts position as {x,z} / [x,z] / top-level x,z. Returns null if unusable. */
export function normalisePoi(p) {
  if (!isObj(p) || !isId(String(p.id))) return null;
  const pos = isObj(p.position) ? p.position : Array.isArray(p.position) ? { x: p.position[0], z: p.position[p.position.length > 2 ? 2 : 1] } : p;
  const x = num(pos.x, NaN), z = num(pos.z ?? pos.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    id: String(p.id), name: cleanName(p.name, String(p.id), 48), region: typeof p.region === 'string' ? p.region : null,
    x, z, radius: num(p.radius, 40, 1, 5000), hidden: p.hidden === true, category: typeof p.category === 'string' ? p.category : null,
  };
}
/** pois.json may be an array or { pois: [...] }. Invalid and duplicate entries are skipped. */
export function parsePois(json) {
  const arr = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.pois) ? json.pois : [];
  const seen = new Set(), out = [];
  for (const raw of arr) { const p = normalisePoi(raw); if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); } }
  return out;
}

export class Explored {
  #fog = new Map();            // chunkKey -> { cx, cz, visited, lo, hi }
  #pois = [];                  // normalised POIs
  #found = new Set();          // discovered poi ids (kept even if the POI list changes)
  #dest = null;
  #last = new Map();           // playerId -> last fog cell (skip repeat reveals)
  #em = createEmitter();

  /** raw: the object from toJSON() (any shape is tolerated). pois: normalised or raw pois.json entries. */
  constructor(raw = null, { pois = [] } = {}) {
    this.setPois(pois);
    this.#load(raw);
  }

  on(ev, fn) { return this.#em.on(ev, fn); }

  // ---- fog + chunks ---------------------------------------------------------------------------
  #rec(cx, cz, create) {
    const k = chunkKey(cx, cz);
    let r = this.#fog.get(k);
    if (!r && create) { r = { cx, cz, visited: false, lo: 0, hi: 0 }; this.#fog.set(k, r); }
    return r;
  }
  #setCell(gx, gz) {            // returns true if newly revealed
    const cx = Math.floor(gx / FOG_CELLS), cz = Math.floor(gz / FOG_CELLS);
    if (Math.abs(cx) > MAX_CHUNK || Math.abs(cz) > MAX_CHUNK) return false;
    const r = this.#rec(cx, cz, true);
    const bit = (gz - cz * FOG_CELLS) * FOG_CELLS + (gx - cx * FOG_CELLS);
    if (bit < 32) { const m = (1 << bit) >>> 0; if (r.lo & m) return false; r.lo = (r.lo | m) >>> 0; }
    else { const m = (1 << (bit - 32)) >>> 0; if (r.hi & m) return false; r.hi = (r.hi | m) >>> 0; }
    return true;
  }
  #hasCell(gx, gz) {
    const cx = Math.floor(gx / FOG_CELLS), cz = Math.floor(gz / FOG_CELLS);
    const r = this.#fog.get(chunkKey(cx, cz));
    if (!r) return false;
    const bit = (gz - cz * FOG_CELLS) * FOG_CELLS + (gx - cx * FOG_CELLS);
    return bit < 32 ? (r.lo >>> bit & 1) === 1 : (r.hi >>> (bit - 32) & 1) === 1;
  }

  /** Reveal every fog cell whose centre is within `radius` of (x,z) (always includes the cell under it). Returns newly revealed cell count. */
  reveal(x, z, radius = DEFAULT_REVEAL_RADIUS) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    radius = clamp(Number.isFinite(radius) ? radius : DEFAULT_REVEAL_RADIUS, 0, 2000);
    let n = this.#setCell(cellOf(x), cellOf(z)) ? 1 : 0;
    const r2 = radius * radius;
    for (let gz = cellOf(z - radius); gz <= cellOf(z + radius); gz++) {
      const cz = (gz + 0.5) * FOG_CELL;
      for (let gx = cellOf(x - radius); gx <= cellOf(x + radius); gx++) {
        const cx = (gx + 0.5) * FOG_CELL;
        if ((cx - x) ** 2 + (cz - z) ** 2 <= r2 && this.#setCell(gx, gz)) n++;
      }
    }
    return n;
  }

  /** Mark the chunk containing (x,z) as visited. Returns true if it was new. */
  markVisited(x, z) {
    const cx = chunkOf(x), cz = chunkOf(z);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(cx) > MAX_CHUNK || Math.abs(cz) > MAX_CHUNK) return false;
    const r = this.#rec(cx, cz, true);
    if (r.visited) return false;
    r.visited = true; return true;
  }
  isChunkVisited(cx, cz) { return !!this.#fog.get(chunkKey(cx, cz))?.visited; }
  isRevealedAt(x, z) { return this.#hasCell(cellOf(x), cellOf(z)); }
  visitedChunks() { return [...this.#fog.values()].filter((r) => r.visited).map((r) => ({ cx: r.cx, cz: r.cz })).sort((a, b) => a.cx - b.cx || a.cz - b.cz); }

  /**
   * Call every frame (or every few) per car. Reveals fog, marks the chunk visited and discovers POIs in range.
   * Returns { newCells, newChunk: {cx,cz}|null, newPois: [poi] }. Events: 'chunk', 'poi', 'change' (only when something is new).
   */
  update(x, z, { radius = DEFAULT_REVEAL_RADIUS, playerId = 'default' } = {}) {
    const out = { newCells: 0, newChunk: null, newPois: [] };
    if (!Number.isFinite(x) || !Number.isFinite(z)) return out;
    const key = cellOf(x) + ',' + cellOf(z) + ',' + radius;
    if (this.#last.get(playerId) !== key) {
      this.#last.set(playerId, key);
      out.newCells = this.reveal(x, z, radius);
      if (this.markVisited(x, z)) out.newChunk = { cx: chunkOf(x), cz: chunkOf(z) };
    }
    for (const p of this.#pois) {
      if (!this.#found.has(p.id) && distance2D(x, z, p.x, p.z) <= p.radius) { this.#found.add(p.id); out.newPois.push(p); }
    }
    if (out.newChunk) this.#em.emit('chunk', { ...out.newChunk, playerId });
    for (const p of out.newPois) this.#em.emit('poi', { poi: p, playerId });
    if (out.newCells || out.newChunk || out.newPois.length) this.#em.emit('change', { what: 'explore', playerId });
    return out;
  }

  /** Counts for UI/unlocks. */
  stats() {
    let cells = 0, chunks = 0;
    for (const r of this.#fog.values()) { cells += popcount32(r.lo) + popcount32(r.hi); if (r.visited) chunks++; }
    return { chunksVisited: chunks, chunksTouched: this.#fog.size, cellsRevealed: cells, areaKm2: (cells * FOG_CELL * FOG_CELL) / 1e6, poisDiscovered: this.#found.size, poisTotal: this.#pois.length };
  }
  /** Fraction (0..1) of fog cells revealed inside world bounds {minX,minZ,maxX,maxZ}. */
  coverage(b) {
    const g = this.getFogGrid(b);
    let n = 0; for (let i = 0; i < g.data.length; i++) n += g.data[i];
    return g.data.length ? n / g.data.length : 0;
  }
  /** Bounding box in metres of everything revealed, or null if nothing is. */
  extent() {
    let any = false, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of this.#fog.values()) {
      if (!r.visited && !r.lo && !r.hi) continue;
      any = true;
      x0 = Math.min(x0, r.cx * CHUNK_SIZE); z0 = Math.min(z0, r.cz * CHUNK_SIZE);
      x1 = Math.max(x1, (r.cx + 1) * CHUNK_SIZE); z1 = Math.max(z1, (r.cz + 1) * CHUNK_SIZE);
    }
    return any ? { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } : null;
  }

  /**
   * Fog grid for drawing the map: bounds {minX,minZ,maxX,maxZ} (metres) snapped out to whole 32 m cells.
   * Returns { cols, rows, cell, originX, originZ, data: Uint8Array(rows*cols) } where data[row*cols+col] = 1 revealed,
   * 0 fogged; row 0 is the northernmost row (smallest Z). Pixel for world (x,z) = ((x-originX)/cell, (z-originZ)/cell).
   */
  getFogGrid(b) {
    const gx0 = cellOf(b.minX), gz0 = cellOf(b.minZ);
    const gx1 = Math.max(gx0, Math.ceil(b.maxX / FOG_CELL) - 1), gz1 = Math.max(gz0, Math.ceil(b.maxZ / FOG_CELL) - 1);
    const cols = gx1 - gx0 + 1, rows = gz1 - gz0 + 1;
    if (!(cols > 0 && rows > 0) || cols * rows > MAX_GRID_CELLS) throw new RangeError(`Fog grid too large or empty (${cols}x${rows})`);
    const data = new Uint8Array(cols * rows);
    // Walk only touched chunks, not every cell of the bounds.
    for (const r of this.#fog.values()) {
      if (!r.lo && !r.hi) continue;
      for (let lz = 0; lz < FOG_CELLS; lz++) {
        const gz = r.cz * FOG_CELLS + lz;
        if (gz < gz0 || gz > gz1) continue;
        for (let lx = 0; lx < FOG_CELLS; lx++) {
          const gx = r.cx * FOG_CELLS + lx;
          if (gx < gx0 || gx > gx1) continue;
          const bit = lz * FOG_CELLS + lx;
          if ((bit < 32 ? r.lo >>> bit : r.hi >>> (bit - 32)) & 1) data[(gz - gz0) * cols + (gx - gx0)] = 1;
        }
      }
    }
    return { cols, rows, cell: FOG_CELL, originX: gx0 * FOG_CELL, originZ: gz0 * FOG_CELL, data };
  }
  /** Same idea per chunk (visited = 1): { cols, rows, cell: 256, originX, originZ, data }. */
  getChunkGrid(b) {
    const c0x = chunkOf(b.minX), c0z = chunkOf(b.minZ);
    const c1x = Math.max(c0x, Math.ceil(b.maxX / CHUNK_SIZE) - 1), c1z = Math.max(c0z, Math.ceil(b.maxZ / CHUNK_SIZE) - 1);
    const cols = c1x - c0x + 1, rows = c1z - c0z + 1;
    if (cols * rows > MAX_GRID_CELLS) throw new RangeError('Chunk grid too large');
    const data = new Uint8Array(cols * rows);
    for (const r of this.#fog.values()) {
      if (r.visited && r.cx >= c0x && r.cx <= c1x && r.cz >= c0z && r.cz <= c1z) data[(r.cz - c0z) * cols + (r.cx - c0x)] = 1;
    }
    return { cols, rows, cell: CHUNK_SIZE, originX: c0x * CHUNK_SIZE, originZ: c0z * CHUNK_SIZE, data };
  }
  /** Fog grid -> RGBA bytes for a canvas ImageData (fogged = opaque-ish colour, revealed = transparent). Soften edges in the renderer by scaling up smoothly. */
  static fogToRGBA(grid, { r = 12, g = 16, b = 20, fogAlpha = 225 } = {}) {
    const px = new Uint8ClampedArray(grid.data.length * 4);
    for (let i = 0; i < grid.data.length; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = grid.data[i] ? 0 : fogAlpha; }
    return px;
  }

  /** OR another Explored into this one (shared exploration in Party Mode, or merging profiles). Returns cells newly revealed here. */
  merge(other) {
    let added = 0;
    for (const o of other.#fog.values()) {
      const r = this.#rec(o.cx, o.cz, true);
      added += popcount32((r.lo | o.lo) >>> 0) - popcount32(r.lo) + popcount32((r.hi | o.hi) >>> 0) - popcount32(r.hi);
      r.lo = (r.lo | o.lo) >>> 0; r.hi = (r.hi | o.hi) >>> 0; r.visited = r.visited || o.visited;
    }
    for (const id of other.#found) this.#found.add(id);
    if (added) this.#em.emit('change', { what: 'merge' });
    return added;
  }

  // ---- landmarks -----------------------------------------------------------------------------
  setPois(list) { this.#pois = parsePois(list); }
  pois() { return this.#pois.map((p) => ({ ...p })); }
  getPoi(id) { const p = this.#pois.find((x) => x.id === id); return p ? { ...p } : null; }
  isDiscovered(id) { return this.#found.has(id); }
  discoveredIds() { return [...this.#found].sort(); }
  /** Manually mark a POI discovered (e.g. a hidden one found another way). Returns true if new. */
  discoverPoi(id, { playerId = 'default' } = {}) {
    const p = this.#pois.find((x) => x.id === id);
    if (!p || this.#found.has(id)) return false;
    this.#found.add(id);
    this.#em.emit('poi', { poi: p, playerId }); this.#em.emit('change', { what: 'poi', playerId });
    return true;
  }
  /**
   * Landmarks for the map/list. opts: { from:{x,z}, discoveredOnly, region, sort:'distance'|'name' (default distance if `from`, else name),
   * includeHidden (default false: hidden POIs only appear once discovered) }. Each result: { poi, discovered, distance|null, bearing|null }.
   */
  landmarks({ from = null, discoveredOnly = false, region = null, sort = null, includeHidden = false } = {}) {
    let out = this.#pois
      .filter((p) => (includeHidden || !p.hidden || this.#found.has(p.id)) && (!region || p.region === region) && (!discoveredOnly || this.#found.has(p.id)))
      .map((p) => ({
        poi: { ...p }, discovered: this.#found.has(p.id),
        distance: from ? distance2D(from.x, from.z, p.x, p.z) : null, bearing: from ? bearingDeg(from.x, from.z, p.x, p.z) : null,
      }));
    const by = sort || (from ? 'distance' : 'name');
    out.sort(by === 'distance' && from ? (a, b) => a.distance - b.distance : (a, b) => a.poi.name.localeCompare(b.poi.name));
    return out;
  }
  /** Nearest not-yet-discovered, non-hidden landmark (the "something to find" hint), or null. */
  nearestUndiscovered(from) {
    return this.landmarks({ from, sort: 'distance' }).find((l) => !l.discovered) || null;
  }

  // ---- destination ---------------------------------------------------------------------------
  /** Set the map waypoint. target: {x,z,name?} or a poi id string. Returns the stored destination. */
  setDestination(target, { name } = {}) {
    let d;
    if (typeof target === 'string') {
      const p = this.#pois.find((x) => x.id === target);
      if (!p) throw new Error(`Unknown landmark "${target}"`);
      d = { x: p.x, z: p.z, name: p.name, poiId: p.id };
    } else if (isObj(target) && Number.isFinite(target.x) && Number.isFinite(target.z)) {
      d = { x: target.x, z: target.z, name: cleanName(name ?? target.name, 'Destination', 40), poiId: null };
    } else throw new TypeError('setDestination needs {x,z} or a landmark id');
    this.#dest = d; this.#em.emit('destination', { ...d }); this.#em.emit('change', { what: 'destination' });
    return { ...d };
  }
  clearDestination() {
    if (!this.#dest) return false;
    this.#dest = null; this.#em.emit('destination', null); this.#em.emit('change', { what: 'destination' });
    return true;
  }
  get destination() { return this.#dest ? { ...this.#dest } : null; }
  distanceToDestination(from) { return this.#dest ? distance2D(from.x, from.z, this.#dest.x, this.#dest.z) : null; }
  bearingToDestination(from) { return this.#dest ? bearingDeg(from.x, from.z, this.#dest.x, this.#dest.z) : null; }
  /** HUD-ready: { destination, distance, bearing, relative (if heading given, + = turn right), arrived } or null. */
  destinationStatus(from, { heading = null, arriveRadius = ARRIVE_RADIUS } = {}) {
    if (!this.#dest) return null;
    const distance = this.distanceToDestination(from), bearing = this.bearingToDestination(from);
    return { destination: this.destination, distance, bearing, relative: heading === null ? null : relativeBearingDeg(bearing, heading), arrived: distance <= arriveRadius };
  }

  // ---- (de)serialisation ---------------------------------------------------------------------
  /** Compact JSON-safe object: { v:1, chunks:[[cx,cz,visited,lo,hi],...], pois:[ids], destination } */
  toJSON() {
    const chunks = [...this.#fog.values()].filter((r) => r.visited || r.lo || r.hi)
      .sort((a, b) => a.cx - b.cx || a.cz - b.cz).map((r) => [r.cx, r.cz, r.visited ? 1 : 0, r.lo >>> 0, r.hi >>> 0]);
    return { v: 1, chunks, pois: this.discoveredIds(), destination: this.#dest ? { ...this.#dest } : null };
  }
  #load(raw) {
    this.#fog.clear(); this.#found.clear(); this.#dest = null; this.#last.clear();
    if (!isObj(raw)) return;
    if (Array.isArray(raw.chunks)) {
      for (const e of raw.chunks.slice(0, MAX_RECORDS)) {
        if (!Array.isArray(e) || e.length < 2) continue;
        const cx = Number.isInteger(e[0]) ? e[0] : NaN, cz = Number.isInteger(e[1]) ? e[1] : NaN;
        if (!(Math.abs(cx) <= MAX_CHUNK && Math.abs(cz) <= MAX_CHUNK)) continue;
        const u = (v) => (Number.isFinite(v) ? (Math.trunc(v) >>> 0) : 0);
        const r = this.#rec(cx, cz, true);
        r.visited = r.visited || e[2] === 1 || e[2] === true;
        r.lo = (r.lo | u(e[3])) >>> 0; r.hi = (r.hi | u(e[4])) >>> 0;
      }
      for (const [k, r] of this.#fog) if (!r.visited && !r.lo && !r.hi) this.#fog.delete(k);
    }
    if (Array.isArray(raw.pois)) for (const id of raw.pois.slice(0, 5000)) if (isId(id)) this.#found.add(id);
    const d = raw.destination;
    if (isObj(d) && Number.isFinite(d.x) && Number.isFinite(d.z) && Math.abs(d.x) < 1e7 && Math.abs(d.z) < 1e7) {
      this.#dest = { x: d.x, z: d.z, name: cleanName(d.name, 'Destination', 40), poiId: isId(d.poiId) ? d.poiId : null };
    }
  }
  /** Replace contents from serialised data (same tolerance as the constructor). */
  load(raw) { this.#load(raw); this.#em.emit('change', { what: 'load' }); }
  reset() { this.#load(null); this.#em.emit('change', { what: 'reset' }); }

  /** Whole-chunk helper used by migrations: mark a chunk visited and fully revealed. */
  revealChunk(cx, cz) {
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || Math.abs(cx) > MAX_CHUNK || Math.abs(cz) > MAX_CHUNK) return false;
    const r = this.#rec(cx, cz, true); r.visited = true; r.lo = FULL; r.hi = FULL; return true;
  }
}
