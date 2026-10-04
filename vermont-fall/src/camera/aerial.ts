import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

export interface CameraPose {
  pos: Vector3
  target: Vector3
  fov: number
  roll: number
}

/**
 * Art-directed aerial view: a slightly isometric diorama framing that breathes a
 * little and follows the pointer, but can never be spun into a bad composition.
 */
export class AerialRig {
  target = new Vector3(50, 0, -170)
  yaw = MathUtils.degToRad(3) // around the target, 0 = looking north
  pitch = MathUtils.degToRad(19)
  dist = 1600
  fov = 31

  /** Two art-directed framings: wide for landscape, a taller look down the valley for portrait. */
  setFraming(portrait: boolean) {
    if (portrait) {
      this.target.set(160, 0, -110)
      this.yaw = MathUtils.degToRad(-2)
      this.pitch = MathUtils.degToRad(29)
      this.dist = 2000
      this.fov = 46
    } else {
      this.target.set(50, 0, -170)
      this.yaw = MathUtils.degToRad(3)
      this.pitch = MathUtils.degToRad(19)
      this.dist = 1600
      this.fov = 31
    }
  }

  // live state
  private zoom = 1
  private zoomGoal = 1
  private px = 0
  private py = 0
  private pxGoal = 0
  private pyGoal = 0
  private t = 0
  reducedMotion = false

  setPointer(nx: number, ny: number) {
    // nx, ny in [-1, 1]
    this.pxGoal = nx
    this.pyGoal = ny
  }

  addZoom(delta: number) {
    this.zoomGoal = MathUtils.clamp(this.zoomGoal * Math.exp(delta), 0.58, 1.12)
  }

  update(dt: number) {
    this.t += dt
    const k = 1 - Math.exp(-dt * 2.2)
    this.px += (this.pxGoal - this.px) * k
    this.py += (this.pyGoal - this.py) * k
    this.zoom += (this.zoomGoal - this.zoom) * (1 - Math.exp(-dt * 3))
  }

  /** Current pose (position / look target). */
  pose(out: CameraPose): CameraPose {
    const breathe = this.reducedMotion ? 0 : 1
    const yaw = this.yaw + MathUtils.degToRad(2.2) * this.px + breathe * MathUtils.degToRad(1.1) * Math.sin(this.t * 0.11)
    const pitch = this.pitch + MathUtils.degToRad(1.4) * this.py + breathe * MathUtils.degToRad(0.35) * Math.sin(this.t * 0.07 + 1)
    const d = this.dist * this.zoom
    // zooming in also lowers the view a touch so it feels like leaning in
    const p = pitch - (1 - this.zoom) * MathUtils.degToRad(5)
    out.target.copy(this.target)
    out.target.y += (1 - this.zoom) * -12
    out.pos.set(
      out.target.x + Math.sin(yaw) * Math.cos(p) * d,
      out.target.y + Math.sin(p) * d,
      out.target.z + Math.cos(yaw) * Math.cos(p) * d,
    )
    out.fov = this.fov
    out.roll = 0
    return out
  }
}

export function applyPose(cam: PerspectiveCamera, pose: CameraPose) {
  cam.position.copy(pose.pos)
  cam.up.set(0, 1, 0)
  cam.lookAt(pose.target)
  if (pose.roll) cam.rotateZ(pose.roll)
  if (cam.fov !== pose.fov) {
    cam.fov = pose.fov
    cam.updateProjectionMatrix()
  }
}
