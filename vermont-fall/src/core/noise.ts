// Deterministic noise + random helpers. Everything in the world is seeded so the
// composition is art-directed and identical on every load.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer hash -> [0,1). Stable for a given (x, y, seed). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6

export class Simplex2 {
  private perm = new Uint8Array(512)
  private gx = new Float32Array(512)
  private gy = new Float32Array(512)

  constructor(seed: number) {
    const rnd = mulberry32(seed)
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255]
      const a = (this.perm[i] / 256) * Math.PI * 2
      this.gx[i] = Math.cos(a)
      this.gy[i] = Math.sin(a)
    }
  }

  /** Simplex noise in roughly [-1, 1]. */
  noise(xin: number, yin: number): number {
    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)
    const i1 = x0 > y0 ? 1 : 0
    const j1 = x0 > y0 ? 0 : 1
    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2
    const ii = i & 255
    const jj = j & 255
    const perm = this.perm
    let n = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 > 0) {
      const g = perm[ii + perm[jj]]
      t0 *= t0
      n += t0 * t0 * (this.gx[g] * x0 + this.gy[g] * y0)
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]]
      t1 *= t1
      n += t1 * t1 * (this.gx[g] * x1 + this.gy[g] * y1)
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]]
      t2 *= t2
      n += t2 * t2 * (this.gx[g] * x2 + this.gy[g] * y2)
    }
    return 99 * n
  }

  fbm(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq + o * 17.3, y * freq - o * 9.1)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  /** Soft ridged fbm: rounded old-mountain ridges (Green Mountains, not the Alps). */
  ridged(x: number, y: number, octaves: number): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    let prev = 1
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x * freq + o * 31.7, y * freq + o * 11.3))
      n = n * n
      sum += n * amp * prev
      norm += amp
      prev = Math.min(1, n * 1.6)
      amp *= 0.5
      freq *= 2.03
    }
    return sum / norm
  }
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
export function smootherstep(x: number): number {
  const t = clamp(x, 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
