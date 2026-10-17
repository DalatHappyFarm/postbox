// Pure JPEG metadata stripper: walks the segments and drops APP1-APP15 (EXIF, XMP, ...) and COM.
// Keeps APP0 (JFIF) and every image segment; bytes after EOI are dropped too. Throws on a malformed file.
const bad = () => new Error("invalid jpeg");

export function stripJpeg(src: Uint8Array): Uint8Array {
  if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) throw bad();
  const parts: Uint8Array[] = [src.subarray(0, 2)];
  let i = 2;
  while (i < src.length) {
    if (src[i] !== 0xff) throw bad();
    while (src[i + 1] === 0xff) i++; // fill bytes
    const m = src[i + 1];
    if (m === undefined) throw bad();
    if (m === 0xd9) { // EOI: done, anything after it is dropped
      parts.push(src.subarray(i, i + 2));
      return concat(parts);
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { parts.push(src.subarray(i, i + 2)); i += 2; continue; } // no length
    if (i + 4 > src.length) throw bad();
    const len = (src[i + 2] << 8) | src[i + 3];
    if (len < 2 || i + 2 + len > src.length) throw bad();
    const end = i + 2 + len;
    const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
    if (!drop) parts.push(src.subarray(i, end));
    i = end;
    if (m === 0xda) { // SOS: entropy-coded data runs to the next real marker
      const from = i;
      while (i + 1 < src.length && !(src[i] === 0xff && src[i + 1] !== 0x00 && src[i + 1] !== 0xff && !(src[i + 1] >= 0xd0 && src[i + 1] <= 0xd7))) i++;
      if (i + 1 >= src.length) throw bad();
      parts.push(src.subarray(from, i));
    }
  }
  throw bad(); // no EOI
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
