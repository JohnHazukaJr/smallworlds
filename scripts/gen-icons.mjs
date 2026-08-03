// Generates public/icon-192.png and public/icon-512.png from simple geometry
// (no image dependencies needed — raw PNG encoding via zlib).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;

function pixel(x, y, size) {
  const c = size / 2;
  const dx = x - c, dy = y - c;
  const r = Math.hypot(dx, dy);
  const R = size * 0.3;       // planet radius
  const ringR = size * 0.345; // orbit ring
  const moonX = c + size * 0.242, moonY = c - size * 0.148, moonR = size * 0.027;

  // moon
  if (Math.hypot(x - moonX, y - moonY) < moonR) return [236, 226, 212, 255];
  // planet with a diagonal gradient
  if (r < R) {
    const t = (dx + dy + 2 * R) / (4 * R);
    return [Math.round(lerp(238, 196, t)), Math.round(lerp(188, 133, t)), Math.round(lerp(122, 74, t)), 255];
  }
  // dashed orbit ring
  if (Math.abs(r - ringR) < size * 0.004) {
    const angle = Math.atan2(dy, dx);
    if (Math.floor(angle * 8 / Math.PI + 16) % 2 === 0) return [140, 138, 134, 255];
  }
  return [8, 9, 12, 255];
}

writeFileSync('public/icon-192.png', png(192, pixel));
writeFileSync('public/icon-512.png', png(512, pixel));
console.log('icons written');
