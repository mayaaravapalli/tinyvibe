import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Sphere,
  MeshLambertMaterial,
  Vector3,
  Vector4,
} from 'three'
import { smoothstep } from '../core/noise'
import { patchMaterial } from '../render/shared'
import { FAR, NEAR, NEAR_STEP, type Terrain } from './terrain'
import { TREE_RECT, forestDensity, treeRegionWeight } from './forest'

/** Warped axis: uniform 5 m inside the detailed region, then growing towards the horizon. */
function axisCoords(): Float32Array {
  const inner: number[] = []
  const n = Math.round((2 * NEAR) / NEAR_STEP)
  for (let k = 0; k <= n; k++) inner.push(-NEAR + k * NEAR_STEP)
  const outer: number[] = []
  let v = NEAR
  let step = NEAR_STEP
  while (v < FAR) {
    step *= 1.065
    v = Math.min(FAR, v + step)
    outer.push(v)
  }
  const neg = outer.map((o) => -o).reverse()
  return new Float32Array([...neg, ...inner, ...outer])
}

/** Coarse uniform height grid covering everything, for sun-occlusion marching. */
class CoarseHeights {
  readonly step = 50
  readonly n: number
  readonly h: Float32Array
  constructor(private T: Terrain) {
    this.n = Math.round((2 * FAR) / this.step) + 1
    this.h = new Float32Array(this.n * this.n)
    for (let j = 0; j < this.n; j++) {
      const z = -FAR + j * this.step
      for (let i = 0; i < this.n; i++) {
        const x = -FAR + i * this.step
        this.h[j * this.n + i] = Math.abs(x) < NEAR && Math.abs(z) < NEAR ? T.heightAt(x, z) : T.compute(x, z)
      }
    }
  }
  at(x: number, z: number): number {
    if (Math.abs(x) < NEAR - 10 && Math.abs(z) < NEAR - 10) return this.T.heightAt(x, z)
    const fx = (x + FAR) / this.step
    const fz = (z + FAR) / this.step
    const n = this.n
    if (fx < 0 || fz < 0 || fx >= n - 1 || fz >= n - 1) return 0
    const i = Math.floor(fx), j = Math.floor(fz)
    const tx = fx - i, tz = fz - j
    const a = this.h[j * n + i], b = this.h[j * n + i + 1]
    const c = this.h[(j + 1) * n + i], d = this.h[(j + 1) * n + i + 1]
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
  }
}

export interface TerrainBuild {
  mesh: Group
  coarse: CoarseHeights
  /** baked sun visibility (0..1) on the detailed grid */
  sunVisAt: (x: number, z: number) => number
  groundAt: (x: number, z: number) => number
}

export function buildTerrainMesh(T: Terrain, sunDir: Vector3): TerrainBuild {
  const A = axisCoords()
  const N = A.length
  const innerStart = A.indexOf(-NEAR)
  const gridN = T.gridN
  const pos = new Float32Array(N * N * 3)
  const nor = new Float32Array(N * N * 3)
  const mask = new Float32Array(N * N * 4)
  const hs = new Float32Array(N * N)

  for (let j = 0; j < N; j++) {
    const z = A[j]
    const gj = j - innerStart
    for (let i = 0; i < N; i++) {
      const x = A[i]
      const gi = i - innerStart
      let h: number
      if (gi >= 0 && gj >= 0 && gi < gridN && gj < gridN) h = T.heights[gj * gridN + gi]
      else h = T.compute(x, z)
      hs[j * N + i] = h
    }
  }

  const coarse = new CoarseHeights(T)

  // sun occlusion: march towards the sun across the land (long golden-hour shadows)
  const sh = Math.hypot(sunDir.x, sunDir.z)
  const sx = sunDir.x / sh, sz = sunDir.z / sh
  const tanSun = sunDir.y / sh

  const kind = { field: 1, lawn: 0.5, meadow: 0.0, overlook: 0.15 } as const
  const hit = { d: 0, s: 0, lat: 0 }

  for (let j = 0; j < N; j++) {
    const z = A[j]
    for (let i = 0; i < N; i++) {
      const x = A[i]
      const k = j * N + i
      const h = hs[k]
      // normals from central differences on the warped grid
      const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1)
      const j0 = Math.max(0, j - 1), j1 = Math.min(N - 1, j + 1)
      const dhx = (hs[j * N + i1] - hs[j * N + i0]) / (A[i1] - A[i0])
      const dhz = (hs[j1 * N + i] - hs[j0 * N + i]) / (A[j1] - A[j0])
      const l = Math.hypot(dhx, 1, dhz)
      nor[k * 3] = -dhx / l
      nor[k * 3 + 1] = 1 / l
      nor[k * 3 + 2] = -dhz / l

      // masks
      const inCore = Math.abs(x) < NEAR && Math.abs(z) < NEAR
      const forest = inCore ? forestDensity(T, x, z) : 1 - T.clearing(x, z)
      const ck = T.clearingKind(x, z)
      let wet = 0
      if (inCore && T.streamNearest(x, z, 14, hit)) wet = 1 - smoothstep(2.5, 10, hit.d)

      // baked sun visibility
      let maxTan = -1
      let t = 4
      const reach = Math.abs(x) < 3000 && Math.abs(z) < 3000 ? 4200 : 2200
      while (t < reach) {
        const hh = coarse.at(x + sx * t, z + sz * t)
        const tn = (hh - h) / t
        if (tn > maxTan) maxTan = tn
        t = t * 1.1 + 3
      }
      const vis = smoothstep(-0.035, 0.03, tanSun - maxTan)

      mask[k * 4] = forest
      mask[k * 4 + 1] = ck ? kind[ck] : 0
      mask[k * 4 + 2] = wet
      mask[k * 4 + 3] = vis

      // far forests get a canopy "skin" so ridgelines carry the height of the trees
      const region = treeRegionWeight(x, z)
      const skin = 8 * smoothstep(0.35, 0.8, forest) * (1 - region)
      pos[k * 3] = x
      pos[k * 3 + 1] = h + skin
      pos[k * 3 + 2] = z
    }
  }

  // shared vertex buffers, split into tiles so the camera only draws what it sees
  const posA = new BufferAttribute(pos, 3)
  const norA = new BufferAttribute(nor, 3)
  const maskA = new BufferAttribute(mask, 4)
  const TILE = 72
  const tiles: BufferGeometry[] = []
  for (let tj = 0; tj < N - 1; tj += TILE) {
    for (let ti = 0; ti < N - 1; ti += TILE) {
      const j1 = Math.min(N - 1, tj + TILE), i1 = Math.min(N - 1, ti + TILE)
      const idx = new Uint32Array((j1 - tj) * (i1 - ti) * 6)
      let o = 0
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let j = tj; j < j1; j++) {
        for (let i = ti; i < i1; i++) {
          const a = j * N + i
          const b = a + 1
          const c = a + N
          const d = c + 1
          idx[o++] = a; idx[o++] = c; idx[o++] = b
          idx[o++] = b; idx[o++] = c; idx[o++] = d
        }
      }
      for (const j of [tj, j1]) for (const i of [ti, i1]) {
        minX = Math.min(minX, A[i]); maxX = Math.max(maxX, A[i])
        minZ = Math.min(minZ, A[j]); maxZ = Math.max(maxZ, A[j])
      }
      for (let j = tj; j <= j1; j += 4) for (let i = ti; i <= i1; i += 4) {
        const y = pos[(j * N + i) * 3 + 1]
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
      const g = new BufferGeometry()
      g.setAttribute('position', posA)
      g.setAttribute('normal', norA)
      g.setAttribute('aMask', maskA)
      g.setIndex(new BufferAttribute(idx, 1))
      g.boundingBox = new Box3(new Vector3(minX, minY - 20, minZ), new Vector3(maxX, maxY + 30, maxZ))
      g.boundingSphere = g.boundingBox.getBoundingSphere(new Sphere())
      tiles.push(g)
    }
  }

  const mat = new MeshLambertMaterial({ color: 0xffffff })
  patchMaterial(mat, {
    key: 'terrain',
    cloudShadows: true,
    sunVis: 'vSunVis',
    uniforms: {
      uTreeRect: { value: new Vector4(TREE_RECT.minX, TREE_RECT.minZ, TREE_RECT.maxX, TREE_RECT.maxZ) },
      uTreeFeather: { value: TREE_RECT.feather },
    },
    vertexPars: /* glsl */ `
      attribute vec4 aMask;
      varying vec4 vMask;
      varying float vSunVis;
      varying vec3 vWN;
    `,
    vertexBegin: /* glsl */ `
      vMask = aMask;
      vSunVis = aMask.w;
      vWN = objectNormal;
    `,
    fragmentPars: /* glsl */ `
      varying vec4 vMask;
      varying float vSunVis;
      varying vec3 vWN;
      uniform vec4 uTreeRect;
      uniform float uTreeFeather;
      uniform sampler2D uWindTex;
      uniform vec4 uWindRect;
      vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }

      float vfTreeRegion(vec2 p) {
        float f = uTreeFeather;
        float wx = min(smoothstep(uTreeRect.x, uTreeRect.x + f, p.x), 1.0 - smoothstep(uTreeRect.z - f, uTreeRect.z, p.x));
        float wz = min(smoothstep(uTreeRect.y, uTreeRect.y + f, p.y), 1.0 - smoothstep(uTreeRect.w - f, uTreeRect.w, p.y));
        return min(wx, wz);
      }

      // stand weights (gold, orange, red, yellow-green) — mirrors colors.ts
      vec4 vfStandW(float lean) {
        vec4 g = vec4(0.66, 0.16, 0.05, 0.13);
        vec4 o = vec4(0.12, 0.72, 0.09, 0.07);
        vec4 c = vec4(0.05, 0.30, 0.58, 0.07);
        float t = lean * 2.0;
        vec4 w = t < 1.0 ? mix(g, o, t) : mix(o, c, t - 1.0);
        return w / dot(w, vec4(1.0));
      }
      const vec3 cGold = vec3(0.70, 0.33, 0.025);
      const vec3 cOrange = vec3(0.55, 0.14, 0.022);
      const vec3 cRed = vec3(0.27, 0.025, 0.028);
      const vec3 cYg = vec3(0.36, 0.37, 0.05);
      const vec3 cEver = vec3(0.035, 0.075, 0.042);

      vec3 vfAutumn(float lean, float h, float h2, float ever) {
        if (h2 < ever) return mix(cEver, cEver * 1.6, h);
        vec4 w = vfStandW(lean);
        float t = h;
        float j = 0.85 + 0.3 * fract(h * 13.7);
        if (t < w.y) return cOrange * j;
        t -= w.y;
        if (t < w.x) return cGold * j;
        t -= w.x;
        if (t < w.z) return cRed * j;
        return cYg * j;
      }
      vec3 vfStandColor(float lean, float ever) {
        vec4 w = vfStandW(lean);
        vec3 hard = cGold * w.x + cOrange * w.y + cRed * w.z + cYg * w.w;
        return mix(hard, cEver * 1.25, ever);
      }

      // canopy painted onto distant hillsides: one Worley cell per crown, filtered to the
      // stand's expected colour once crowns shrink below a pixel
      vec3 vfCanopy(vec3 wp, out float shade) {
        vec2 p = wp.xz / 11.0;
        vec2 i = floor(p);
        vec2 f = fract(p);
        float d1 = 8.0;
        vec2 cid = vec2(0.0);
        vec2 rel = vec2(0.0);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(float(x), float(y));
            vec2 r = o + vfHash22(i + o) * 0.9 - f;
            float d = dot(r, r);
            if (d < d1) { d1 = d; cid = i + o; rel = r; }
          }
        }
        float h = vfHash12(cid * 1.37 + 0.5);
        float h2 = vfHash12(cid * 2.11 + 3.1);
        vec2 sw = wp.xz;
        float lean = smoothstep(0.3, 0.7, vfFbm(sw / 360.0 + 3.0));
        float ever = 0.06 + 0.75 * smoothstep(0.5, 0.66, vfFbm(sw / 240.0 + 11.0)) + 0.22 * smoothstep(80.0, 320.0, wp.y);
        ever = clamp(ever, 0.0, 0.92);
        vec3 c = vfAutumn(lean, h, h2, ever);
        float dome = 1.0 - smoothstep(0.0, 0.9, sqrt(d1));
        float side = dot(normalize(-rel + 1e-4), normalize(uSunDir.xz)) * 0.5 + 0.5;
        shade = mix(0.42, 1.12, dome) * mix(0.8, 1.15, side * dome);
        // once crowns shrink below a pixel keep some of their grain: a forest reads
        // as texture, a fully averaged one reads as grass
        float fw = smoothstep(0.25, 1.1, length(fwidth(p)));
        c = mix(c, vfStandColor(lean, ever), fw * 0.55);
        shade = mix(shade, mix(0.45, 0.62, h), fw * 0.7);
        // distant hillsides lose saturation before the haze takes them
        float dd = smoothstep(1500.0, 6000.0, distance(wp, cameraPosition));
        c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))) * vec3(1.05, 0.95, 0.85), dd * 0.45);
        return c;
      }
    `,
    fragmentColor: /* glsl */ `
      {
        vec3 wp = vAtmoWorld;
        vec3 N = normalize(vWN);
        float forest = vMask.x;
        float ftype = vMask.y;
        float wet = vMask.z;

        float m1 = vfFbm(wp.xz * 0.045);
        float m2 = vfNoise(wp.xz * 0.7);
        float m3 = vfFbm(wp.xz * 0.012 + 5.0);
        vec3 meadow = mix(srgb(0.66, 0.58, 0.30), srgb(0.76, 0.64, 0.36), m1);
        meadow = mix(meadow, srgb(0.50, 0.53, 0.26), smoothstep(0.45, 0.72, m3) * 0.6);
        meadow = mix(meadow, srgb(0.62, 0.42, 0.26), smoothstep(0.62, 0.8, vfFbm(wp.xz * 0.03 + 9.0)) * 0.5);
        meadow *= 0.88 + 0.22 * m2;
        float sArg = dot(wp.xz, vec2(0.8, 0.6)) * 0.42;
        float sFade = 1.0 - smoothstep(0.25, 0.9, fwidth(sArg));
        float stripe = sin(sArg) * sFade;
        vec3 hay = mix(srgb(0.78, 0.70, 0.42), srgb(0.62, 0.60, 0.32), smoothstep(-0.25, 0.25, stripe) * sFade + 0.5 * (1.0 - sFade));
        hay *= 0.92 + 0.12 * m2;
        vec3 lawn = mix(srgb(0.44, 0.47, 0.24), srgb(0.55, 0.53, 0.29), m1) * (0.92 + 0.12 * m2);
        vec3 openC = mix(meadow, lawn, smoothstep(0.25, 0.5, ftype));
        openC = mix(openC, hay, smoothstep(0.75, 0.95, ftype));
        // far-off fields read as warm stubble, never as water
        float fo = smoothstep(1800.0, 3200.0, distance(wp, cameraPosition));
        openC = mix(openC, srgb(0.55, 0.45, 0.28) * (0.85 + 0.2 * m1), fo * 0.8);

        vec3 floorC = mix(srgb(0.15, 0.11, 0.075), srgb(0.29, 0.18, 0.10), vfNoise(wp.xz * 0.9));
        floorC = mix(floorC, srgb(0.36, 0.22, 0.10), smoothstep(0.78, 0.92, vfNoise(wp.xz * 3.1)) * 0.45);
        floorC = mix(floorC, srgb(0.22, 0.25, 0.13), smoothstep(0.62, 0.82, vfNoise(wp.xz * 0.11)) * 0.5);

        float region = vfTreeRegion(wp.xz);
        float paint = smoothstep(0.3, 0.75, forest) * (1.0 - region);
        float cshade;
        vec3 canopy = vfCanopy(wp, cshade) * cshade;

        float rock = smoothstep(0.42, 0.62, 1.0 - N.y + 0.15 * (vfNoise(wp.xz * 0.08) - 0.5));
        vec3 rockC = mix(srgb(0.42, 0.41, 0.39), srgb(0.58, 0.57, 0.52), vfNoise(wp.xz * 0.35));
        rockC = mix(rockC, srgb(0.47, 0.50, 0.37), smoothstep(0.6, 0.8, vfNoise(wp.xz * 1.3)) * 0.4);

        // catspaws: grass bends and flashes paler where a gust runs over the field
        vec4 wtex = texture2D(uWindTex, (wp.xz - uWindRect.xy) * uWindRect.zw);
        vec2 bend = (wtex.rg - 0.5) * 2.0;
        float streak = vfNoise(wp.xz * 0.11 + bend * 6.0 + vec2(uTime * 0.6, 0.0));
        float gust = clamp(wtex.b * 1.3, 0.0, 1.0) * (0.55 + 0.45 * streak);
        openC = mix(openC, openC * 1.32 + vec3(0.035, 0.03, 0.015), gust * 0.75);
        vec3 col = mix(openC, floorC, smoothstep(0.25, 0.75, forest));
        col = mix(col, rockC, rock * (1.0 - paint));
        col = mix(col, canopy, paint);
        col = mix(col, srgb(0.21, 0.16, 0.11), wet * 0.85);
        // close to the camera: grass streaks, bare soil, and a carpet of fallen leaves
        float dCam = distance(wp, cameraPosition);
        float nearD = 1.0 - smoothstep(20.0, 80.0, dCam);
        if (nearD > 0.0) {
          float gs = vfNoise(wp.xz * vec2(3.1, 9.0)) * 0.6 + vfNoise(wp.xz * vec2(7.3, 2.4) + 3.0) * 0.4;
          float soil = smoothstep(0.62, 0.8, vfNoise(wp.xz * 1.1 + 9.0));
          vec3 openNear = col * (0.72 + 0.45 * gs);
          openNear = mix(openNear, srgb(0.30, 0.24, 0.16), soil * 0.35);
          // individual fallen leaves: a small rotated ellipse per 25 cm cell
          vec2 cellP = wp.xz * 4.0;
          vec2 cid = floor(cellP);
          float lc = vfHash12(cid);
          vec2 q = fract(cellP) - 0.5 - (vfHash22(cid) - 0.5) * 0.4;
          float la = lc * 6.2831;
          q = mat2(cos(la), -sin(la), sin(la), cos(la)) * q;
          float shape = 1.0 - smoothstep(0.85, 1.0, length(q / vec2(0.36, 0.22)));
          float leafy = shape * step(0.42, lc) * smoothstep(0.35, 0.6, vfNoise(wp.xz * 0.9 + 2.0) + 0.25);
          vec3 leafCol = lc > 0.8 ? srgb(0.70, 0.30, 0.08) : lc > 0.65 ? srgb(0.75, 0.52, 0.14) : lc > 0.5 ? srgb(0.52, 0.12, 0.08) : srgb(0.40, 0.26, 0.14);
          vec3 floorNear = mix(col * (0.8 + 0.3 * gs), leafCol, leafy * 0.8);
          float fm = smoothstep(0.25, 0.75, forest);
          col = mix(col, mix(openNear, floorNear, fm), nearD * (1.0 - paint));
        }
        diffuseColor.rgb = col;
      }
    `,
  })

  // hills already carry their baked golden-hour shadows, so the land casts none
  const mesh = new Group()
  mesh.name = 'terrain'
  for (const g of tiles) {
    const m = new Mesh(g, mat)
    m.receiveShadow = true
    m.castShadow = false
    m.frustumCulled = true
    mesh.add(m)
  }
  // bilinear lookup on the warped grid (binary search on the shared axis)
  const axisIndex = (v: number) => {
    let lo = 0, hi = N - 1
    if (v <= A[0]) return 0
    if (v >= A[N - 1]) return N - 2
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (A[mid] <= v) lo = mid
      else hi = mid
    }
    return lo
  }
  const sunVisAt = (x: number, z: number) => {
    const i = axisIndex(x), j = axisIndex(z)
    const tx = Math.min(1, Math.max(0, (x - A[i]) / (A[i + 1] - A[i])))
    const tz = Math.min(1, Math.max(0, (z - A[j]) / (A[j + 1] - A[j])))
    const m = (ii: number, jj: number) => mask[(jj * N + ii) * 4 + 3]
    return (m(i, j) * (1 - tx) + m(i + 1, j) * tx) * (1 - tz) + (m(i, j + 1) * (1 - tx) + m(i + 1, j + 1) * tx) * tz
  }
  /** ground height under the canopy skin (true terrain) */
  const groundAt = (x: number, z: number) => {
    const i = axisIndex(x), j = axisIndex(z)
    const tx = Math.min(1, Math.max(0, (x - A[i]) / (A[i + 1] - A[i])))
    const tz = Math.min(1, Math.max(0, (z - A[j]) / (A[j + 1] - A[j])))
    const m = (ii: number, jj: number) => hs[jj * N + ii]
    return (m(i, j) * (1 - tx) + m(i + 1, j) * tx) * (1 - tz) + (m(i, j + 1) * (1 - tx) + m(i + 1, j + 1) * tx) * tz
  }
  return { mesh, coarse, sunVisAt, groundAt }
}
