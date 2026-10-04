import {
  Color,
  DoubleSide,
  Object3D,
  ShaderMaterial,
  type Material,
  type Texture,
  FrontSide,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshLambertMaterial,
  Quaternion,
  RGBADepthPacking,
  Vector3,
  type BufferGeometry,
} from 'three'
import { hash2, mulberry32, smoothstep } from '../core/noise'
import { GLSL_BUMP, GLSL_SUN_SHADOW, U, patchDepthMaterial, patchMaterial, type PatchOptions } from '../render/shared'
import { makeLeafClusterTexture } from '../render/leafTexture'
import { PALETTE, evergreenChance, hardwoodHue, standLean, treeColor, type Hue } from './colors'
import { TREE_RECT, forestDensity, treeRegionWeight } from './forest'
import { LONE_TREES } from './layout'
import type { Terrain } from './terrain'
import { SPECIES, buildTreeGeometry, type Lod, type SpeciesId } from './treeGeometry'

export const SPECIES_LIST: SpeciesId[] = ['sugarMaple', 'redMaple', 'birch', 'oak', 'spruce', 'pine']
export const VARIANTS = 3

export interface TreeData {
  count: number
  x: Float32Array
  y: Float32Array
  z: Float32Array
  rot: Float32Array
  height: Float32Array
  tiltX: Float32Array
  tiltZ: Float32Array
  species: Uint8Array
  variant: Uint8Array
  hue: Uint8Array
  tint: Float32Array
  phase: Float32Array
  /** terrain light at the root: x = slope facing the sun, y = baked hill shadow */
  site: Float32Array
}

const HUES: Hue[] = ['orange', 'gold', 'red', 'evergreen', 'yellowgreen']

function speciesFor(hue: Hue, r: number): SpeciesId {
  switch (hue) {
    case 'orange':
      return r < 0.62 ? 'sugarMaple' : 'oak'
    case 'red':
      return r < 0.75 ? 'redMaple' : 'sugarMaple'
    case 'gold':
      return r < 0.5 ? 'birch' : r < 0.75 ? 'sugarMaple' : 'oak'
    case 'yellowgreen':
      return r < 0.5 ? 'oak' : r < 0.75 ? 'redMaple' : 'birch'
    case 'evergreen':
      return r < 0.72 ? 'spruce' : 'pine'
  }
}

export function placeTrees(T: Terrain, sunVisAt: (x: number, z: number) => number, sunDir: Vector3, densityScale = 1): TreeData {
  const cell = 9.8 / Math.sqrt(densityScale)
  const cap = Math.ceil(((TREE_RECT.maxX - TREE_RECT.minX) / cell) * ((TREE_RECT.maxZ - TREE_RECT.minZ) / cell)) + 64
  const d: TreeData = {
    count: 0,
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    z: new Float32Array(cap),
    rot: new Float32Array(cap),
    height: new Float32Array(cap),
    tiltX: new Float32Array(cap),
    tiltZ: new Float32Array(cap),
    species: new Uint8Array(cap),
    variant: new Uint8Array(cap),
    hue: new Uint8Array(cap),
    tint: new Float32Array(cap * 3),
    phase: new Float32Array(cap),
    site: new Float32Array(cap * 2),
  }
  const col = new Color()
  const hit = { d: 0, s: 0, lat: 0 }
  const nrm = { x: 0, y: 1, z: 0 }
  const push = (x: number, z: number, hue: Hue, sp: SpeciesId, h: number, rnd: () => number) => {
    const i = d.count++
    d.x[i] = x
    d.z[i] = z
    d.y[i] = T.heightAt(x, z)
    d.rot[i] = rnd() * Math.PI * 2
    d.height[i] = h
    d.species[i] = SPECIES_LIST.indexOf(sp)
    d.variant[i] = Math.floor(rnd() * VARIANTS)
    d.hue[i] = HUES.indexOf(hue)
    treeColor(hue, x, z, 7, col)
    d.tint[i * 3] = col.r
    d.tint[i * 3 + 1] = col.g
    d.tint[i * 3 + 2] = col.b
    d.phase[i] = rnd() * Math.PI * 2
    // trees lean gently downhill and, at the road edge, out over the asphalt
    T.normalAt(x, z, nrm)
    const flat = sunDir.y
    const nl = Math.max(0, nrm.x * sunDir.x + nrm.y * sunDir.y + nrm.z * sunDir.z)
    d.site[i * 2] = Math.min(1.6, Math.max(0.35, (nl + 0.15) / (flat + 0.15)))
    d.site[i * 2 + 1] = sunVisAt(x, z)
    let tx = nrm.x * 0.25, tz = nrm.z * 0.25
    if (T.roadNearest(x, z, 16, hit)) {
      const w = 1 - smoothstep(7, 15, hit.d)
      const p = { x: 0, z: 0, tx: 0, tz: 0 }
      T.road.sample(hit.s, p)
      // direction from tree towards the road centre
      const side = hit.lat > 0 ? 1 : -1
      tx += p.tz * side * 0.12 * w
      tz += -p.tx * side * 0.12 * w
    }
    d.tiltX[i] = tx
    d.tiltZ[i] = tz
  }

  const rndGlobal = mulberry32(99)
  for (let gz = TREE_RECT.minZ; gz < TREE_RECT.maxZ; gz += cell) {
    for (let gx = TREE_RECT.minX; gx < TREE_RECT.maxX; gx += cell) {
      const ci = Math.round(gx / cell), cj = Math.round(gz / cell)
      const r1 = hash2(ci, cj, 1), r2 = hash2(ci, cj, 2), r3 = hash2(ci, cj, 3), r4 = hash2(ci, cj, 4)
      const x = gx + (r1 - 0.5) * cell * 0.92
      const z = gz + (r2 - 0.5) * cell * 0.92
      const region = treeRegionWeight(x, z)
      if (region <= 0 || r3 > region * 1.05) continue
      const dens = forestDensity(T, x, z)
      if (dens <= 0 || r4 > dens) continue
      const h0 = T.heightAt(x, z)
      let wet = 0
      if (T.streamNearest(x, z, 40, hit)) wet = 1 - smoothstep(6, 40, hit.d)
      const rnd = mulberry32((ci * 73856093) ^ (cj * 19349663))
      const ever = rnd() < evergreenChance(x, z, h0, wet)
      const hue: Hue = ever ? 'evergreen' : hardwoodHue(standLean(x, z), rnd())
      const sp = speciesFor(hue, rnd())
      // forest-edge trees are a little shorter and fuller; ridges are stunted
      const site = 1 - 0.18 * smoothstep(70, 140, h0) + 0.1 * wet
      // a sparser forest (lower quality tiers) grows larger crowns so the canopy stays closed
      const h = SPECIES[sp].height * (0.72 + 0.5 * rnd()) * site * (0.85 + 0.15 * dens) * Math.pow(1 / densityScale, 0.32)
      push(x, z, hue, sp, h, rnd)
    }
  }
  // the handful of iconic lone maples
  for (const t of LONE_TREES) {
    const rnd = mulberry32(Math.floor(t.pos[0] * 31 + t.pos[1]))
    const hue: Hue = t.color === 'red' ? 'red' : t.color === 'gold' ? 'gold' : 'orange'
    push(t.pos[0], t.pos[1], hue, 'sugarMaple', 19 * t.scale, rnd)
  }
  void rndGlobal
  void PALETTE
  return d
}

// ------------------------------------------------------------------ material

const WIND_VERTEX_PARS = /* glsl */ `
attribute vec4 aFol;
attribute vec3 aBark;
attribute vec3 aTint;
attribute vec2 aSeed; // x phase, y tree height
attribute vec2 aSite; // x slope light, y hill shadow
uniform sampler2D uWindTex;
uniform vec4 uWindRect;
uniform vec2 uAmbientWind;
uniform vec2 uLodRange;
uniform float uLodMode; // 0 = far (fades out near camera), 1 = near (fades in)
uniform float uWindVis; // exaggerates sway when seen from far above
uniform float uCullBehind; // 1 in the colour pass only (shadows come from behind too)
varying vec4 vFol;
varying vec3 vTint;
varying float vGust;
varying float vLodFade;
varying vec2 vSite;
varying vec2 vLeafUv;
`

const WIND_VERTEX_WORLD = /* glsl */ `
  mat4 im = modelMatrix * instanceMatrix;
  vec3 root = im[3].xyz;
  vfWorld = im * vec4(transformed, 1.0);
  // trees well behind the main camera (POV) do no further work
  bool vfBehind = dot(root - uViewPos, uViewDir) < -35.0 && uLodMode < 1.5;
  float H = aSeed.y;
  vec2 wuv = (root.xz - uWindRect.xy) * uWindRect.zw;
  vec4 wind = texture2D(uWindTex, wuv);
  vec2 gustBend = (wind.rg - 0.5) * 2.0 * 1.16;
  // ambient breeze: broad slow patches drifting across the hills
  float patchN = vfNoise(root.xz * 0.0045 - uAmbientWind * uTime * 0.035);
  float amb = 0.10 + 0.32 * smoothstep(0.35, 0.85, patchN);
  vec2 sway = uAmbientWind * amb * (0.55 + 0.45 * sin(uTime * (0.7 + 0.15 * fract(aSeed.x)) + aSeed.x));
  vec2 disp = (gustBend * (0.85 + 0.3 * fract(aSeed.x * 3.7)) + sway) * uWindVis;
  float hf = aFol.x;
  float bend = hf * hf;
  vfWorld.xz += disp * bend * H * 0.075;
  vfWorld.y -= dot(disp, disp) * bend * H * 0.02;
  // clumps and leaves flutter, more inside a gust
  vec3 wn = normalize((im * vec4(normal, 0.0)).xyz);
  float fl = step(0.5, aFol.w) * (0.04 + 0.32 * wind.b) * sin(uTime * (4.5 + 3.0 * aFol.y) + aFol.y * 37.0 + aSeed.x * 3.0);
  vfWorld.xyz += wn * fl * (0.4 + hf) * (aFol.w > 1.5 ? 1.6 : 1.0);
  vfWorld.xz += disp * step(0.5, aFol.w) * 0.25 * sin(uTime * 2.1 + aFol.y * 12.0) * hf;
  vFol = aFol;
  vTint = mix(aBark, aTint, step(0.5, aFol.w));
  vGust = wind.b;
  vSite = aSite;
  vLeafUv = uv;
  // LOD cross-fade against the main view camera (also valid in the shadow pass)
  // the detailed tree fades in (dithered) over a still-solid far tree, and the far
  // tree only dissolves once it is hidden inside the near one: no visible stipple
  float dv = distance(root, uViewPos);
  vLodFade = uLodMode < 0.5 ? smoothstep(uLodRange.x - 14.0, uLodRange.x, dv) : 1.0 - smoothstep(uLodRange.x, uLodRange.y, dv);
  if (vLodFade <= 0.001 || (vfBehind && uCullBehind > 0.5)) vfWorld = vec4(0.0, -1.0e5, 0.0, 1.0);
`

const LOD_DISCARD = /* glsl */ `
  if (vLodFade < 0.999) {
    if (vfHash12(floor(gl_FragCoord.xy)) > vLodFade) discard;
  }
`

const CARD_ALPHA = /* glsl */ `
  float vfCardLum = 1.0;
  if (vFol.w > 1.5) {
    vec4 lt = texture2D(uLeafTex, vLeafUv);
    // sharpened alpha test keeps cards from thinning out in the mip chain
    float a = (lt.a - 0.5) / max(fwidth(lt.a), 1e-4) + 0.5;
    if (a < 0.5) discard;
    vfCardLum = lt.r;
  }
`

const FRAG_PARS = /* glsl */ `
  uniform sampler2D uLeafTex;
  varying vec4 vFol;
  varying vec3 vTint;
  varying float vGust;
  varying float vLodFade;
  varying vec2 vSite;
  varying vec2 vLeafUv;
`

function treePatch(key: string, leafTex: Texture): PatchOptions {
  return {
    key,
    cloudShadows: true,
    sunVis: 'vSite.y',
    uniforms: { uLodMode: { value: 0 }, uLeafTex: { value: leafTex } },
    vertexPars: WIND_VERTEX_PARS,
    vertexWorld: WIND_VERTEX_WORLD,
    fragmentPars: /* glsl */ `
      ${FRAG_PARS}
      ${GLSL_SUN_SHADOW}
      ${GLSL_BUMP}
      // leaf-cluster height field (metres), shared by colour and normal
      float vfLeafH(vec3 wp) {
        vec3 p = wp * 1.45;
        return vfNoise3(p) * 0.62 + vfNoise3(p * 2.3 + 3.1) * 0.38;
      }
    `,
    fragmentColor: /* glsl */ `
      ${LOD_DISCARD}
      ${CARD_ALPHA}
      float vfDistV = length(vViewPosition);
      float vfLeaf = 0.5;
      {
        vec3 c = vTint;
        if (vFol.w > 0.5) {
          vfLeaf = vfLeafH(vAtmoWorld);
          float lm2 = vfNoise3(vAtmoWorld * 0.42 + 7.0);
          // leaf clusters vs. the dark pockets between them (fades to the mean with distance)
          float detail = 1.0 - smoothstep(90.0, 420.0, vfDistV);
          float cl = mix(0.82, mix(0.5, 1.12, smoothstep(0.32, 0.68, vfLeaf)), detail);
          if (vFol.w > 1.5) cl = mix(0.75, 1.15, vfCardLum) * mix(0.9, 1.05, vfLeaf);
          c *= cl;
          c *= 0.82 + 0.3 * vFol.y;
          c *= 0.86 + 0.28 * lm2;
          // leaves flipping in a gust show their paler undersides
          float g = clamp(vGust, 0.0, 1.0);
          // undersides are paler and less saturated; conifers barely flash
          float lum = dot(c, vec3(0.3, 0.55, 0.15));
          float broad = smoothstep(0.02, 0.09, max(c.r, c.g) - c.b * 0.5);
          vec3 under = mix(c, vec3(lum) * vec3(1.1, 1.0, 0.82), 0.35) * 1.7 + vec3(0.05, 0.04, 0.02) * broad;
          float tw = 0.55 + 0.45 * sin(uTime * 7.0 + vFol.y * 23.0 + vAtmoWorld.x * 0.7);
          c = mix(c, under, g * broad * (0.5 + 0.5 * vfLeaf) * tw);
          c *= vFol.z;
          // whole hillsides brighten where they face the low sun
          c *= mix(0.8, 1.18, clamp((vSite.x - 0.35) / 1.25, 0.0, 1.0));
        } else {
          c *= vFol.z * (0.8 + 0.3 * vfNoise3(vAtmoWorld * vec3(6.0, 0.8, 6.0)));
        }
        diffuseColor.rgb = c;
      }
      // ragged, leafy silhouettes on the solid clumps
      if (vFol.w > 0.5 && vFol.w < 1.5) {
        vec3 vd = normalize(vViewPosition);
        float facing = abs(dot(normalize(vNormal), vd));
        float leafy = vfNoise3(vAtmoWorld * 2.6 + vFol.y * 10.0);
        if (facing < 0.24 && leafy > facing * 3.6 + 0.22) discard;
      }
    `,
    fragmentNormal: /* glsl */ `
      if (vFol.w > 0.5) {
        float bf = 1.0 - smoothstep(50.0, 240.0, vfDistV);
        if (bf > 0.0) normal = vfBump(normal, -vViewPosition, vfLeaf * 0.16 * bf, faceDirection);
      }
    `,
    fragmentOutgoing: /* glsl */ `
      if (vFol.w > 0.5) {
        // translucency: the low sun shining through thin leaves towards the viewer.
        // Self-shadowing must not kill it — light passes through the crown edge.
        vec3 V = normalize(cameraPosition - vAtmoWorld);
        float back = pow(max(dot(-V, uSunDir), 0.0), 2.5);
        float sh = vfSunShadow();
        float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
        float thin = clamp(rim * 1.2 + (1.0 - vFol.z) * 0.2 + vfLeaf * 0.3 + (vFol.w > 1.5 ? 0.35 : 0.0), 0.0, 1.0);
        vec3 leafLight = vTint * uSunColor * vfCloudShade(vAtmoWorld) * vSite.y;
        outgoingLight += leafLight * back * thin * mix(0.28, 1.0, sh) * 0.75;
        outgoingLight += diffuseColor.rgb * uSunColor * 0.04;
      }
    `,
  }
}

const _m = new Matrix4()
const _q = new Quaternion()
const _e = new Euler()
const _s = new Vector3()
const _p = new Vector3()

export function writeInstance(mesh: InstancedMesh, slot: number, d: TreeData, i: number) {
  const sp = SPECIES[SPECIES_LIST[d.species[i]]]
  const s = d.height[i] / sp.height
  _e.set(d.tiltZ[i], d.rot[i], -d.tiltX[i], 'YXZ')
  _q.setFromEuler(_e)
  _s.set(s, s, s)
  _p.set(d.x[i], d.y[i], d.z[i])
  _m.compose(_p, _q, _s)
  mesh.setMatrixAt(slot, _m)
  const tint = mesh.geometry.getAttribute('aTint') as InstancedBufferAttribute | undefined
  tint?.setXYZ(slot, d.tint[i * 3], d.tint[i * 3 + 1], d.tint[i * 3 + 2])
  const seed = mesh.geometry.getAttribute('aSeed') as InstancedBufferAttribute
  seed.setXY(slot, d.phase[i], d.height[i])
  const site = mesh.geometry.getAttribute('aSite') as InstancedBufferAttribute | undefined
  site?.setXY(slot, d.site[i * 2], d.site[i * 2 + 1])
}

function makeMaterials(lod: Lod, leafTex: Texture) {
  const mat = new MeshLambertMaterial({ side: lod === 'near' ? DoubleSide : FrontSide })
  const opts = treePatch(`tree-${lod}`, leafTex)
  // colour and depth programs share the same uniform objects
  opts.uniforms!.uLodMode.value = lod === 'near' ? 1 : 0
  opts.uniforms!.uWindVis = U_WIND_VIS
  patchMaterial(mat, { ...opts, uniforms: { ...opts.uniforms, uCullBehind: { value: 1 } } })
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: lod === 'near' ? DoubleSide : FrontSide })
  patchDepthMaterial(depth, {
    ...opts,
    uniforms: { ...opts.uniforms, uCullBehind: { value: 0 } },
    fragmentPars: FRAG_PARS,
    fragmentColor: LOD_DISCARD + CARD_ALPHA,
  })
  return { mat, depth }
}

/** Sway exaggeration: trees must visibly move even from a kilometre up. */
export const U_WIND_VIS = { value: 1 }

/** Never drawn in the main pass — exists only to cast cheap shadows. */
function shadowOnlyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    colorWrite: false,
    depthWrite: false,
  })
}

interface Group {
  species: number
  variant: number
  geo: BufferGeometry
}

/**
 * The forest: every tree as a cheap far mesh, shadow proxies that only render in
 * the shadow pass, and a detailed near set refilled around the camera with a
 * dithered cross-fade so nothing pops.
 */
export class Forest {
  readonly group = new Object3D()
  far: InstancedMesh[] = []
  proxies: InstancedMesh[] = []
  near: InstancedMesh[] = []
  private nearIndex = new Map<number, InstancedMesh>()
  private cellSize = 32
  private gx0 = 0
  private gz0 = 0
  private gw = 0
  private gh = 0
  private cellStart!: Int32Array
  private cellItems!: Int32Array
  private lastRebuild = new Vector3(1e9, 0, 0)
  nearCount = 0
  readonly leafTex: Texture

  constructor(readonly d: TreeData, private terrain: Terrain, quality: { near: boolean }) {
    this.leafTex = makeLeafClusterTexture()
    const far = makeMaterials('far', this.leafTex)
    const near = makeMaterials('near', this.leafTex)
    const shadowDepth = makeMaterials('shadow', this.leafTex).depth
    const hidden = shadowOnlyMaterial()

    for (let si = 0; si < SPECIES_LIST.length; si++) {
      for (let v = 0; v < VARIANTS; v++) {
        const idx: number[] = []
        for (let i = 0; i < d.count; i++) if (d.species[i] === si && d.variant[i] === v) idx.push(i)
        if (!idx.length) continue
        const seed = 1 + v * 17 + si * 101
        const g: Group = { species: si, variant: v, geo: buildTreeGeometry(SPECIES_LIST[si], 'far', seed) }
        // far
        const fm = this.instanced(g.geo, far.mat, idx.length, true)
        fm.customDepthMaterial = far.depth
        idx.forEach((ti, slot) => writeInstance(fm, slot, d, ti))
        fm.castShadow = false
        fm.receiveShadow = true
        fm.name = `trees-far-${SPECIES_LIST[si]}-${v}`
        this.far.push(fm)
        // near (dynamic)
        if (quality.near) {
          const nm = this.instanced(buildTreeGeometry(SPECIES_LIST[si], 'near', seed), near.mat, 640, true)
          nm.customDepthMaterial = near.depth
          nm.count = 0
          nm.castShadow = true
          nm.receiveShadow = true
          nm.name = `trees-near-${SPECIES_LIST[si]}-${v}`
          this.near.push(nm)
          this.nearIndex.set(si * 16 + v, nm)
        }
      }
    }
    // shadow proxies: one per species per spatial tile, so the tight shadow
    // frustum around the car only touches nearby trees
    const TN = 3
    const tw = (TREE_RECT.maxX - TREE_RECT.minX) / TN, th = (TREE_RECT.maxZ - TREE_RECT.minZ) / TN
    for (let si = 0; si < SPECIES_LIST.length; si++) {
      const geo = buildTreeGeometry(SPECIES_LIST[si], 'shadow', 1 + si * 101)
      for (let tj = 0; tj < TN; tj++) {
        for (let ti = 0; ti < TN; ti++) {
          const idx: number[] = []
          for (let i = 0; i < d.count; i++) {
            if (d.species[i] !== si) continue
            const cx = Math.min(TN - 1, Math.max(0, Math.floor((d.x[i] - TREE_RECT.minX) / tw)))
            const cz = Math.min(TN - 1, Math.max(0, Math.floor((d.z[i] - TREE_RECT.minZ) / th)))
            if (cx === ti && cz === tj) idx.push(i)
          }
          if (!idx.length) continue
          const pm = this.instanced(geo, hidden, idx.length, false)
          pm.customDepthMaterial = shadowDepth
          idx.forEach((t, slot) => writeInstance(pm, slot, d, t))
          pm.castShadow = true
          pm.receiveShadow = false
          pm.frustumCulled = true
          pm.computeBoundingSphere()
          pm.boundingSphere!.radius += 30
          pm.name = `trees-shadow-${SPECIES_LIST[si]}-${ti}-${tj}`
          this.proxies.push(pm)
        }
      }
    }
    for (const m of [...this.far, ...this.proxies, ...this.near]) {
      m.instanceMatrix.needsUpdate = true
      this.group.add(m)
    }
    this.buildGrid()
  }

  private instanced(geo: BufferGeometry, mat: Material, count: number, tint: boolean): InstancedMesh {
    geo = geo.clone()
    if (tint) geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(count * 2), 2))
    geo.setAttribute('aSite', new InstancedBufferAttribute(new Float32Array(count * 2), 2))
    const m = new InstancedMesh(geo, mat, count)
    m.frustumCulled = false
    return m
  }

  private buildGrid() {
    const d = this.d
    const c = this.cellSize
    this.gx0 = TREE_RECT.minX - c
    this.gz0 = TREE_RECT.minZ - c
    this.gw = Math.ceil((TREE_RECT.maxX - TREE_RECT.minX) / c) + 3
    this.gh = Math.ceil((TREE_RECT.maxZ - TREE_RECT.minZ) / c) + 3
    const counts = new Int32Array(this.gw * this.gh + 1)
    const cellOf = new Int32Array(d.count)
    for (let i = 0; i < d.count; i++) {
      const gx = Math.min(this.gw - 1, Math.max(0, Math.floor((d.x[i] - this.gx0) / c)))
      const gz = Math.min(this.gh - 1, Math.max(0, Math.floor((d.z[i] - this.gz0) / c)))
      cellOf[i] = gz * this.gw + gx
      counts[cellOf[i] + 1]++
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1]
    this.cellStart = counts
    this.cellItems = new Int32Array(d.count)
    const fill = counts.slice()
    for (let i = 0; i < d.count; i++) this.cellItems[fill[cellOf[i]]++] = i
  }

  /** Trees within r of (x, z), calling f(index). */
  forEachNear(x: number, z: number, r: number, f: (i: number) => void) {
    const c = this.cellSize
    const d = this.d
    const i0 = Math.max(0, Math.floor((x - r - this.gx0) / c))
    const i1 = Math.min(this.gw - 1, Math.floor((x + r - this.gx0) / c))
    const j0 = Math.max(0, Math.floor((z - r - this.gz0) / c))
    const j1 = Math.min(this.gh - 1, Math.floor((z + r - this.gz0) / c))
    const r2 = r * r
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * this.gw + i
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
          const t = this.cellItems[k]
          const dx = d.x[t] - x, dz = d.z[t] - z
          if (dx * dx + dz * dz <= r2) f(t)
        }
      }
    }
  }

  /** Refill the near set around the view position. */
  update(view: Vector3) {
    if (!this.near.length) return
    const ground = this.terrain.heightAt(view.x, view.z)
    const high = view.y - ground > 320
    if (high) {
      if (this.nearCount) {
        for (const m of this.near) m.count = 0
        this.nearCount = 0
      }
      this.lastRebuild.set(1e9, 0, 0)
      return
    }
    const dx = view.x - this.lastRebuild.x, dz = view.z - this.lastRebuild.z
    if (dx * dx + dz * dz < 9) return
    this.lastRebuild.copy(view)
    for (const m of this.near) m.count = 0
    const d = this.d
    let total = 0
    this.forEachNear(view.x, view.z, U.uLodRange.value.y + 8, (i) => {
      const m = this.nearIndex.get(d.species[i] * 16 + d.variant[i])
      if (!m || m.count >= m.instanceMatrix.count) return
      writeInstance(m, m.count++, d, i)
      total++
    })
    for (const m of this.near) {
      m.instanceMatrix.needsUpdate = true
      for (const n of ['aTint', 'aSeed', 'aSite']) (m.geometry.getAttribute(n) as InstancedBufferAttribute).needsUpdate = true
    }
    this.nearCount = total
  }
}

/**
 * Beyond the detailed forest: one lumpy blob per small group of crowns, so the
 * nearer ranges carry real canopy texture and bumpy ridgelines.
 */
export function buildFarLumps(
  T: Terrain,
  groundAt: (x: number, z: number) => number,
  sunVisAt: (x: number, z: number) => number,
  sunDir: Vector3,
  leafTex: Texture,
  densityScale = 1,
): Object3D {
  const group = new Object3D()
  const spacing = 19 / Math.sqrt(densityScale)
  const minX = -2500, maxX = 2500, minZ = -2900, maxZ = 1500
  const pts: { x: number; z: number; y: number; hue: Hue; h: number; r: number; site: number; vis: number }[] = []
  const nrm = { x: 0, y: 1, z: 0 }
  for (let gz = minZ; gz < maxZ; gz += spacing) {
    for (let gx = minX; gx < maxX; gx += spacing) {
      const ci = Math.round(gx / spacing), cj = Math.round(gz / spacing)
      const x = gx + (hash2(ci, cj, 11) - 0.5) * spacing * 0.9
      const z = gz + (hash2(ci, cj, 12) - 0.5) * spacing * 0.9
      // only within view of the valley, outside (and in the rim of) the detailed forest
      const dc = Math.hypot(x - 40, (z + 300) * 0.8)
      if (dc > 2300 || z > 1450) continue
      const region = treeRegionWeight(x, z)
      if (hash2(ci, cj, 13) < region) continue
      if (T.clearing(x, z) > 0.4) continue
      const y = groundAt(x, z)
      // keep to where the aerial and overlook views can actually see
      const rnd = mulberry32((ci * 2654435761) ^ (cj * 40503))
      const ever = rnd() < evergreenChance(x, z, y, 0)
      const hue: Hue = ever ? 'evergreen' : hardwoodHue(standLean(x, z), rnd())
      T.normalAt(x, z, nrm)
      const nl = Math.max(0, nrm.x * sunDir.x + nrm.y * sunDir.y + nrm.z * sunDir.z)
      pts.push({
        x, z, y, hue,
        h: (16 + 7 * rnd()) * Math.pow(1 / densityScale, 0.3),
        r: rnd(),
        site: Math.min(1.6, Math.max(0.35, (nl + 0.15) / (sunDir.y + 0.15))),
        vis: sunVisAt(x, z),
      })
    }
  }
  const { mat } = makeMaterials('far', leafTex)
  const make = (conifer: boolean) => {
    const list = pts.filter((p) => (p.hue === 'evergreen') === conifer)
    const geo = lumpGeometry(conifer)
    geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(list.length * 3), 3))
    geo.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(list.length * 2), 2))
    geo.setAttribute('aSite', new InstancedBufferAttribute(new Float32Array(list.length * 2), 2))
    const m = new InstancedMesh(geo, mat, list.length)
    const tint = geo.getAttribute('aTint') as InstancedBufferAttribute
    const seed = geo.getAttribute('aSeed') as InstancedBufferAttribute
    const site = geo.getAttribute('aSite') as InstancedBufferAttribute
    const col = new Color()
    list.forEach((p, i) => {
      const s = p.h / 16
      _e.set(0, p.r * Math.PI * 2, 0)
      _q.setFromEuler(_e)
      _s.set(s * (0.9 + 0.3 * p.r), s, s * (0.9 + 0.3 * (1 - p.r)))
      _p.set(p.x, p.y, p.z)
      _m.compose(_p, _q, _s)
      m.setMatrixAt(i, _m)
      treeColor(p.hue, p.x, p.z, 7, col)
      tint.setXYZ(i, col.r, col.g, col.b)
      seed.setXY(i, p.r * 6.28, p.h)
      site.setXY(i, p.site, p.vis)
    })
    m.instanceMatrix.needsUpdate = true
    m.frustumCulled = false
    m.castShadow = false
    m.receiveShadow = false
    m.name = conifer ? 'lumps-conifer' : 'lumps-hardwood'
    group.add(m)
  }
  make(false)
  make(true)
  group.userData.count = pts.length
  return group
}

/** A 16 m crown group: three merged lumps (hardwood) or a ragged spire (conifer). */
function lumpGeometry(conifer: boolean): BufferGeometry {
  return buildTreeGeometry(conifer ? 'spruce' : 'sugarMaple', 'lump', conifer ? 5 : 9)
}
