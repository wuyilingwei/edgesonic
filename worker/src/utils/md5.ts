export function md5(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const words: number[] = [];
  for (let i = 0; i < (bytes.length + 8) >> 6; i++) {
    const block: number[] = [];
    for (let j = 0; j < 64; j += 4) {
      block.push(
        (bytes[i * 64 + j] || 0) |
        ((bytes[i * 64 + j + 1] || 0) << 8) |
        ((bytes[i * 64 + j + 2] || 0) << 16) |
        ((bytes[i * 64 + j + 3] || 0) << 24)
      );
    }
    if (i === ((bytes.length + 8) >> 6) - 1) {
      const bitLen = bytes.length * 8;
      const idx = (bitLen >> 5) % 16;
      block[idx] |= 0x80 << (bitLen % 32);
      block[14] = bitLen;
    }
    words.push(...block);
  }

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
  }

  for (let i = 0; i < words.length; i += 16) {
    let aa = a, bb = b, cc = c, dd = d;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const temp = d;
      d = c;
      c = b;
      b = b + rotl(a + f + K[j] + words[i + g], S[(j >> 4) * 4 + j % 4]);
      a = temp;
    }
    a += aa; b += bb; c += cc; d += dd;
  }

  return [a, b, c, d].map((x) => {
    const hex = ((x >>> 0) & 0xff).toString(16).padStart(2, "0") +
                ((x >>> 8) & 0xff).toString(16).padStart(2, "0") +
                ((x >>> 16) & 0xff).toString(16).padStart(2, "0") +
                ((x >>> 24) & 0xff).toString(16).padStart(2, "0");
    return hex;
  }).join("");
}

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}
