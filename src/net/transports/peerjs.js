// WebRTC transport over the free public PeerJS broker (0.peerjs.com, no account) + Google public STUN. No TURN.
//  * control channel  = PeerJS DataConnection (reliable, ordered, JSON)      -> lobby / profile / feedback
//  * input channel    = extra RTCDataChannel 'pm-in' {ordered:false, maxRetransmits:0} on the SAME RTCPeerConnection
//                       -> inputs, pings, snapshots. Falls back to the control channel if it cannot open.
import { ERR, STUN_SERVERS, randomToken } from '../protocol.js';

export const PEERJS_CDN = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm';
const CTL_LABEL = 'pm-ctl';
const IN_LABEL = 'pm-in';

async function loadPeer(opts) {
  if (opts.Peer) return opts.Peer;
  if (globalThis.Peer) return globalThis.Peer;
  if (globalThis.peerjs?.Peer) return globalThis.peerjs.Peer;
  const mod = await import(/* @vite-ignore */ opts.peerModuleUrl || PEERJS_CDN);
  return mod.Peer || mod.default?.Peer || mod.default;
}

/** PeerJS options: public cloud broker, STUN only (set useBuiltinTurn:true to keep PeerJS' own free relay). */
export function peerOptions(opts = {}) {
  const iceServers = [...(opts.iceServers || STUN_SERVERS)];
  if (opts.useBuiltinTurn) iceServers.push({ urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' });
  const o = { debug: opts.debug ?? 0, config: { iceServers, sdpSemantics: 'unified-plan' } };
  if (opts.broker) Object.assign(o, opts.broker); // {host, port, path, secure, key} for a self-hosted PeerServer
  return o;
}

function brokerErr(e) {
  const type = e?.type;
  if (type === 'peer-unavailable') return { code: ERR.ROOM_NOT_FOUND, message: 'TV not found' };
  if (type === 'unavailable-id') return { code: 'ID_TAKEN', message: 'Peer id taken' };
  if (type === 'webrtc' || type === 'negotiation-failed') return { code: ERR.ICE_FAILED, message: String(e.message || e) };
  return { code: ERR.BROKER_UNREACHABLE, message: String(e?.message || e || 'broker error') }; // network, server-error, socket-error, socket-closed
}

// ============================ HOST ======================================================================
export class PeerJsHostTransport {
  constructor(opts = {}) { this.opts = opts; this.conns = new Map(); this.peer = null; this.cb = {}; this.closed = false; }
  /** callbacks: onConnection(connId), onMessage(connId,msg,channel), onClose(connId), onError({code,message}), onStatus(s) */
  /**
   * opts.peerId  = fixed id (restore). With opts.retryMs the id is re-registered with backoff while the broker still holds the old one
   * ('unavailable-id') or is briefly unreachable; cb.onRetry({attempt, code, elapsedMs, message}) is called before each wait.
   */
  async open(cb) {
    this.cb = cb;
    const Peer = await loadPeer(this.opts);
    if (this.opts.peerId) {
      const t0 = Date.now(), deadline = t0 + (this.opts.retryMs || 0); let attempt = 0, delay = 700;
      for (;;) {
        try { await this.#register(Peer, this.opts.peerId); return { peerId: this.peer.id, attempts: attempt + 1 }; }
        catch (e) {
          const retryable = e.code === 'ID_TAKEN' || e.code === ERR.BROKER_UNREACHABLE;
          if (!retryable || Date.now() + delay > deadline) throw { ...e, attempts: attempt + 1, elapsedMs: Date.now() - t0 };
          attempt++; this.cb.onRetry?.({ attempt, code: e.code, message: e.message, elapsedMs: Date.now() - t0 });
          await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 1.5, 4000);
        }
      }
    }
    const maxTries = 5;
    for (let i = 0; i < maxTries; i++) {
      const id = this.opts.idFromCode ? 'pm-' + this.opts.idFromCode() : 'pm-' + randomToken(16);
      try { await this.#register(Peer, id); break; }
      catch (e) { if (e.code === 'ID_TAKEN' && i < maxTries - 1) continue; throw e; }
    }
    return { peerId: this.peer.id, attempts: 1 };
  }

  #register(Peer, id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, peerOptions(this.opts));
      let opened = false;
      const timer = setTimeout(() => { if (!opened) { try { peer.destroy(); } catch {} reject({ code: ERR.BROKER_UNREACHABLE, message: 'Timed out reaching the PeerJS broker' }); } }, this.opts.brokerTimeoutMs || 10000);
      peer.on('open', () => { opened = true; clearTimeout(timer); this.peer = peer; this.#wire(peer); resolve(); });
      peer.on('error', e => { if (!opened) { clearTimeout(timer); try { peer.destroy(); } catch {} reject(brokerErr(e)); } else this.cb.onError?.(brokerErr(e)); });
    });
  }

  #wire(peer) {
    // Broker websocket can drop while established p2p connections stay up: re-register in the background.
    let backoff = 1000;
    peer.on('disconnected', () => {
      if (this.closed || peer.destroyed) return;
      this.cb.onStatus?.('broker-lost');
      const retry = () => { if (this.closed || peer.destroyed) return; if (!peer.disconnected) { this.cb.onStatus?.('broker-ok'); return; } try { peer.reconnect(); } catch {} setTimeout(retry, backoff = Math.min(backoff * 1.5, 8000)); };
      setTimeout(retry, backoff);
    });
    peer.on('open', () => { backoff = 1000; this.cb.onStatus?.('broker-ok'); });
    peer.on('connection', conn => {
      if (conn.label !== CTL_LABEL) { conn.close(); return; }
      const connId = conn.connectionId;
      const rec = { conn, inDc: null };
      this.conns.set(connId, rec);
      // Catch the phone's extra unreliable channel before PeerJS' own ondatachannel handler treats it as the main one.
      const pc = conn.peerConnection;
      if (pc) {
        const orig = pc.ondatachannel;
        pc.ondatachannel = evt => {
          if (evt.channel.label === IN_LABEL) {
            const dc = evt.channel; rec.inDc = dc;
            dc.onmessage = e => this.cb.onMessage?.(connId, e.data, 'in');
            dc.onclose = () => { if (rec.inDc === dc) rec.inDc = null; };
          } else if (orig) orig.call(pc, evt);
        };
      }
      conn.on('open', () => this.cb.onConnection?.(connId));
      conn.on('data', d => this.cb.onMessage?.(connId, d, 'ctl'));
      const gone = () => { if (this.conns.get(connId) === rec) { this.conns.delete(connId); this.cb.onClose?.(connId); } };
      conn.on('close', gone); conn.on('error', gone);
      // ICE failure shows up on the pc: PeerJS closes the conn, which lands in `gone`.
    });
  }

  send(connId, msg, { unreliable = false } = {}) {
    const rec = this.conns.get(connId); if (!rec) return;
    if (unreliable && rec.inDc && rec.inDc.readyState === 'open') { rec.inDc.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); return; }
    if (rec.conn.open) rec.conn.send(msg);
  }
  close(connId) { const rec = this.conns.get(connId); if (!rec) return; this.conns.delete(connId); try { rec.inDc?.close(); rec.conn.close(); } catch {} }
  shutdown() { this.closed = true; for (const id of [...this.conns.keys()]) this.close(id); try { this.peer?.destroy(); } catch {} }
  channelsOf(connId) { const r = this.conns.get(connId); return r ? { ctl: !!r.conn?.open, input: !!(r.inDc && r.inDc.readyState === 'open') } : null; }
}

// ============================ CONTROLLER ==============================================================
export class PeerJsControllerTransport {
  /** opts: {peerId (host), ...peerjs options}  callbacks: onMessage(msg), onClose(reason) */
  constructor(opts = {}) { this.opts = opts; this.peer = null; this.conn = null; this.inDc = null; this.cb = {}; this.closed = false; }

  async #ensurePeer() {
    if (this.peer && !this.peer.destroyed) { if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} } if (this.peer.open) return; }
    const Peer = await loadPeer(this.opts);
    await new Promise((resolve, reject) => {
      const peer = new Peer(undefined, peerOptions(this.opts));
      let ok = false;
      const timer = setTimeout(() => { if (!ok) { try { peer.destroy(); } catch {} reject({ code: ERR.BROKER_UNREACHABLE, message: 'Timed out reaching the PeerJS broker' }); } }, this.opts.brokerTimeoutMs || 10000);
      peer.on('open', () => { ok = true; clearTimeout(timer); this.peer = peer; resolve(); });
      peer.on('error', e => { if (!ok) { clearTimeout(timer); try { peer.destroy(); } catch {} reject(brokerErr(e)); } });
    });
  }

  /** Resolves when the control channel is open (the unreliable one opens shortly after; sends fall back until then). */
  async connect(cb, o = {}) {
    this.cb = cb || this.cb;
    await this.#ensurePeer();
    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(this.opts.peerId, { reliable: true, serialization: 'json', label: CTL_LABEL, metadata: { v: 1 } });
      this.conn = conn; this.inDc = null;
      let opened = false;
      const timer = setTimeout(() => { if (!opened) { try { conn.close(); } catch {} reject({ code: ERR.ICE_FAILED, message: 'No answer from the TV' }); } }, o.timeoutMs || this.opts.connectTimeoutMs || 12000);
      const onPeerErr = e => { if (!opened && this.conn === conn) { clearTimeout(timer); reject(brokerErr(e)); } };
      this.peer.once('error', onPeerErr);
      conn.on('iceStateChanged', st => { if (st === 'failed' && !opened) { clearTimeout(timer); reject({ code: ERR.ICE_FAILED, message: 'ICE failed' }); } });
      conn.on('open', () => {
        opened = true; clearTimeout(timer); this.peer.off('error', onPeerErr);
        try {
          const dc = conn.peerConnection.createDataChannel(IN_LABEL, { ordered: false, maxRetransmits: 0 });
          dc.onopen = () => { this.inDc = dc; this.cb.onChannel?.({ input: true }); };
          dc.onclose = () => { if (this.inDc === dc) this.inDc = null; };
          dc.onmessage = e => this.cb.onMessage?.(e.data);
        } catch { /* stay on ctl */ }
        resolve();
      });
      conn.on('data', d => this.cb.onMessage?.(d));
      const closed = () => { if (this.conn === conn) { this.conn = null; this.inDc = null; this.cb.onClose?.('closed'); } };
      conn.on('close', closed); conn.on('error', closed);
    });
  }
  get hasUnreliable() { return !!(this.inDc && this.inDc.readyState === 'open'); }
  send(msg, { unreliable = false } = {}) {
    if (unreliable && this.inDc && this.inDc.readyState === 'open') { this.inDc.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); return true; }
    if (this.conn && this.conn.open) { this.conn.send(msg); return true; }
    return false;
  }
  closeConn() { const c = this.conn; this.conn = null; this.inDc = null; try { c?.close(); } catch {} }
  close() { this.closed = true; this.closeConn(); try { this.peer?.destroy(); } catch {} }
}
