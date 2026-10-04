import { Simplex2, clamp, lerp, smoothstep } from '../core/noise'
import { Path2 } from '../core/path'
import {
  BRIDGE,
  CLEARINGS,
  ROAD_POINTS,
  STREAM_POINTS,
  type Clearing,
  type V2,
} from './layout'

export const NEAR = 1400 // half-extent of the detailed heightfield
export const NEAR_STEP = 5
export const FAR = 11000

const ROAD_FLAT = 6.6 // half-width of the graded road bed
const STREAM_BED = 3.2 // half-width of the brook bed

const gauss = (dx: number, dz: number, rx: number, rz: number) =>
  Math.exp(-((dx * dx) / (rx * rx) + (dz * dz) / (rz * rz)))

interface NearestHit {
  d: number
  s: number
  lat: number
}

/** Polygon signed distance (negative inside). */
function polySdf(poly: V2[], x: number, z: number): number {
  let d = Infinity
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]
    const [bx, bz] = poly[i]
    const ex = bx - ax, ez = bz - az
    const wx = x - ax, wz = z - az
    const t = clamp((wx * ex + wz * ez) / (ex * ex + ez * ez), 0, 1)
    const px = wx - ex * t, pz = wz - ez * t
    d = Math.min(d, px * px + pz * pz)
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside
  }
  return inside ? -Math.sqrt(d) : Math.sqrt(d)
}

export class Terrain {
  readonly nA = new Simplex2(11)
  readonly nB = new Simplex2(23)
  readonly nC = new Simplex2(37)
  readonly nD = new Simplex2(51)

  readonly road: Path2
  readonly stream: Path2
  /** road surface elevation per road sample */
  roadY!: Float32Array
  /** brook bed elevation per stream sample */
  streamY!: Float32Array

  bridge = {
    s: 0,
    s0: 0,
    s1: 0,
    x: 0,
    z: 0,
    dirX: 0,
    dirZ: 1,
    deckY: 0,
  }

  /** detailed heightfield over [-NEAR, NEAR]^2 */
  readonly gridN = Math.round((2 * NEAR) / NEAR_STEP) + 1
  heights!: Float32Array

  private clearingBounds: { c: Clearing; minX: number; maxX: number; minZ: number; maxZ: number }[]
  private streamCoarse: Float32Array // distance + arc-length field (coarse)
  private readonly sdStep = 25
  private readonly sdHalf = 3200
  private readonly sdN: number

  private tmpHit: NearestHit = { d: 0, s: 0, lat: 0 }
  private tmpHit2: NearestHit = { d: 0, s: 0, lat: 0 }

  constructor() {
    this.road = new Path2(ROAD_POINTS, true, 1.5)
    this.stream = new Path2(STREAM_POINTS, false, 2.0)
    this.clearingBounds = CLEARINGS.map((c) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const [x, z] of c.poly) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
      }
      const m = c.feather + 8
      return { c, minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m }
    })
    this.sdN = Math.round((2 * this.sdHalf) / this.sdStep) + 1
    this.streamCoarse = this.buildStreamDistance()
    this.buildStreamProfile()
    this.locateBridge()
    this.buildRoadProfile()
    this.buildHeightfield()
  }

  // ---------------------------------------------------------------- natural

  /** The land before people graded a road through it. Valley floor ~ 0 m. */
  natural(x: number, z: number): number {
    const nA = this.nA
    let h = 0
    // rolling New England hills
    h += 24 * nA.fbm(x / 600, z / 600, 4)
    h += 5 * this.nB.fbm(x / 170, z / 170, 3)
    // the forested knoll the road loops around
    h += 100 * gauss(x + 30, z + 150, 230, 205)
    h += 30 * gauss(x + 250, z + 60, 150, 180)
    // hills rising east beyond the farm and west of the loop
    h += 165 * smoothstep(640, 1350, x) * (0.75 + 0.4 * this.nC.fbm(x / 400, z / 400, 3))
    h += 185 * smoothstep(-560, -1300, x) * (0.75 + 0.4 * this.nC.fbm(x / 420 + 7, z / 420, 3))
    // the overlook ridge — gentle from the south, falling away to the north
    const crestZ = -650 + 40 * Math.sin(x / 260) + 25 * nA.noise(x / 300, 4.2)
    const dz = z - crestZ
    const ridgeW = dz > 0 ? 440 : 190
    const ridgeTaper = 1 - smoothstep(650, 1400, Math.abs(x - 40))
    h += 66 * Math.exp(-(dz * dz) / (ridgeW * ridgeW)) * (0.5 + 0.5 * ridgeTaper)
    // the northern valley floor sits a little below ours
    h -= 22 * smoothstep(-760, -1100, z) * (1 - smoothstep(-1700, -2200, z))
    // foreground hills towards the camera
    h += 55 * smoothstep(460, 1150, z) * (0.6 + 0.6 * this.nC.fbm(x / 360, z / 360, 3))
    // then layered ranges into the haze
    h += this.ranges(x, z)
    return h
  }

  /**
   * Layered, rounded ranges (old Green Mountains, not alpine peaks). Each range
   * is a little taller than the one in front so they stack into the haze.
   */
  private ranges(x: number, z: number): number {
    if (z > -900) return 0
    const nD = this.nD
    let h = 0
    const band = (crest: number, width: number, height: number, sx: number, seed: number) => {
      const d = (z - crest) / width
      if (Math.abs(d) > 3) return 0
      // crest height wanders: summits and saddles along the ridge line
      const along = 0.62 + 0.38 * nD.fbm(x / sx + seed, seed * 1.7, 3) + 0.18 * nD.noise(x / (sx * 0.35) - seed, seed)
      return height * Math.exp(-d * d) * Math.max(0.15, along)
    }
    h += band(-2050 + 220 * nD.noise(x / 1300, 1.3), 430, 115, 900, 1)
    h += band(-3200 + 320 * nD.noise(x / 1800, 7.7), 640, 300, 1300, 2)
    h += band(-4800 + 420 * nD.noise(x / 2400, 3.1), 900, 520, 1900, 3)
    h += band(-7300 + 600 * nD.noise(x / 3200, 5.5), 1300, 960, 2600, 4)
    h += band(-10200 + 700 * nD.noise(x / 4200, 2.2), 1600, 1350, 3400, 5)
    return h * smoothstep(-900, -1400, z)
  }

  // ---------------------------------------------------------------- stream

  private buildStreamDistance(): Float32Array {
    // channel 0: distance, channel 1: arc length of the nearest point
    const N = this.sdN
    const out = new Float32Array(N * N * 2)
    const pts: number[] = []
    const st = this.stream
    for (let i = 0; i < st.n; i += 4) pts.push(st.xs[i], st.zs[i], i * st.step)
    for (let j = 0; j < N; j++) {
      const z = -this.sdHalf + j * this.sdStep
      for (let i = 0; i < N; i++) {
        const x = -this.sdHalf + i * this.sdStep
        let best = Infinity
        let bs = 0
        for (let k = 0; k < pts.length; k += 3) {
          const dx = x - pts[k], dz = z - pts[k + 1]
          const d2 = dx * dx + dz * dz
          if (d2 < best) {
            best = d2
            bs = pts[k + 2]
          }
        }
        out[(j * N + i) * 2] = Math.sqrt(best)
        out[(j * N + i) * 2 + 1] = bs
      }
    }
    return out
  }

  private streamCoarseAt(x: number, z: number, out: { d: number; s: number }) {
    const N = this.sdN
    const fx = (x + this.sdHalf) / this.sdStep
    const fz = (z + this.sdHalf) / this.sdStep
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) {
      out.d = 1e4
      out.s = 0
      return out
    }
    const i = Math.floor(fx), j = Math.floor(fz)
    const tx = fx - i, tz = fz - j
    const g = this.streamCoarse
    const o00 = (j * N + i) * 2, o10 = o00 + 2, o01 = o00 + N * 2, o11 = o01 + 2
    out.d = lerp(lerp(g[o00], g[o10], tx), lerp(g[o01], g[o11], tx), tz)
    out.s = lerp(lerp(g[o00 + 1], g[o10 + 1], tx), lerp(g[o01 + 1], g[o11 + 1], tx), tz)
    return out
  }

  /** Designed brook valley floor: descends steadily from the spring. */
  private valleyFloor(s: number): number {
    const L = this.stream.length
    const t = s / L
    return 16 - 30 * Math.pow(t, 0.8) - 6 * smoothstep(0, 0.25, t)
  }

  private tmpCoarse = { d: 0, s: 0 }

  /** natural land with the brook's valley pressed into it */
  private valleyed(x: number, z: number): number {
    const h = this.natural(x, z)
    const c = this.streamCoarseAt(x, z, this.tmpCoarse)
    if (c.d > 900) return h
    // gentle U-shaped valley whose floor always runs downhill
    const floor = this.valleyFloor(c.s)
    const side = floor + 0.0009 * c.d * c.d + 0.06 * c.d
    return smin(h, side, 22)
  }

  private buildStreamProfile() {
    const st = this.stream
    const y = new Float32Array(st.n)
    for (let i = 0; i < st.n; i++) y[i] = Math.min(this.valleyed(st.xs[i], st.zs[i]), this.valleyFloor(i * st.step)) - 1.6
    smooth1D(y, 18, false) // ~36 m
    // water only runs downhill
    for (let i = 1; i < st.n; i++) y[i] = Math.min(y[i], y[i - 1] - 0.01)
    this.streamY = y
  }

  streamBedAt(s: number): number {
    const f = clamp(s / this.stream.step, 0, this.stream.n - 1)
    const i = Math.floor(f)
    const j = Math.min(i + 1, this.stream.n - 1)
    return lerp(this.streamY[i], this.streamY[j], f - i)
  }

  // ---------------------------------------------------------------- road

  private locateBridge() {
    const hit = this.tmpHit
    const [bx, bz] = BRIDGE.center
    this.road.nearest(bx, bz, 60, hit)
    const s = hit.s
    const p = { x: 0, z: 0, tx: 0, tz: 0 }
    this.road.sample(s, p)
    const sh = this.tmpHit2
    this.stream.nearest(p.x, p.z, 80, sh)
    const b = this.bridge
    b.s = s
    b.s0 = s - BRIDGE.length / 2
    b.s1 = s + BRIDGE.length / 2
    b.x = p.x
    b.z = p.z
    b.dirX = p.tx
    b.dirZ = p.tz
    b.deckY = this.streamBedAt(sh.s) + 6.2
  }

  private buildRoadProfile() {
    const r = this.road
    const y = new Float32Array(r.n)
    for (let i = 0; i < r.n; i++) y[i] = this.valleyed(r.xs[i], r.zs[i])
    smooth1D(y, 27, true) // ~40 m
    smooth1D(y, 14, true)
    // pin the bridge deck and blend the approaches
    const b = this.bridge
    for (let i = 0; i < r.n; i++) {
      const s = i * r.step
      let ds = Math.abs(s - b.s)
      ds = Math.min(ds, r.length - ds)
      const w = 1 - smoothstep(BRIDGE.length / 2, BRIDGE.length / 2 + 70, ds)
      y[i] = lerp(y[i], b.deckY, w)
    }
    smooth1D(y, 5, true)
    const pinned = new Uint8Array(r.n)
    for (let i = 0; i < r.n; i++) {
      let ds = Math.abs(i * r.step - b.s)
      ds = Math.min(ds, r.length - ds)
      if (ds <= BRIDGE.length / 2 + 3) {
        pinned[i] = 1
        y[i] = b.deckY
      }
    }
    limitGrade(y, pinned, r.step, 0.08)
    smooth1D(y, 3, true)
    for (let i = 0; i < r.n; i++) if (pinned[i]) y[i] = b.deckY
    limitGrade(y, pinned, r.step, 0.085)
    this.roadY = y
  }

  roadYAt(s: number): number {
    const r = this.road
    s = r.wrap(s)
    const f = s / r.step
    const i = Math.floor(f) % r.n
    const j = (i + 1) % r.n
    return lerp(this.roadY[i], this.roadY[j], f - Math.floor(f))
  }

  isOnBridge(s: number): boolean {
    const b = this.bridge
    let ds = Math.abs(this.road.wrap(s) - b.s)
    ds = Math.min(ds, this.road.length - ds)
    return ds < BRIDGE.length / 2
  }

  // ---------------------------------------------------------------- composite

  /** Full evaluation: natural + valley + graded road + brook channel. */
  compute(x: number, z: number): number {
    let h = this.valleyed(x, z)
    const hit = this.tmpHit
    if (this.road.nearest(x, z, ROAD_FLAT + 40, hit)) {
      const ry = this.roadYAt(hit.s) - 0.32
      const diff = Math.abs(h - ry)
      const bank = Math.min(10 + diff * 1.4, 38)
      const w = 1 - smoothstep(ROAD_FLAT, ROAD_FLAT + bank, hit.d)
      // bed is flat across the road, then eases into the land
      h = lerp(h, ry, w * w * (3 - 2 * w))
    }
    if (this.stream.nearest(x, z, 60, hit)) {
      const bed = this.streamBedAt(hit.s)
      const src = smoothstep(0, 90, hit.s) // the brook starts as a trickle
      const half = STREAM_BED * (0.35 + 0.65 * src)
      const d = Math.max(0, hit.d - half)
      const bankH = bed + Math.pow(d, 1.25) * 0.55 + (1 - src) * 2.2
      if (bankH < h) h = lerp(h, bankH, 0.92 + 0.08 * src)
    }
    return h
  }

  private buildHeightfield() {
    const N = this.gridN
    const hs = new Float32Array(N * N)
    for (let j = 0; j < N; j++) {
      const z = -NEAR + j * NEAR_STEP
      for (let i = 0; i < N; i++) {
        hs[j * N + i] = this.compute(-NEAR + i * NEAR_STEP, z)
      }
    }
    this.heights = hs
  }

  /** Fast height lookup: bilinear on the detailed grid, analytic outside. */
  heightAt(x: number, z: number): number {
    const fx = (x + NEAR) / NEAR_STEP
    const fz = (z + NEAR) / NEAR_STEP
    const N = this.gridN
    if (fx >= 0 && fz >= 0 && fx < N - 1 && fz < N - 1) {
      const i = Math.floor(fx), j = Math.floor(fz)
      const tx = fx - i, tz = fz - j
      const hs = this.heights
      const a = hs[j * N + i], b = hs[j * N + i + 1]
      const c = hs[(j + 1) * N + i], d = hs[(j + 1) * N + i + 1]
      // match the mesh triangulation (diagonal from (i+1, j) to (i, j+1))
      if (tx + tz <= 1) return a + (b - a) * tx + (c - a) * tz
      return d + (c - d) * (1 - tx) + (b - d) * (1 - tz)
    }
    return this.compute(x, z)
  }

  normalAt(x: number, z: number, out: { x: number; y: number; z: number }) {
    const e = 2.5
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z)
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e)
    const l = Math.hypot(hx, 2 * e, hz)
    out.x = -hx / l
    out.y = (2 * e) / l
    out.z = -hz / l
    return out
  }

  // ---------------------------------------------------------------- masks

  /** 1 = open land (field, lawn, meadow), 0 = forest. Ragged natural edges. */
  clearing(x: number, z: number): number {
    let open = 0
    for (const b of this.clearingBounds) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue
      const sd = polySdf(b.c.poly, x, z)
      const f = b.c.feather
      const ragged = sd + f * 0.55 * this.nB.noise(x / 22, z / 22) + f * 0.25 * this.nC.noise(x / 7, z / 7)
      open = Math.max(open, 1 - smoothstep(-f * 0.5, f * 0.5, ragged))
    }
    return open
  }

  clearingKind(x: number, z: number): Clearing['kind'] | null {
    for (const b of this.clearingBounds) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue
      if (polySdf(b.c.poly, x, z) < b.c.feather * 0.3) return b.c.kind
    }
    return null
  }

  roadNearest(x: number, z: number, max: number, out: NearestHit): boolean {
    return this.road.nearest(x, z, max, out)
  }

  streamNearest(x: number, z: number, max: number, out: NearestHit): boolean {
    return this.stream.nearest(x, z, max, out)
  }
}

/** In-place smoothing: three passes of a moving average (~gaussian, sigma ~= r samples). */
export function smooth1D(a: Float32Array, r: number, wrap: boolean) {
  const n = a.length
  const tmp = new Float32Array(n)
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let cnt = 0
      for (let k = -r; k <= r; k++) {
        let j = i + k
        if (wrap) j = (j + n) % n
        else if (j < 0 || j >= n) continue
        sum += a[j]
        cnt++
      }
      tmp[i] = sum / cnt
    }
    a.set(tmp)
  }
}

/** smooth minimum (polynomial) */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** Clamp the slope of a closed profile so a vintage car could manage it. */
function limitGrade(y: Float32Array, pinned: Uint8Array, step: number, maxGrade: number) {
  const n = y.length
  const dmax = maxGrade * step
  for (let iter = 0; iter < 3; iter++) {
    // cut the crests and fill the dips symmetrically; pinned samples never move
    const up = Float32Array.from(y)
    const dn = Float32Array.from(y)
    for (let k = 0; k < 2 * n; k++) {
      const i = k % n, p = (i - 1 + n) % n
      if (pinned[i]) continue
      up[i] = Math.min(up[i], up[p] + dmax)
      dn[i] = Math.max(dn[i], dn[p] - dmax)
    }
    for (let k = 2 * n - 1; k >= 0; k--) {
      const i = k % n, q = (i + 1) % n
      if (pinned[i]) continue
      up[i] = Math.min(up[i], up[q] + dmax)
      dn[i] = Math.max(dn[i], dn[q] - dmax)
    }
    for (let i = 0; i < n; i++) y[i] = 0.5 * (up[i] + dn[i])
  }
}
