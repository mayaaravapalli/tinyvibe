import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, type Texture } from 'three'
import { smoothstep } from '../core/noise'
import { GLSL_BUMP, patchMaterial } from '../render/shared'
import type { Terrain } from './terrain'

/** The brook: a shallow ribbon of moving water in its channel. */
export function buildWater(T: Terrain, env: Texture | null): Mesh {
  const st = T.stream
  const step = 2
  const s0 = 34
  const rows = Math.floor((st.length - s0) / step)
  const cols = 7
  const pos = new Float32Array(rows * cols * 3)
  const uv = new Float32Array(rows * cols * 2)
  const p = { x: 0, z: 0, tx: 0, tz: 0 }
  for (let j = 0; j < rows; j++) {
    const s = s0 + j * step
    st.sample(s, p)
    const src = smoothstep(0, 90, s)
    const half = 3.2 * (0.35 + 0.65 * src) + 1.7
    const y = T.streamBedAt(s) + 0.42 + 0.25 * (1 - src)
    for (let i = 0; i < cols; i++) {
      const u = (i / (cols - 1)) * 2 - 1
      const k = j * cols + i
      pos[k * 3] = p.x - p.tz * u * half
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = p.z + p.tx * u * half
      uv[k * 2] = u
      uv[k * 2 + 1] = s
    }
  }
  const idx: number[] = []
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1
      idx.push(a, b, c, b, d, c)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('uv', new BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  // the ribbon is generated with consistent winding; make sure normals point up
  const n = geo.getAttribute('normal') as BufferAttribute
  if (n.getY(0) < 0) {
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
    const ix = geo.getIndex()!
    for (let i = 0; i < ix.count; i += 3) {
      const t = ix.getX(i + 1)
      ix.setX(i + 1, ix.getX(i + 2))
      ix.setX(i + 2, t)
    }
  }
  geo.computeBoundingSphere()

  const mat = new MeshStandardMaterial({
    color: new Color('#26342f'),
    roughness: 0.07,
    metalness: 0,
    envMap: env,
    envMapIntensity: 0.85,
  })
  patchMaterial(mat, {
    key: 'brook',
    cloudShadows: true,
    vertexPars: 'varying vec2 vWUv;',
    vertexBegin: 'vWUv = uv;',
    fragmentPars: /* glsl */ `
      varying vec2 vWUv;
      ${GLSL_BUMP}
      float vfRipple(vec2 q) {
        // q.x across the brook, q.y downstream (metres); the water runs downstream
        vec2 a = vec2(q.x * 0.9, q.y * 0.35 - uTime * 0.9);
        vec2 b = vec2(q.x * 2.1 + 3.0, q.y * 0.9 - uTime * 1.6);
        return vfNoise(a) * 0.65 + vfNoise(b) * 0.35;
      }
    `,
    fragmentColor: /* glsl */ `
      {
        float edge = smoothstep(0.55, 1.0, abs(vWUv.x));
        // shallows near the banks show the stony bed
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.075, 0.055), edge * 0.6);
        float foam = smoothstep(0.78, 0.92, vfRipple(vWUv * vec2(4.0, 1.5) + 7.0)) * (0.3 + 0.7 * edge);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.74, 0.70), foam * 0.35);
      }
    `,
    fragmentNormal: /* glsl */ `
      {
        float h = vfRipple(vec2(vWUv.x * 4.0, vWUv.y)) * 0.05;
        normal = vfBump(normal, -vViewPosition, h, faceDirection);
      }
    `,
  })
  const mesh = new Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'brook'
  return mesh
}
