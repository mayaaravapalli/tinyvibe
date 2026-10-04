import { Color, IcosahedronGeometry, Quaternion, Vector3 } from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { mulberry32, smoothstep } from '../core/noise'
import { TILE, tileUv } from '../render/leafTexture'
import { Builder } from './geoBuilder'

/**
 * Grown trees: a trunk with a flared base, limbs, branches and twigs that reach
 * out to fill the species' crown envelope, with clusters of leaf cards on the
 * twigs. Used for the trees you drive past (and, coarser, for the middle
 * distance) and for roadside shrubs.
 */
export interface GrowParams {
  height: number
  crownBase: number // fraction of height where the crown starts
  crownHeight: number // fraction of height
  crownRadius: number // fraction of height
  stems: number
  stemLean: number // radians
  trunkFrac: number // how far up the main stem continues
  trunkRadius: number // fraction of height
  flare: number // extra radius at the root
  limbs: number
  limbAngle: [number, number] // from vertical: top, bottom
  children: number[] // per depth >= 1
  childAngle: number[] // per depth >= 1
  lenRatio: number[] // child length as fraction of remaining room
  gnarl: number
  droop: number
  maxDepth: number
  tile: number
  cardSize: number // fraction of height
  cardsTip: number
  cardsPerMetre: number
  sides: number[] // tube sides per depth
  segs: number[] // tube segments per depth
  core: number // inner shade blob radius as a fraction of the crown (0 = none)
  bark: Color
}

const UP = new Vector3(0, 1, 0)

export function speciesParams(id: string, lod: 'near' | 'mid', bark: string, height: number, rnd: () => number): GrowParams {
  const near = lod === 'near'
  const base: GrowParams = {
    height,
    crownBase: 0.26,
    crownHeight: 0.74,
    crownRadius: 0.33,
    stems: 1,
    stemLean: 0.05,
    trunkFrac: 0.56,
    trunkRadius: 0.021,
    flare: 1.7,
    limbs: near ? 7 : 6,
    limbAngle: [0.35, 1.05],
    children: near ? [4, 4] : [3],
    childAngle: [0.75, 0.85],
    lenRatio: [0.62, 0.5],
    gnarl: 0.16,
    droop: 0,
    maxDepth: near ? 3 : 2,
    tile: TILE.maple,
    cardSize: near ? 0.075 : 0.13,
    cardsTip: near ? 3 : 4,
    cardsPerMetre: near ? 1.25 : 0.95,
    sides: near ? [9, 6, 4, 3] : [6, 4, 3],
    segs: near ? [7, 4, 3, 1] : [3, 2, 1],
    core: 0,
    bark: new Color(bark),
  }
  switch (id) {
    case 'redMaple':
      return { ...base, crownRadius: 0.27, crownBase: 0.28, crownHeight: 0.72, limbAngle: [0.28, 0.85], trunkFrac: 0.6 }
    case 'birch': {
      const stems = rnd() < 0.5 ? 1 : rnd() < 0.7 ? 2 : 3
      return {
        ...base,
        stems,
        stemLean: stems > 1 ? 0.2 : 0.06,
        crownBase: 0.34,
        crownHeight: 0.66,
        crownRadius: 0.21,
        trunkFrac: 0.82,
        trunkRadius: 0.013,
        flare: 1.35,
        limbs: near ? 10 : 7,
        limbAngle: [0.45, 1.15],
        children: near ? [3, 4] : [3],
        lenRatio: [0.55, 0.55],
        droop: 0.55,
        tile: TILE.birch,
        cardSize: near ? 0.068 : 0.11,
      }
    }
    case 'oak':
      return {
        ...base,
        crownBase: 0.3,
        crownHeight: 0.62,
        crownRadius: 0.42,
        trunkFrac: 0.42,
        trunkRadius: 0.027,
        limbs: near ? 6 : 5,
        limbAngle: [0.6, 1.3],
        gnarl: 0.34,
        tile: TILE.oak,
      }
    default:
      return base
  }
}

export function shrubParams(kind: 'maple' | 'sumac', height: number): GrowParams {
  if (kind === 'sumac') {
    return {
      height,
      crownBase: 0.35,
      crownHeight: 0.65,
      crownRadius: 0.38,
      stems: 4,
      stemLean: 0.35,
      trunkFrac: 0.85,
      trunkRadius: 0.018,
      flare: 1.1,
      limbs: 3,
      limbAngle: [0.5, 1.0],
      children: [],
      childAngle: [],
      lenRatio: [0.7],
      gnarl: 0.2,
      droop: 0.2,
      maxDepth: 1,
      tile: TILE.sumac,
      cardSize: 0.42,
      cardsTip: 2,
      cardsPerMetre: 0,
      sides: [4, 3],
      segs: [3, 1],
      core: 0,
      bark: new Color('#5b4636'),
    }
  }
  return {
    height,
    crownBase: 0.15,
    crownHeight: 0.85,
    crownRadius: 0.45,
    stems: 5,
    stemLean: 0.42,
    trunkFrac: 0.8,
    trunkRadius: 0.012,
    flare: 1.1,
    limbs: 3,
    limbAngle: [0.5, 1.1],
    children: [3],
    childAngle: [0.8],
    lenRatio: [0.65, 0.6],
    gnarl: 0.25,
    droop: 0.1,
    maxDepth: 2,
    tile: TILE.maple,
    cardSize: 0.2,
    cardsTip: 2,
    cardsPerMetre: 1.2,
    sides: [4, 3, 3],
    segs: [2, 1, 1],
    core: 0,
    bark: new Color('#4a3a2e'),
  }
}

interface Crown {
  c: Vector3
  r: Vector3
}

/** distance along a ray from inside the crown to its surface */
function exitDistance(o: Vector3, d: Vector3, cr: Crown): number {
  const ox = (o.x - cr.c.x) / cr.r.x, oy = (o.y - cr.c.y) / cr.r.y, oz = (o.z - cr.c.z) / cr.r.z
  const dx = d.x / cr.r.x, dy = d.y / cr.r.y, dz = d.z / cr.r.z
  const a = dx * dx + dy * dy + dz * dz
  const b = 2 * (ox * dx + oy * dy + oz * dz)
  const c = ox * ox + oy * oy + oz * oz - 1
  const disc = b * b - 4 * a * c
  if (disc < 0) return 0.5
  return Math.max(0.3, (-b + Math.sqrt(disc)) / (2 * a))
}

function insideness(p: Vector3, cr: Crown): number {
  const x = (p.x - cr.c.x) / cr.r.x, y = (p.y - cr.c.y) / cr.r.y, z = (p.z - cr.c.z) / cr.r.z
  return Math.sqrt(x * x + y * y + z * z)
}

function envelopeNormal(p: Vector3, cr: Crown, out: Vector3): Vector3 {
  return out
    .set((p.x - cr.c.x) / (cr.r.x * cr.r.x), (p.y - cr.c.y) / (cr.r.y * cr.r.y), (p.z - cr.c.z) / (cr.r.z * cr.r.z))
    .normalize()
}

const _q = new Quaternion()

/** rotate `dir` away by `angle`, around an axis at azimuth `az` about `dir` */
function deflect(dir: Vector3, angle: number, az: number, out: Vector3): Vector3 {
  const ref = Math.abs(dir.y) > 0.95 ? new Vector3(1, 0, 0) : UP
  const side = new Vector3().crossVectors(dir, ref).normalize()
  _q.setFromAxisAngle(dir, az)
  side.applyQuaternion(_q)
  _q.setFromAxisAngle(side, angle)
  return out.copy(dir).applyQuaternion(_q).normalize()
}

export function growTree(p: GrowParams, seed: number, b: Builder = new Builder()): Builder {
  const rnd = mulberry32(seed * 2654435761 + 97)
  const H = p.height
  const crown: Crown = {
    c: new Vector3((rnd() - 0.5) * 0.05 * H, H * (p.crownBase + p.crownHeight * 0.5), (rnd() - 0.5) * 0.05 * H),
    r: new Vector3(H * p.crownRadius * (0.9 + rnd() * 0.2), H * p.crownHeight * 0.5, H * p.crownRadius * (0.9 + rnd() * 0.2)),
  }
  const tmpN = new Vector3()
  const leafCol = new Color(0, 0, 0)

  const occlusion = (pt: Vector3) => {
    const ins = insideness(pt, crown)
    const hy = Math.min(1, Math.max(0, pt.y / H))
    return Math.min(1, 0.3 + 0.55 * smoothstep(0.15, 1.0, ins) + 0.25 * hy)
  }

  // ------------------------------------------------ leaf cards
  const card = (center: Vector3, size: number, clusterRnd: number) => {
    // face: random, leaning outward and a little up so clusters read from outside
    const out = envelopeNormal(center, crown, new Vector3())
    const face = new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(1.1).add(out).addScaledVector(UP, 0.25).normalize()
    const t1 = Math.abs(face.y) > 0.9 ? new Vector3(1, 0, 0) : UP.clone()
    t1.cross(face).normalize()
    const t2 = new Vector3().crossVectors(face, t1).normalize()
    const rot = rnd() * Math.PI * 2
    const u = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot))
    const v = t2.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t1, -Math.sin(rot))
    const ao = occlusion(center)
    const ids: number[] = []
    for (const [cu, cv] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const pt = center.clone().addScaledVector(u, cu * size).addScaledVector(v, cv * size)
      // shading normal: mostly the crown's soft volume, a little of the card
      envelopeNormal(pt, crown, tmpN).multiplyScalar(0.65).addScaledVector(face, 0.35).normalize()
      const [uu, vv] = tileUv(p.tile, cu + 0.5, cv + 0.5)
      ids.push(b.vertex(pt, tmpN, [Math.max(0, pt.y / H), clusterRnd, ao, 2], leafCol, uu, vv))
    }
    b.tri(ids[0], ids[1], ids[2])
    b.tri(ids[0], ids[2], ids[3])
  }

  const cluster = (at: Vector3, count: number, scale = 1) => {
    const r = rnd()
    for (let k = 0; k < count; k++) {
      const s = p.cardSize * H * (0.8 + rnd() * 0.45) * scale
      const c = at.clone().add(new Vector3(rnd() - 0.5, (rnd() - 0.4) * 0.8, rnd() - 0.5).multiplyScalar(s * 0.55))
      card(c, s, r)
    }
  }

  // ------------------------------------------------ branches as tubes
  const tube = (pts: Vector3[], radii: number[], sides: number, rand: number) => {
    const n = pts.length
    const T: Vector3[] = []
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)]
      T.push(new Vector3().subVectors(c, a).normalize())
    }
    let N = Math.abs(T[0].y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)
    N = new Vector3().crossVectors(T[0], N).normalize()
    const rings: number[][] = []
    for (let i = 0; i < n; i++) {
      // parallel transport keeps the rings from twisting
      N.addScaledVector(T[i], -N.dot(T[i])).normalize()
      const B = new Vector3().crossVectors(T[i], N).normalize()
      const ring: number[] = []
      const ao = occlusion(pts[i]) * 0.9
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2
        const dir = N.clone().multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a))
        const pt = pts[i].clone().addScaledVector(dir, radii[i])
        ring.push(b.vertex(pt, dir, [Math.max(0, pt.y / H), rand, ao, 0], p.bark, s / sides, i))
      }
      rings.push(ring)
    }
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = rings[i][s], c = rings[i][s + 1], d = rings[i + 1][s], e = rings[i + 1][s + 1]
        b.tri(a, d, c)
        b.tri(c, d, e)
      }
    }
  }

  const grow = (start: Vector3, dir0: Vector3, len: number, r0: number, depth: number, rEnd: number) => {
    const segs = Math.max(1, p.segs[Math.min(depth, p.segs.length - 1)])
    const pts: Vector3[] = [start.clone()]
    const radii: number[] = [r0]
    const dir = dir0.clone()
    const step = len / segs
    const wobble = new Vector3()
    for (let i = 1; i <= segs; i++) {
      wobble.set(rnd() - 0.5, (rnd() - 0.5) * 0.6, rnd() - 0.5).multiplyScalar(p.gnarl * (depth === 0 ? 0.5 : 1))
      dir.add(wobble)
      // reach for the light; slender twigs sag under their leaves
      const t = depth / Math.max(1, p.maxDepth)
      dir.addScaledVector(UP, 0.05 * (1 - t) - p.droop * t * t * 0.35)
      dir.normalize()
      pts.push(pts[i - 1].clone().addScaledVector(dir, step))
      const f = i / segs
      radii.push(r0 + (rEnd - r0) * f)
    }
    if (depth === 0 && p.flare > 1) {
      // root flare: the trunk swells as it meets the ground
      radii[0] *= p.flare
      if (radii.length > 2) radii[1] *= 1 + (p.flare - 1) * 0.25
    }
    tube(pts, radii, p.sides[Math.min(depth, p.sides.length - 1)], rnd())

    // children
    const at = (t: number, out: Vector3) => {
      const f = t * segs
      const i = Math.min(segs - 1, Math.floor(f))
      return out.copy(pts[i]).lerp(pts[i + 1], f - i)
    }
    const radAt = (t: number) => r0 + (rEnd - r0) * t
    if (depth < p.maxDepth) {
      const count = depth === 0 ? p.limbs : p.children[depth - 1] ?? 0
      const t0 = depth === 0 ? Math.max(0.05, (p.crownBase * H) / Math.max(len, 1e-3)) : depth === 1 ? 0.3 : 0.25
      const golden = Math.PI * (3 - Math.sqrt(5))
      const az0 = rnd() * Math.PI * 2
      for (let k = 0; k < count; k++) {
        const u = count === 1 ? 0.7 : k / (count - 1)
        const t = Math.min(0.97, t0 + (0.97 - t0) * u + (rnd() - 0.5) * 0.06)
        const pt = at(t, new Vector3())
        const cdir = new Vector3()
        if (depth === 0) {
          // limbs: low ones spread, high ones climb
          const ang = p.limbAngle[1] + (p.limbAngle[0] - p.limbAngle[1]) * u + (rnd() - 0.5) * 0.15
          const az = az0 + k * golden + (rnd() - 0.5) * 0.4
          cdir.set(Math.sin(ang) * Math.cos(az), Math.cos(ang), Math.sin(ang) * Math.sin(az)).normalize()
        } else {
          deflect(dir, p.childAngle[depth - 1] * (0.75 + rnd() * 0.5), az0 + k * golden, cdir)
          // drift outward to fill the crown rather than crowding the middle
          const outward = new Vector3(pt.x - crown.c.x, 0, pt.z - crown.c.z)
          if (outward.lengthSq() > 1e-4) cdir.addScaledVector(outward.normalize(), 0.3).normalize()
        }
        const room = exitDistance(pt, cdir, crown)
        const ratio = p.lenRatio[Math.min(depth, p.lenRatio.length - 1)]
        const clen = depth === 0 ? room * (0.82 + rnd() * 0.16) : Math.min(room * 0.95, len * (1 - t) * 1.1 + room * ratio * 0.4) * (0.75 + rnd() * 0.3)
        const cr0 = Math.max(H * 0.0016, radAt(t) * (depth === 0 ? 0.62 : 0.6))
        grow(pt, cdir, Math.max(0.4, clen), cr0, depth + 1, Math.max(H * 0.0008, cr0 * 0.25))
      }
    }
    // leaves on the outer branches
    if (p.cardsTip > 0 && depth >= p.maxDepth - (p.maxDepth >= 3 ? 1 : 0) && depth > 0) {
      const tip = pts[pts.length - 1]
      if (depth === p.maxDepth) cluster(tip, p.cardsTip)
      const along = Math.round(len * p.cardsPerMetre * (depth === p.maxDepth ? 1 : 0.4))
      for (let k = 0; k < along; k++) {
        const t = 0.35 + 0.6 * rnd()
        cluster(at(t, new Vector3()), 1, depth === p.maxDepth ? 0.9 : 1.1)
      }
    }
  }

  // stems from the ground
  for (let s = 0; s < p.stems; s++) {
    const az = (s / p.stems) * Math.PI * 2 + rnd() * 0.8
    const lean = p.stemLean * (p.stems > 1 ? 1 : rnd())
    const dir = new Vector3(Math.sin(lean) * Math.cos(az), Math.cos(lean), Math.sin(lean) * Math.sin(az)).normalize()
    const base = new Vector3(Math.cos(az), 0, Math.sin(az)).multiplyScalar(p.stems > 1 ? H * 0.012 : 0)
    base.y = -0.5
    const r0 = H * p.trunkRadius * (p.stems > 1 ? 0.8 : 1)
    grow(base, dir, H * p.trunkFrac, r0, 0, r0 * 0.4)
  }

  // the shaded inner mass of leaves
  if (p.core > 0) {
    const g = mergeVertices(new IcosahedronGeometry(1, 1))
    g.scale(crown.r.x * p.core, crown.r.y * p.core * 0.9, crown.r.z * p.core)
    g.translate(crown.c.x, crown.c.y + crown.r.y * 0.05, crown.c.z)
    g.computeVertexNormals()
    const cr = rnd()
    b.add(g, (_i, P) => [Math.max(0, P.y / H), cr, 0.26, 1], leafCol)
  }
  return b
}
