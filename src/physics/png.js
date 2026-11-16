// Minimal PNG decoder (no dependencies) for terrain data: 8/16-bit greyscale, RGB, RGBA, non-interlaced.
// Uses DecompressionStream('deflate'), present in modern browsers and Node >= 18. 16-bit samples stay 16-bit (Uint16Array).
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export async function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a PNG');
  let o = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (o < bytes.length) {
    const len = be32(bytes, o), type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const d = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = be32(d, 0); height = be32(d, 4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`unsupported colour type ${ctype}`);
  const total = idat.reduce((a, c) => a + c.length, 0), cat = new Uint8Array(total);
  let p = 0; for (const c of idat) { cat.set(c, p); p += c.length; }
  const raw = await inflate(cat);
  const bpp = channels * depth / 8, stride = width * bpp, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  let data;
  if (depth === 8) data = out;
  else { data = new Uint16Array(width * height * channels); for (let i = 0; i < data.length; i++) data[i] = (out[2 * i] << 8) | out[2 * i + 1]; }
  return { width, height, channels, depth, data };
}
