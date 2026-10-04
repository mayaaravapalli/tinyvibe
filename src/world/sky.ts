import { BackSide, Mesh, ShaderMaterial, SphereGeometry, type IUniform } from 'three'
import { GLSL_ATMO, GLSL_NOISE, U } from '../render/shared'

/** Soft pale-blue sky warming to cream at the horizon, with a few restrained clouds. */
export function buildSky(): Mesh {
  const geo = new SphereGeometry(1, 48, 24)
  const uniforms: Record<string, IUniform> = {}
  for (const k of Object.keys(U) as (keyof typeof U)[]) uniforms[k] = U[k] as IUniform
  const mat = new ShaderMaterial({
    uniforms,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uCloudOffset;
      varying vec3 vDir;
      ${GLSL_NOISE}
      ${GLSL_ATMO}
      void main() {
        vec3 dir = normalize(vDir);
        vec3 col = vfSky(dir, 1.0);
        // restrained clouds: a few soft fair-weather wisps, lit warm from the low sun
        if (dir.y > 0.0) {
          vec2 p = dir.xz / (dir.y + 0.12) * 1.6;
          p += uCloudOffset / 1500.0;
          float n = vfFbm(p * 0.9 + vec2(3.1, 7.7));
          float n2 = vfFbm(p * 2.7 + vec2(1.3, 2.9));
          float c = smoothstep(0.55, 0.78, n * 0.8 + n2 * 0.25);
          c *= smoothstep(0.02, 0.18, dir.y) * (1.0 - smoothstep(0.5, 0.9, dir.y));
          float cs = max(dot(dir, uSunDir), 0.0);
          vec3 cloudCol = mix(vec3(0.95, 0.93, 0.92), uSunColor * 1.05, 0.35 + 0.4 * pow(cs, 3.0));
          cloudCol *= 0.9 + 0.2 * n2;
          col = mix(col, cloudCol, c * 0.55);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  mesh.name = 'sky'
  return mesh
}
