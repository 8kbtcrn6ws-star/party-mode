// Pure lobby/room state: players, slots, profiles, lock, reconnect grace. No I/O, no timers (call sweep(now)).
// Used by the browser host (WebRTC mode) and by the Node tests; the Node relay server shares protocol.js.
import { Emitter } from './emitter.js';
import { ERR, MAX_PLAYERS, SEAT_GRACE_MS, PLAYER_COLORS, randomToken, sanitizeName, VEHICLE_RE, COLOUR_RE } from './protocol.js';

export class Lobby extends Emitter {
  /**
   * @param {object} o
   * @param {number} [o.maxPlayers=8]
   * @param {number} [o.graceMs=90000]   how long a dropped player's slot is held
   * @param {string[]|null} [o.vehicles] allowed vehicle ids (null = any id matching /^[a-z0-9_-]{1,32}$/i)
   * @param {string} [o.defaultVehicle]
   * @param {()=>number} [o.now]
   */
  constructor({ maxPlayers = MAX_PLAYERS, graceMs = SEAT_GRACE_MS, vehicles = null, defaultVehicle = null, now = () => Date.now() } = {}) {
    super();
    this.maxPlayers = Math.max(1, Math.min(32, maxPlayers | 0));
    this.graceMs = graceMs; this.vehicles = vehicles; this.now = now;
    this.defaultVehicle = defaultVehicle || (vehicles && vehicles[0]) || 'car1';
    this.players = new Map(); // id -> player
    this.byToken = new Map();
    this.locked = false;
    this.phase = 'lobby'; // 'lobby' | 'playing' | 'ended'
    this.version = 0;
  }

  #bump() { this.version++; }
  #freeSlot() { for (let i = 0; i < this.maxPlayers; i++) if (![...this.players.values()].some(p => p.slot === i)) return i; return -1; }
  #colourFree(c, exceptId) { return ![...this.players.values()].some(p => p.id !== exceptId && p.colour.toLowerCase() === c.toLowerCase()); }

  get size() { return this.players.size; }
  get connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }

  join({ name, vehicle, colour: wantColour } = {}) {
    if (this.phase === 'ended') return { ok: false, code: ERR.ROOM_CLOSED };
    if (this.locked) return { ok: false, code: ERR.ROOM_LOCKED };
    const slot = this.#freeSlot();
    if (slot < 0) return { ok: false, code: ERR.ROOM_FULL };
    if (vehicle != null && !this.#vehicleOk(vehicle)) return { ok: false, code: ERR.BAD_VEHICLE };
    const nm = name == null ? null : sanitizeName(name);
    if (name != null && !nm) return { ok: false, code: ERR.BAD_NAME };
    let colour = PLAYER_COLORS.find(c => this.#colourFree(c)) || '#cccccc';
    if (typeof wantColour === 'string' && COLOUR_RE.test(wantColour) && this.#colourFree(wantColour)) colour = wantColour.toLowerCase(); // taken/invalid colour: silently keep an auto one
    const player = {
      id: 'p' + (slot + 1), slot, token: randomToken(16), name: nm || `Player ${slot + 1}`, colour,
      vehicle: vehicle || this.defaultVehicle, ready: false, connected: true,
      joinedAt: this.now(), disconnectedAt: null, rtt: null,
    };
    this.players.set(player.id, player); this.byToken.set(player.token, player.id); this.#bump();
    this.emit('join', this.#pub(player));
    this.emit('change', this.state());
    return { ok: true, player };
  }

  /** Reclaim a seat with the token from `welcome`. */
  resume(token) {
    const id = typeof token === 'string' ? this.byToken.get(token) : null;
    const p = id && this.players.get(id);
    if (!p) return { ok: false, code: ERR.BAD_TOKEN };
    const wasConnected = p.connected;
    p.connected = true; p.disconnectedAt = null; this.#bump();
    this.emit('reconnect', this.#pub(p), { replaced: wasConnected });
    this.emit('change', this.state());
    return { ok: true, player: p, replaced: wasConnected };
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p || !p.connected) return false;
    p.connected = false; p.disconnectedAt = this.now(); p.rtt = null; this.#bump();
    this.emit('disconnect', this.#pub(p));
    this.emit('change', this.state());
    return true;
  }

  /** Remove a player for good. reason: 'left' | 'kicked' | 'timeout' */
  remove(id, reason = 'left') {
    const p = this.players.get(id);
    if (!p) return false;
    this.players.delete(id); this.byToken.delete(p.token); this.#bump();
    this.emit('leave', this.#pub(p), reason);
    this.emit('change', this.state());
    return true;
  }
  kick(id) { return this.remove(id, 'kicked'); }

  /** Drop players whose grace period ran out. Call periodically. */
  sweep(now = this.now()) {
    const gone = [];
    for (const p of [...this.players.values()]) {
      if (!p.connected && p.disconnectedAt != null && now - p.disconnectedAt >= this.graceMs) { this.remove(p.id, 'timeout'); gone.push(p.id); }
    }
    return gone;
  }

  #vehicleOk(v) { return typeof v === 'string' && VEHICLE_RE.test(v) && (!this.vehicles || this.vehicles.includes(v)); }

  /** patch: {name, vehicle, colour, ready}. Returns {ok, player} or {ok:false, code}. Atomic: nothing applied on error. */
  update(id, patch = {}) {
    const p = this.players.get(id);
    if (!p) return { ok: false, code: ERR.NOT_JOINED };
    const next = {};
    if (patch.name !== undefined) { const n = sanitizeName(patch.name); if (!n) return { ok: false, code: ERR.BAD_NAME }; next.name = n; }
    if (patch.vehicle !== undefined) { if (!this.#vehicleOk(patch.vehicle)) return { ok: false, code: ERR.BAD_VEHICLE }; next.vehicle = patch.vehicle; }
    if (patch.colour !== undefined) {
      if (typeof patch.colour !== 'string' || !COLOUR_RE.test(patch.colour)) return { ok: false, code: ERR.BAD_MESSAGE };
      if (!this.#colourFree(patch.colour, id)) return { ok: false, code: ERR.COLOUR_TAKEN };
      next.colour = patch.colour.toLowerCase();
    }
    if (patch.ready !== undefined) next.ready = !!patch.ready;
    const changed = Object.keys(next).filter(k => p[k] !== next[k]);
    if (!changed.length) return { ok: true, player: p, changed };
    Object.assign(p, next); this.#bump();
    this.emit('profile', this.#pub(p), changed);
    this.emit('change', this.state());
    return { ok: true, player: p, changed };
  }

  setLocked(v) { v = !!v; if (v !== this.locked) { this.locked = v; this.#bump(); this.emit('change', this.state()); } }

  /** Host starts the game. Optionally require everyone connected to be ready. */
  start({ requireReady = false } = {}) {
    if (this.phase !== 'lobby') return { ok: false, code: ERR.BAD_MESSAGE };
    const active = [...this.players.values()].filter(p => p.connected);
    if (!active.length) return { ok: false, code: ERR.NOT_JOINED };
    if (requireReady && !active.every(p => p.ready)) return { ok: false, code: 'NOT_READY' };
    this.phase = 'playing'; this.#bump();
    this.emit('start', this.state()); this.emit('change', this.state());
    return { ok: true };
  }
  backToLobby() { if (this.phase !== 'lobby') { this.phase = 'lobby'; for (const p of this.players.values()) p.ready = false; this.#bump(); this.emit('change', this.state()); } }
  end() { this.phase = 'ended'; this.#bump(); this.emit('end'); this.emit('change', this.state()); }

  /** Plain-JSON snapshot for persistence (host reload). Includes reconnect tokens: store only on the host's own device. */
  exportState() {
    return { phase: this.phase === 'ended' ? 'lobby' : this.phase, locked: this.locked,
      players: [...this.players.values()].sort((a, b) => a.slot - b.slot).map(p => ({ id: p.id, slot: p.slot, name: p.name, colour: p.colour, vehicle: p.vehicle, ready: p.ready, token: p.token })) };
  }
  /** Restore seats from exportState(). Every seat starts disconnected with a fresh grace window; phones reclaim them with their tokens. Returns number restored. */
  importState(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.players)) return 0;
    this.players.clear(); this.byToken.clear();
    const t = this.now();
    for (const p of s.players) {
      if (!p || typeof p.id !== 'string' || !/^p\d{1,2}$/.test(p.id) || !Number.isInteger(p.slot) || p.slot < 0 || p.slot >= 32 || typeof p.token !== 'string' || p.token.length < 16) continue;
      if (this.players.has(p.id)) continue;
      const name = sanitizeName(p.name) || `Player ${p.slot + 1}`;
      const vehicle = typeof p.vehicle === 'string' && VEHICLE_RE.test(p.vehicle) ? p.vehicle : this.defaultVehicle;
      const colour = typeof p.colour === 'string' && COLOUR_RE.test(p.colour) ? p.colour.toLowerCase() : '#cccccc';
      this.players.set(p.id, { id: p.id, slot: p.slot, token: p.token, name, colour, vehicle, ready: !!p.ready, connected: false, joinedAt: t, disconnectedAt: t, rtt: null });
      this.byToken.set(p.token, p.id);
      if (p.slot >= this.maxPlayers) this.maxPlayers = p.slot + 1; // never lock out a restored seat
    }
    this.phase = s.phase === 'playing' ? 'playing' : 'lobby'; this.locked = !!s.locked;
    this.#bump(); this.emit('change', this.state());
    return this.players.size;
  }
  /** Restart the grace clock of every disconnected seat (call when the host is reachable again). */
  refreshGrace() { const t = this.now(); for (const p of this.players.values()) if (!p.connected) p.disconnectedAt = t; }
  /** Forget every seat (failed restore / new room). */
  clear() { this.players.clear(); this.byToken.clear(); this.phase = 'lobby'; this.locked = false; this.#bump(); this.emit('change', this.state()); }

  #pub(p) { return { id: p.id, slot: p.slot, name: p.name, colour: p.colour, vehicle: p.vehicle, ready: p.ready, connected: p.connected, rtt: p.rtt }; }
  player(id) { const p = this.players.get(id); return p ? this.#pub(p) : null; }
  list() { return [...this.players.values()].sort((a, b) => a.slot - b.slot).map(p => this.#pub(p)); }
  state() { return { phase: this.phase, locked: this.locked, max: this.maxPlayers, v: this.version, players: this.list() }; }
}
