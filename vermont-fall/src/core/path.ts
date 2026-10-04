import { CatmullRomCurve3, Vector3 } from 'three'

/**
 * A densely-sampled 2D (x/z) path with arc-length parameterisation and a
 * spatial grid for fast nearest-point queries. Used for the road and the brook.
 */
export class Path2 {
  readonly closed: boolean
  readonly n: number
  readonly xs: Float32Array
  readonly zs: Float32Array
  readonly tx: Float32Array
  readonly tz: Float32Array
  readonly length: number
  readonly step: number

  private cell: number
  private gridMinX = 0
  private gridMinZ = 0
  private gridW = 0
  private gridH = 0
  private cellStart!: Int32Array
  private cellItems!: Int32Array

  constructor(points: [number, number][], closed: boolean, step = 1.5, tension = 0.5) {
    this.closed = closed
    const curve = new CatmullRomCurve3(
      points.map(([x, z]) => new Vector3(x, 0, z)),
      closed,
      'centripetal',
      tension,
    )
    curve.arcLengthDivisions = Math.max(2000, points.length * 400)
    const len = curve.getLength()
    const n = Math.max(8, Math.round(len / step))
    this.n = closed ? n : n + 1
    this.length = len
    this.step = len / n
    this.xs = new Float32Array(this.n)
    this.zs = new Float32Array(this.n)
    this.tx = new Float32Array(this.n)
    this.tz = new Float32Array(this.n)
    const p = new Vector3()
    const t = new Vector3()
    for (let i = 0; i < this.n; i++) {
      const u = i / n
      curve.getPointAt(Math.min(u, 1), p)
      curve.getTangentAt(Math.min(u, 1), t)
      this.xs[i] = p.x
      this.zs[i] = p.z
      const tl = Math.hypot(t.x, t.z) || 1
      this.tx[i] = t.x / tl
      this.tz[i] = t.z / tl
    }
    this.cell = 16
    this.buildGrid()
  }

  private buildGrid() {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.xs[i]); maxX = Math.max(maxX, this.xs[i])
      minZ = Math.min(minZ, this.zs[i]); maxZ = Math.max(maxZ, this.zs[i])
    }
    const c = this.cell
    this.gridMinX = minX - c
    this.gridMinZ = minZ - c
    this.gridW = Math.ceil((maxX - minX) / c) + 3
    this.gridH = Math.ceil((maxZ - minZ) / c) + 3
    const counts = new Int32Array(this.gridW * this.gridH + 1)
    const idx = new Int32Array(this.n)
    for (let i = 0; i < this.n; i++) {
      const gx = Math.floor((this.xs[i] - this.gridMinX) / c)
      const gz = Math.floor((this.zs[i] - this.gridMinZ) / c)
      idx[i] = gz * this.gridW + gx
      counts[idx[i] + 1]++
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1]
    this.cellStart = counts
    this.cellItems = new Int32Array(this.n)
    const fill = counts.slice()
    for (let i = 0; i < this.n; i++) this.cellItems[fill[idx[i]]++] = i
  }

  wrap(s: number): number {
    if (!this.closed) return Math.min(Math.max(s, 0), this.length)
    s %= this.length
    return s < 0 ? s + this.length : s
  }

  /** Interpolated sample at arc length s. */
  sample(s: number, out: { x: number; z: number; tx: number; tz: number }) {
    s = this.wrap(s)
    const f = s / this.step
    let i0 = Math.floor(f)
    const t = f - i0
    let i1 = i0 + 1
    if (this.closed) {
      i0 %= this.n
      i1 %= this.n
    } else {
      i0 = Math.min(i0, this.n - 1)
      i1 = Math.min(i1, this.n - 1)
    }
    out.x = this.xs[i0] + (this.xs[i1] - this.xs[i0]) * t
    out.z = this.zs[i0] + (this.zs[i1] - this.zs[i0]) * t
    const ax = this.tx[i0] + (this.tx[i1] - this.tx[i0]) * t
    const az = this.tz[i0] + (this.tz[i1] - this.tz[i0]) * t
    const l = Math.hypot(ax, az) || 1
    out.tx = ax / l
    out.tz = az / l
    return out
  }

  /**
   * Nearest point on the path within maxDist. Returns false if none.
   * Writes distance, arc length and signed lateral offset (positive = right of travel).
   */
  nearest(x: number, z: number, maxDist: number, out: { d: number; s: number; lat: number }): boolean {
    const c = this.cell
    const r = Math.ceil(maxDist / c)
    const gx = Math.floor((x - this.gridMinX) / c)
    const gz = Math.floor((z - this.gridMinZ) / c)
    let best = maxDist * maxDist
    let bi = -1
    for (let jz = Math.max(0, gz - r); jz <= Math.min(this.gridH - 1, gz + r); jz++) {
      for (let jx = Math.max(0, gx - r); jx <= Math.min(this.gridW - 1, gx + r); jx++) {
        const cell = jz * this.gridW + jx
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
          const i = this.cellItems[k]
          const dx = x - this.xs[i]
          const dz = z - this.zs[i]
          const d2 = dx * dx + dz * dz
          if (d2 < best) {
            best = d2
            bi = i
          }
        }
      }
    }
    if (bi < 0) return false
    // refine on the two adjacent segments
    let bestD2 = Infinity
    let bestS = 0
    let bestLat = 0
    for (let k = -1; k <= 0; k++) {
      let a = bi + k
      let b = a + 1
      if (this.closed) {
        a = (a + this.n) % this.n
        b = (b + this.n) % this.n
      } else if (a < 0 || b >= this.n) continue
      const ax = this.xs[a], az = this.zs[a]
      const sx = this.xs[b] - ax, sz = this.zs[b] - az
      const l2 = sx * sx + sz * sz || 1
      let t = ((x - ax) * sx + (z - az) * sz) / l2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = ax + sx * t, pz = az + sz * t
      const dx = x - px, dz = z - pz
      const d2 = dx * dx + dz * dz
      if (d2 < bestD2) {
        bestD2 = d2
        const ia = bi + k
        bestS = (ia + t) * this.step
        const l = Math.sqrt(l2)
        // right of travel = (-tz, tx)
        bestLat = (dx * (-sz / l) + dz * (sx / l))
      }
    }
    out.d = Math.sqrt(bestD2)
    out.s = this.wrap(bestS)
    out.lat = bestLat
    return true
  }
}
