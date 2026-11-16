// Tiny framework-free event emitter (browser + Node).
export class Emitter {
  #h = new Map();
  on(ev, fn) { (this.#h.get(ev) || this.#h.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  once(ev, fn) { const off = this.on(ev, (...a) => { off(); fn(...a); }); return off; }
  off(ev, fn) { this.#h.get(ev)?.delete(fn); }
  emit(ev, ...args) {
    for (const fn of [...(this.#h.get(ev) || [])]) {
      try { fn(...args); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
  }
  removeAllListeners() { this.#h.clear(); }
}
