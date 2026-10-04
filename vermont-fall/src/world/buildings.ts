import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Shape,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../core/noise'
import { patchMaterial } from '../render/shared'
import { BARN, CHURCH, HOUSES, SILO, type HouseSpec } from './layout'
import type { Terrain } from './terrain'

const SRGB = 'vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }'

/** Shared building materials (one program each). */
function materials() {
  const clap = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bld-clapboard',
    cloudShadows: true,
    fragmentPars: SRGB,
    fragmentColor: /* glsl */ `
      {
        // white clapboard: a soft shadow line under every board
        float k = fract(vAtmoWorld.y / 0.16);
        float line = smoothstep(0.0, 0.18, k) * (0.86 + 0.14 * smoothstep(0.18, 1.0, k));
        float fw = fwidth(vAtmoWorld.y / 0.16);
        line = mix(line, 0.93, smoothstep(0.3, 0.8, fw));
        vec3 c = srgb(0.93, 0.91, 0.86) * line;
        c *= 0.94 + 0.06 * vfNoise(vAtmoWorld.xz * 1.3 + vAtmoWorld.y);
        diffuseColor.rgb = c;
      }
    `,
  })
  const red = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bld-barnred',
    cloudShadows: true,
    vertexPars: 'varying vec3 vBN2;',
    vertexBegin: 'vBN2 = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);',
    fragmentPars: 'varying vec3 vBN2;\n' + SRGB,
    fragmentColor: /* glsl */ `
      {
        // vertical barn boards, weathered and sun-faded
        vec2 h = vec2(vBN2.z, -vBN2.x);
        float along = dot(vAtmoWorld.xz, normalize(h + 1e-4));
        float board = floor(along / 0.3);
        float tone = vfHash12(vec2(board, 2.0));
        float seam = smoothstep(0.0, 0.06, fract(along / 0.3));
        float fw = fwidth(along / 0.3);
        seam = mix(seam, 0.95, smoothstep(0.3, 0.8, fw));
        vec3 c = mix(srgb(0.58, 0.15, 0.10), srgb(0.49, 0.12, 0.09), tone) * (0.78 + 0.22 * seam);
        c *= 0.86 + 0.2 * vfFbm(vAtmoWorld.xy * vec2(0.8, 2.0) + vAtmoWorld.z);
        diffuseColor.rgb = c;
      }
    `,
  })
  const roof = (key: string, a: string, b: string) =>
    patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
      key,
      cloudShadows: true,
      fragmentPars: SRGB,
      fragmentColor: /* glsl */ `
        {
          float row = floor(vAtmoWorld.y / 0.22);
          float sh = vfHash12(vec2(floor(dot(vAtmoWorld.xz, vec2(0.7071)) / 0.35 + row * 0.5), row));
          vec3 c = mix(${a}, ${b}, sh);
          float fw = fwidth(vAtmoWorld.y / 0.22);
          c *= mix(0.78 + 0.22 * smoothstep(0.0, 0.15, fract(vAtmoWorld.y / 0.22)), 0.92, smoothstep(0.3, 0.8, fw));
          diffuseColor.rgb = c;
        }
      `,
    })
  const plain = (key: string, hex: string) => patchMaterial(new MeshLambertMaterial({ color: new Color(hex) }), { key, cloudShadows: true })
  return {
    clap,
    red,
    slate: roof('bld-roof-slate', 'srgb(0.22, 0.23, 0.25)', 'srgb(0.30, 0.31, 0.32)'),
    metal: roof('bld-roof-metal', 'srgb(0.46, 0.48, 0.50)', 'srgb(0.52, 0.54, 0.55)'),
    rust: roof('bld-roof-rust', 'srgb(0.36, 0.17, 0.12)', 'srgb(0.42, 0.22, 0.15)'),
    trim: plain('bld-trim', '#efeae0'),
    glass: patchMaterial(new MeshLambertMaterial({ color: new Color('#1c2226'), emissive: new Color('#000000') }), { key: 'bld-glass', cloudShadows: true }),
    shutter: plain('bld-shutter', '#1f2522'),
    door: plain('bld-door', '#7c1e1a'),
    brick: plain('bld-brick', '#7d3a2c'),
    stone: plain('bld-stone', '#7f7a72'),
    concrete: plain('bld-concrete', '#b9b4a8'),
    dark: plain('bld-dark', '#231c17'),
  }
}

type Mats = ReturnType<typeof materials>

/** Accumulates transformed geometry per material, then emits one mesh per material. */
class Builder {
  private byMat = new Map<Material, BufferGeometry[]>()
  add(g: BufferGeometry, mat: Material, m: Matrix4) {
    g = g.index ? g.toNonIndexed() : g
    g.applyMatrix4(m)
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n)
    const list = this.byMat.get(mat) ?? []
    list.push(g)
    this.byMat.set(mat, list)
  }
  box(w: number, h: number, d: number, mat: Material, base: Matrix4, x: number, y: number, z: number, ry = 0) {
    const m = new Matrix4().makeRotationY(ry).setPosition(x, y, z)
    this.add(new BoxGeometry(w, h, d), mat, base.clone().multiply(m))
  }
  emit(group: Group) {
    for (const [mat, list] of this.byMat) {
      const g = mergeGeometries(list, false)!
      g.computeBoundingSphere()
      const mesh = new Mesh(g, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }
}

/** A gabled prism: footprint w (x) by d (z), wall height h, ridge rise r. */
function gablePrism(w: number, h: number, d: number, r: number): BufferGeometry {
  const s = new Shape()
  s.moveTo(-w / 2, 0)
  s.lineTo(w / 2, 0)
  s.lineTo(w / 2, h)
  s.lineTo(0, h + r)
  s.lineTo(-w / 2, h)
  s.closePath()
  const g = new ExtrudeGeometry(s, { depth: d, bevelEnabled: false })
  g.translate(0, 0, -d / 2)
  return g
}

function gambrelPrism(w: number, h: number, d: number): BufferGeometry {
  const s = new Shape()
  s.moveTo(-w / 2, 0)
  s.lineTo(w / 2, 0)
  s.lineTo(w / 2, h)
  s.lineTo(w * 0.33, h + w * 0.26)
  s.lineTo(0, h + w * 0.36)
  s.lineTo(-w * 0.33, h + w * 0.26)
  s.lineTo(-w / 2, h)
  s.closePath()
  const g = new ExtrudeGeometry(s, { depth: d, bevelEnabled: false })
  g.translate(0, 0, -d / 2)
  return g
}

/** Roof slabs over a symmetric gable (with overhang). */
function gableRoof(B: Builder, mat: Material, base: Matrix4, w: number, h: number, d: number, r: number, over = 0.45) {
  const half = w / 2 + over
  const len = Math.hypot(half, r * (half / (w / 2)))
  const ang = Math.atan2(r, w / 2)
  for (const side of [-1, 1]) {
    const m = new Matrix4()
      .makeRotationZ(-side * ang)
      .setPosition(side * (half / 2 - over * 0.05) * Math.cos(ang) * 0.98, h + r / 2 + 0.12 - (over * Math.sin(ang)) / 2, 0)
    B.add(new BoxGeometry(len, 0.16, d + over * 2), mat, base.clone().multiply(m))
  }
}

export interface Chimney {
  pos: Vector3
}

export interface BuildingsBuild {
  group: Group
  chimneys: Chimney[]
  /** footprints (x, z, radius) so props and trees keep clear */
  footprints: { x: number; z: number; r: number }[]
  mailboxes: { x: number; z: number; rot: number }[]
}

function faceRoadAngle(T: Terrain, x: number, z: number): { rot: number; roadX: number; roadZ: number; side: number } {
  const hit = { d: 0, s: 0, lat: 0 }
  T.roadNearest(x, z, 200, hit)
  const p = { x: 0, z: 0, tx: 0, tz: 0 }
  T.road.sample(hit.s, p)
  // the front (+z local) looks at the road
  const dx = p.x - x, dz = p.z - z
  return { rot: Math.atan2(dx, dz), roadX: p.x, roadZ: p.z, side: hit.lat > 0 ? 1 : -1 }
}

function house(B: Builder, M: Mats, T: Terrain, spec: HouseSpec, out: BuildingsBuild, rnd: () => number) {
  const [x, z] = spec.pos
  const kind = spec.kind ?? 'cape'
  const face = spec.faceRoad ? faceRoadAngle(T, x, z) : null
  const rot = face ? face.rot : spec.rot ?? 0
  const y = Math.min(T.heightAt(x - 4, z), T.heightAt(x + 4, z), T.heightAt(x, z - 4), T.heightAt(x, z + 4))
  const base = new Matrix4().makeRotationY(rot).setPosition(x, y, z)
  const dims = kind === 'colonial' ? { w: 11, h: 6.2, d: 8.5, r: 3.4 } : kind === 'farmhouse' ? { w: 9.5, h: 5.6, d: 7.5, r: 3.6 } : { w: 10, h: 3.6, d: 7.5, r: 3.4 }
  const { w, h, d, r } = dims
  // granite foundation absorbs the slope
  B.box(w + 0.3, 1.6, d + 0.3, M.stone, base, 0, -0.5, 0)
  // ridge runs along x (gable ends left/right), front facade faces +z
  const body = gablePrism(d, h, w, r)
  B.add(body, M.clap, base.clone().multiply(new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0.3, 0)))
  // roof: along x
  const roofBase = base.clone().multiply(new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0.3, 0))
  gableRoof(B, kind === 'farmhouse' ? M.metal : M.slate, roofBase, d, h, w, r)
  // windows with black shutters on the front and back
  const rows = kind === 'cape' ? 1 : 2
  const cols = kind === 'cape' ? 4 : 5
  for (const fz of [1, -1]) {
    for (let rI = 0; rI < rows; rI++) {
      for (let c = 0; c < cols; c++) {
        const wx = -w / 2 + (w / cols) * (c + 0.5)
        if (fz === 1 && rI === 0 && c === Math.floor(cols / 2)) continue // door
        const wy = 1.25 + rI * 2.5
        const zz = fz * (d / 2 + 0.03)
        B.box(0.95, 1.45, 0.08, M.trim, base, wx, wy + 0.3, zz)
        B.box(0.75, 1.25, 0.1, M.glass, base, wx, wy + 0.3, zz + fz * 0.02)
        for (const sx of [-1, 1]) B.box(0.38, 1.4, 0.06, M.shutter, base, wx + sx * 0.7, wy + 0.3, zz + fz * 0.04)
      }
    }
  }
  // front door + little portico
  const dxDoor = -w / 2 + (w / cols) * (Math.floor(cols / 2) + 0.5)
  B.box(1.0, 2.1, 0.12, M.door, base, dxDoor, 1.35, d / 2 + 0.05)
  B.box(1.5, 0.12, 0.9, M.trim, base, dxDoor, 2.6, d / 2 + 0.45)
  B.box(1.6, 0.25, 1.0, M.stone, base, dxDoor, 0.42, d / 2 + 0.6)
  // corner boards
  for (const cx of [-1, 1]) for (const cz of [-1, 1]) B.box(0.18, h, 0.18, M.trim, base, cx * (w / 2), h / 2 + 0.3, cz * (d / 2))
  // chimney on the ridge
  const chx = kind === 'cape' ? 0 : w * 0.3 * (rnd() > 0.5 ? 1 : -1)
  B.box(0.85, 2.6, 0.85, M.brick, base, chx, h + r - 0.2 + 1.0, 0)
  const cp = new Vector3(chx, h + r + 2.3, 0).applyMatrix4(base)
  if (spec.chimneySmoke) out.chimneys.push({ pos: cp })
  // farmhouse: an ell and a woodshed, connected the New England way
  if (kind === 'farmhouse') {
    const ell = new Matrix4().makeTranslation(-w / 2 - 3.2, 0, -1.2)
    const eb = base.clone().multiply(ell)
    B.add(gablePrism(5.5, 3.4, 6.5, 2.4), M.clap, eb.clone().multiply(new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0.3, 0)))
    gableRoof(B, M.metal, eb.clone().multiply(new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0.3, 0)), 5.5, 3.4, 6.5, 2.4)
    for (let c = 0; c < 2; c++) {
      B.box(0.75, 1.25, 0.1, M.glass, eb, -1.5 + c * 3, 1.6, 5.5 / 2 + 0.05)
    }
  }
  out.footprints.push({ x, z, r: Math.max(w, d) * 0.75 + 4 })
  if (spec.mailbox && face) {
    // at the road edge on the house's side
    const mx = face.roadX + (x - face.roadX) * (5.6 / Math.hypot(x - face.roadX, z - face.roadZ))
    const mz = face.roadZ + (z - face.roadZ) * (5.6 / Math.hypot(x - face.roadX, z - face.roadZ))
    out.mailboxes.push({ x: mx, z: mz, rot: rot + Math.PI })
  }
}

function barn(B: Builder, M: Mats, T: Terrain, out: BuildingsBuild) {
  const [x, z] = BARN.pos
  const face = faceRoadAngle(T, x, z)
  // gable end towards the road
  const rot = face.rot
  const y = Math.min(T.heightAt(x - 8, z), T.heightAt(x + 8, z), T.heightAt(x, z - 10), T.heightAt(x, z + 10))
  const base = new Matrix4().makeRotationY(rot).setPosition(x, y, z)
  const w = 13, h = 6.2, d = 24
  B.box(w + 0.4, 1.8, d + 0.4, M.stone, base, 0, -0.6, 0)
  // gambrel body: profile in x/y, length along z (gable end faces +z = the road)
  B.add(gambrelPrism(w, h, d), M.red, base.clone().multiply(new Matrix4().makeTranslation(0, 0.3, 0)))
  // roof planes following the gambrel
  const pts: [number, number][] = [[w / 2, h], [w * 0.33, h + w * 0.26], [0, h + w * 0.36], [-w * 0.33, h + w * 0.26], [-w / 2, h]]
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[i + 1]
    const len = Math.hypot(bx - ax, by - ay) + 0.5
    const ang = Math.atan2(by - ay, bx - ax)
    const m = new Matrix4().makeRotationZ(ang).setPosition((ax + bx) / 2, (ay + by) / 2 + 0.38, 0)
    B.add(new BoxGeometry(len, 0.18, d + 1.0), M.metal, base.clone().multiply(m))
  }
  // big sliding doors with white X bracing on the road gable
  for (const end of [1, -1]) {
    const zz = end * (d / 2 + 0.06)
    B.box(4.2, 4.6, 0.1, M.red, base, 0, 2.6, zz)
    B.box(4.5, 0.22, 0.14, M.trim, base, 0, 4.95, zz + end * 0.02)
    B.box(4.5, 0.22, 0.14, M.trim, base, 0, 0.4, zz + end * 0.02)
    for (const sx of [-1, 1]) B.box(0.22, 4.6, 0.14, M.trim, base, sx * 2.15, 2.65, zz + end * 0.02)
    const diag = Math.hypot(4.0, 4.3)
    for (const sgn of [-1, 1]) {
      const m = new Matrix4().makeRotationZ(sgn * Math.atan2(4.3, 4.0)).setPosition(0, 2.65, zz + end * 0.04)
      B.add(new BoxGeometry(diag, 0.18, 0.08), M.trim, base.clone().multiply(m))
    }
    // hay-loft door
    B.box(2.2, 1.8, 0.1, M.trim, base, 0, h + 2.6, zz)
    B.box(1.9, 1.5, 0.12, M.red, base, 0, h + 2.6, zz + end * 0.02)
  }
  // a row of small windows along the side
  for (const sx of [-1, 1]) for (let k = -3; k <= 3; k++) B.box(0.1, 0.9, 1.1, M.trim, base, sx * (w / 2 + 0.04), 3.2, k * 3.0)
  // cupola on the ridge
  B.box(1.8, 1.6, 1.8, M.trim, base, 0, h + w * 0.36 + 1.0, 0)
  B.add(new ConeGeometry(1.6, 1.4, 4), M.metal, base.clone().multiply(new Matrix4().makeRotationY(Math.PI / 4).setPosition(0, h + w * 0.36 + 2.4, 0)))
  out.footprints.push({ x, z, r: 18 })
  // concrete stave silo with a dome
  const [sx, sz] = SILO.pos
  const sy = T.heightAt(sx, sz)
  const sb = new Matrix4().makeTranslation(sx, sy, sz)
  B.add(new CylinderGeometry(2.6, 2.7, 15, 20, 1, true), M.concrete, sb.clone().multiply(new Matrix4().makeTranslation(0, 7.3, 0)))
  B.add(new SphereGeometry(2.62, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.metal, sb.clone().multiply(new Matrix4().makeTranslation(0, 14.8, 0)))
  for (let k = 0; k < 7; k++) {
    B.add(new CylinderGeometry(2.7, 2.7, 0.1, 20, 1, true), M.dark, sb.clone().multiply(new Matrix4().makeTranslation(0, 1 + k * 2, 0)))
  }
  out.footprints.push({ x: sx, z: sz, r: 5 })
}

function church(B: Builder, M: Mats, T: Terrain, out: BuildingsBuild) {
  const [x, z] = CHURCH.pos
  const rot = CHURCH.rot
  const y = T.heightAt(x, z)
  const base = new Matrix4().makeRotationY(rot).setPosition(x, y, z)
  const w = 11, h = 8, d = 18, r = 4.5
  B.box(w + 0.4, 1.4, d + 0.4, M.stone, base, 0, -0.4, 0)
  B.add(gablePrism(w, h, d, r), M.clap, base.clone().multiply(new Matrix4().makeTranslation(0, 0.3, 0)))
  gableRoof(B, M.slate, base.clone().multiply(new Matrix4().makeTranslation(0, 0.3, 0)).multiply(new Matrix4().makeRotationY(0)), w, h, d, r, 0.4)
  // tall round-topped windows
  for (const sx of [-1, 1]) for (let k = -2; k <= 2; k++) B.box(0.1, 3.4, 1.1, M.glass, base, sx * (w / 2 + 0.04), 4.3, k * 3.2)
  // tower + belfry + spire at the front (+z)
  const tz = d / 2 + 2
  B.box(4.4, 13, 4.4, M.clap, base, 0, 6.8, tz)
  B.box(3.6, 3.4, 3.6, M.trim, base, 0, 15.0, tz)
  for (const [lx, lz] of [[1.81, 0], [-1.81, 0], [0, 1.81], [0, -1.81]]) B.box(lx ? 0.06 : 1.8, 2.2, lz ? 0.06 : 1.8, M.dark, base, lx, 15.0, tz + lz)
  B.box(3.0, 2.2, 3.0, M.clap, base, 0, 17.8, tz)
  B.add(new ConeGeometry(1.75, 11, 8), M.clap, base.clone().multiply(new Matrix4().makeTranslation(0, 24.4, tz)))
  B.add(new CylinderGeometry(0.06, 0.06, 1.6, 6), M.dark, base.clone().multiply(new Matrix4().makeTranslation(0, 30.6, tz)))
  out.footprints.push({ x, z, r: 16 })
}

export function buildBuildings(T: Terrain): BuildingsBuild {
  const M = materials()
  const B = new Builder()
  const out: BuildingsBuild = { group: new Group(), chimneys: [], footprints: [], mailboxes: [] }
  out.group.name = 'buildings'
  const rnd = mulberry32(1791)
  for (const h of HOUSES) house(B, M, T, h, out, rnd)
  barn(B, M, T, out)
  church(B, M, T, out)
  B.emit(out.group)
  return out
}
