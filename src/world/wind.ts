import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, Vector2 } from 'three'
import { U } from '../render/shared'

/**
 * Spatial wind field. User gusts are "puffs" that travel across the land; each
 * grid cell carries a damped spring (a stand of trees) that the puffs push. The
 * springs overshoot and settle, so a gust visibly rolls across the forest and
 * leaves a ripple behind it. Packed into an RGBA8 texture every frame:
 *   rg = bend displacement (-1..1), b = gust energy (leaf flutter / flip), a = puff force
 */

interface Puff {
  x: number
  z: number
  dx: number
  dz: number
  speed: number
  radius: number
  grow: number
  strength: number
  age: number
  life: number
}

export class WindField {
  readonly N = 128
  readonly min = -1400
  readonly size = 2800
  readonly cell: number
  private dispX: Float32Array
  private dispZ: Float32Array
  private velX: Float32Array
  private velZ: Float32Array
  private energy: Float32Array
  private forceX: Float32Array
  private forceZ: Float32Array
  private data: Uint8Array
  readonly texture: DataTexture
  private puffs: Puff[] = []
  readonly maxPuffs = 48
  /** ambient breeze direction (unit) and strength 0..1 */
  ambientDir = new Vector2(0.86, 0.5).normalize()
  ambient = 0.35
  private t = 0
  /** total gust force near the last queried point (for smoke, audio) */
  activity = 0

  constructor() {
    const n = this.N * this.N
    this.cell = this.size / this.N
    this.dispX = new Float32Array(n)
    this.dispZ = new Float32Array(n)
    this.velX = new Float32Array(n)
    this.velZ = new Float32Array(n)
    this.energy = new Float32Array(n)
    this.forceX = new Float32Array(n)
    this.forceZ = new Float32Array(n)
    this.data = new Uint8Array(n * 4)
    this.texture = new DataTexture(this.data, this.N, this.N, RGBAFormat, UnsignedByteType)
    this.texture.magFilter = LinearFilter
    this.texture.minFilter = LinearFilter
    this.texture.needsUpdate = true
    U.uWindTex.value = this.texture
    U.uWindRect.value.set(this.min, this.min, 1 / this.size, 1 / this.size)
  }

  /** A gust puff born at (x, z) travelling along (dx, dz). strength 0..1 */
  gust(x: number, z: number, dx: number, dz: number, strength: number, radius = 70) {
    const l = Math.hypot(dx, dz) || 1
    if (this.puffs.length >= this.maxPuffs) this.puffs.shift()
    this.puffs.push({
      x, z,
      dx: dx / l,
      dz: dz / l,
      speed: 42 + 30 * strength,
      radius,
      grow: 16,
      strength,
      age: 0,
      life: 3.2 + 1.6 * strength,
    })
  }

  /** a random live gust, weighted towards the strong ones (for tearing leaves loose) */
  randomGustPoint(r: () => number): { x: number; z: number; dx: number; dz: number } | null {
    if (!this.puffs.length) return null
    for (let k = 0; k < 4; k++) {
      const p = this.puffs[Math.floor(r() * this.puffs.length)]
      const life = 1 - p.age / p.life
      if (r() < p.strength * life) {
        const a = r() * 6.28, rr = p.radius * Math.sqrt(r()) * 0.8
        return { x: p.x + Math.cos(a) * rr, z: p.z + Math.sin(a) * rr, dx: p.dx, dz: p.dz }
      }
    }
    return null
  }

  get puffCount() {
    return this.puffs.length
  }

  /** Air velocity (m/s, horizontal) at a point: ambient breeze + passing gusts. */
  sample(x: number, z: number, out: { x: number; z: number; e: number }) {
    let fx = 0, fz = 0
    for (const p of this.puffs) {
      const w = this.puffWeight(p, x, z)
      fx += p.dx * w
      fz += p.dz * w
    }
    const gx = (x - this.min) / this.cell - 0.5
    const gz = (z - this.min) / this.cell - 0.5
    let e = 0
    if (gx >= 0 && gz >= 0 && gx < this.N - 1 && gz < this.N - 1) {
      e = this.energy[Math.round(gz) * this.N + Math.round(gx)]
    }
    const amb = this.ambient * (0.7 + 0.3 * Math.sin(this.t * 0.31 + x * 0.004))
    out.x = this.ambientDir.x * amb * 2.2 + fx * 9
    out.z = this.ambientDir.y * amb * 2.2 + fz * 9
    out.e = e
    return out
  }

  private puffWeight(p: Puff, x: number, z: number): number {
    const ex = x - p.x, ez = z - p.z
    const r = p.radius
    // elongated across the direction of travel: a gust front rather than a ball
    const along = ex * p.dx + ez * p.dz
    const across = -ex * p.dz + ez * p.dx
    const q = (along * along) / (r * r * 0.55) + (across * across) / (r * r * 1.6)
    if (q > 9) return 0
    const fadeIn = Math.min(1, p.age / 0.18)
    const k = 1 - p.age / p.life
    return p.strength * fadeIn * k * k * Math.exp(-q)
  }

  update(dt: number) {
    dt = Math.min(dt, 1 / 20)
    this.t += dt
    const N = this.N
    const fx = this.forceX, fz = this.forceZ
    fx.fill(0)
    fz.fill(0)
    // move puffs, splat their force into the grid
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]
      p.age += dt
      if (p.age >= p.life) {
        this.puffs.splice(i, 1)
        continue
      }
      p.x += p.dx * p.speed * dt
      p.z += p.dz * p.speed * dt
      p.radius += p.grow * dt
      p.speed *= Math.exp(-dt * 0.25)
      const reach = p.radius * 2.6
      const i0 = Math.max(0, Math.floor((p.x - reach - this.min) / this.cell))
      const i1 = Math.min(N - 1, Math.ceil((p.x + reach - this.min) / this.cell))
      const j0 = Math.max(0, Math.floor((p.z - reach - this.min) / this.cell))
      const j1 = Math.min(N - 1, Math.ceil((p.z + reach - this.min) / this.cell))
      for (let j = j0; j <= j1; j++) {
        const z = this.min + (j + 0.5) * this.cell
        for (let ii = i0; ii <= i1; ii++) {
          const x = this.min + (ii + 0.5) * this.cell
          const w = this.puffWeight(p, x, z)
          if (w < 1e-4) continue
          const k = j * N + ii
          fx[k] += p.dx * w
          fz[k] += p.dz * w
        }
      }
    }
    // springs: trees lean into the gust, overshoot, then settle
    const omega = 2 * Math.PI * 0.42
    const zeta = 0.22
    const kForce = omega * omega * 0.85
    const dX = this.dispX, dZ = this.dispZ, vX = this.velX, vZ = this.velZ, E = this.energy
    const eDecay = Math.exp(-dt * 1.4)
    const d = this.data
    let act = 0
    for (let k = 0; k < N * N; k++) {
      let Fx = fx[k], Fz = fz[k]
      // overlapping puffs reinforce each other, but a stand can only lean so far
      const f2 = Fx * Fx + Fz * Fz
      if (f2 > 1) {
        const inv = 1 / Math.sqrt(f2)
        Fx *= inv
        Fz *= inv
      }
      const ax = kForce * Fx - omega * omega * dX[k] - 2 * zeta * omega * vX[k]
      const az = kForce * Fz - omega * omega * dZ[k] - 2 * zeta * omega * vZ[k]
      vX[k] += ax * dt
      vZ[k] += az * dt
      dX[k] += vX[k] * dt
      dZ[k] += vZ[k] * dt
      const fm = Math.sqrt(Fx * Fx + Fz * Fz)
      const vm = Math.sqrt(vX[k] * vX[k] + vZ[k] * vZ[k])
      E[k] = Math.max(E[k] * eDecay, Math.min(1, fm * 1.3 + vm * 0.35))
      act += fm
      const o = k * 4
      d[o] = Math.max(0, Math.min(255, 128 + dX[k] * 110))
      d[o + 1] = Math.max(0, Math.min(255, 128 + dZ[k] * 110))
      d[o + 2] = Math.min(255, E[k] * 255)
      d[o + 3] = Math.min(255, fm * 255)
    }
    this.activity = act
    this.texture.needsUpdate = true
    // ambient breeze slowly veers
    const a = Math.atan2(this.ambientDir.y, this.ambientDir.x) + Math.sin(this.t * 0.05) * 0.0008
    this.ambientDir.set(Math.cos(a), Math.sin(a))
    U.uAmbientWind.value.copy(this.ambientDir).multiplyScalar(this.ambient)
  }
}
