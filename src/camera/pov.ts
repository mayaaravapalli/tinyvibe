import { MathUtils, Quaternion, Vector3 } from 'three'
import type { Driver } from '../world/drive'
import { LANE } from '../world/drive'
import type { Terrain } from '../world/terrain'
import type { CameraPose } from './aerial'

/**
 * Driver's-eye camera just behind the long hood. Looks down the road with a
 * little anticipation, leans gently with the car, and lets the pointer glance
 * around within comfortable limits.
 */
export class PovRig {
  /** eye position in the car's frame */
  readonly eye = new Vector3(0, 1.5, 0.82)
  fov = 56
  reducedMotion = false
  // smoothed state
  private look = new Vector3(0, 0, 1)
  private glanceYaw = 0
  private glancePitch = 0
  private glanceGoalYaw = 0
  private glanceGoalPitch = 0
  private t = 0
  private overlookPan = 0
  private tmp = new Vector3()
  private q = new Quaternion()
  private p = { x: 0, z: 0, tx: 0, tz: 0 }
  private primed = false

  /** sign of the yaw that turns from the road towards the overlook's view */
  private viewSide: number

  constructor(private T: Terrain, private D: Driver) {
    const t = T.road.sample(D.overlookS, { x: 0, z: 0, tx: 0, tz: 0 })
    // the open view lies to the north-north-west of the crest
    const vx = -0.35, vz = -1
    const cross = t.tx * vz - t.tz * vx
    const dot = t.tx * vx + t.tz * vz
    this.viewSide = Math.sign(Math.atan2(-cross, dot)) || 1
  }

  /** pointer in [-1, 1]; held drags look further than a passing hover */
  setGlance(nx: number, ny: number, strength = 1) {
    this.glanceGoalYaw = -nx * MathUtils.degToRad(26) * strength
    this.glanceGoalPitch = ny * MathUtils.degToRad(11) * strength
  }

  resetPrime() {
    this.primed = false
  }

  update(dt: number) {
    this.t += dt
    const D = this.D
    // look target: further ahead at speed, at roughly eye height above the road
    const ahead = 14 + D.v * 1.25
    const s = D.s + ahead
    const p = this.T.road.sample(s, this.p)
    const ty = this.T.roadYAt(s) + 1.0
    const target = this.tmp.set(p.x - p.tz * LANE * 0.6, ty, p.z + p.tx * LANE * 0.6)
    const eye = this.eyeWorld(new Vector3())
    const dir = target.sub(eye).normalize()
    if (!this.primed) {
      this.look.copy(dir)
      this.primed = true
    } else {
      const k = 1 - Math.exp(-dt * 2.6)
      this.look.lerp(dir, k).normalize()
    }
    const g = 1 - Math.exp(-dt * 2.2)
    this.glanceYaw += (this.glanceGoalYaw - this.glanceYaw) * g
    this.glancePitch += (this.glanceGoalPitch - this.glancePitch) * g
    // at the overlook the camera drifts towards the view on its own
    let dov = D.s - D.overlookS
    const L = this.T.road.length
    if (dov > L / 2) dov -= L
    if (dov < -L / 2) dov += L
    const want = this.viewSide * MathUtils.degToRad(16) * Math.exp(-((dov + 30) * (dov + 30)) / (2 * 70 * 70))
    this.overlookPan += (want - this.overlookPan) * (1 - Math.exp(-dt * 0.8))
  }

  eyeWorld(out: Vector3): Vector3 {
    const D = this.D
    out.copy(this.eye).applyQuaternion(D.quat).add(D.pos)
    if (!this.reducedMotion) {
      // the faintest road texture through the seat
      out.y += 0.006 * Math.sin(this.t * 13.1) * Math.sin(this.t * 3.7) * Math.min(1, D.v / 10)
    }
    return out
  }

  pose(out: CameraPose): CameraPose {
    const D = this.D
    this.eyeWorld(out.pos)
    const dir = this.tmp.copy(this.look)
    // glance + overlook pan around world up, then pitch
    this.q.setFromAxisAngle(new Vector3(0, 1, 0), this.glanceYaw + this.overlookPan)
    dir.applyQuaternion(this.q)
    const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize()
    this.q.setFromAxisAngle(right, this.glancePitch - MathUtils.degToRad(1.2))
    dir.applyQuaternion(this.q)
    out.target.copy(out.pos).addScaledVector(dir, 30)
    out.fov = this.fov
    out.roll = this.reducedMotion ? 0 : D.roll * 0.6
    return out
  }
}
