// Storage adapters: a tiny synchronous key/value interface { getItem, setItem, removeItem, keys? }.
// localStorage in the browser, in-memory in Node/tests or when localStorage is blocked (private mode, disabled).
// Everything stays on the device: no network, no accounts.
// (IndexedDB is deliberately not used: the whole save is a few KB to ~100 KB, and a synchronous interface
// keeps save-on-pagehide reliable. Any object with getItem/setItem/removeItem can be passed in later.)

export function createMemoryStorage(initial = {}, { quotaChars = Infinity } = {}) {
  const m = new Map(Object.entries(initial));
  const used = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
  return {
    persistent: false,
    kind: 'memory',
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      v = String(v);
      const prev = m.get(k);
      m.set(k, v);
      if (used() > quotaChars) {                 // mimic QuotaExceededError and leave the old value intact
        if (prev === undefined) m.delete(k); else m.set(k, prev);
        const e = new Error('Storage quota exceeded'); e.name = 'QuotaExceededError'; throw e;
      }
    },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

/** Wrap window.localStorage. Returns null when unavailable or throwing (Safari private mode, blocked cookies). */
export function createLocalStorageAdapter(scope = globalThis) {
  let ls;
  try {
    ls = scope.localStorage;
    if (!ls) return null;
    const probe = '__pm_probe__';
    ls.setItem(probe, '1'); ls.removeItem(probe);
  } catch { return null; }
  return {
    persistent: true,
    kind: 'localStorage',
    getItem: (k) => ls.getItem(k),
    setItem: (k, v) => ls.setItem(k, v),
    removeItem: (k) => ls.removeItem(k),
    keys() { const out = []; for (let i = 0; i < ls.length; i++) out.push(ls.key(i)); return out; },
  };
}

/** localStorage if it works, otherwise an in-memory store (progress then lasts only for this page visit). */
export function autoStorage(scope = globalThis) {
  return createLocalStorageAdapter(scope) || createMemoryStorage();
}
