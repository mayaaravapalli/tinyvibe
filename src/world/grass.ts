import {
  BufferAttribute,
  Color,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Vector3,
  type Texture,
} from 'three'
import { mulberry32, smoothstep } from '../core/noise'
import { patchMaterial } from '../render/shared'
import { forestDensity } from './forest'
import type { Terrain } from './terrain'
import type { TreeData } from './trees'
import { FENCE_RUNS } from './props'
import { UNDER_PALETTE, type UnderInstance, type UndergrowthKit } from './undergrowth'

/**
 * Ground detail along the road corridor, seen only from the car: golden autumn
 * grass on the verges and meadows, and drifts of fallen leaves. Chunked along
 * the road so only the stretch around the camera is drawn.
 */

const CHUNK = 60

function leafQuad(): BufferGeometry {
  const g = new BufferGeometry()
  // a slightly cupped leaf lying flat
  const p = [-0.5, 0.02, -0.5, 0.5, 0.02, -0.5, 0.5, 0.02, 0.5, -0.5, 0.02, 0.5, 0, 0.05, 0]
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5]
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  g.setIndex([0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0])
  return g
}

export class GroundDetail {
  readonly group = new Group()
  private chunks: { mesh: Mesh[]; center: Vector3 }[] = []

  // forest density sampled in road coordinates (s every 3 m, lateral every 2 m)
  private vergeGrid!: Float32Array
  private vergeNs = 0
  private readonly vergeLat = 33

  private verge(s: number, lat: number): number {
    const fs = s / 3
    const fl = (lat + 32) / 2
    const i = Math.floor(fs) % this.vergeNs
    const j = Math.max(0, Math.min(this.vergeLat - 2, Math.floor(fl)))
    const tl = Math.min(1, Math.max(0, fl - j))
    const i2 = (i + 1) % this.vergeNs
    const ts = fs - Math.floor(fs)
    const g = this.vergeGrid, W = this.vergeLat
    const a = g[i * W + j] * (1 - tl) + g[i * W + j + 1] * tl
    const b = g[i2 * W + j] * (1 - tl) + g[i2 * W + j + 1] * tl
    return a * (1 - ts) + b * ts
  }

  constructor(
    T: Terrain,
    trees: TreeData,
    leafAtlas: Texture,
    density = 1,
    kit: UndergrowthKit | null = null,
    sunVisAt: (x: number, z: number) => number = () => 1,
  ) {
    this.vergeNs = Math.ceil(T.road.length / 3)
    this.vergeGrid = new Float32Array(this.vergeNs * this.vergeLat)
    {
      const f0 = { x: 0, z: 0, tx: 0, tz: 0 }
      for (let i = 0; i < this.vergeNs; i++) {
        T.road.sample(i * 3, f0)
        for (let j = 0; j < this.vergeLat; j++) {
          const lat = -32 + j * 2
          if (Math.abs(lat) < 5) continue
          this.vergeGrid[i * this.vergeLat + j] = forestDensity(T, f0.x - f0.tz * lat, f0.z + f0.tx * lat)
        }
      }
    }
    const leafMat = patchMaterial(new MeshLambertMaterial({ map: leafAtlas, alphaTest: 0.5, side: DoubleSide }), {
      key: 'litter',
      cloudShadows: true,
      vertexPars: /* glsl */ `
        attribute vec4 aL;     // x, y, z, packed (rotation, scale)
        attribute vec4 aLCol;  // rgb, atlas tile
        varying vec3 vLCol;
      `,
      vertexBegin: /* glsl */ `
        // pick the atlas tile in uv space
        float tile = aLCol.w;
        vMapUv = (vMapUv * 0.5) + vec2(mod(tile, 2.0), floor(tile / 2.0)) * 0.5;
      `,
      vertexWorld: /* glsl */ `
        float rot = fract(aL.w) * 6.2831;
        float sc = floor(aL.w) / 100.0;
        float c = cos(rot), s = sin(rot);
        vec3 lp = vec3(transformed.x * c - transformed.z * s, transformed.y, transformed.x * s + transformed.z * c) * sc;
        vfWorld = vec4(aL.xyz + lp, 1.0);
        vLCol = aLCol.rgb;
      `,
      fragmentPars: 'varying vec3 vLCol;',
      fragmentColor: 'diffuseColor.rgb *= vLCol;',
    })

    const leaf = leafQuad()
    const r = T.road
    const hit = { d: 0, s: 0, lat: 0 }
    const f = { x: 0, z: 0, tx: 0, tz: 0 }
    const L = r.length
    for (let c0 = 0; c0 < L; c0 += CHUNK) {
      const ls: number[] = []
      const lc: number[] = []
      const rnd = mulberry32(Math.floor(c0 * 13) + 7)
      const center = new Vector3()
      let n = 0
      // (grass itself lives in meadow.ts and follows the camera across every open field)
      {
        const f0 = { x: 0, z: 0, tx: 0, tz: 0 }
        r.sample(c0 + CHUNK / 2, f0)
        center.set(f0.x, T.roadYAt(c0 + CHUNK / 2), f0.z)
        n = 1
      }
      // fallen leaves drifting on the verges, collecting against the edges
      for (let k = 0; k < CHUNK * 9 * density; k++) {
        const s = c0 + rnd() * CHUNK
        let db = Math.abs(s - T.bridge.s)
        db = Math.min(db, L - db)
        if (db < 19) continue
        r.sample(s, f)
        const side = rnd() > 0.5 ? 1 : -1
        // most leaves gather at the edge of the asphalt and in the grass beyond
        const lat = side * (2.6 + Math.pow(rnd(), 0.7) * 9)
        const x = f.x - f.tz * lat, z = f.z + f.tx * lat
        const y = T.heightAt(x, z)
        const onRoad = Math.abs(lat) < 5.7
        const ry = onRoad ? T.roadYAt(s) + 0.02 + (Math.abs(lat) > 3.3 ? -0.04 : 0.0) : y
        // colour from the nearest tree
        let best = 1e9, bi = -1
        const cx = x, cz = z
        for (let t = 0; t < 40; t++) {
          const i = Math.floor(rnd() * trees.count)
          const dx = trees.x[i] - cx, dz = trees.z[i] - cz
          const d2 = dx * dx + dz * dz
          if (d2 < best) {
            best = d2
            bi = i
          }
        }
        const tint = bi >= 0 && trees.hue[bi] !== 3 ? [trees.tint[bi * 3], trees.tint[bi * 3 + 1], trees.tint[bi * 3 + 2]] : [0.55, 0.22, 0.05]
        const fade = 0.55 + rnd() * 0.45 // older leaves are browner
        const sc = 0.09 + rnd() * 0.07
        ls.push(x, ry + 0.01, z, Math.floor(sc * 100 * 10) / 10 + rnd() * 0.999)
        lc.push(tint[0] * fade + 0.18 * (1 - fade), tint[1] * fade + 0.1 * (1 - fade), tint[2] * fade + 0.04 * (1 - fade), Math.floor(rnd() * 4))
      }
      // leaves blown against the fence rails pile up along their foot
      for (const [fa, fb, flat] of FENCE_RUNS) {
        if (c0 + CHUNK < fa || c0 > fb) continue
        for (let k = 0; k < CHUNK * 7 * density; k++) {
          const s = c0 + rnd() * CHUNK
          if (s < fa || s > fb) continue
          r.sample(s, f)
          // windward side of the rails, bunched up
          const lat = flat - Math.sign(flat) * Math.pow(rnd(), 2.2) * 0.9 + (rnd() - 0.5) * 0.25
          const x = f.x - f.tz * lat, z = f.z + f.tx * lat
          const y = T.heightAt(x, z)
          const hueR = rnd()
          const base = hueR < 0.4 ? [0.62, 0.2, 0.04] : hueR < 0.7 ? [0.7, 0.42, 0.06] : hueR < 0.85 ? [0.42, 0.07, 0.05] : [0.36, 0.22, 0.1]
          const fade = 0.55 + rnd() * 0.45
          const sc = 0.09 + rnd() * 0.07
          ls.push(x, y + 0.01 + rnd() * 0.04, z, Math.floor(sc * 100 * 10) / 10 + rnd() * 0.999)
          lc.push(base[0] * fade + 0.15 * (1 - fade), base[1] * fade + 0.08 * (1 - fade), base[2] * fade + 0.03 * (1 - fade), Math.floor(rnd() * 4))
        }
      }
      // undergrowth: ferns on the forest floor, shrubs and sumac at the edges,
      // goldenrod and asters gone to seed in the open
      const under: UnderInstance[] = []
      if (kit) {
        const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]
        const place = (kind: UnderInstance['kind'], l0: number, l1: number, attempts: number, accept: (f: number) => number, sMin: number, sMax: number, pal: Color[]) => {
          for (let k = 0; k < attempts * density; k++) {
            const s = c0 + rnd() * CHUNK
            let db = Math.abs(s - T.bridge.s)
            db = Math.min(db, L - db)
            if (db < 22) continue
            const side = rnd() > 0.5 ? 1 : -1
            const lat = side * (l0 + Math.pow(rnd(), 1.4) * (l1 - l0))
            const fd = this.verge(s, lat)
            if (rnd() > accept(fd)) continue
            r.sample(s, f)
            const x = f.x - f.tz * lat, z = f.z + f.tx * lat
            if (T.roadNearest(x, z, 6.2, hit)) continue
            if (T.streamNearest(x, z, 3.2, hit)) continue
            under.push({
              kind,
              x, z,
              y: T.heightAt(x, z) - 0.03,
              rot: rnd() * Math.PI * 2,
              scale: sMin + rnd() * (sMax - sMin),
              color: pick(pal).clone().multiplyScalar(0.85 + rnd() * 0.3),
              sun: sunVisAt(x, z),
            })
          }
        }
        place('fern', 6.3, 24, 700, (fd) => smoothstep(0.15, 0.5, fd), 0.8, 1.5, UNDER_PALETTE.fern)
        place('shrub', 6.6, 20, 90, (fd) => smoothstep(0.1, 0.35, fd) * (1 - smoothstep(0.8, 0.98, fd)), 0.7, 1.3, UNDER_PALETTE.shrub)
        place('sumac', 7, 18, 40, (fd) => smoothstep(0.02, 0.15, fd) * (1 - smoothstep(0.35, 0.65, fd)), 0.8, 1.25, UNDER_PALETTE.sumac)
      }
      if (!n) continue
      const meshes: Mesh[] = []
      if (ls.length) {
        const geo = new InstancedBufferGeometry()
        geo.index = leaf.index
        for (const name of ['position', 'normal', 'uv']) geo.setAttribute(name, leaf.getAttribute(name))
        // the leaf scale needs finer packing than grass: scale*100 is stored with one decimal
        const packed = new Float32Array(ls.length)
        for (let i = 0; i < ls.length; i += 4) {
          packed[i] = ls[i]
          packed[i + 1] = ls[i + 1]
          packed[i + 2] = ls[i + 2]
          packed[i + 3] = Math.floor(ls[i + 3]) + (ls[i + 3] % 1)
        }
        geo.setAttribute('aL', new InstancedBufferAttribute(packed, 4))
        geo.setAttribute('aLCol', new InstancedBufferAttribute(new Float32Array(lc), 4))
        geo.instanceCount = ls.length / 4
        geo.boundingSphere = new Sphere(center.clone(), CHUNK)
        const m = new Mesh(geo, leafMat)
        m.receiveShadow = true
        m.frustumCulled = true
        meshes.push(m)
      }
      if (kit && under.length) meshes.push(...kit.meshes(under))
      for (const m of meshes) {
        m.visible = false
        this.group.add(m)
      }
      this.chunks.push({ mesh: meshes, center })
    }
  }

  /** Show only the chunks around a low camera. */
  update(cam: Vector3, aboveGround: number) {
    const on = aboveGround < 60
    for (const c of this.chunks) {
      const vis = on && c.center.distanceToSquared(cam) < 130 * 130
      for (const m of c.mesh) m.visible = vis
    }
  }
}
