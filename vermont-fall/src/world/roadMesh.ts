import { BufferAttribute, BufferGeometry, Mesh, MeshLambertMaterial } from 'three'
import { patchMaterial } from '../render/shared'
import type { Terrain } from './terrain'

/** Cross-section: lateral offset (m) and height relative to the road surface. */
const SECTION: [number, number][] = [
  [-5.7, -0.34],
  [-4.7, -0.07],
  [-3.35, -0.02],
  [-1.7, 0.03],
  [0, 0.06],
  [1.7, 0.03],
  [3.35, -0.02],
  [4.7, -0.07],
  [5.7, -0.34],
]

export function buildRoadMesh(T: Terrain): Mesh {
  const r = T.road
  const b = T.bridge
  const step = 1.5
  // start at the far end of the bridge and go all the way round to its near end
  const sStart = b.s1 - 0.4
  const sEnd = b.s0 + r.length + 0.4
  const rows = Math.ceil((sEnd - sStart) / step) + 1
  const cols = SECTION.length
  const pos = new Float32Array(rows * cols * 3)
  const uv = new Float32Array(rows * cols * 2)
  const nor = new Float32Array(rows * cols * 3)
  const p = { x: 0, z: 0, tx: 0, tz: 0 }
  for (let j = 0; j < rows; j++) {
    const s = Math.min(sStart + j * step, sEnd)
    r.sample(s, p)
    const y = T.roadYAt(s)
    const rx = -p.tz, rz = p.tx
    for (let i = 0; i < cols; i++) {
      const [lat, dy] = SECTION[i]
      const k = j * cols + i
      pos[k * 3] = p.x + rx * lat
      pos[k * 3 + 1] = y + dy
      pos[k * 3 + 2] = p.z + rz * lat
      uv[k * 2] = lat
      uv[k * 2 + 1] = s
      nor[k * 3 + 1] = 1
    }
  }
  const idx: number[] = []
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, bb = a + 1, c = a + cols, d = c + 1
      // travel direction is +rows; right side is +cols -> keep faces pointing up
      idx.push(a, bb, c, bb, d, c)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('normal', new BufferAttribute(nor, 3))
  geo.setAttribute('uv', new BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  const mat = new MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  patchMaterial(mat, {
    key: 'road',
    cloudShadows: true,
    vertexPars: /* glsl */ `varying vec2 vRoadUv;`,
    vertexBegin: /* glsl */ `vRoadUv = uv;`,
    fragmentPars: /* glsl */ `
      varying vec2 vRoadUv;
      vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
      float vfLine(float x, float c, float w) {
        float fw = max(fwidth(x), 1e-4);
        float d = abs(x - c) - w * 0.5;
        return 1.0 - smoothstep(-fw, fw, d);
      }
    `,
    fragmentColor: /* glsl */ `
      {
        float u = vRoadUv.x;
        float v = vRoadUv.y;
        float au = abs(u);
        vec2 wp = vAtmoWorld.xz;
        // asphalt: aggregate speckle, patched repairs, worn wheel tracks
        float n1 = vfNoise(wp * 3.1);
        float n2 = vfFbm(vec2(u * 0.6, v * 0.08));
        vec3 asph = mix(srgb(0.23, 0.23, 0.235), srgb(0.30, 0.30, 0.30), n1 * 0.6 + n2 * 0.4);
        float patchN = smoothstep(0.62, 0.66, vfFbm(vec2(u * 0.25 + 3.0, v * 0.035)));
        asph = mix(asph, srgb(0.17, 0.17, 0.18), patchN * 0.8);
        float track = exp(-pow((au - 1.65) / 0.45, 2.0));
        asph = mix(asph, srgb(0.33, 0.33, 0.32), track * 0.35);
        // tar-sealed seams running along the lane
        float seam = smoothstep(0.03, 0.0, abs(u - 1.1 + 0.25 * vfNoise(vec2(v * 0.05, 3.0)))) * smoothstep(0.5, 0.65, vfNoise(vec2(v * 0.02, 1.0)));
        float crack = seam * 0.5;
        asph = mix(asph, srgb(0.14, 0.14, 0.14), crack);
        // markings: solid white edge lines, double yellow centre (faded, Vermont back road)
        float wear = 0.65 + 0.35 * vfNoise(vec2(u * 6.0, v * 1.7));
        float edge = vfLine(au, 3.05, 0.11) * wear;
        float yel = (vfLine(u, -0.11, 0.1) + vfLine(u, 0.11, 0.1)) * wear;
        // markings fade out when they are much thinner than a pixel (aerial view)
        float px = fwidth(u);
        float vis = 1.0 - smoothstep(0.2, 0.7, px);
        vec3 col = asph;
        col = mix(col, srgb(0.86, 0.85, 0.80), edge * vis);
        col = mix(col, srgb(0.86, 0.66, 0.18), clamp(yel, 0.0, 1.0) * vis);
        // gravel shoulder blending into the verge
        float shoulder = smoothstep(3.3, 3.5, au);
        vec3 grav = mix(srgb(0.46, 0.42, 0.36), srgb(0.36, 0.31, 0.25), vfNoise(wp * 4.0));
        grav = mix(grav, srgb(0.40, 0.36, 0.20), smoothstep(4.2, 5.4, au));
        col = mix(col, grav, shoulder);
        diffuseColor.rgb = col;
      }
    `,
  })
  const mesh = new Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'road'
  return mesh
}
