// PartyHost: runs on the TV / host screen. The game only sees: join, leave, input, lobby (+ sendFeedback).
//   const host = new PartyHost({ transport: 'webrtc', maxPlayers: MAX_PLAYERS });
//   const { joinUrl, code } = await host.open();
//   host.on('join', (playerId, name, player) => spawnCar(playerId, player));
//   host.on('leave', (playerId, reason) => removeCar(playerId));
//   host.on('input', (playerId, state) => {});            // or poll host.getInput(playerId) every physics step (adds the 500 ms safety)
//   host.sendFeedback(playerId, { speed, gear, surface, rumble, vehicle, colour, cam, state });
// Reload-proof: the session (room code, peer id / server room, seats + tokens, host secret, started flag) is saved to localStorage and
// restored automatically by open() (see PROTOCOL.md "Host reload"). Events while it happens: 'status' ('restoring' | 'reconnecting' | 'open'),
// 'restore' ({phase:'start'|'retry'|'done'|'failed', ...}), 'restored' (seats), then 'reconnect' as each phone comes back.
import { Emitter } from './emitter.js';
import { HostCore } from './host-core.js';
import { MAX_PLAYERS, ERR, ERR_TEXT, randomCode, randomToken, PROTOCOL_VERSION, SESSION_TTL_MS, RESTORE_RETRY_MS } from './protocol.js';
import { PeerJsHostTransport } from './transports/peerjs.js';
import { WsHostTransport } from './transports/ws.js';

/** True if obj (deep) has a key that looks like driver input / tilt / calibration data. */
const INPUT_KEY_RE = /^(input|inputs|steer|steering|throttle|brake|tilt|beta|gamma|alpha|calib\w*|offset\w*|motion|orientation|accel\w*|gyro\w*|rotation\w*)$/i;
export function hasInputKeys(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return false;
  for (const [k, v] of Object.entries(o)) if (INPUT_KEY_RE.test(k) || hasInputKeys(v, depth + 1)) return true;
  return false;
}

export class PartyHost extends Emitter {
  /**
   * @param {object} [o]
   * @param {'webrtc'|'ws'} [o.transport='webrtc']
   * @param {number} [o.maxPlayers=MAX_PLAYERS]
   * @param {string[]} [o.vehicles]       allowed vehicle ids (omit = any id)
   * @param {string} [o.playUrl]          controller page URL used in the QR (default: ./play.html next to the current page)
   * @param {string} [o.server]           ws transport: base URL of the party server (default: page origin)
   * @param {boolean} [o.codeAsPeerId]    webrtc: peer id = 'pm-'+CODE so phones can type the code (guessable; default off = random 128-bit id)
   * @param {object} [o.peerjs]           {Peer, peerModuleUrl, broker, useBuiltinTurn, iceServers, debug}
   * @param {object} [o.lobby]            extra Lobby options (graceMs...)
   */
  constructor(o = {}) {
    super();
    this.opts = o; this.kind = o.transport || 'webrtc';
    this.maxPlayers = o.maxPlayers || MAX_PLAYERS;
    this.code = randomCode(4); this.joinUrl = null; this.peerId = null; this.qrUrl = null; this.opened = false;
    this.status = 'idle';
    // persistence
    this.ns = o.namespace || 'pm';
    this.storageKey = `${this.ns}.host.session`;
    this.persist = o.persist !== false;
    try { this.storage = o.storage === undefined ? globalThis.localStorage : o.storage; } catch { this.storage = null; }
    if (!this.storage) this.persist = false;
    this.sessionTtlMs = o.sessionTtlMs ?? SESSION_TTL_MS; this.restoreRetryMs = o.restoreRetryMs ?? RESTORE_RETRY_MS;
    this.hostSecret = null; this.restored = null; this.extra = null; this._ended = false; this._saveTimer = null;
    const self = this;
    this.core = new HostCore({
      send: (c, m, opt) => self.transport?.send(c, m, opt),
      close: c => self.transport?.close(c),
      lobby: { maxPlayers: this.maxPlayers, vehicles: o.vehicles || null, ...(o.lobby || {}) },
      requireReady: !!o.requireReady,
    });
    for (const ev of ['join', 'leave', 'disconnect', 'reconnect', 'profile', 'input', 'lobby', 'rtt', 'start']) this.core.on(ev, (...a) => this.emit(ev, ...a));
    this.core.on('lobby', () => this.#scheduleSave());
    this.core.on('reconnect', () => { if (this.restored) this.#restoreProgress(); });
  }

  /**
   * Start (or restore) the party. Resolves with info():
   * {transport, code, joinUrl, qrUrl, peerId, maxPlayers, restored:boolean, seats, started, extra}.
   * opts.resume: 'auto' (default: restore a saved session if there is a valid one, else new room) | false (always a new room, ignores/overwrites the saved one)
   *   | true (must restore: rejects with RESUME_FAILED if impossible) | a session object (explicit, strict: e.g. one you stored yourself).
   */
  async open() {
    const o = this.opts; const mode = o.resume === undefined ? 'auto' : o.resume;
    let saved = null, strict = false;
    if (mode && typeof mode === 'object') { saved = mode; strict = true; }
    else if (mode !== false && this.persist) { saved = this.#loadSaved(); strict = mode === true; }
    if (saved && this.persist && !(await this.#acquireLock())) {
      // another tab of this browser is running the saved session: never touch it, run a separate fresh (unsaved) room instead
      this.sessionInUse = true; this.emit('status', this.status = 'session-in-use'); this.emit('session-in-use', { code: saved.code });
      if (strict) throw { code: ERR.HOST_IN_USE, message: 'This party is already open in another tab' };
      saved = null; this.persist = false;
    } else if (!saved && this.persist) { if (!(await this.#acquireLock())) { this.persist = false; this.emit('session-in-use', {}); } }

    if (saved) {
      this.emit('status', this.status = 'restoring'); this.emit('restore', { phase: 'start', code: saved.code, peerId: saved.peerId || null, seats: saved.lobby?.players?.length || 0 });
      this.code = saved.code; this.hostSecret = saved.hostSecret; this.extra = saved.extra ?? null;
      this.core.importState(saved.lobby);
      try { return await this.#openTransport(saved); }
      catch (e) {
        this.emit('restore', { phase: 'failed', code: e.code, message: e.message, attempts: e.attempts, elapsedMs: e.elapsedMs });
        this.transport?.shutdown?.(); this.transport = null;
        if (strict) { this.core.lobby.clear(); this._releaseLock?.(); this._releaseLock = null; throw { code: ERR.RESUME_FAILED, message: 'Could not restore the party: ' + (e.code || e.message), cause: e }; }
        // auto: the old room is gone (expired / id lost). Start fresh.
        this.core.lobby.clear(); this.restored = null; this.#clearSaved(); this.code = randomCode(4); this.hostSecret = null; this.extra = null;
      }
    }
    return this.#openTransport(null);
  }

  async #openTransport(saved) {
    const o = this.opts;
    const retry = { onRetry: r => { this.emit('status', this.status = 'reconnecting'); this.emit('restore', { phase: 'retry', ...r }); } };
    const cb = {
      onConnection: id => this.core.onConnection(id),
      onMessage: (id, m, ch) => this.core.onMessage(id, m, ch),
      onClose: id => this.core.onClose(id),
      onError: e => { if (e.fatal && (e.code === ERR.ROOM_CLOSED)) this.#clearSaved(true); this.emit('error', e); },
      onStatus: s => { this.status = s; this.emit('status', s); },
      ...retry,
    };
    if (this.kind === 'ws') {
      const r = saved ? { code: saved.code, hostToken: saved.hostSecret, joinUrl: saved.joinUrl, qrUrl: saved.qrUrl } : null;
      this.transport = new WsHostTransport({ server: o.server, maxPlayers: this.maxPlayers, resume: r, retryMs: saved ? this.restoreRetryMs : 0 });
    } else {
      this.transport = new PeerJsHostTransport({ ...(o.peerjs || {}), idFromCode: o.codeAsPeerId ? () => this.code : null, peerId: saved ? saved.peerId : null, retryMs: saved ? this.restoreRetryMs : 0 });
    }
    const info = await this.transport.open(cb);
    if (this.kind === 'ws') { this.code = info.code; this.joinUrl = info.joinUrl; this.qrUrl = info.qrUrl; this.hostSecret = info.hostToken; }
    else {
      this.peerId = info.peerId; this.hostSecret = this.hostSecret || randomToken(16);
      const play = o.playUrl || (globalThis.location ? new URL('play.html', globalThis.location.href).href : '/play');
      this.joinUrl = `${play}#peer=${info.peerId}`;
    }
    this.core.lobby.refreshGrace(); // reachable again: phones get a full grace window from now
    this.core.startTimers(250);
    this.opened = true; this.status = 'open';
    if (saved) {
      this.restored = { seats: this.players(), started: this.core.lobby.phase === 'playing', extra: this.extra, attempts: info.attempts || 1, at: Date.now(), code: this.code };
      this.emit('status', 'open'); this.emit('restore', { phase: 'done', attempts: info.attempts || 1, seats: this.restored.seats.length });
      this.emit('open', this.info()); this.emit('restored', this.restored);
      if (this.opts.replayJoinsOnRestore !== false) for (const p of this.restored.seats) this.emit('join', p.id, p.name, p, { restored: true });
      this.#restoreProgress();
    } else { this.emit('status', 'open'); this.emit('open', this.info()); }
    this.#installPersistence(); this.#save();
    return this.info();
  }

  #restoreProgress() {
    const seats = this.players(); const back = seats.filter(p => p.connected).length;
    this.emit('restore-progress', { seats: seats.length, connected: back, missing: seats.filter(p => !p.connected).map(p => p.id) });
  }

  // ---- persistence ----------------------------------------------------------------------------------
  #loadSaved() {
    try {
      const raw = this.storage.getItem(this.storageKey); if (!raw) return null;
      const s = JSON.parse(raw);
      const ok = s && s.v === 1 && s.kind === this.kind && typeof s.code === 'string' && typeof s.hostSecret === 'string' && s.hostSecret.length >= 16 && s.lobby && Array.isArray(s.lobby.players)
        && Date.now() - s.savedAt <= this.sessionTtlMs && s.savedAt <= Date.now() + 60000
        && (this.kind === 'ws' ? (typeof s.joinUrl === 'string' && (!this.opts.server || s.server === this.opts.server)) : /^pm-[A-Za-z0-9_-]{6,64}$/.test(s.peerId || ''));
      if (!ok) { this.#clearSaved(); return null; }
      return s;
    } catch { this.#clearSaved(); return null; }
  }
  #snapshot() {
    return { v: 1, savedAt: Date.now(), kind: this.kind, code: this.code, peerId: this.peerId, hostSecret: this.hostSecret, server: this.opts.server || null,
      joinUrl: this.joinUrl, qrUrl: this.qrUrl, maxPlayers: this.maxPlayers, lobby: this.core.exportState(), extra: this.extra };
  }
  #save() { if (!this.persist || this._ended || !this.opened) return; try { this.storage.setItem(this.storageKey, JSON.stringify(this.#snapshot())); } catch { /* quota / private mode: reload just won't restore */ } }
  #scheduleSave() { if (!this.persist || this._ended) return; clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => this.#save(), 120); }
  #clearSaved(stop = false) { if (stop) { this._ended = true; clearTimeout(this._saveTimer); } if (!this.persist) return; /* a 'session-in-use' tab must never delete the other tab's session */ try { this.storage?.removeItem(this.storageKey); } catch {} }
  #installPersistence() {
    if (!this.persist || this._persistOn) return; this._persistOn = true;
    this._touch = setInterval(() => this.#save(), 5000);           // keeps savedAt fresh: TTL counts from when the host was last alive
    this._flush = () => { clearTimeout(this._saveTimer); this.#save(); };
    try { globalThis.addEventListener?.('pagehide', this._flush); globalThis.addEventListener?.('beforeunload', this._flush); } catch {}
  }
  async #acquireLock() {
    const L = this.opts.lock === false ? null : globalThis.navigator?.locks; if (!L) return true;
    return new Promise(resolve => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000); // reload race: old page releases its lock when it unloads
      L.request(`${this.ns}.host.lock`, { signal: ctl.signal }, () => { clearTimeout(t); resolve(true); return new Promise(r => { this._releaseLock = r; }); }).catch(() => { clearTimeout(t); resolve(false); });
    });
  }
  #teardownPersistence() {
    clearInterval(this._touch); clearTimeout(this._saveTimer); this._persistOn = false;
    try { globalThis.removeEventListener?.('pagehide', this._flush); globalThis.removeEventListener?.('beforeunload', this._flush); } catch {}
    this._releaseLock?.(); this._releaseLock = null;
  }

  /** Is there a restorable saved session for this transport right now? (e.g. to show "Resume party?" before open()). */
  static hasSavedSession(o = {}) {
    try { const st = o.storage === undefined ? globalThis.localStorage : o.storage; const s = JSON.parse(st?.getItem(`${o.namespace || 'pm'}.host.session`) || 'null');
      return !!(s && s.v === 1 && (o.transport || 'webrtc') === s.kind && Date.now() - s.savedAt <= (o.sessionTtlMs ?? SESSION_TTL_MS)); } catch { return false; }
  }
  /** Secret-free preview of the saved session so the UI can show the SAME code/QR immediately while restoring: {code, joinUrl, qrUrl, seats:[{id,name,colour,vehicle}], started, savedAt} or null. */
  static peekSavedSession(o = {}) {
    try { const st = o.storage === undefined ? globalThis.localStorage : o.storage; const s = JSON.parse(st?.getItem(`${o.namespace || 'pm'}.host.session`) || 'null');
      if (!PartyHost.hasSavedSession(o) || !s.code) return null;
      return { code: s.code, joinUrl: s.joinUrl, qrUrl: s.qrUrl || null, started: s.lobby?.phase === 'playing', savedAt: s.savedAt, seats: (s.lobby?.players || []).map(p => ({ id: p.id, name: p.name, colour: p.colour, vehicle: p.vehicle })) }; } catch { return null; }
  }
  /** Forget the saved session (the next open() starts a new room). */
  static clearSavedSession(o = {}) { try { (o.storage === undefined ? globalThis.localStorage : o.storage)?.removeItem(`${o.namespace || 'pm'}.host.session`); } catch {} }
  /** Stash small JSON (<= 8 KB) with the session, e.g. lap or world seed; returned as `restored.extra` after a reload. Privacy: objects with input/steer/tilt/calibration-like keys are refused (never persisted). */
  setSessionExtra(obj) { try { if (JSON.stringify(obj ?? null).length <= 8192 && !hasInputKeys(obj)) { this.extra = obj ?? null; this.#scheduleSave(); } } catch {} }

  info() { return { transport: this.kind, code: this.code, joinUrl: this.joinUrl, qrUrl: this.qrUrl, peerId: this.peerId, maxPlayers: this.maxPlayers, restored: !!this.restored, sessionInUse: !!this.sessionInUse, seats: this.restored?.seats || [], started: this.core.lobby.phase === 'playing', extra: this.extra, v: PROTOCOL_VERSION }; }

  // --- game-facing API (thin wrappers over HostCore) ---
  get lobby() { return this.core.lobby; }
  players() { return this.core.lobby.list(); }
  getInput(playerId) { return this.core.getInput(playerId); }
  rtt(playerId) { return this.core.rtt(playerId); }
  inputStats(playerId) { return this.core.inputStats(playerId); }
  channels(playerId) { const pl = this.core.players.get(playerId); return pl ? this.transport?.channelsOf?.(pl.connId) : null; }
  sendFeedback(playerId, fb, opts) { this.core.sendFeedback(playerId, fb, opts); }
  sendHaptic(playerId, strength, ms) { this.core.sendHaptic(playerId, strength, ms); }
  sendSnapshot(players, extra) { this.core.sendSnapshot(players, extra); }
  startSnapshots(getPlayers, hz) { this.core.startSnapshots(getPlayers, hz); }
  stopSnapshots() { this.core.stopSnapshots(); }
  setLocked(v) { this.core.setLocked(v); }
  startGame() { return this.core.start(); }
  backToLobby() { this.core.backToLobby(); }
  kick(playerId) { return this.core.kick(playerId); }
  /** End the party for everyone and forget the saved session (a fresh load starts a new room). */
  end() { this.#clearSaved(true); this.#teardownPersistence(); this.core.end(); setTimeout(() => this.transport?.shutdown(), 300); }
  /** Stop this page's host WITHOUT ending the party: the saved session stays so a reload/reopen restores it. */
  close() { this.#save(); this._ended = true; this.#teardownPersistence(); this.core.stopTimers(); (this.transport?.detach || this.transport?.shutdown)?.call(this.transport); }
}
