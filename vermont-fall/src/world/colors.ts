import { Color } from 'three'
import { Simplex2, hash2, smoothstep } from '../core/noise'

/**
 * Peak-foliage art direction. Colours are clustered into stands so a hillside
 * leans golden or crimson as a whole, with evergreen pockets breaking it up.
 *
 * Target mix across the forest:
 *   30% burnt orange / copper, 20% golden amber, 15% burgundy / crimson,
 *   25% evergreen, 10% transitional yellow-green
 */

export type Hue = 'orange' | 'gold' | 'red' | 'evergreen' | 'yellowgreen'

const hex = (h: string) => new Color(h) // converted to linear by ColorManagement

export const PALETTE: Record<Hue, Color[]> = {
  // burnt orange / copper
  orange: ['#cc5d1c', '#bb4f1c', '#d8712a', '#b2552a', '#c96a2e', '#a84a1e', '#dc7c30', '#b8622e'].map(hex),
  // golden amber
  gold: ['#dc9a22', '#e6ad30', '#cf8a1a', '#e4b442', '#d39f34', '#e8a62c'].map(hex),
  // burgundy / deep crimson, with a few brighter scarlet maples
  red: ['#a02024', '#8e1c26', '#7a1824', '#b32e24', '#9a2a22', '#6e1a22', '#bd3a26'].map(hex),
  evergreen: ['#2c4630', '#36523a', '#28402e', '#3f5b3c', '#2d4a3a', '#33503f'].map(hex),
  // transitional yellow-green
  yellowgreen: ['#a3a23a', '#8e9c3e', '#b3a944', '#7d9539', '#b8a43e'].map(hex),
}

const nStand = new Simplex2(101)
const nWarp = new Simplex2(202)
const nEver = new Simplex2(303)

/** Low-frequency stand character in [0,1]: 0 golden, ~0.5 orange maple, 1 crimson-rich. */
export function standLean(x: number, z: number): number {
  const wx = x + 140 * nWarp.noise(x / 520, z / 520)
  const wz = z + 140 * nWarp.noise(x / 520 + 9.3, z / 520 - 4.1)
  const v = nStand.fbm(wx / 360, wz / 360, 3)
  return smoothstep(-0.42, 0.42, v)
}

/** Evergreen likelihood: coherent pockets, wetter hollows and the higher ground. */
export function evergreenChance(x: number, z: number, height: number, wet: number): number {
  const pocket = nEver.fbm(x / 240, z / 240, 3) // [-1,1]
  let p = 0.07 + 0.78 * smoothstep(0.12, 0.42, pocket)
  p += 0.25 * wet
  p += 0.2 * smoothstep(60, 200, height)
  return Math.min(0.95, Math.max(0.04, p))
}

/** Pick a hue for a hardwood: stands lean golden, maple-orange or crimson. */
export function hardwoodHue(lean: number, r: number): Hue {
  // weights at the three stand archetypes, blended by lean
  const g = [0.66, 0.16, 0.05, 0.13] // gold, orange, red, yg  (golden stand)
  const o = [0.12, 0.72, 0.09, 0.07] // orange stand
  const c = [0.05, 0.3, 0.58, 0.07] // crimson stand
  const t = lean * 2
  const w = t < 1 ? g.map((v, i) => v + (o[i] - v) * t) : o.map((v, i) => v + (c[i] - v) * (t - 1))
  let acc = r * (w[0] + w[1] + w[2] + w[3])
  if ((acc -= w[1]) < 0) return 'orange'
  if ((acc -= w[0]) < 0) return 'gold'
  if ((acc -= w[2]) < 0) return 'red'
  return 'yellowgreen'
}

const tmp = new Color()

/** Final per-tree colour (linear), with gentle jitter so no two crowns match. */
export function treeColor(hue: Hue, x: number, z: number, seed: number, out: Color): Color {
  const pal = PALETTE[hue]
  const r1 = hash2(Math.floor(x * 3.1), Math.floor(z * 3.7), seed)
  const r2 = hash2(Math.floor(x * 1.9), Math.floor(z * 2.3), seed + 7)
  const a = pal[Math.floor(r1 * pal.length) % pal.length]
  const b = pal[Math.floor(r2 * pal.length) % pal.length]
  out.copy(a).lerp(b, 0.35)
  // brightness / saturation jitter
  const k = 0.88 + 0.24 * hash2(Math.floor(x * 5.3), Math.floor(z * 4.9), seed + 13)
  out.multiplyScalar(k)
  if (hue !== 'evergreen') {
    // neighbouring crowns drift a little towards the stand's character
    const lean = standLean(x, z)
    tmp.copy(lean > 0.6 ? PALETTE.red[1] : lean < 0.35 ? PALETTE.gold[0] : PALETTE.orange[0])
    out.lerp(tmp, 0.08)
  }
  return out
}
