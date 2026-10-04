import {
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three'
import { TILE, tileUv } from '../render/leafTexture'
import { growTree, shrubParams } from './branchTree'
import { Builder } from './geoBuilder'

const hex = (h: string) => new Color(h)

/** autumn palettes for what grows under and between the trees */
export const UNDER_PALETTE = {
  fern: ['#e2d39c', '#d6c07a', '#cdb064', '#b89448', '#9aa258', '#a8683a'].map(hex),
  shrub: ['#b4262a', '#8e1e2c', '#c64a22', '#a8381e', '#d8762a', '#7a2030'].map(hex),
  sumac: ['#c8281a', '#d63c1c', '#b01e18', '#e0602a'].map(hex),
  goldenrod: ['#bfae88', '#c8a848', '#b09868', '#d0b860'].map(hex),
  aster: ['#8c76cc', '#7058b4', '#9a86d6', '#6e4aa6'].map(hex),
}

/** five or six arching fronds from one crown */
function fernClump(seed: number): BufferGeometry {
  const b = new Builder()
  const none = new Color(0, 0, 0)
  let r = seed * 9301 + 49297
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
  const fronds = 5 + Math.floor(rnd() * 3)
  const n = new Vector3()
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + rnd() * 0.7
    const L = 0.75 + rnd() * 0.45
    const rise = 0.55 + rnd() * 0.35
    const dir = new Vector3(Math.cos(a), 0, Math.sin(a))
    const across = new Vector3(-dir.z, 0, dir.x)
    const W = L * 0.5
    const segs = 6
    const cr = rnd()
    const ids: number[][] = []
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      // arches up, then droops at the tip
      const c = dir.clone().multiplyScalar(L * t * 0.9)
      c.y = L * (rise * t - (rise * 0.9) * t * t) + 0.02
      const tilt = 0.25 * t
      const ax = across.clone().multiplyScalar(Math.cos(tilt)).add(new Vector3(0, Math.sin(tilt), 0))
      n.set(dir.x * 0.25, 1, dir.z * 0.25).normalize()
      const row: number[] = []
      for (const u of [0, 1]) {
        const p = c.clone().addScaledVector(ax, (u - 0.5) * W)
        const [uu, vv] = tileUv(TILE.fern, u, t)
        row.push(b.vertex(p, n, [Math.min(1, p.y / 0.6), cr, 0.72 + 0.28 * t, 2], none, uu, vv))
      }
      ids.push(row)
    }
    for (let i = 0; i < segs; i++) {
      b.tri(ids[i][0], ids[i + 1][0], ids[i][1])
      b.tri(ids[i][1], ids[i + 1][0], ids[i + 1][1])
    }
  }
  return b.build()
}

/** crossed cards for a tall seed-head or flower clump */
function crossedCards(tile: number, w: number, h: number): BufferGeometry {
  const b = new Builder()
  const none = new Color(0, 0, 0)
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI
    const ax = new Vector3(Math.cos(a), 0, Math.sin(a))
    const n = new Vector3(-ax.z, 0.6, ax.x).normalize()
    const ids: number[] = []
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const p = ax.clone().multiplyScalar((u - 0.5) * w)
      p.y = v * h
      const [uu, vv] = tileUv(tile, u, v)
      ids.push(b.vertex(p, n, [v, k / 3, 0.55 + 0.45 * v, 2], none, uu, vv))
    }
    b.tri(ids[0], ids[1], ids[2])
    b.tri(ids[0], ids[2], ids[3])
  }
  return b.build()
}

export type UnderKind = 'fern' | 'shrub' | 'sumac' | 'goldenrod' | 'aster'

export interface UnderInstance {
  kind: UnderKind
  x: number
  y: number
  z: number
  rot: number
  scale: number
  color: Color
  sun: number
}

/** Shared geometry + material for the undergrowth; builds one instanced mesh per kind per chunk. */
export class UndergrowthKit {
  private geos: Record<UnderKind, BufferGeometry>
  /** nominal heights the geometry was authored at (for wind bending) */
  private heights: Record<UnderKind, number> = { fern: 0.6, shrub: 1.8, sumac: 2.4, goldenrod: 1.0, aster: 0.7 }

  constructor(private material: Material, private depth: Material) {
    this.geos = {
      fern: fernClump(7),
      shrub: growTree(shrubParams('maple', 1.8), 31).build(),
      sumac: growTree(shrubParams('sumac', 2.4), 57).build(),
      goldenrod: crossedCards(TILE.goldenrod, 0.75, 1.0),
      aster: crossedCards(TILE.aster, 0.7, 0.7),
    }
  }

  meshes(list: UnderInstance[]): InstancedMesh[] {
    const out: InstancedMesh[] = []
    const kinds: UnderKind[] = ['fern', 'shrub', 'sumac', 'goldenrod', 'aster']
    const m4 = new Matrix4()
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    for (const k of kinds) {
      const items = list.filter((i) => i.kind === k)
      if (!items.length) continue
      const geo = this.geos[k].clone()
      const tint = new Float32Array(items.length * 3)
      const seed = new Float32Array(items.length * 2)
      const site = new Float32Array(items.length * 2)
      const mesh = new InstancedMesh(geo, this.material, items.length)
      items.forEach((it, i) => {
        q.setFromAxisAngle(up, it.rot)
        m4.compose(new Vector3(it.x, it.y, it.z), q, new Vector3(it.scale, it.scale, it.scale))
        mesh.setMatrixAt(i, m4)
        tint[i * 3] = it.color.r
        tint[i * 3 + 1] = it.color.g
        tint[i * 3 + 2] = it.color.b
        seed[i * 2] = it.rot * 3.7
        seed[i * 2 + 1] = this.heights[k] * it.scale
        site[i * 2] = 1
        site[i * 2 + 1] = it.sun
      })
      geo.setAttribute('aTint', new InstancedBufferAttribute(tint, 3))
      geo.setAttribute('aSeed', new InstancedBufferAttribute(seed, 2))
      geo.setAttribute('aSite', new InstancedBufferAttribute(site, 2))
      mesh.customDepthMaterial = this.depth
      mesh.castShadow = k === 'shrub' || k === 'sumac'
      mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      mesh.frustumCulled = true
      mesh.name = `under-${k}`
      out.push(mesh)
    }
    return out
  }
}
