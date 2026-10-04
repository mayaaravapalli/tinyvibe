import { BufferAttribute, BufferGeometry, Color, IcosahedronGeometry, Vector3 } from 'three'
import { TILE, tileUv } from '../render/leafTexture'
import { growConifer, growTree, speciesParams } from './branchTree'
import { Builder } from './geoBuilder'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { mulberry32, Simplex2 } from '../core/noise'

/**
 * Procedural stylised trees. Every geometry is authored at a nominal height and
 * scaled per instance. Vertex attribute aFol:
 *   x = height fraction (sway weight), y = clump random, z = baked occlusion, w = 1 foliage / 0 bark
 */

export type SpeciesId = 'sugarMaple' | 'redMaple' | 'birch' | 'oak' | 'spruce' | 'pine'

export interface SpeciesDef {
  id: SpeciesId
  conifer: boolean
  /** nominal authored height in metres */
  height: number
  bark: string
}

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  sugarMaple: { id: 'sugarMaple', conifer: false, height: 19, bark: '#4a4038' },
  redMaple: { id: 'redMaple', conifer: false, height: 16, bark: '#5a524a' },
  birch: { id: 'birch', conifer: false, height: 16, bark: '#e4ddd0' },
  oak: { id: 'oak', conifer: false, height: 18, bark: '#3f3730' },
  spruce: { id: 'spruce', conifer: true, height: 19, bark: '#3a2e26' },
  pine: { id: 'pine', conifer: true, height: 24, bark: '#433528' },
}

export type Lod = 'near' | 'mid' | 'far' | 'shadow' | 'lump'

const noise = new Simplex2(4242)

function noise3(x: number, y: number, z: number): number {
  return (noise.noise(x + z * 0.7, y - z * 0.3) + noise.noise(y * 1.3 - 4.1, z * 1.1 + x * 0.2)) * 0.5
}

/** A tapered limb from a to b, with radius ra -> rb. */
function limb(a: Vector3, b: Vector3, ra: number, rb: number, sides: number, segs: number, bend: Vector3 | null): BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const axis = new Vector3().subVectors(b, a)
  const len = axis.length()
  axis.normalize()
  const up = Math.abs(axis.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)
  const u = new Vector3().crossVectors(axis, up).normalize()
  const v = new Vector3().crossVectors(axis, u).normalize()
  const c = new Vector3()
  for (let j = 0; j <= segs; j++) {
    const t = j / segs
    const r = ra + (rb - ra) * t
    c.copy(a).addScaledVector(axis, len * t)
    if (bend) c.addScaledVector(bend, Math.sin(t * Math.PI) * 1)
    for (let i = 0; i < sides; i++) {
      const ang = (i / sides) * Math.PI * 2
      const nx = u.x * Math.cos(ang) + v.x * Math.sin(ang)
      const ny = u.y * Math.cos(ang) + v.y * Math.sin(ang)
      const nz = u.z * Math.cos(ang) + v.z * Math.sin(ang)
      pos.push(c.x + nx * r, c.y + ny * r, c.z + nz * r)
      nor.push(nx, ny, nz)
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < sides; i++) {
      const a0 = j * sides + i
      const a1 = j * sides + ((i + 1) % sides)
      const b0 = a0 + sides
      const b1 = a1 + sides
      idx.push(a0, a1, b0, a1, b1, b0)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
  g.setIndex(idx)
  return g
}

const icoCache: Record<number, BufferGeometry> = {}
function icosphere(detail: number): BufferGeometry {
  if (!icoCache[detail]) {
    const g = new IcosahedronGeometry(1, detail)
    g.deleteAttribute('uv')
    icoCache[detail] = mergeVertices(g)
  }
  return icoCache[detail]
}

interface Crown {
  c: Vector3
  r: Vector3
}

/**
 * One foliage clump: a lumpy sphere whose normals are bent towards the crown's
 * envelope so the whole tree shades like a soft volume rather than balls.
 */
function clump(
  b: Builder,
  center: Vector3,
  radius: Vector3,
  detail: number,
  crown: Crown,
  height: number,
  seed: number,
  rnd: () => number,
  bumpAmp: number,
  flatten = 0,
) {
  const src = icosphere(detail)
  const g = src.clone()
  const p = g.getAttribute('position') as BufferAttribute
  const n = g.getAttribute('normal') as BufferAttribute
  const cr = rnd()
  const tmp = new Vector3()
  for (let i = 0; i < p.count; i++) {
    tmp.fromBufferAttribute(p, i).normalize()
    let d = 1 + bumpAmp * noise3(tmp.x * 1.7 + seed, tmp.y * 1.7 - seed * 0.3, tmp.z * 1.7 + seed * 0.7)
    d += bumpAmp * 0.5 * noise3(tmp.x * 4.1 - seed, tmp.y * 4.1, tmp.z * 4.1 + seed)
    // conifer / pine pads are flatter underneath
    if (flatten > 0 && tmp.y < 0) d *= 1 - flatten * -tmp.y
    const x = center.x + tmp.x * radius.x * d
    const y = center.y + tmp.y * radius.y * d
    const z = center.z + tmp.z * radius.z * d
    p.setXYZ(i, x, y, z)
    // crown envelope normal
    const ex = (x - crown.c.x) / (crown.r.x * crown.r.x)
    const ey = (y - crown.c.y) / (crown.r.y * crown.r.y)
    const ez = (z - crown.c.z) / (crown.r.z * crown.r.z)
    const el = Math.hypot(ex, ey, ez) || 1
    const w = 0.55
    const nx = tmp.x * (1 - w) + (ex / el) * w
    const ny = tmp.y * (1 - w) + (ey / el) * w
    const nz = tmp.z * (1 - w) + (ez / el) * w
    const nl = Math.hypot(nx, ny, nz) || 1
    n.setXYZ(i, nx / nl, ny / nl, nz / nl)
  }
  b.add(
    g,
    (_i, P, N) => {
      // occlusion: deeper inside / lower / facing inwards is darker
      const rx = (P.x - crown.c.x) / crown.r.x
      const ry = (P.y - crown.c.y) / crown.r.y
      const rz = (P.z - crown.c.z) / crown.r.z
      const depth = Math.min(1, Math.hypot(rx, ry, rz))
      const outward = (N.x * rx + N.y * ry + N.z * rz) / (depth || 1)
      let ao = 0.5 + 0.5 * Math.min(1, Math.max(0, (ry + 0.9) / 1.6))
      ao *= 0.55 + 0.45 * Math.min(1, Math.max(0, depth * 1.2 - 0.15))
      ao *= 0.7 + 0.3 * Math.max(0, Math.min(1, outward * 0.5 + 0.5))
      return [Math.max(0, P.y / height), cr, Math.max(0.18, Math.min(1, ao)), 1]
    },
    new Color(0, 0, 0),
  )
}

function barkLimb(b: Builder, geo: BufferGeometry, height: number, barkCol: Color, rnd: () => number) {
  const r = rnd()
  b.add(geo, (_i, P) => [Math.max(0, P.y / height), r, 0.55 + 0.45 * Math.min(1, P.y / (height * 0.5)), 0], barkCol)
}

/** Deciduous crown archetypes. */
function deciduous(def: SpeciesDef, lod: Lod, seed: number): BufferGeometry {
  const rnd = mulberry32(seed * 7919 + 13)
  const b = new Builder()
  const H = def.height
  const barkCol = new Color(def.bark)
  let crownBase: number, crownR: number, crownH: number, nClumps: number, clumpR: number
  switch (def.id) {
    case 'sugarMaple':
      crownBase = 0.28; crownR = 0.33; crownH = 0.72; nClumps = 9; clumpR = 0.42
      break
    case 'redMaple':
      crownBase = 0.3; crownR = 0.27; crownH = 0.7; nClumps = 8; clumpR = 0.43
      break
    case 'birch':
      crownBase = 0.36; crownR = 0.22; crownH = 0.64; nClumps = 8; clumpR = 0.4
      break
    default: // oak / beech: broad and spreading
      crownBase = 0.3; crownR = 0.4; crownH = 0.62; nClumps = 9; clumpR = 0.42
  }
  const crown: Crown = {
    c: new Vector3((rnd() - 0.5) * 0.06 * H, H * (crownBase + crownH * 0.5), (rnd() - 0.5) * 0.06 * H),
    r: new Vector3(H * crownR, H * crownH * 0.5, H * crownR * (0.88 + rnd() * 0.2)),
  }

  // trunk
  const trunkTop = new Vector3(crown.c.x * 0.6, H * (crownBase + crownH * 0.45), crown.c.z * 0.6)
  const sides = lod === 'near' ? 7 : 4
  const tr = H * (def.id === 'birch' ? 0.022 : 0.03)
  const lean = new Vector3((rnd() - 0.5) * 0.4, 0, (rnd() - 0.5) * 0.4)
  if (lod !== 'shadow' && lod !== 'lump') barkLimb(b, limb(new Vector3(0, -0.6, 0), trunkTop, tr, tr * 0.35, sides, lod === 'near' ? 4 : 1, lean), H, barkCol, rnd)

  // clump centres spread through the envelope (top-heavy, like a real crown)
  const centers: Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  const count = lod === 'lump' || lod === 'shadow' ? 1 : lod === 'far' ? 3 : nClumps
  if (count === 1) centers.push(crown.c.clone())
  for (let i = 0; i < count && count > 1; i++) {
    const t = (i + 0.5) / count
    const yN = 1 - t * 1.55 // from top towards lower-middle
    const rr = Math.sqrt(Math.max(0, 1 - yN * yN))
    const ang = i * golden + rnd() * 0.6
    const k = 0.62 + rnd() * 0.18
    centers.push(
      new Vector3(
        crown.c.x + Math.cos(ang) * rr * crown.r.x * k,
        crown.c.y + Math.max(-0.75, yN) * crown.r.y * 0.62,
        crown.c.z + Math.sin(ang) * rr * crown.r.z * k,
      ),
    )
  }
  if (lod !== 'shadow' && lod !== 'lump') {
    // main limbs reaching for the clumps (visible from the road)
    const limbs = lod === 'near' ? centers.length : 1
    for (let i = 0; i < limbs; i++) {
      const c = centers[centers.length - 1 - (i % centers.length)]
      const from = new Vector3(0, H * (crownBase + 0.03 + rnd() * 0.14), 0).lerp(trunkTop, 0.2 + rnd() * 0.2)
      const to = c.clone().lerp(crown.c, 0.2)
      const thick = lod === 'near' ? 0.45 : 0.4
      barkLimb(b, limb(from, to, tr * thick, tr * 0.1, lod === 'near' ? 5 : 3, lod === 'near' ? 2 : 1, null), H, barkCol, rnd)
      if (lod === 'near') {
        // a couple of twigs fanning out of each limb
        for (let k = 0; k < 2; k++) {
          const mid = from.clone().lerp(to, 0.55 + 0.3 * rnd())
          const tip = to.clone().add(new Vector3((rnd() - 0.5) * 4, (rnd() - 0.2) * 2.5, (rnd() - 0.5) * 4))
          barkLimb(b, limb(mid, tip, tr * 0.14, tr * 0.04, 3, 1, null), H, barkCol, rnd)
        }
      }
    }
  }
  const detail = lod === 'near' ? 1 : 0
  const bump = lod === 'near' ? 0.26 : lod === 'far' ? 0.2 : 0.12
  for (let i = 0; i < centers.length; i++) {
    const s = clumpR * (0.85 + rnd() * 0.35) * (lod === 'shadow' || lod === 'lump' ? 2.1 : lod === 'far' ? 1.36 : 1.0)
    const rad = new Vector3(crown.r.x * s, crown.r.y * s * 0.8, crown.r.z * s)
    clump(b, centers[i], rad, detail, crown, H, seed * 13 + i * 3.7, rnd, bump)
  }
  return b.build()
}

/**
 * Needle boughs radiating from the trunk: two crossed cards per bough, drooping
 * towards the tip, textured from the right half of the foliage atlas.
 */
function boughs(b: Builder, y0: number, R: number, count: number, H: number, droop: number, ao: number, rnd: () => number) {
  const cr = rnd()
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + rnd() * 0.5
    const len = R * (0.75 + 0.4 * rnd())
    const ux = Math.cos(a), uz = Math.sin(a)
    const inner = new Vector3(ux * R * 0.08, y0 + R * 0.12, uz * R * 0.08)
    const tip = new Vector3(ux * len, y0 - droop * (0.7 + 0.6 * rnd()), uz * len)
    const axis = tip.clone().sub(inner)
    const along = axis.clone().normalize()
    const side = new Vector3(-uz, 0, ux)
    const w = R * (0.5 + 0.2 * rnd())
    for (let cIdx = 0; cIdx < 2; cIdx++) {
      const tilt = cIdx === 0 ? 0.25 : 1.15
      const up = new Vector3().crossVectors(side, along).normalize()
      const across = side.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(up, Math.sin(tilt))
      const base = b.pos.length / 3
      const corners: [number, number][] = [[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]]
      for (const [cu, cv] of corners) {
        const p = inner.clone().addScaledVector(axis, cu).addScaledVector(across, cv * w * (1 - 0.35 * cu))
        // droop the outer half a little more
        p.y -= cu * cu * droop * 0.3
        b.pos.push(p.x, p.y, p.z)
        const n = new Vector3(ux, 0.85, uz).normalize()
        b.nor.push(n.x, n.y, n.z)
        b.fol.push(Math.max(0, p.y / H), cr, Math.min(1, ao * (0.75 + 0.35 * cu)), 2)
        b.bark.push(0, 0, 0)
        const [uu, vv] = tileUv(TILE.needles, cu, cv + 0.5)
        b.uv.push(uu, vv)
      }
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
}

/** Spruce / hemlock: drooping layered tiers, not a smooth cone. */
function spruce(def: SpeciesDef, lod: Lod, seed: number): BufferGeometry {
  const rnd = mulberry32(seed * 104729 + 7)
  const b = new Builder()
  const H = def.height
  const barkCol = new Color(def.bark)
  const sides = lod === 'near' ? 6 : 4
  if (lod !== 'shadow' && lod !== 'lump') barkLimb(b, limb(new Vector3(0, -0.6, 0), new Vector3(0, H * 0.92, 0), H * 0.024, H * 0.004, sides, lod === 'near' ? 3 : 1, null), H, barkCol, rnd)
  const tiers = lod === 'lump' ? 1 : lod === 'shadow' ? 2 : lod === 'far' ? 3 : lod === 'mid' ? 6 : 10
  const base = H * 0.12
  const crown: Crown = { c: new Vector3(0, H * 0.48, 0), r: new Vector3(H * 0.2, H * 0.5, H * 0.2) }
  const rim = lod === 'near' ? 11 : 8
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers
    const y0 = base + (H - base) * f * 0.92
    const tierH = ((H - base) / tiers) * (1.9 - f * 0.4)
    const R = H * 0.2 * Math.pow(1 - f, 0.95) * (0.9 + rnd() * 0.2) + H * 0.015
    // skirt: apex + jagged drooping rim + an underside
    const pos: number[] = []
    const nor: number[] = []
    const idx: number[] = []
    pos.push(0, y0 + tierH, 0)
    nor.push(0, 1, 0)
    for (let i = 0; i < rim; i++) {
      const a = (i / rim) * Math.PI * 2 + rnd() * 0.25
      const jag = 0.78 + 0.32 * rnd()
      const rr = R * jag
      const droop = R * (0.12 + 0.12 * rnd())
      pos.push(Math.cos(a) * rr, y0 - droop, Math.sin(a) * rr)
      const ny = 0.55
      const l = Math.hypot(1, ny)
      nor.push((Math.cos(a) * 1) / l, ny / l, (Math.sin(a) * 1) / l)
    }
    // underside centre
    pos.push(0, y0 + tierH * 0.22, 0)
    nor.push(0, -1, 0)
    const uc = rim + 1
    for (let i = 0; i < rim; i++) {
      const a = 1 + i
      const c = 1 + ((i + 1) % rim)
      idx.push(0, c, a)
      idx.push(uc, a, c)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
    g.setIndex(idx)
    const cr = rnd()
    const nearDim = lod === 'near' || lod === 'mid' ? 0.7 : 1
    if (lod === 'near') g.scale(0.62, 1, 0.62)
    if (lod === 'mid') g.scale(0.75, 1, 0.75)
    b.add(
      g,
      (i, P) => {
        const under = i === uc ? 0.35 : 1
        const ao = (0.45 + 0.55 * f) * under * (i === 0 ? 1.05 : 0.9) * nearDim
        return [Math.max(0, P.y / H), cr, Math.min(1, ao), 1]
      },
      new Color(0, 0, 0),
    )
    if (lod === 'near') boughs(b, y0 + tierH * 0.35, R * 1.05, 11, H, R * 0.28, 0.5 + 0.5 * f, rnd)
    if (lod === 'mid') boughs(b, y0 + tierH * 0.35, R * 1.1, 6, H, R * 0.28, 0.5 + 0.5 * f, rnd)
  }
  void crown
  return b.build()
}

/** Eastern white pine: tall, open, irregular horizontal pads. */
function pine(def: SpeciesDef, lod: Lod, seed: number): BufferGeometry {
  const rnd = mulberry32(seed * 7907 + 3)
  const b = new Builder()
  const H = def.height
  const barkCol = new Color(def.bark)
  const sides = lod === 'near' ? 6 : 4
  const top = new Vector3((rnd() - 0.5) * 1.2, H * 0.93, (rnd() - 0.5) * 1.2)
  if (lod !== 'shadow' && lod !== 'lump') barkLimb(b, limb(new Vector3(0, -0.6, 0), top, H * 0.022, H * 0.006, sides, lod === 'near' ? 3 : 1, null), H, barkCol, rnd)
  const crown: Crown = { c: new Vector3(0, H * 0.66, 0), r: new Vector3(H * 0.22, H * 0.34, H * 0.22) }
  const pads = lod === 'shadow' || lod === 'lump' ? 2 : lod === 'far' ? 3 : lod === 'mid' ? 6 : 10
  for (let i = 0; i < pads; i++) {
    const f = i / pads
    const y = H * (0.42 + 0.5 * f)
    const ang = rnd() * Math.PI * 2
    const off = H * (0.05 + 0.12 * (1 - f)) * (0.5 + rnd() * 0.6)
    const c = new Vector3(Math.cos(ang) * off, y, Math.sin(ang) * off).lerp(top, f * 0.3)
    const rr = H * (0.12 + 0.08 * (1 - f)) * (0.8 + rnd() * 0.4)
    if (lod !== 'shadow' && lod !== 'lump' && f < 0.75) {
      barkLimb(b, limb(new Vector3(top.x * f, y - 0.4, top.z * f), c, H * 0.006, H * 0.002, 3, 1, null), H, barkCol, rnd)
    }
    const padR = new Vector3(rr * 1.25, rr * 0.42, rr * 1.15)
    if (lod === 'near' || lod === 'mid') {
      const before = b.fol.length
      clump(b, c, padR.clone().multiplyScalar(lod === 'near' ? 0.45 : 0.6), lod === 'near' ? 1 : 0, crown, H, seed * 31 + i, rnd, 0.26, 0.4)
      for (let k = before + 2; k < b.fol.length; k += 4) b.fol[k] *= 0.8
      // soft long-needle sprays fanning out of each pad
      const sub = new Builder()
      boughs(sub, 0, rr * 1.5, lod === 'near' ? 13 : 8, H, rr * 0.16, 0.9, rnd)
      for (let k = 0; k < sub.pos.length; k += 3) {
        b.pos.push(sub.pos[k] + c.x, sub.pos[k + 1] + c.y, sub.pos[k + 2] + c.z)
        b.nor.push(sub.nor[k], sub.nor[k + 1], sub.nor[k + 2])
        b.bark.push(0, 0, 0)
      }
      const base = b.uv.length / 2
      for (let k = 0; k < sub.fol.length; k += 4) b.fol.push(Math.max(0, (sub.pos[(k / 4) * 3 + 1] + c.y) / H), sub.fol[k + 1], sub.fol[k + 2], 2)
      b.uv.push(...sub.uv)
      for (const ix of sub.idx) b.idx.push(base + ix)
    } else {
      clump(b, c, padR, 0, crown, H, seed * 31 + i, rnd, 0.26, 0.4)
    }
  }
  return b.build()
}

export function buildTreeGeometry(id: SpeciesId, lod: Lod, seed: number): BufferGeometry {
  const def = SPECIES[id]
  if (def.conifer && (lod === 'near' || lod === 'mid')) {
    return growConifer(id === 'spruce' ? 'spruce' : 'pine', lod, def.height, def.bark, seed).build()
  }
  if (!def.conifer && (lod === 'near' || lod === 'mid')) {
    const rnd = mulberry32(seed * 7 + 3)
    return growTree(speciesParams(id, lod, def.bark, def.height, rnd), seed).build()
  }
  if (id === 'spruce') return spruce(def, lod, seed)
  if (id === 'pine') return pine(def, lod, seed)
  return deciduous(def, lod, seed)
}
