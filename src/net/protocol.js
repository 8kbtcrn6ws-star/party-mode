// Party Mode protocol constants + pure helpers. Isomorphic ESM: runs in the browser (TV/phone) and in Node.
// Message shapes are documented in ../PROTOCOL.md. Names align with /workspace/party-mode/architecture.md
// ('in' = controller input, 'fb' = feedback to phone).

export const PROTOCOL_VERSION = 1;

// Same values as Parrot's spike (spike/shared.js) so the whole project agrees.
export const MAX_PLAYERS = 4;           // THE single player-limit setting (architecture.md v2). Override per party via options.maxPlayers; load-tested with 8.
export const INPUT_HZ = 30;            // what controllers aim for
export const INPUT_TIMEOUT_MS = 500;   // host starts easing throttle to 0 after this much silence
export const INPUT_EASE_MS = 900;      // ...and reaches 0 this much later (~1.4 s after the last packet, as in the spike)
export const REJOIN_MS = 30000;        // minimum guaranteed rejoin window after a phone drop (kept for compatibility)
export const SEAT_GRACE_MS = 90000;    // a dropped / orphaned seat is held this long (phones keep retrying for the same time; >= 60 s so a TV reload fits)
export const SESSION_TTL_MS = 600000;  // saved TV session expires 10 min after the host was last alive
export const RESTORE_RETRY_MS = 60000; // restored host keeps trying to re-register its peer id / room this long
export const JOIN_TIMEOUT_MS = 10000;
export const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O (display code; spike uses the same)
export const SERVER_ROOM_ALPHABET = ROOM_LETTERS + '23456789'; // ws mode (server-made codes): letters without I/O, digits without 0/1
export const MAX_INPUT_HZ = 60;        // per-player ceiling enforced by host + relay
export const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

export const PLAYER_COLORS = [0xff4d4d, 0xffb020, 0x3dde7f, 0x3da9ff, 0xc56cff, 0xff6b9d, 0x2ee6d6, 0xf2f2f2]
  .map(n => '#' + n.toString(16).padStart(6, '0'));

// ---- Error codes (see PROTOCOL.md) -------------------------------------------------------------
export const ERR = Object.freeze({
  BAD_MESSAGE: 'BAD_MESSAGE',          // unparsable / unknown / too big
  BAD_VERSION: 'BAD_VERSION',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',    // ws: unknown code. webrtc: peer id not registered
  ROOM_FULL: 'ROOM_FULL',              // = FULL_ERR text in the UI
  ROOM_LOCKED: 'ROOM_LOCKED',          // host locked joining (race running)
  ROOM_CLOSED: 'ROOM_CLOSED',          // host ended the session / room expired
  NO_HOST: 'NO_HOST',                  // ws: host socket absent
  KICKED: 'KICKED',
  BAD_TOKEN: 'BAD_TOKEN',              // reconnect token unknown/expired
  BAD_VEHICLE: 'BAD_VEHICLE',
  BAD_NAME: 'BAD_NAME',
  COLOUR_TAKEN: 'COLOUR_TAKEN',
  RESUME_FAILED: 'RESUME_FAILED',      // host: explicit resume of a saved session was impossible (detail in .cause)
  HOST_IN_USE: 'HOST_IN_USE',          // host: another tab of this browser already runs the saved session
  REPLACED: 'REPLACED',                // same token connected from another page/tab
  RATE_LIMITED: 'RATE_LIMITED',        // informational, sent at most once per second
  NOT_HOST: 'NOT_HOST',
  NOT_JOINED: 'NOT_JOINED',
  BROKER_UNREACHABLE: 'BROKER_UNREACHABLE', // client-side only
  ICE_FAILED: 'ICE_FAILED',                  // client-side only
  TIMEOUT: 'TIMEOUT',                        // client-side only
});

export const ERR_TEXT = Object.freeze({
  ROOM_FULL: 'Session is full.',
  BROKER_UNREACHABLE: 'Connection service unreachable, try again',
  ICE_FAILED: "Can't reach the TV. Make sure your phone and the TV are on the same Wi-Fi, not a guest network (guest networks block devices talking to each other).",
  ROOM_NOT_FOUND: 'No party with that code. Check the code or scan the QR again.',
  ROOM_LOCKED: 'The race has started. Joining is locked right now.',
  KICKED: 'The host removed you from the party.',
  ROOM_CLOSED: 'The party has ended.',
  BAD_TOKEN: 'Could not rejoin your seat (too long ago). Join again.',
  NO_HOST: 'The TV is not connected to this party yet.',
});

// ---- ids / codes --------------------------------------------------------------------------------
function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export function randomToken(bytes = 16) { return [...randomBytes(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
export function randomCode(len = 4, alphabet = ROOM_LETTERS) {
  // rejection sampling: no modulo bias
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < len) for (const b of randomBytes(len * 2)) { if (b < limit && out.length < len) out += alphabet[b % alphabet.length]; }
  return out;
}
export function normalizeCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// ---- validation ---------------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Normalise an `in` message into a safe object (or null). Compact keys are not used: JSON is ~100 bytes. */
export const GLANCES = ['back', 'left', 'right'];
export function sanitizeInput(m) {
  if (!m || typeof m !== 'object' || m.t !== 'in') return null;
  if (typeof m.seq !== 'number' || !Number.isInteger(m.seq) || m.seq < 0 || m.seq > 0xffffffff) return null;
  const out = {
    t: 'in', seq: m.seq,
    ts: num(m.ts, 0),                              // client timestamp (ms). Host echoes the latest one back in `fb.echo` so the phone can measure RTT
    steer: clamp(num(m.steer), -1, 1),
    throttle: clamp(num(m.throttle), 0, 1),
    brake: clamp(num(m.brake), 0, 1),
    hand: m.hand ? 1 : 0,
    rev: m.rev ? 1 : 0,                            // reverse gear engaged (throttle then drives backwards)
    cam: (m.cam === 'next' || m.cam === 'view') ? m.cam : null,        // camera cycle request (chase/close chase/first-person/free-look). Phone holds 'next' ~200 ms per tap; host reacts to the rising edge
    horn: m.horn ? 1 : 0,
    reset: m.reset ? 1 : 0,
    mode: m.mode === 'touch' ? 'touch' : 'wheel',
    look: null,                                    // free-look pad {x,y} -1..1 or null
    zoom: clamp(num(m.zoom), -1, 1),               // optional: camera zoom -1 (in/close) .. 1 (out/far), default 0
    glance: GLANCES.includes(m.glance) ? m.glance : null, // optional: hold-to-glance 'back'|'left'|'right' (level while held), anything else -> null
  };
  if (m.look && typeof m.look === 'object') out.look = { x: clamp(num(m.look.x), -1, 1), y: clamp(num(m.look.y), -1, 1) };
  return out;
}

export function sanitizeName(s) {
  if (typeof s !== 'string') return null;
  // strip control chars, collapse whitespace, 1..16 chars
  const n = s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n.length ? n : null;
}
export const VEHICLE_RE = /^[a-z0-9_-]{1,32}$/i;
export const COLOUR_RE = /^#[0-9a-f]{6}$/i;

export function parseMessage(raw, maxBytes = 2048) {
  if (raw && typeof raw === 'object' && !(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) return raw;
  if (typeof raw !== 'string' || raw.length > maxBytes) return null;
  try { const m = JSON.parse(raw); return m && typeof m === 'object' && typeof m.t === 'string' ? m : null; } catch { return null; }
}

// ---- seq ordering: uint32 wrap-safe -------------------------------------------------------------
/** true if a is newer than b (serial number arithmetic, RFC 1982) */
export function seqNewer(a, b) { return a !== b && ((a - b) >>> 0) < 0x80000000; }

/**
 * Per-player gate: drops stale / duplicate / out-of-order inputs, enforces a token-bucket rate limit.
 * Time is injectable for tests.
 */
export class InputGate {
  constructor({ maxHz = MAX_INPUT_HZ, burst = 12, now = () => Date.now() } = {}) {
    this.maxHz = maxHz; this.burst = burst; this.now = now;
    this.tokens = burst; this.last = now();
    this.lastSeq = -1; this.accepted = 0; this.stale = 0; this.limited = 0; this.firstSeq = -1;
  }
  /** returns 'ok' | 'stale' | 'limited' */
  check(seq) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.maxHz / 1000);
    this.last = t;
    if (this.lastSeq >= 0 && !seqNewer(seq, this.lastSeq)) { this.stale++; return 'stale'; }
    if (this.tokens < 1) { this.limited++; return 'limited'; } // do NOT advance lastSeq: next newer one can pass
    this.tokens -= 1;
    if (this.firstSeq < 0) this.firstSeq = seq;
    this.lastSeq = seq; this.accepted++;
    return 'ok';
  }
  reset() { this.lastSeq = -1; }
  stats() { return { accepted: this.accepted, stale: this.stale, limited: this.limited, lastSeq: this.lastSeq }; }
}

// ---- stats ---------------------------------------------------------------------------------------
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Exponential moving average RTT with jitter, fed by ping/pong. */
export class RttTracker {
  constructor() { this.last = null; this.avg = null; this.min = null; this.max = null; this.samples = 0; this.recent = []; }
  add(ms) {
    this.last = ms; this.samples++;
    this.avg = this.avg == null ? ms : this.avg * 0.8 + ms * 0.2;
    this.min = this.min == null ? ms : Math.min(this.min, ms); this.max = this.max == null ? ms : Math.max(this.max, ms);
    this.recent.push(ms); if (this.recent.length > 100) this.recent.shift();
  }
  summary() {
    return { last: this.last, avg: this.avg == null ? null : +this.avg.toFixed(1), min: this.min, max: this.max,
      p50: percentile(this.recent, 50), p95: percentile(this.recent, 95), samples: this.samples };
  }
}
