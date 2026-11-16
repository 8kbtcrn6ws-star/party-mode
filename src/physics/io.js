// Tiny browser/Node byte reader so the same loaders work in the game (fetch) and in headless tests (fs).
export const isHttp = (u) => /^https?:/i.test(u) || (typeof location !== 'undefined' && !/^file:/i.test(u) && !u.startsWith('/') && !/^[A-Za-z]:\\/.test(u));
export async function readBytes(url) {
  const u = String(url);
  if (typeof process !== 'undefined' && process.versions?.node && !/^https?:/i.test(u)) {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return new Uint8Array(await fs.readFile(u.startsWith('file:') ? fileURLToPath(u) : u));
  }
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
export async function readText(url) { return new TextDecoder().decode(await readBytes(url)); }
export async function exists(url) { try { await readBytes(url); return true; } catch { return false; } }
