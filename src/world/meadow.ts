import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  Vector4,
  type IUniform,
  type Texture,
} from 'three'
import { mulberry32 } from '../core/noise'
import { TILE, tileUv } from '../render/leafTexture'
import { GLSL_SUN_SHADOW, patchMaterial } from '../render/shared'
import type { GroundGrid } from './terrainMesh'

/**
 * Meadow grass that travels with the camera. Three rings of clumps (fine near,
 * coarser further out) sit on a wrapped grid anchored to the world, so a clump
 * never slides as you drive; each clump looks up the land map to decide
 * whether it grows here, how tall, and in which colour. Goldenrod and asters
 * ride on the same scheme.
 */

/** shared GLSL: sample the land under any world point */
export const GLSL_GROUND = /* glsl */ `
uniform sampler2D uHeightTex;
uniform sampler2D uMeadowTex;
uniform vec3 uGround; // min, step, n
// heights are packed as 16 bits in RG (−200 m .. 1200 m, ~2 cm steps): works on every GPU
float vfDecodeH(vec4 t) {
  return (floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5)) / 65535.0 * 1400.0 - 200.0;
}
float vfGroundH(vec2 p) {
  vec2 f = (p - uGround.x) / uGround.y;
  ivec2 n2 = ivec2(int(uGround.z) - 2);
  ivec2 i = clamp(ivec2(floor(f)), ivec2(0), n2);
  vec2 t = clamp(f - vec2(i), 0.0, 1.0);
  float a = vfDecodeH(texelFetch(uHeightTex, i, 0));
  float b = vfDecodeH(texelFetch(uHeightTex, i + ivec2(1, 0), 0));
  float c = vfDecodeH(texelFetch(uHeightTex, i + ivec2(0, 1), 0));
  float d = vfDecodeH(texelFetch(uHeightTex, i + ivec2(1, 1), 0));
  // same diagonal as the terrain mesh, so roots sit exactly on the ground
  if (t.x + t.y <= 1.0) return a + (b - a) * t.x + (c - a) * t.y;
  return d + (c - d) * (1.0 - t.x) + (b - d) * (1.0 - t.y);
}
vec4 vfMeadowAt(vec2 p) {
  return texture2D(uMeadowTex, ((p - uGround.x) / uGround.y + 0.5) / uGround.z);
}
`

/**
 * The colour of an autumn meadow at a point: tawny grass, drifts of russet
 * little bluestem, the last late green, pale seed heads. Shared by the blades
 * and the ground beneath and beyond them so the two always agree.
 */
export const GLSL_MEADOW_TONE = /* glsl */ `
vec3 vfSrgb(vec3 c) { return pow(c, vec3(2.2)); }
vec3 vfMeadowTone(vec2 p, float kind, float roadD, float r) {
  // rotated and warped, so the drifts never show the noise grid's boxy contours
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p;
  q += (vec2(vfNoise(q * 0.021 + 7.0), vfNoise(q * 0.021 + 19.0)) - 0.5) * 46.0;
  float big = vfFbm(q * 0.016 + 3.0);
  float mid = vfFbm(q * 0.055 + 11.0);
  float small = vfNoise(q * 0.3 + 5.0);
  vec3 tawny = vfSrgb(vec3(0.70, 0.56, 0.34));
  vec3 straw = vfSrgb(vec3(0.80, 0.71, 0.52));
  vec3 russet = vfSrgb(vec3(0.62, 0.37, 0.24));
  vec3 rust = vfSrgb(vec3(0.52, 0.30, 0.20));
  vec3 green = vfSrgb(vec3(0.44, 0.48, 0.25));
  vec3 lawn = vfSrgb(vec3(0.41, 0.48, 0.23));
  vec3 c = mix(tawny, straw, smoothstep(0.38, 0.68, mid) * 0.65);
  // little bluestem grows in drifts and turns copper-red in October
  float blue = smoothstep(0.45, 0.68, big + (mid - 0.47) * 0.45);
  c = mix(c, mix(russet, rust, smoothstep(0.3, 0.8, small)), blue * 0.68);
  // damp low spots and the field margins hold on to green
  c = mix(c, green, smoothstep(0.52, 0.74, 1.0 - big + (mid - 0.5) * 0.4) * 0.65);
  // mown verges and lawns: shorter and greener
  float mown = max(1.0 - smoothstep(8.5, 11.0, roadD), smoothstep(0.3, 0.45, kind) * (1.0 - smoothstep(0.6, 0.75, kind)));
  c = mix(c, mix(lawn, tawny, 0.4), mown * 0.65);
  // the hay field is stubble
  c = mix(c, mix(straw, tawny, 0.5), smoothstep(0.8, 0.95, kind) * 0.75);
  return c * (0.88 + 0.24 * r);
}
`

/** land-map textures, shared with the terrain shader (filled once the meadow is built) */
export const GROUND_U = {
  uHeightTex: { value: null as Texture | null },
  uMeadowTex: { value: null as Texture | null },
  uGround: { value: new Vector3(0, 1, 2) },
  /** 1 while the camera is low enough for blades to be drawn */
  uGrassOn: { value: 0 },
}

function textures(g: GroundGrid) {
  const packed = new Uint8Array(g.n * g.n * 4)
  for (let i = 0; i < g.n * g.n; i++) {
    const v = Math.max(0, Math.min(65535, Math.round(((g.height[i] + 200) / 1400) * 65535)))
    packed[i * 4] = v >> 8
    packed[i * 4 + 1] = v & 255
    packed[i * 4 + 3] = 255
  }
  const h = new DataTexture(packed, g.n, g.n, RGBAFormat, UnsignedByteType)
  h.minFilter = h.magFilter = NearestFilter
  h.needsUpdate = true
  const m = new DataTexture(g.meadow, g.n, g.n, RGBAFormat, UnsignedByteType)
  m.minFilter = m.magFilter = LinearFilter
  m.needsUpdate = true
  return { h, m }
}

/** a clump of curved grass blades; aTip runs 0 at the root to 1 at the tip */
function clumpGeometry(blades: number, segs: number, spread: number, width: number, seed: number): BufferGeometry {
  const rnd = mulberry32(seed)
  const pos: number[] = []
  const tip: number[] = []
  const side: number[] = []
  const brand: number[] = []
  const idx: number[] = []
  for (let b = 0; b < blades; b++) {
    const br = rnd()
    const a = rnd() * Math.PI * 2
    const r = spread * Math.sqrt(rnd())
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r
    const face = rnd() * Math.PI * 2
    const fx = Math.cos(face), fz = Math.sin(face)
    // lean outward from the clump centre, curving over
    const lean = 0.18 + rnd() * 0.32
    const lx = (r > 1e-3 ? ox / r : Math.cos(a)) * lean, lz = (r > 1e-3 ? oz / r : Math.sin(a)) * lean
    const h = 0.7 + rnd() * 0.5
    const w = width * (0.7 + rnd() * 0.6)
    // some stems carry a seed head: a wider, paler tip
    const seedHead = rnd() < 0.3
    const base = pos.length / 3
    for (let k = 0; k <= segs; k++) {
      const t = k / segs
      const y = h * t
      const off = t * t
      let ww = w * (1 - t * 0.85)
      if (seedHead && t > 0.7) ww = w * 1.6 * (1 - (t - 0.7) / 0.3) + w * 0.2
      for (const sd of [-1, 1]) {
        pos.push(ox + lx * off + (-fz) * ww * sd, y, oz + lz * off + fx * ww * sd)
        tip.push(t)
        side.push(seedHead ? 1 : 0)
        brand.push(br)
      }
    }
    for (let k = 0; k < segs; k++) {
      const i0 = base + k * 2
      idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setAttribute('aTip', new BufferAttribute(new Float32Array(tip), 1))
  g.setAttribute('aHead', new BufferAttribute(new Float32Array(side), 1))
  g.setAttribute('aBlade', new BufferAttribute(new Float32Array(brand), 1))
  g.setIndex(idx)
  return g
}

/**
 * Goldenrod: a few slender stems, each ending in a nodding plume of short,
 * feathery sprays. aTip < 0.7 is stem, above is plume.
 */
function plumeGeometry(seed: number): BufferGeometry {
  const rnd = mulberry32(seed)
  const pos: number[] = []
  const tip: number[] = []
  const head: number[] = []
  const brand: number[] = []
  const idx: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[], ta: number, tb: number, br: number) => {
    const base = pos.length / 3
    pos.push(...a, ...b, ...c, ...d)
    tip.push(ta, ta, tb, tb)
    head.push(1, 1, 1, 1)
    brand.push(br, br, br, br)
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
  }
  for (let st = 0; st < 4; st++) {
    const a = rnd() * Math.PI * 2
    const r = 0.12 * Math.sqrt(rnd())
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r
    const h = 0.85 + rnd() * 0.35
    const lean = (rnd() - 0.5) * 0.25
    const nod = rnd() * Math.PI * 2
    const nx = Math.cos(nod), nz = Math.sin(nod)
    const br = rnd()
    const w = 0.009
    // stem
    for (let k = 0; k < 3; k++) {
      const t0 = k / 3, t1 = (k + 1) / 3
      const y0 = h * t0, y1 = h * t1
      const x0 = ox + lean * t0 * t0, x1 = ox + lean * t1 * t1
      quad([x0 - w, y0, oz], [x0 + w, y0, oz], [x1 - w, y1, oz], [x1 + w, y1, oz], t0 * 0.7, t1 * 0.7, br)
    }
    // plume: sprays fanning out from the top third, arching over towards the nod
    const topX = ox + lean, topY = h
    for (let k = 0; k < 7; k++) {
      const t = k / 6
      const sy = topY - 0.28 + t * 0.28
      const sx = ox + lean * Math.pow(sy / h, 2)
      const side = (k % 2 ? 1 : -1) * (0.6 + rnd() * 0.4)
      const len = 0.1 + 0.12 * (1 - t) + rnd() * 0.04
      const dx = nx * 0.7 + -nz * side * 0.6, dz = nz * 0.7 + nx * side * 0.6
      const ex = sx + dx * len, ez = oz + dz * len, ey = sy + 0.05 - len * 0.35
      const pw = 0.03 + 0.015 * (1 - t)
      quad([sx - nz * pw, sy, oz + nx * pw], [sx + nz * pw, sy, oz - nx * pw], [ex - nz * pw * 0.4, ey, ez + nx * pw * 0.4], [ex + nz * pw * 0.4, ey, ez - nx * pw * 0.4], 0.75, 1.0, br)
    }
    void topX
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setAttribute('aTip', new BufferAttribute(new Float32Array(tip), 1))
  g.setAttribute('aHead', new BufferAttribute(new Float32Array(head), 1))
  g.setAttribute('aBlade', new BufferAttribute(new Float32Array(brand), 1))
  g.setIndex(idx)
  return g
}

/** three crossed cards showing one atlas tile */
function cardGeometry(tile: number, w: number, h: number): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const tip: number[] = []
  const idx: number[] = []
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI
    const ax = Math.cos(a), az = Math.sin(a)
    const base = pos.length / 3
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      pos.push(ax * (u - 0.5) * w, v * h, az * (u - 0.5) * w)
      const [uu, vv] = tileUv(tile, u, v)
      uv.push(uu, vv)
      tip.push(v)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  g.setAttribute('aTip', new BufferAttribute(new Float32Array(tip), 1))
  g.setAttribute('aHead', new BufferAttribute(new Float32Array(tip.length), 1))
  g.setAttribute('aBlade', new BufferAttribute(new Float32Array(tip.length).fill(0.5), 1))
  g.setIndex(idx)
  return g
}

interface Ring {
  tile: number
  spacing: number
  inner: number
  outer: number
  shift: number
  /** 0 grass, 1 goldenrod, 2 aster */
  kind: number
  geo: BufferGeometry
}

const PLACE = /* glsl */ `
attribute vec2 aOff;
attribute vec2 aRnd;
attribute float aTip;
attribute float aHead;
attribute float aBlade;
uniform vec4 uRing;      // tile, inner, outer, forward shift
uniform float uRingKind; // 0 grass, 1 goldenrod, 2 aster
uniform float uSpacing;
uniform sampler2D uWindTex;
uniform vec4 uWindRect;
uniform vec2 uAmbientWind;
varying vec3 vGCol;
varying float vTipG;
varying float vHead;
varying vec3 vGTilt;
`

const PLACE_WORLD = /* glsl */ `
  vec2 fwd = normalize(uViewDir.xz + vec2(1e-5));
  vec2 center = uViewPos.xz + fwd * uRing.w;
  // the world position of this clump: the copy of its tile slot nearest the camera
  vec2 wp = aOff + uRing.x * floor((center - aOff) / uRing.x + 0.5);
  vec2 d = wp - uViewPos.xz;
  float dist = length(d);
  float fade = smoothstep(uRing.y - 3.0, uRing.y + 1.0, dist) * (1.0 - smoothstep(uRing.z * 0.78, uRing.z, dist));
  // nothing behind the camera
  if (dist > 3.0 && dot(d / dist, fwd) < -0.25) fade = 0.0;
  vec4 m = vfMeadowAt(wp);
  float open = m.r;
  float kind = m.g;
  float roadD = m.b * 25.5;
  // a ragged edge where the grass meets the gravel
  float edge = smoothstep(4.7, 6.0, roadD + (aRnd.x - 0.5) * 1.2);
  float dens;
  if (uRingKind < 0.5) {
    // meadows are thick; under the trees only the odd tuft survives
    dens = edge * (open * open * 1.02 + 0.03);
  } else {
    // wildflowers: only in the tall, unmown meadow
    float tall = (1.0 - smoothstep(0.3, 0.45, kind)) * smoothstep(9.0, 12.0, roadD);
    float patchy = smoothstep(0.36, 0.56, vfFbm(wp * (uRingKind < 1.5 ? 0.03 : 0.045) + uRingKind * 7.0));
    dens = edge * open * open * tall * patchy;
  }
  if (aRnd.x > dens) fade = 0.0;
  if (fade <= 0.001) {
    vfWorld = vec4(0.0, -1.0e5, 0.0, 1.0);
  } else {
    float h0 = vfGroundH(wp);
    // height by place: mown verge and lawns, stubble, tall meadow
    float mownV = 1.0 - smoothstep(8.5, 11.0, roadD);
    float lawn = smoothstep(0.3, 0.45, kind) * (1.0 - smoothstep(0.6, 0.75, kind));
    float hay = smoothstep(0.8, 0.95, kind);
    float tall = mix(0.85, 1.25, vfNoise(wp * 0.05));
    float hgt = mix(tall, 0.3, max(mownV, lawn));
    hgt = mix(hgt, 0.32, hay);
    if (open < 0.5) hgt *= 0.65;
    if (uRingKind > 0.5) hgt = uRingKind < 1.5 ? 1.0 : 0.85;
    float sc = hgt * (0.75 + 0.5 * aRnd.y) * fade;
    float rot = aRnd.y * 31.4;
    float c = cos(rot), s = sin(rot);
    vec3 lp = vec3(transformed.x * c - transformed.z * s, transformed.y, transformed.x * s + transformed.z * c);
    lp.xz *= mix(1.0, sc, 0.4);
    lp.y *= sc;
    vec3 wpos = vec3(wp.x, h0 - 0.02, wp.y) + lp;
    // wind: gusts from the field texture, plus slow waves rolling across the meadow
    vec4 wind = texture2D(uWindTex, (wp - uWindRect.xy) * uWindRect.zw);
    vec2 wdir = normalize(uAmbientWind + vec2(1e-4));
    float wave = sin(dot(wp, wdir) * 0.11 - uTime * 2.3 + vfNoise(wp * 0.02) * 5.0);
    float waveAmt = (0.5 + 0.5 * wave) * length(uAmbientWind) * 1.6;
    vec2 bend = (wind.rg - 0.5) * 2.4 + wdir * waveAmt;
    float t2 = aTip * aTip;
    wpos.xz += bend * t2 * 0.42 * sc;
    wpos.xz += vec2(sin(uTime * 3.3 + wp.x * 1.9), cos(uTime * 2.9 + wp.y * 1.7)) * 0.035 * t2 * (0.4 + wind.b);
    wpos.y -= dot(bend, bend) * t2 * 0.07 * sc;
    vfWorld = vec4(wpos, 1.0);
    if (uRingKind < 0.5) {
      vGCol = vfMeadowTone(wp, kind, roadD, aRnd.y);
      // every blade a little different: some bleached, some still green, some rusty
      vGCol *= 0.84 + 0.32 * aBlade;
      vGCol = mix(vGCol, vfSrgb(vec3(0.42, 0.47, 0.24)), step(0.86, aBlade) * 0.5);
      vGCol = mix(vGCol, vfSrgb(vec3(0.60, 0.33, 0.19)), step(aBlade, 0.1) * 0.5);
      // the light rolling over in the wave
      vGCol *= 1.0 + waveAmt * 0.18 * aTip;
    } else if (uRingKind < 1.5) {
      // some goldenrod still in bloom, most gone to soft buff seed
      vGCol = aRnd.y > 0.55 ? vfSrgb(vec3(0.86, 0.68, 0.22)) : vfSrgb(vec3(0.78, 0.72, 0.58));
    } else {
      vGCol = mix(vfSrgb(vec3(0.58, 0.46, 0.86)), vfSrgb(vec3(0.46, 0.33, 0.74)), aRnd.y);
    }
    vTipG = aTip;
    vHead = aHead;
    vGTilt = vec3(lp.x, 0.0, lp.z) * 0.35;
  }
`

export class Meadow {
  readonly group = new Group()
  private uniforms: Record<string, IUniform>

  constructor(ground: GroundGrid, atlas: Texture, density: number) {
    const tex = textures(ground)
    GROUND_U.uHeightTex.value = tex.h
    GROUND_U.uMeadowTex.value = tex.m
    GROUND_U.uGround.value.set(ground.min, ground.step, ground.n)
    this.uniforms = GROUND_U
    // spacing grows on lower tiers; clumps grow to match so the field stays full
    const k = 1 / Math.sqrt(Math.max(0.25, density))
    const rings: Ring[] = [
      { tile: 28, spacing: 0.3 * k, inner: -10, outer: 13, shift: 0, kind: 0, geo: clumpGeometry(7, 3, 0.16 * k, 0.026, 3) },
      { tile: 70, spacing: 0.72 * k, inner: 12, outer: 32, shift: 14, kind: 0, geo: clumpGeometry(10, 2, 0.4 * k, 0.04, 5) },
      { tile: 180, spacing: 1.9 * k, inner: 30, outer: 88, shift: 40, kind: 0, geo: clumpGeometry(14, 1, 1.05 * k, 0.08, 7) },
      { tile: 100, spacing: 1.7 * k, inner: -10, outer: 48, shift: 20, kind: 1, geo: plumeGeometry(11) },
      { tile: 100, spacing: 2.2 * k, inner: -10, outer: 42, shift: 20, kind: 2, geo: cardGeometry(TILE.aster, 0.75, 0.72) },
    ]
    for (const r of rings) this.group.add(this.ring(r, atlas))
    this.group.name = 'meadow'
  }

  private ring(r: Ring, atlas: Texture): Mesh {
    const n = Math.max(1, Math.round(r.tile / r.spacing))
    const count = n * n
    const off = new Float32Array(count * 2)
    const rr = new Float32Array(count * 2)
    const rnd = mulberry32(Math.round(r.tile * 13 + r.kind * 101))
    const cell = r.tile / n
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 2
        off[o] = (i + 0.1 + rnd() * 0.8) * cell
        off[o + 1] = (j + 0.1 + rnd() * 0.8) * cell
        rr[o] = rnd()
        rr[o + 1] = rnd()
      }
    }
    const geo = new InstancedBufferGeometry()
    geo.index = r.geo.index
    for (const name of Object.keys(r.geo.attributes)) geo.setAttribute(name, r.geo.getAttribute(name))
    geo.setAttribute('aOff', new InstancedBufferAttribute(off, 2))
    geo.setAttribute('aRnd', new InstancedBufferAttribute(rr, 2))
    geo.instanceCount = count
    const cards = r.kind > 1.5
    const mat = patchMaterial(new MeshLambertMaterial({ side: DoubleSide }), {
      key: cards ? 'meadow-cards' : 'meadow-grass',
      cloudShadows: true,
      uniforms: {
        ...this.uniforms,
        uRing: { value: new Vector4(r.tile, r.inner, r.outer, r.shift) },
        uRingKind: { value: r.kind },
        uSpacing: { value: r.spacing },
        uAtlas: { value: atlas },
      },
      vertexPars: PLACE + GLSL_GROUND + GLSL_MEADOW_TONE + (cards ? 'varying vec2 vCardUv;' : ''),
      vertexBegin: cards ? 'vCardUv = uv;' : '',
      vertexWorld: PLACE_WORLD,
      fragmentPars: /* glsl */ `
        varying vec3 vGCol;
        varying float vTipG;
        varying float vHead;
        varying vec3 vGTilt;
        uniform float uRingKind;
        vec3 vfSrgb(vec3 c) { return pow(c, vec3(2.2)); }
        uniform sampler2D uAtlas;
        ${cards ? 'varying vec2 vCardUv;' : ''}
        ${GLSL_SUN_SHADOW}
      `,
      fragmentColor: cards
        ? /* glsl */ `
          vec4 at = texture2D(uAtlas, vCardUv);
          float aa = (at.a - 0.5) / max(fwidth(at.a), 1e-4) + 0.5;
          if (aa < 0.5) discard;
          vec3 cc = vGCol * mix(0.55, 1.1, at.r) * (0.9 + 0.2 * at.g);
          if (at.b > 0.5) cc = (uRingKind > 1.5 && at.r > 0.7) ? vec3(0.62, 0.42, 0.04) : vec3(0.07, 0.07, 0.035);
          diffuseColor.rgb = cc;
        `
        : /* glsl */ `
          // darker down among the stems, bright at the tips
          vec3 gc;
          if (uRingKind > 0.5) {
            // goldenrod: olive stems under a fluffy plume
            gc = mix(vfSrgb(vec3(0.36, 0.36, 0.2)) * mix(0.5, 1.0, vTipG), vGCol, smoothstep(0.68, 0.76, vTipG));
          } else {
            gc = vGCol * mix(0.42, 1.05, vTipG);
            // bleached seed heads
            gc = mix(gc, vfSrgb(vec3(0.82, 0.76, 0.62)), vHead * smoothstep(0.72, 0.9, vTipG) * 0.6);
          }
          diffuseColor.rgb = gc;
        `,
      fragmentNormal: /* glsl */ `
        // light the blades like the meadow surface they belong to, never from behind
        normal = normalize((viewMatrix * vec4(normalize(vec3(0.0, 1.0, 0.0) + vGTilt), 0.0)).xyz);
      `,
      fragmentOutgoing: /* glsl */ `
        {
          // the low sun glows through seed heads and blade tips when you look towards it
          vec3 V = normalize(cameraPosition - vAtmoWorld);
          float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
          float sh = vfSunShadow() * vfCloudShade(vAtmoWorld);
          outgoingLight += vGCol * uSunColor * back * sh * vTipG * (0.55 + vHead * 0.6);
        }
      `,
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.name = cards ? 'meadow-flowers' : 'meadow-grass'
    return mesh
  }

  /** only drawn close to the ground */
  update(aboveGround: number) {
    this.group.visible = aboveGround < 70
    GROUND_U.uGrassOn.value = 1 - Math.min(1, Math.max(0, (aboveGround - 40) / 30))
  }
}
