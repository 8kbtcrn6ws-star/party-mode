// PartyController: phone side. One class for both transports.
//   const pc = new PartyController({ url: location.href, name: 'Zav' });   // reads #peer=<id> (webrtc) or ?code=XXXXX (ws)
//   pc.on('status', s => ...)   // 'connecting' | 'connected' | 'reconnecting' | 'closed'
//   await pc.connect();         // resolves after `welcome`
//   pc.startInputLoop(() => ({ steer, throttle, brake, rev, hand, horn, look, cam, reset, mode }), 30);
//   pc.setProfile({ vehicle: 'pickup', colour: '#3da9ff', ready: true });
import { Emitter } from './emitter.js';
import { PROTOCOL_VERSION, ERR, ERR_TEXT, SEAT_GRACE_MS, INPUT_HZ, RttTracker, seqNewer } from './protocol.js';
import { PeerJsControllerTransport } from './transports/peerjs.js';
import { WsControllerTransport } from './transports/ws.js';

const HOST_SILENCE_MS = 5000;
const CAM_HOLD_MS = 200;

/** Parse a join URL (QR content): '#peer=ID' -> webrtc, '?code=ABCDE' -> ws (server = that URL's origin). */
export function parseJoinUrl(href) {
  try {
    const u = new URL(href, globalThis.location?.href);
    const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
    const peer = hash.get('peer');
    const code = (u.searchParams.get('code') || hash.get('code') || '').toUpperCase() || null;
    return { peer: peer || null, code, server: u.origin };
  } catch { return { peer: null, code: null, server: null }; }
}

export class PartyController extends Emitter {
  /**
   * @param {object} o
   * @param {string} [o.url]          join URL (QR). Alternative to peer/code.
   * @param {string} [o.peer]         host peer id (webrtc)
   * @param {string} [o.code]         room code (ws)
   * @param {string} [o.server]       ws server base URL
   * @param {'auto'|'webrtc'|'ws'} [o.transport]
   * @param {string} [o.fallbackServer]  in 'auto' mode, if WebRTC fails, retry via this ws server using `code`
   * @param {string} [o.name] [o.vehicle] [o.colour]
   * @param {object} [o.peerjs]
   * @param {Storage|null} [o.storage]  default sessionStorage
   */
  constructor(o = {}) {
    super();
    const j = o.url ? parseJoinUrl(o.url) : {};
    this.opts = o;
    this.peer = o.peer || j.peer || null;
    this.code = (o.code || j.code || '').toUpperCase() || null;
    this.server = o.server || j.server || null;
    this.kind = o.transport && o.transport !== 'auto' ? o.transport : (this.peer ? 'webrtc' : 'ws');
    this.profile = { name: o.name, vehicle: o.vehicle, colour: o.colour };
    this.status = 'idle'; this.playerId = null; this.token = null; this.lobby = null; this.you = null;
    this.graceMs = SEAT_GRACE_MS; this.rtt = new RttTracker();
    this.seq = Math.floor(Math.random() * 1000); this.camUntil = 0; this.resetUntil = 0;
    this.stats = { sent: 0, dropped: 0, fb: 0, snaps: 0 };
    this.lastFb = null; this.lastRx = 0; this._stopped = false; this._wasJoined = false;
    try { this.storage = o.storage === undefined ? globalThis.sessionStorage : o.storage; } catch { this.storage = null; }
    const id = this.peer || `${this.code}@${this.server}`;
    this.storeKey = 'pm.session.' + id;
    this.#loadSession();
  }

  // ---- session persistence (rejoin within the grace period after a refresh) ----
  #loadSession() {
    try { const s = JSON.parse(this.storage?.getItem(this.storeKey) || 'null'); if (s) { this.token = s.token || null; this.playerId = s.playerId || null; this.profile = { ...this.profile, name: this.profile.name || s.name, vehicle: this.profile.vehicle || s.vehicle, colour: this.profile.colour || s.colour }; } } catch {}
  }
  #saveSession() { try { this.storage?.setItem(this.storeKey, JSON.stringify({ playerId: this.playerId, token: this.token, name: this.you?.name || this.profile.name, vehicle: this.you?.vehicle, colour: this.you?.colour, at: Date.now() })); } catch {} }
  #clearSession() { this.token = null; this.playerId = null; try { this.storage?.removeItem(this.storeKey); } catch {} }
  hasSavedSeat() { return !!this.token; }

  #setStatus(s) { if (this.status !== s) { this.status = s; this.emit('status', s); } }
  #makeTransport(kind) {
    return kind === 'webrtc'
      ? new PeerJsControllerTransport({ ...(this.opts.peerjs || {}), peerId: this.peer })
      : new WsControllerTransport({ server: this.server, code: this.code });
  }
  #handlers() { return { onMessage: m => this.#onMessage(m), onClose: r => this.#onTransportClose(r), onChannel: () => this.emit('channel', { unreliable: true }) }; }

  /** Connect + join. Rejects with {code, message}. Resolves with the welcome payload. */
  async connect() {
    this._stopped = false;
    this.#setStatus('connecting');
    try { await this.#open(this.kind); }
    catch (e) {
      const fallback = this.kind === 'webrtc' && this.opts.fallbackServer && this.code && (!this.opts.transport || this.opts.transport === 'auto')
        && [ERR.BROKER_UNREACHABLE, ERR.ICE_FAILED, ERR.TIMEOUT].includes(e.code);
      if (!fallback) { this.#setStatus('closed'); this.emit('error', this.#withText(e, true)); throw e; }
      this.emit('fallback', { from: 'webrtc', to: 'ws', reason: e });
      this.kind = 'ws'; this.server = this.opts.fallbackServer;
      try { await this.#open('ws'); } catch (e2) { this.#setStatus('closed'); this.emit('error', this.#withText(e2, true)); throw e2; }
    }
    return this.#join();
  }

  async #open(kind, attemptMs) {
    this.transport?.close?.();
    this.transport = this.#makeTransport(kind);
    await this.transport.connect(this.#handlers(), attemptMs ? { timeoutMs: attemptMs } : undefined);
    this.lastRx = Date.now();
  }

  #join() {
    return new Promise((resolve, reject) => {
      const off1 = this.once('welcome', w => { off1(); off2(); resolve(w); });
      const off2 = this.once('error', e => { if (e.fatal) { off1(); off2(); reject(e); } });
      this.#sendHello();
      this.#startHeartbeat();
    });
  }

  #sendHello() {
    const p = this.profile;
    this.#tx({ t: 'hello', v: PROTOCOL_VERSION, playerId: this.playerId, token: this.token || undefined, name: p.name, vehicle: p.vehicle, colour: p.colour }, false);
  }

  #tx(msg, unreliable) { const ok = this.transport?.send(msg, { unreliable }) ?? false; return ok; }

  #withText(e, fatal) { return { code: e.code, message: ERR_TEXT[e.code] || e.message || e.code, fatal: e.fatal ?? fatal, detail: e.message }; }

  // ---- inbound ----
  #onMessage(raw) {
    let m = raw;
    if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { return; } }
    if (!m || typeof m.t !== 'string') return;
    this.lastRx = Date.now();
    switch (m.t) {
      case 'welcome':
        this.playerId = m.playerId; this.token = m.token; this.you = m.you; this.lobby = m.lobby; this.graceMs = m.graceMs || SEAT_GRACE_MS;
        this._wasJoined = true; this._dropAt = null; this.#saveSession(); this.#setStatus('connected');
        this.emit('welcome', m); this.emit('lobby', m.lobby); break;
      case 'lobby': {
        this.lobby = m; const me = m.players?.find(p => p.id === this.playerId); if (me) { this.you = me; this.#saveSession(); }
        this.emit('lobby', m); break;
      }
      case 'fb': this.stats.fb++; this.lastFb = m; if (m.echo) { const rtt = performance.now() - m.echo; if (rtt >= 0 && rtt < 5000) this.emit('echo', rtt); } this.emit('fb', m); if (m.rumble) this.emit('haptic', { strength: m.rumble, ms: m.rumbleMs || 60 }); break;
      case 'snap': this.stats.snaps++; this.emit('snap', m); break;
      case 'ping': this.#tx({ t: 'pong', n: m.n, ts: m.ts }, true); break;
      case 'pong': { if (typeof m.ts === 'number') { const r = performance.now() - m.ts; if (r >= 0 && r < 10000) { this.rtt.add(r); this.emit('rtt', this.rtt.summary()); } } break; }
      case 'start': this.emit('start'); break;
      case 'kick': this.#clearSession(); this.#fatal({ code: ERR.KICKED, message: m.message }); break;
      case 'end': this.#clearSession(); this.#fatal({ code: m.code || ERR.ROOM_CLOSED, message: m.message }); break;
      case 'hostup': this.#sendHello(); break; // ws relay: host (re)attached
      case 'hostdown': this.emit('hostdown'); if (this.status === 'connected') { this._dropAt = this._dropAt || Date.now(); this.#setStatus('reconnecting'); this.emit('reconnecting', { graceMs: this.graceMs, reason: 'host-down', since: this._dropAt }); } break; // ws relay: TV left, socket stays up; 'hostup' brings it back
      case 'err': {
        const e = this.#withText(m, !!m.fatal);
        if (m.code === ERR.BAD_TOKEN) { this.token = null; this.#sendHello(); this.emit('rejoin-failed', e); break; } // seat expired: join as a new player
        if (m.code === ERR.RATE_LIMITED) { this.emit('ratelimited'); break; }
        if (m.fatal) { if ([ERR.REPLACED].includes(m.code)) { /* keep session: another page owns it now */ } this.#fatal(e); }
        else this.emit('error', e);
        break;
      }
    }
  }

  #fatal(e) {
    this._stopped = true; this.stopInputLoop(); clearInterval(this._hb); this.#setStatus('closed');
    this.emit('error', { ...this.#withText(e, true), fatal: true });
    this.transport?.close?.();
  }

  // ---- reconnect ----
  #onTransportClose() {
    if (this._stopped) return;
    if (!this._wasJoined) return;
    this.#startReconnect();
  }
  #startReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true; this._dropAt = this._dropAt || Date.now();
    this.#setStatus('reconnecting'); this.emit('reconnecting', { graceMs: this.graceMs, reason: 'link', since: this._dropAt });
    let delay = 300;
    const attempt = async () => {
      if (this._stopped) { this._reconnecting = false; return; }
      if (Date.now() - this._dropAt > this.graceMs) { this._reconnecting = false; this.#clearSession(); this.#fatal({ code: ERR.TIMEOUT, message: 'Lost the TV for more than ' + Math.round(this.graceMs / 1000) + ' s' }); return; }
      try { this.transport?.closeConn?.(); await this.#open(this.kind, 3500); this._reconnecting = false; this.#sendHello(); } // short attempts: the broker queues an offer for an absent TV ~5 s; retrying fast finds a returning TV sooner
      catch (e) { if (e.code === ERR.ROOM_NOT_FOUND && this.kind === 'ws') { this._reconnecting = false; return this.#fatal(e); } delay = Math.min(delay * 1.6, 1500); setTimeout(attempt, delay); }
    };
    setTimeout(attempt, delay);
  }

  // ---- heartbeat / rtt ----
  #startHeartbeat() {
    clearInterval(this._hb); let n = 0;
    this._hb = setInterval(() => {
      if (this._stopped) return;
      if (this.status === 'connected') {
        this.#tx({ t: 'ping', n: ++n, ts: performance.now() }, true);
        if (Date.now() - this.lastRx > HOST_SILENCE_MS) { this.transport?.closeConn?.(); this.#startReconnect(); } // silent TV = dropped link
      }
    }, 1000);
  }

  // ---- outbound ----
  /** Patch your lobby profile: {name, vehicle, colour, ready}. Reliable. */
  setProfile(p) { Object.assign(this.profile, { name: p.name ?? this.profile.name, vehicle: p.vehicle ?? this.profile.vehicle, colour: p.colour ?? this.profile.colour }); this.#tx({ t: 'set', ...p }, false); }
  ready(v = true) { this.setProfile({ ready: !!v }); }

  /** Tap on the camera button: the host sees cam:'next' for ~200 ms (several packets) = one edge. */
  camNext() { this.camKind = 'next'; this.camUntil = performance.now() + CAM_HOLD_MS; }
  /** Tap on the view toggle: cab view <-> last third-person view. Same ~200 ms hold, sent as cam:'view'. */
  camView() { this.camKind = 'view'; this.camUntil = performance.now() + CAM_HOLD_MS; }
  /** Reset-vehicle tap (held 200 ms, edge on host). */
  resetVehicle() { this.resetUntil = performance.now() + CAM_HOLD_MS; }

  /** Send one input now (unreliable channel when available). state fields are the controls output; seq/ts are added. */
  sendInput(s = {}) {
    if (this.status !== 'connected') { this.stats.dropped++; return false; }
    const now = performance.now();
    const msg = {
      t: 'in', seq: this.seq = (this.seq + 1) >>> 0, ts: +now.toFixed(2),
      steer: s.steer || 0, throttle: s.throttle || 0, brake: s.brake || 0, rev: s.rev ? 1 : 0, hand: s.hand ? 1 : 0, horn: s.horn ? 1 : 0,
      look: s.look || null, zoom: Number.isFinite(s.zoom) ? Math.max(-1, Math.min(1, s.zoom)) : 0, glance: (s.glance === 'back' || s.glance === 'left' || s.glance === 'right') ? s.glance : null, cam: (s.cam === 'next' || s.cam === 'view') ? s.cam : (now < this.camUntil ? (this.camKind || 'next') : null), reset: (s.reset || now < this.resetUntil) ? 1 : 0, mode: s.mode || 'wheel',
    };
    const ok = this.#tx(msg, true); this.stats.sent++; if (!ok) this.stats.dropped++;
    return ok;
  }
  /** Calls getState() hz times a second (default 30) and sends it. */
  startInputLoop(getState, hz = INPUT_HZ) {
    this.stopInputLoop();
    this._inputTimer = setInterval(() => { try { this.sendInput(getState()); } catch (e) { this.emit('error', { code: 'INPUT_LOOP', message: String(e), fatal: false }); } }, Math.round(1000 / hz));
  }
  stopInputLoop() { clearInterval(this._inputTimer); this._inputTimer = null; }
  get channel() { return this.transport?.hasUnreliable ? 'unreliable' : 'control'; }

  /** Leave the party for good (frees the seat immediately). */
  leave() {
    this.#tx({ t: 'bye' }, false); this.#clearSession(); this._stopped = true; this.stopInputLoop(); clearInterval(this._hb);
    setTimeout(() => this.transport?.close?.(), 100); this.#setStatus('closed');
  }
  /** Close without freeing the seat (page going away; rejoin within the grace period). */
  disconnect() { this._stopped = true; this.stopInputLoop(); clearInterval(this._hb); this.transport?.close?.(); this.#setStatus('closed'); }
}
