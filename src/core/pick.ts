import type { Camera, Vector3 } from 'three'
import { Raycaster, Vector2 } from 'three'
import type { Terrain } from '../world/terrain'

const rc = new Raycaster()
const ndc = new Vector2()

/**
 * Intersect a screen ray with the land (lifted to roughly canopy height, which
 * is what the eye reads as "the forest" from above). March + bisect on the
 * analytic heightfield — no triangle raycasting against half a million faces.
 */
export function pickGround(
  T: Terrain,
  camera: Camera,
  nx: number,
  ny: number,
  out: Vector3,
  lift = 11,
  maxDist = 9000,
): boolean {
  ndc.set(nx, ny)
  rc.setFromCamera(ndc, camera)
  const o = rc.ray.origin
  const d = rc.ray.direction
  let t = 0
  let prevT = 0
  let hit = false
  for (let i = 0; i < 600 && t < maxDist; i++) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t
    const h = T.heightAt(x, z) + lift
    const gap = y - h
    if (gap < 0) {
      hit = true
      break
    }
    prevT = t
    t += Math.min(60, Math.max(0.8, gap * 0.5))
  }
  if (!hit) return false
  let a = prevT, b = t
  for (let k = 0; k < 18; k++) {
    const m = (a + b) * 0.5
    const x = o.x + d.x * m, y = o.y + d.y * m, z = o.z + d.z * m
    if (y < T.heightAt(x, z) + lift) b = m
    else a = m
  }
  out.set(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b)
  return true
}
