import { Simplex2, smoothstep } from '../core/noise'
import type { Terrain } from './terrain'
import { BARN, CHURCH, HOUSES, SILO } from './layout'

/** buildings keep a little yard clear of trees */
const YARDS: [number, number, number][] = [
  ...HOUSES.map((h) => [h.pos[0], h.pos[1], 15] as [number, number, number]),
  [BARN.pos[0], BARN.pos[1], 22],
  [SILO.pos[0], SILO.pos[1], 8],
  [CHURCH.pos[0], CHURCH.pos[1], 22],
]

/** Where the detailed instanced forest lives; beyond it the terrain paints canopy. */
export const TREE_RECT = { minX: -1000, maxX: 1080, minZ: -1240, maxZ: 1240, feather: 130 }

export function treeRegionWeight(x: number, z: number): number {
  const f = TREE_RECT.feather
  const wx = Math.min(smoothstep(TREE_RECT.minX, TREE_RECT.minX + f, x), 1 - smoothstep(TREE_RECT.maxX - f, TREE_RECT.maxX, x))
  const wz = Math.min(smoothstep(TREE_RECT.minZ, TREE_RECT.minZ + f, z), 1 - smoothstep(TREE_RECT.maxZ - f, TREE_RECT.maxZ, z))
  return Math.min(wx, wz)
}

const nGap = new Simplex2(77)
const hit = { d: 0, s: 0, lat: 0 }

/**
 * 0..1 likelihood that a tree grows here (independent of the detailed region).
 * Shared by tree placement and terrain shading so the ground under the canopy matches.
 */
export function forestDensity(T: Terrain, x: number, z: number): number {
  let d = 1 - T.clearing(x, z)
  if (d <= 0) return 0
  for (const [yx, yz, r] of YARDS) {
    const dx = x - yx, dz = z - yz
    if (dx * dx + dz * dz < r * r * 2.2) d *= smoothstep(r * 0.9, r * 1.45, Math.sqrt(dx * dx + dz * dz))
  }
  if (T.roadNearest(x, z, 12, hit)) d *= smoothstep(6.4, 9.5, hit.d)
  if (d <= 0) return 0
  if (T.streamNearest(x, z, 10, hit)) d *= smoothstep(3.5, 7, hit.d)
  // small natural openings: ledges, old beaver meadows
  const g = nGap.fbm(x / 110, z / 110, 3)
  d *= 1 - 0.85 * smoothstep(0.42, 0.6, g)
  // the overlook ridge keeps a few bare ledges
  return d
}
