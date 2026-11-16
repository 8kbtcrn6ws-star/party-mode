// WebSocket transport (local fallback server: /workspace/party-mode/server). Same messages as WebRTC; one socket carries everything.
import { ERR, ERR_TEXT } from '../protocol.js';

const wsUrlOf = base => base.replace(/^http/, 'ws').replace(/\/$/, '');
const httpUrlOf = base => base.replace(/^ws/, 'http').replace(/\/$/, '');

/** Ask the server for a room. Returns {code, hostToken, joinUrl, wsUrl, qrUrl, maxPlayers} */
export async function createRoom(server, maxPlayers) {
  const r = await fetch(httpUrlOf(server) + '/api/party', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(maxPlayers ? { maxPlayers } : {}) });
  if (!r.ok) throw { code: ERR.BROKER_UNREACHABLE, message: 'Party server said ' + r.status };
  return r.json();
}

// ============================ HOST ======================================================================
export class WsHostTransport {
  constructor(opts = {}) { this.opts = opts; this.ws = null; this.closed = false; this.cb = {}; this.known = new Set(); }
  /** opts.resume = {code, hostToken, joinUrl, qrUrl} re-attaches to an existing room (host page reloaded). opts.retryMs: keep trying (server unreachable). */
  async open(cb) {
    this.cb = cb;
    const server = this.opts.server || globalThis.location?.origin;
    if (!server) throw { code: ERR.BROKER_UNREACHABLE, message: 'No server URL' };
    const r = this.opts.resume;
    if (r) {
      this.room = { code: r.code, hostToken: r.hostToken, joinUrl: r.joinUrl, qrUrl: r.qrUrl, wsUrl: wsUrlOf(server) + '/ws' };
      const t0 = Date.now(), deadline = t0 + (this.opts.retryMs || 0); let attempt = 0, delay = 700;
      for (;;) {
        try { await this.#connect(); break; }
        catch (e) {
          if (e.code !== ERR.BROKER_UNREACHABLE || Date.now() + delay > deadline) throw { ...e, attempts: attempt + 1, elapsedMs: Date.now() - t0 };
          attempt++; this.cb.onRetry?.({ attempt, code: e.code, message: e.message, elapsedMs: Date.now() - t0 });
          await new Promise(res => setTimeout(res, delay)); delay = Math.min(delay * 1.5, 4000);
        }
      }
      return { code: this.room.code, joinUrl: this.room.joinUrl, qrUrl: this.room.qrUrl, hostToken: this.room.hostToken, attempts: attempt + 1 };
    }
    let room;
    try { room = await createRoom(server, this.opts.maxPlayers); } catch (e) { throw e.code ? e : { code: ERR.BROKER_UNREACHABLE, message: String(e.message || e) }; }
    this.room = room;
    await this.#connect();
    return { code: room.code, joinUrl: room.joinUrl, qrUrl: room.qrUrl, hostToken: room.hostToken, attempts: 1 };
  }
  #connect() {
    return new Promise((resolve, reject) => {
      const room = this.room;
      const ws = new WebSocket(`${room.wsUrl}?role=host&code=${room.code}&hostToken=${room.hostToken}`);
      let ready = false;
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'hostready') { ready = true; this.ws = ws; this.reconnectDelay = 500; resolve(); }
        else if (m.t === 'open') { this.known.add(m.c); this.cb.onConnection?.(m.c); }
        else if (m.t === 'rx') this.cb.onMessage?.(m.c, m.m, m.m?.t === 'in' || m.m?.t === 'ping' ? 'in' : 'ctl');
        else if (m.t === 'close') { this.known.delete(m.c); this.cb.onClose?.(m.c); }
        else if (m.t === 'end') { this.closed = true; this.cb.onError?.({ code: m.code || ERR.ROOM_CLOSED, message: m.message, fatal: true }); }
        else if (m.t === 'err') { if (!ready) reject({ code: m.code, message: m.message }); }
      };
      ws.onerror = () => { if (!ready) reject({ code: ERR.BROKER_UNREACHABLE, message: 'Cannot reach the party server' }); };
      ws.onclose = ev => {
        if (this.ws === ws) this.ws = null;
        if (ready && ev.code === 4001) { this.closed = true; this.cb.onError?.({ code: ERR.REPLACED, message: 'This party was taken over by another TV page', fatal: true }); return; } // newer host page attached with the same token: do not fight it
        if (!ready) return reject({ code: ERR.BROKER_UNREACHABLE, message: 'Cannot reach the party server' });
        if (this.closed) return;
        this.cb.onStatus?.('broker-lost');
        const again = () => { if (this.closed) return; this.#connect().then(() => this.cb.onStatus?.('broker-ok')).catch(() => setTimeout(again, this.reconnectDelay = Math.min((this.reconnectDelay || 500) * 1.5, 5000))); };
        setTimeout(again, 500);
      };
    });
  }
  send(connId, msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'tx', c: connId, m: msg })); }
  broadcast(msg) { this.send('*', msg); }
  close(connId) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'drop', c: connId })); }
  shutdown() { this.closed = true; try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'end' })); this.ws?.close(); } catch {} }
  /** Leave WITHOUT ending the room (same as the page being closed): the server keeps it for hostGraceMs so this host can re-attach. */
  detach() { this.closed = true; try { this.ws?.close(); } catch {} }
  channelsOf() { return { ctl: true, input: false }; }
}

// ============================ CONTROLLER ==============================================================
export class WsControllerTransport {
  constructor(opts = {}) { this.opts = opts; this.ws = null; this.cb = {}; this.closed = false; }
  connect(cb) {
    this.cb = cb || this.cb;
    const server = this.opts.server || globalThis.location?.origin;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrlOf(server)}/ws?role=controller&code=${encodeURIComponent(this.opts.code)}`);
      let opened = false;
      const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} reject({ code: ERR.TIMEOUT, message: 'Party server did not answer' }); } }, this.opts.connectTimeoutMs || 8000);
      ws.onopen = () => { opened = true; clearTimeout(timer); this.ws = ws; resolve(); };
      ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } this.cb.onMessage?.(m); };
      ws.onerror = () => {};
      ws.onclose = ev => {
        clearTimeout(timer);
        if (!opened) {
          const code = ev.reason && ERR[ev.reason] ? ev.reason : (ev.code === 4404 ? ERR.ROOM_NOT_FOUND : ERR.BROKER_UNREACHABLE);
          return reject({ code, message: ERR_TEXT[code] || 'Cannot reach the party server' });
        }
        if (this.ws === ws) { this.ws = null; this.cb.onClose?.(ev.reason || 'closed'); }
      };
    });
  }
  get hasUnreliable() { return false; }
  send(msg) { if (this.ws && this.ws.readyState === 1) { this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); return true; } return false; }
  closeConn() { const w = this.ws; this.ws = null; try { w?.close(); } catch {} }
  close() { this.closed = true; this.closeConn(); }
}
