// HostCore: transport-agnostic protocol engine for the TV/host side.
// A transport (PeerJS data channels, or the WebSocket relay) feeds it connections + messages and gives it a send() function.
import { Emitter } from './emitter.js';
import { Lobby } from './lobby.js';
import {
  PROTOCOL_VERSION, ERR, ERR_TEXT, INPUT_TIMEOUT_MS, INPUT_EASE_MS, MAX_INPUT_HZ, parseMessage, sanitizeInput, InputGate, RttTracker,
} from './protocol.js';

const HEARTBEAT_TIMEOUT_MS = 5000;

export class HostCore extends Emitter {
  /**
   * @param {object} o
   * @param {(connId:string, msg:object, opts?:{unreliable?:boolean})=>void} o.send
   * @param {(connId:string)=>void} o.close      close a connection
   * @param {object} [o.lobby]   Lobby options (maxPlayers, vehicles, graceMs, ...)
   * @param {()=>number} [o.now]
   * @param {number} [o.pingIntervalMs=2000]
   * @param {boolean} [o.requireReady=false]
   */
  constructor({ send, close, lobby = {}, now = () => Date.now(), pingIntervalMs = 2000, maxInputHz = MAX_INPUT_HZ, requireReady = false } = {}) {
    super();
    this._send = send; this._close = close; this.now = now; this.pingIntervalMs = pingIntervalMs; this.requireReady = requireReady;
    this.lobby = new Lobby({ now, ...lobby });
    this.maxInputHz = maxInputHz;
    this.conns = new Map();      // connId -> {playerId, lastSeen, lastRateWarn}
    this.players = new Map();    // playerId -> {connId, gate, rtt:RttTracker, input, inputAt, pingN, pingSent:Map}
    this._timer = null; this._snapTimer = null; this._lastPing = 0; this.ended = false;
    this.lobby.on('change', s => this.emit('lobby', s));
    this.lobby.on('join', p => this.emit('join', p.id, p.name, p));
    this.lobby.on('leave', (p, why) => { this.players.delete(p.id); this.emit('leave', p.id, why, p); });
    this.lobby.on('disconnect', p => this.emit('disconnect', p.id, p));
    this.lobby.on('reconnect', p => this.emit('reconnect', p.id, p));
    this.lobby.on('profile', (p, ch) => this.emit('profile', p.id, p, ch));
    this.lobby.on('start', s => this.emit('start', s));
    // push state to everybody whenever it changes (reliable). Coalesced per microtask so bursts send once.
    let queued = false;
    this.lobby.on('change', () => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; if (!this.ended) this.broadcastLobby(); }); });
  }

  // ---- lifecycle ------------------------------------------------------------------------------
  startTimers(tickMs = 250) { this.stopTimers(); this._timer = setInterval(() => this.tick(), tickMs); return this; }
  stopTimers() { clearInterval(this._timer); clearInterval(this._snapTimer); this._timer = this._snapTimer = null; }

  tick(t = this.now()) {
    this.lobby.sweep(t);
    for (const [connId, c] of this.conns) {
      // heartbeat: a joined phone that went silent is treated as dropped (starts the 30 s grace period)
      if (c.playerId && t - c.lastSeen > HEARTBEAT_TIMEOUT_MS) this._drop(connId, 'heartbeat');
    }
    if (t - this._lastPing >= this.pingIntervalMs) {
      this._lastPing = t;
      for (const [pid, pl] of this.players) {
        const p = this.lobby.players.get(pid);
        if (!p || !p.connected) continue;
        const n = ++pl.pingN; pl.pingSent.set(n, t);
        if (pl.pingSent.size > 20) pl.pingSent.delete(pl.pingSent.keys().next().value);
        this._tx(pl.connId, { t: 'ping', n, ts: t }, true);
      }
    }
  }

  // ---- transport entry points ----------------------------------------------------------------
  onConnection(connId) { if (this.conns.has(connId)) return; if (this.ended) { this._tx(connId, { t: 'err', code: ERR.ROOM_CLOSED, message: ERR_TEXT.ROOM_CLOSED, fatal: true }); this._close(connId); return; } this.conns.set(connId, { playerId: null, lastSeen: this.now(), lastRateWarn: 0 }); }

  onMessage(connId, raw, channel = 'ctl') {
    const c = this.conns.get(connId);
    if (!c) return;
    const m = parseMessage(raw);
    if (!m) { this._err(connId, ERR.BAD_MESSAGE, 'Unreadable message'); return; }
    c.lastSeen = this.now();
    switch (m.t) {
      case 'in': return this._onInput(connId, c, m);
      case 'ping': return this._tx(connId, { t: 'pong', n: m.n, ts: m.ts, hts: this.now() }, true);
      case 'pong': return this._onPong(c, m);
      case 'hello': return this._onHello(connId, c, m);
      case 'set': return this._onSet(connId, c, m);
      case 'bye': return this._drop(connId, 'bye', true);
      default: return this._err(connId, ERR.BAD_MESSAGE, 'Unknown type ' + String(m.t).slice(0, 20));
    }
  }

  onClose(connId) { this._drop(connId, 'closed', false); }

  // ---- handlers -------------------------------------------------------------------------------
  _onHello(connId, c, m) {
    if (c.playerId) { // already joined on this connection (phone re-sent hello after the relay reported 'hostup'): answer again so it leaves 'reconnecting'
      const me = this.lobby.player(c.playerId);
      if (me && m.token && this.lobby.byToken.get(m.token) === me.id) this._tx(connId, { t: 'welcome', v: PROTOCOL_VERSION, playerId: me.id, token: m.token, resumed: true, you: me, lobby: this.lobby.state(), hts: this.now(), graceMs: this.lobby.graceMs });
      return;
    }
    if (m.v !== undefined && m.v !== PROTOCOL_VERSION) return this._fatal(connId, ERR.BAD_VERSION, 'Protocol version mismatch');
    let res;
    if (m.token) {
      res = this.lobby.resume(m.token);
      if (!res.ok) { this._tx(connId, { t: 'err', code: ERR.BAD_TOKEN, message: ERR_TEXT.BAD_TOKEN, fatal: false }); return; }
      // same seat taken over from a still-open old connection: close it
      const old = this.players.get(res.player.id);
      if (old && old.connId !== connId) {
        const oc = this.conns.get(old.connId);
        if (oc) { oc.playerId = null; this._tx(old.connId, { t: 'err', code: ERR.REPLACED, message: 'Opened on another page', fatal: true }); this._close(old.connId); this.conns.delete(old.connId); }
      }
    } else {
      res = this.lobby.join({ name: m.name, vehicle: m.vehicle, colour: m.colour });
      if (!res.ok) return this._fatal(connId, res.code, ERR_TEXT[res.code] || res.code);
    }
    const p = res.player;
    c.playerId = p.id;
    let pl = this.players.get(p.id);
    if (!pl) { pl = { connId, gate: new InputGate({ maxHz: this.maxInputHz, now: this.now }), rtt: new RttTracker(), input: null, inputAt: 0, pingN: 0, pingSent: new Map() }; this.players.set(p.id, pl); }
    pl.connId = connId; pl.gate.reset();
    this._tx(connId, { t: 'welcome', v: PROTOCOL_VERSION, playerId: p.id, token: p.token, resumed: !!m.token, you: this.lobby.player(p.id), lobby: this.lobby.state(), hts: this.now(), graceMs: this.lobby.graceMs });
    if (m.token) this.broadcastLobby();
  }

  _onSet(connId, c, m) {
    if (!c.playerId) return this._err(connId, ERR.NOT_JOINED, 'Send hello first');
    const patch = {};
    for (const k of ['name', 'vehicle', 'colour', 'ready']) if (m[k] !== undefined) patch[k] = m[k];
    const r = this.lobby.update(c.playerId, patch);
    if (!r.ok) this._err(connId, r.code, 'Rejected: ' + r.code);
  }

  _onInput(connId, c, m) {
    if (!c.playerId) return;
    const pl = this.players.get(c.playerId);
    if (!pl || pl.connId !== connId) return;
    const inp = sanitizeInput(m);
    if (!inp) return;
    const verdict = pl.gate.check(inp.seq);
    if (verdict === 'stale') return;
    if (verdict === 'limited') {
      const t = this.now();
      if (t - c.lastRateWarn > 1000) { c.lastRateWarn = t; this._tx(connId, { t: 'err', code: ERR.RATE_LIMITED, message: 'Too many inputs', fatal: false }, true); }
      return;
    }
    inp.rxAt = this.now();
    const prev = pl.input;
    // one-shot actions are edges: phone holds cam:'next' / reset:1 for several packets so one lost datagram cannot swallow a tap
    inp.camEdge = !!inp.cam && !(prev && prev.cam === inp.cam);
    inp.resetEdge = !!inp.reset && !(prev && prev.reset);
    inp.hornEdge = !!inp.horn && !(prev && prev.horn);
    pl.input = inp; pl.inputAt = inp.rxAt;
    this.emit('input', c.playerId, inp); // immediately, no batching
  }

  _onPong(c, m) {
    const pl = c.playerId && this.players.get(c.playerId);
    if (!pl) return;
    const sent = pl.pingSent.get(m.n);
    if (sent == null) return;
    pl.pingSent.delete(m.n);
    const rtt = this.now() - sent;
    pl.rtt.add(rtt);
    const p = this.lobby.players.get(c.playerId); if (p) p.rtt = Math.round(pl.rtt.avg);
    this.emit('rtt', c.playerId, pl.rtt.summary());
  }

  _drop(connId, why, intentional = false) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    if (c.playerId) {
      const pl = this.players.get(c.playerId);
      if (pl && pl.connId === connId) {
        if (intentional) this.lobby.remove(c.playerId, 'left');
        else this.lobby.disconnect(c.playerId);
      }
    }
    if (why === 'heartbeat') this._close(connId);
    if (intentional) this._close(connId);
  }

  // ---- host API --------------------------------------------------------------------------------
  broadcastLobby() { const s = this.lobby.state(); for (const [connId, c] of this.conns) if (c.playerId) this._tx(connId, { t: 'lobby', ...s, you: c.playerId }); }

  /** Latest input with the safety from architecture.md / the spike: after 500 ms of silence throttle eases to 0 (reaches 0 at ~1.4 s), steering recentres, light brake. */
  getInput(playerId, timeoutMs = INPUT_TIMEOUT_MS, easeMs = INPUT_EASE_MS) {
    const pl = this.players.get(playerId);
    const zero = { t: 'in', seq: -1, ts: 0, steer: 0, throttle: 0, brake: 0, hand: 0, rev: 0, horn: 0, reset: 0, mode: 'wheel', look: null, zoom: 0, glance: null, cam: null, camEdge: false, resetEdge: false, hornEdge: false, age: Infinity, timedOut: true };
    if (!pl || !pl.input) return zero;
    const age = this.now() - pl.inputAt;
    if (age <= timeoutMs) return { ...pl.input, age, timedOut: false };
    const k = Math.max(0, 1 - (age - timeoutMs) / easeMs);
    // silence: ease throttle to 0, recentre steering, add a light brake (architecture.md)
    return { ...pl.input, throttle: pl.input.throttle * k, steer: pl.input.steer * k, brake: Math.max(pl.input.brake, 0.3 * (1 - k)), horn: 0, reset: 0, cam: null, look: null, zoom: 0, glance: null, camEdge: false, resetEdge: false, hornEdge: false, age, timedOut: true };
  }

  rtt(playerId) { return this.players.get(playerId)?.rtt.summary() || null; }
  inputStats(playerId) { return this.players.get(playerId)?.gate.stats() || null; }

  /** Send to one player. Default reliable; pass {unreliable:true} for high-rate data. */
  sendTo(playerId, msg, opts) { const pl = this.players.get(playerId); if (pl && this.lobby.players.get(playerId)?.connected) this._tx(pl.connId, msg, opts?.unreliable); }
  broadcast(msg, opts) { for (const [connId, c] of this.conns) if (c.playerId) this._tx(connId, msg, opts?.unreliable); }

  /** fb (architecture.md): {speed, gear, surface, rumble, vehicle, colour, cam, state:'lobby'|'drive'} (+ echo:ts added automatically) — unreliable by default (a lost one is replaced by the next). */
  sendFeedback(playerId, fb, opts = {}) {
    const pl = this.players.get(playerId);
    this.sendTo(playerId, { t: 'fb', ...fb, echo: pl?.input ? pl.input.ts : 0 }, { unreliable: opts.reliable ? false : true });
  }

  /** One-shot haptic cue. strength 0..1, ms duration. Reliable so it is not lost. */
  sendHaptic(playerId, strength = 0.5, ms = 80) { this.sendTo(playerId, { t: 'fb', rumble: strength, rumbleMs: ms }, { unreliable: false }); }

  /** Positions for HUD/minimap: players = [{id,x,z,h,v}] (world units, heading rad, speed). Sent unreliable. */
  sendSnapshot(players, extra = {}) {
    const r = v => Math.round(v * 100) / 100;
    this.broadcast({ t: 'snap', ts: this.now(), p: players.map(o => [o.id, r(o.x), r(o.z), r(o.h || 0), r(o.v || 0)]), ...extra }, { unreliable: true });
  }
  /** Convenience: call getPlayers() ~hz times a second and send the snapshot. */
  startSnapshots(getPlayers, hz = 20) { clearInterval(this._snapTimer); this._snapTimer = setInterval(() => this.sendSnapshot(getPlayers()), Math.round(1000 / Math.min(30, hz))); }
  stopSnapshots() { clearInterval(this._snapTimer); this._snapTimer = null; }

  setLocked(v) { this.lobby.setLocked(v); }
  start() { const r = this.lobby.start({ requireReady: this.requireReady }); if (r.ok) this.broadcast({ t: 'start' }); return r; }
  backToLobby() { this.lobby.backToLobby(); }
  kick(playerId) {
    const pl = this.players.get(playerId);
    if (pl) { this._tx(pl.connId, { t: 'kick', code: ERR.KICKED, message: ERR_TEXT.KICKED }); const connId = pl.connId; this.conns.delete(connId); setTimeout(() => this._close(connId), 50); }
    return this.lobby.kick(playerId);
  }
  end(code = ERR.ROOM_CLOSED) {
    if (this.ended) return; this.ended = true;
    this.broadcast({ t: 'end', code, message: ERR_TEXT[code] || 'Party ended' });
    this.lobby.end(); this.stopTimers();
    const ids = [...this.conns.keys()]; setTimeout(() => ids.forEach(id => this._close(id)), 100);
  }

  /** Persistable snapshot (seats + tokens + phase). */
  exportState() { return this.lobby.exportState(); }
  /** Restore a snapshot (host page reloaded). Seats stay disconnected until their phones come back with their tokens. */
  importState(s) { return this.lobby.importState(s); }

  // ---- internals -------------------------------------------------------------------------------
  _tx(connId, msg, unreliable = false) { try { this._send(connId, msg, { unreliable }); } catch { /* connection already gone */ } }
  _err(connId, code, message) { this._tx(connId, { t: 'err', code, message, fatal: false }); }
  _fatal(connId, code, message) { this._tx(connId, { t: 'err', code, message, fatal: true }); const c = this.conns.get(connId); this.conns.delete(connId); setTimeout(() => this._close(connId), 50); }
}
