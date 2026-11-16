// Tiny event bus (Parrot, src/core). on() returns an unsubscribe function.
export function createEvents() {
  const map = new Map();
  const api = {
    on(name, fn) { let s = map.get(name); if (!s) map.set(name, s = new Set()); s.add(fn); return () => api.off(name, fn); },
    once(name, fn) { const off = api.on(name, (...a) => { off(); fn(...a); }); return off; },
    off(name, fn) { map.get(name)?.delete(fn); },
    emit(name, ...args) { for (const fn of [...(map.get(name) || [])]) { try { fn(...args); } catch (e) { console.error(`event "${name}" handler failed:`, e); } } },
    clear() { map.clear(); },
  };
  return api;
}
export const events = createEvents(); // shared bus
