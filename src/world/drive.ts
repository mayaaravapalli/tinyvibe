import { Matrix4, Quaternion, Vector3 } from 'three'
import { clamp, smoothstep } from '../core/noise'
import { smooth1D, type Terrain } from './terrain'

export const LANE = 1.68

/**
 * Drives the car round the loop at an unhurried, art-directed pace: slower into
 * curves, onto the covered bridge and at the overlook, gentle acceleration out.
 */
export class Driver {
  s: number
  v = 9
  readonly profile: Float32Array
  /** world pose of the car (ground point between the axles) */
  readonly pos = new Vector3()
  readonly fwd = new Vector3(0, 0, 1)
  readonly up = new Vector3(0, 1, 0)
  readonly quat = new Quaternion()
  /** signed lateral acceleration (m/s^2, + = turning right) */
  aLat = 0
  aLong = 0
  roll = 0
  pitch = 0
  overlookS: number
  private p = { x: 0, z: 0, tx: 0, tz: 0 }
  private m = new Matrix4()
  private x = new Vector3()

  constructor(private T: Terrain, startS: number) {
    this.s = startS
    const r = T.road
    const n = r.n
    // signed curvature from heading change
    const curv = new Float32Array(n)
    const k = 6
    for (let i = 0; i < n; i++) {
      const a = (i - k + n) % n, b = (i + k) % n
      const h0 = Math.atan2(r.tz[a], r.tx[a])
      let dh = Math.atan2(r.tz[b], r.tx[b]) - h0
      while (dh > Math.PI) dh -= Math.PI * 2
      while (dh < -Math.PI) dh += Math.PI * 2
      curv[i] = dh / (2 * k * r.step)
    }
    smooth1D(curv, 6, true)
    // find the overlook: nearest road point to the pull-off
    const hit = { d: 0, s: 0, lat: 0 }
    T.road.nearest(238, -632, 200, hit)
    this.overlookS = hit.s
    const prof = new Float32Array(n)
    const base = 12.5
    for (let i = 0; i < n; i++) {
      const s = i * r.step
      let v = base
      v = Math.min(v, Math.sqrt(1.5 / Math.max(1e-4, Math.abs(curv[i]))))
      // covered bridge: ease off and roll through
      let db = Math.abs(s - T.bridge.s)
      db = Math.min(db, r.length - db)
      v = Math.min(v, 7.5 + 5 * smoothstep(25, 90, db))
      // overlook: slow right down so the view can be taken in
      let dov = s - this.overlookS
      if (dov > r.length / 2) dov -= r.length
      if (dov < -r.length / 2) dov += r.length
      v = Math.min(v, 5.2 + 7 * smoothstep(40, 170, Math.abs(dov + 20)))
      prof[i] = Math.max(4.5, v)
    }
    // acceleration limits (forward: speed up gently; backward: brake early)
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < 2 * n; j++) {
        const i = j % n, p = (i - 1 + n) % n
        prof[i] = Math.min(prof[i], Math.sqrt(prof[p] * prof[p] + 2 * 0.55 * r.step))
      }
      for (let j = 2 * n - 1; j >= 0; j--) {
        const i = j % n, q = (i + 1) % n
        prof[i] = Math.min(prof[i], Math.sqrt(prof[q] * prof[q] + 2 * 0.8 * r.step))
      }
    }
    smooth1D(prof, 8, true)
    this.profile = prof
    this.v = this.targetSpeed(this.s)
    this.computePose(this.s, 0)
  }

  targetSpeed(s: number): number {
    const r = this.T.road
    const f = r.wrap(s) / r.step
    const i = Math.floor(f) % r.n
    const j = (i + 1) % r.n
    return this.profile[i] + (this.profile[j] - this.profile[i]) * (f - Math.floor(f))
  }

  update(dt: number, speedScale = 1) {
    const target = this.targetSpeed(this.s + this.v * 1.2) * speedScale
    const prev = this.v
    this.v += clamp(target - this.v, -1.1 * dt, 0.7 * dt)
    this.aLong = (this.v - prev) / Math.max(dt, 1e-3)
    this.s = this.T.road.wrap(this.s + this.v * dt)
    this.computePose(this.s, dt)
  }

  /** Lane offset: the covered bridge is one lane, so the car drifts to the middle. */
  laneAt(s: number): number {
    const r = this.T.road
    let d = Math.abs(r.wrap(s) - this.T.bridge.s)
    d = Math.min(d, r.length - d)
    return LANE * (0.08 + 0.92 * smoothstep(24, 70, d))
  }

  /** Pose of the car at arc length s (lane centre, on the road surface). */
  computePose(s: number, dt: number) {
    const T = this.T
    const r = T.road
    const p = r.sample(s, this.p)
    const y = T.roadYAt(s)
    const lane = this.laneAt(s)
    this.pos.set(p.x - p.tz * lane, y + 0.02, p.z + p.tx * lane)
    const dy = (T.roadYAt(s + 2) - T.roadYAt(s - 2)) / 4
    this.fwd.set(p.tx, dy, p.tz).normalize()
    // lateral acceleration from heading rate
    const ahead = r.sample(s + 4, { x: 0, z: 0, tx: 0, tz: 0 })
    const cross = p.tx * ahead.tz - p.tz * ahead.tx
    const kappa = Math.asin(clamp(cross, -1, 1)) / 4
    const aLat = this.v * this.v * kappa
    const k = dt > 0 ? 1 - Math.exp(-dt * 3) : 1
    this.aLat += (aLat - this.aLat) * k
    // soft vintage suspension: lean out of turns, nod under braking
    this.roll += (-this.aLat * 0.022 - this.roll) * k
    this.pitch += (-this.aLong * 0.012 - this.pitch) * k
    this.x.crossVectors(new Vector3(0, 1, 0), this.fwd).normalize()
    this.up.crossVectors(this.fwd, this.x).normalize()
    this.m.makeBasis(this.x, this.up, this.fwd)
    this.quat.setFromRotationMatrix(this.m)
  }
}
