import { Vector3 } from 'three'
import { smoothstep } from '../core/noise'
import type { CameraPose } from './aerial'

/** CSS-style cubic-bezier easing (x1, y1, x2, y2), solved by Newton iterations. */
export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t
  const sy = (t: number) => ((ay * t + by) * t + cy) * t
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x
      const d = dsx(t)
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break
      t -= e / d
    }
    t = Math.min(1, Math.max(0, t))
    return sy(t)
  }
}

const UP = new Vector3(0, 1, 0)
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()
const _d = new Vector3()

function bezier(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number, out: Vector3) {
  const it = 1 - t
  return out
    .copy(p0)
    .multiplyScalar(it * it * it)
    .addScaledVector(p1, 3 * it * it * t)
    .addScaledVector(p2, 3 * it * t * t)
    .addScaledVector(p3, t * t * t)
}

export const diveEase = cubicBezierEase(0.58, 0.0, 0.16, 1.0)
export const riseEase = cubicBezierEase(0.42, 0.0, 0.22, 1.0)

/**
 * Aerial -> road. Leaves the diorama, swings down behind the car through the
 * canopy and settles at the windshield. Car-relative control points move with
 * the car every frame so the landing is always exactly on it.
 */
export function divePose(
  e: number,
  start: CameraPose,
  carPos: Vector3,
  carFwd: Vector3,
  pov: CameraPose,
  out: CameraPose,
): CameraPose {
  const flatFwd = _d.set(carFwd.x, 0, carFwd.z).normalize()
  const p1 = _a.copy(carPos).addScaledVector(UP, 240).addScaledVector(flatFwd, -170).lerp(start.pos, 0.35)
  const p2 = _b.copy(carPos).addScaledVector(UP, 15).addScaledVector(flatFwd, -30)
  bezier(start.pos, p1, p2, pov.pos, e, out.pos)
  // look: from the diorama to the car, then down the road
  const carLook = _c.copy(carPos).addScaledVector(UP, 1.2).addScaledVector(flatFwd, 6)
  out.target.copy(start.target).lerp(carLook, smoothstep(0.0, 0.42, e))
  out.target.lerp(pov.target, smoothstep(0.6, 1.0, e))
  out.fov = start.fov + (pov.fov - start.fov) * smoothstep(0.18, 0.92, e)
  out.roll = pov.roll * smoothstep(0.85, 1.0, e)
  return out
}

/** Road -> aerial. Tilts up, lifts out of the trees, then drifts back to the diorama. */
export function risePose(
  e: number,
  pov: CameraPose,
  carPos: Vector3,
  carFwd: Vector3,
  aerial: CameraPose,
  out: CameraPose,
): CameraPose {
  const flatFwd = _d.set(carFwd.x, 0, carFwd.z).normalize()
  const p1 = _a.copy(carPos).addScaledVector(UP, 46).addScaledVector(flatFwd, -12)
  const p2 = _b.copy(carPos).addScaledVector(UP, 330).lerp(aerial.pos, 0.55)
  bezier(pov.pos, p1, p2, aerial.pos, e, out.pos)
  const carLook = _c.copy(carPos).addScaledVector(flatFwd, 10)
  out.target.copy(pov.target).lerp(carLook, smoothstep(0.02, 0.3, e))
  out.target.lerp(aerial.target, smoothstep(0.32, 0.96, e))
  out.fov = pov.fov + (aerial.fov - pov.fov) * smoothstep(0.1, 0.85, e)
  out.roll = pov.roll * (1 - smoothstep(0.0, 0.15, e))
  return out
}
