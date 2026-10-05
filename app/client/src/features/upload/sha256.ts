/**
 * Incremental SHA-256, for files too big to hand to crypto.subtle in one piece.
 *
 * Web Crypto only digests a whole buffer, so anything over a few hundred MB has
 * to be hashed here, a slice at a time. It runs inside hash.worker.ts and never
 * on the page itself: hashing a 15 GB file is minutes of solid CPU, and on the
 * page that froze every click, scroll and repaint until it finished.
 */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private state = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Int32Array(64);
  /** A partial block carried between update() calls. */
  private pending = new Uint8Array(64);
  private pendingLength = 0;
  private total = 0;

  update(data: Uint8Array): this {
    let pos = 0;
    let left = data.length;
    this.total += left;
    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, left);
      this.pending.set(data.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      pos += take;
      left -= take;
      if (this.pendingLength < 64) return this;
      this.blocks(this.pending, 0, 64);
      this.pendingLength = 0;
    }
    const whole = left - (left % 64);
    if (whole > 0) {
      this.blocks(data, pos, whole);
      pos += whole;
      left -= whole;
    }
    if (left > 0) {
      this.pending.set(data.subarray(pos), 0);
      this.pendingLength = left;
    }
    return this;
  }

  hex(): string {
    const tail = this.pendingLength;
    const padded = new Uint8Array(tail < 56 ? 64 : 128);
    padded.set(this.pending.subarray(0, tail));
    padded[tail] = 0x80;
    const bits = this.total * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded.length - 4, bits >>> 0);
    this.blocks(padded, 0, padded.length);
    let out = '';
    for (let i = 0; i < 8; i += 1) out += (this.state[i] >>> 0).toString(16).padStart(8, '0');
    return out;
  }

  /** Every 64-byte block in p[pos, pos + length). Locals only, so V8 keeps it all in registers. */
  private blocks(p: Uint8Array, pos: number, length: number) {
    const w = this.w;
    const s = this.state;
    let h0 = s[0]; let h1 = s[1]; let h2 = s[2]; let h3 = s[3];
    let h4 = s[4]; let h5 = s[5]; let h6 = s[6]; let h7 = s[7];
    while (length >= 64) {
      for (let i = 0; i < 16; i += 1) {
        const j = pos + i * 4;
        w[i] = (p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3];
      }
      for (let i = 16; i < 64; i += 1) {
        let u = w[i - 2];
        const t1 = ((u >>> 17) | (u << 15)) ^ ((u >>> 19) | (u << 13)) ^ (u >>> 10);
        u = w[i - 15];
        const t2 = ((u >>> 7) | (u << 25)) ^ ((u >>> 18) | (u << 14)) ^ (u >>> 3);
        w[i] = (((t1 + w[i - 7]) | 0) + ((t2 + w[i - 16]) | 0)) | 0;
      }
      let a = h0; let b = h1; let c = h2; let d = h3;
      let e = h4; let f = h5; let g = h6; let h = h7;
      for (let i = 0; i < 64; i += 1) {
        const t1 = ((((((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)))
          + ((e & f) ^ (~e & g))) | 0) + ((h + ((K[i] + w[i]) | 0)) | 0)) | 0;
        const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)))
          + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
      pos += 64;
      length -= 64;
    }
    s[0] = h0; s[1] = h1; s[2] = h2; s[3] = h3;
    s[4] = h4; s[5] = h5; s[6] = h6; s[7] = h7;
  }
}
