// Small shared helpers for src/data. Pure, no DOM, no dependencies (browser + Node).

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;      // vehicle / paint / wheel / accessory / poi / profile ids
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);

/** Finite number from a number or numeric string, clamped; `def` if it isn't one. */
export function num(v, def, min = -Infinity, max = Infinity) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? clamp(n, min, max) : def;
}
export function int(v, def, min = -Infinity, max = Infinity) {
  const n = num(v, NaN, min, max);
  return Number.isFinite(n) ? Math.round(n) : def;
}
export const bool = (v, def) => (typeof v === 'boolean' ? v : def);
export const oneOf = (v, allowed, def) => (allowed.includes(v) ? v : def);

/** Player/profile name: trimmed, whitespace collapsed, control chars and angle brackets removed, max `max` chars. */
export function cleanName(v, def = 'Player', max = 16) {
  if (typeof v !== 'string') return def;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s ? Array.from(s).slice(0, max).join('') : def;
}

export const deepClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Recursively merge plain objects (arrays and primitives in `patch` replace). Returns a new object. Ignores __proto__/constructor keys. */
export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return isObj(patch) ? deepClone(patch) : deepClone(base);
  const out = deepClone(base);
  for (const k of Object.keys(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(patch[k]) && isObj(out[k]) ? deepMerge(out[k], patch[k]) : deepClone(patch[k]);
  }
  return out;
}

/** Tiny framework-free emitter (same shape as net/shared/emitter.js: on returns an unsubscribe fn). */
export function createEmitter() {
  const h = new Map();
  return {
    on(ev, fn) { (h.get(ev) || h.set(ev, new Set()).get(ev)).add(fn); return () => h.get(ev)?.delete(fn); },
    off(ev, fn) { h.get(ev)?.delete(fn); },
    emit(ev, ...args) {
      for (const fn of [...(h.get(ev) || [])]) {
        try { fn(...args); } catch (e) { queueMicrotask(() => { throw e; }); }
      }
    },
    clear() { h.clear(); },
  };
}
