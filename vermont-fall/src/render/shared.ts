import {
  Color,
  DataTexture,
  Material,
  ShaderChunk,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
  type WebGLProgramParametersWithUniforms,
} from 'three'

/** Uniforms shared by every material in the world (same objects, so one update reaches all). */
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new Vector3(-0.7, 0.25, -0.3).normalize() },
  uSunColor: { value: new Color(1, 0.8, 0.6) },
  uSkyZenith: { value: new Color('#7aa3d2') },
  uSkyHorizonSun: { value: new Color('#ecd0a4') },
  uSkyHorizonAway: { value: new Color('#d6dcdc') },
  uHazeCool: { value: new Color('#a9bccf') },
  uFogA: { value: 0.000014 },
  uFogB: { value: 0.00000011 },
  uFogFalloff: { value: 0.0014 },
  uFogBase: { value: -20 },
  /** main view camera position (also valid inside the shadow pass) */
  uViewPos: { value: new Vector3() },
  /** main view camera forward direction */
  uViewDir: { value: new Vector3(0, 0, -1) },
  /** wind field texture: rg = bend displacement (m), b = gust energy, a = unused */
  uWindTex: { value: null as DataTexture | null },
  /** xy = world min corner, zw = 1 / world size */
  uWindRect: { value: new Vector4(-1400, -1400, 1 / 2800, 1 / 2800) },
  uAmbientWind: { value: new Vector2(0.8, 0.3) },
  uCloudOffset: { value: new Vector2(0, 0) },
  uCloudShadow: { value: 0.32 },
  /** 0 aerial, 1 POV — lets shaders shift detail with the camera */
  uPov: { value: 0 },
  /** near-tree radius used for LOD cross fades: x = start, y = end */
  uLodRange: { value: new Vector2(95, 135) },
}

export type SharedUniforms = typeof U

// ------------------------------------------------------------------ GLSL

export const GLSL_NOISE = /* glsl */ `
float vfHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 vfHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vfHash12(i);
  float b = vfHash12(i + vec2(1.0, 0.0));
  float c = vfHash12(i + vec2(0.0, 1.0));
  float d = vfHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vfFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vfNoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
float vfNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  float a = vfHash12(vec2(n, 0.0));
  float b = vfHash12(vec2(n + 1.0, 0.0));
  float c = vfHash12(vec2(n + 57.0, 0.0));
  float d = vfHash12(vec2(n + 58.0, 0.0));
  float e = vfHash12(vec2(n + 113.0, 0.0));
  float f1 = vfHash12(vec2(n + 114.0, 0.0));
  float g = vfHash12(vec2(n + 170.0, 0.0));
  float h = vfHash12(vec2(n + 171.0, 0.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
`

export const GLSL_ATMO = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizonSun;
uniform vec3 uSkyHorizonAway;
uniform vec3 uHazeCool;
uniform float uFogA;
uniform float uFogB;
uniform float uFogFalloff;
uniform float uFogBase;

vec3 vfHorizon(vec3 dir) {
  vec2 hd = normalize(dir.xz + vec2(1e-5));
  vec2 hs = normalize(uSunDir.xz + vec2(1e-5));
  float az = dot(hd, hs) * 0.5 + 0.5;
  return mix(uSkyHorizonAway, uSkyHorizonSun, az * az * (3.0 - 2.0 * az));
}

vec3 vfSky(vec3 dir, float withSun) {
  float e = clamp(dir.y, -1.0, 1.0);
  vec3 hz = vfHorizon(dir);
  float t = pow(max(e, 0.0), 0.45);
  vec3 col = mix(hz, uSkyZenith, smoothstep(0.0, 0.8, t));
  // a thin warmer band hugging the horizon
  col = mix(col, hz * vec3(1.02, 0.98, 0.94), exp(-max(e, 0.0) * 24.0) * 0.5);
  float cs = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (0.06 * pow(cs, 4.0) + 0.2 * pow(cs, 32.0) + 0.6 * pow(cs, 400.0));
  col += withSun * uSunColor * 30.0 * smoothstep(0.99984, 0.99992, cs);
  // below the horizon: keep the haze tone
  col = mix(col, hz * 0.92, smoothstep(0.0, -0.08, e));
  return col;
}

vec3 vfHaze(vec3 dir, float dist) {
  vec3 hz = vfSky(normalize(vec3(dir.x, 0.03, dir.z)), 0.0);
  float far = smoothstep(1200.0, 13000.0, dist);
  vec3 c = mix(uHazeCool, hz, far);
  float cs = max(dot(dir, uSunDir), 0.0);
  c += uSunColor * 0.16 * pow(cs, 6.0);
  return c;
}

vec3 vfAtmosphere(vec3 col, vec3 wp) {
  vec3 v = wp - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  float f = uFogFalloff;
  float y0 = max(cameraPosition.y - uFogBase, 0.0);
  float y1 = max(wp.y - uFogBase, 0.0);
  float dy = y1 - y0;
  float hf = abs(dy) > 0.5 ? (exp(-f * y0) - exp(-f * y1)) / (f * dy) : exp(-f * y0);
  float dd = max(dist - 1400.0, 0.0);
  float od = hf * (uFogA * dist + uFogB * dd * dd);
  float T = exp(-od);
  return mix(vfHaze(dir, dist), col, T);
}
`

export const GLSL_CLOUDS = /* glsl */ `
uniform vec2 uCloudOffset;
uniform float uCloudShadow;
// soft drifting cloud shadows: 1 = sunlit, lower = shaded
float vfCloudShade(vec3 wp) {
  // project along the sun direction onto a cloud layer ~ 900 m up
  vec2 p = wp.xz + uSunDir.xz / max(uSunDir.y, 0.15) * (900.0 - wp.y);
  p = (p + uCloudOffset) / 1500.0;
  float n = vfFbm(p + vec2(3.1, 7.7));
  float c = smoothstep(0.52, 0.72, n);
  return 1.0 - uCloudShadow * c;
}
`

// ------------------------------------------------------------------ material patching

export interface PatchOptions {
  /** extra uniforms merged into the program */
  uniforms?: Record<string, IUniform>
  /** declarations placed before main() in the vertex shader */
  vertexPars?: string
  /** code after #include <begin_vertex> (local 'transformed' available) */
  vertexBegin?: string
  /**
   * world-position override: code that sets vec4 'vfWorld' (world position);
   * when provided, gl_Position is recomputed from it.
   */
  vertexWorld?: string
  /** code at end of main() in vertex shader */
  vertexEnd?: string
  fragmentPars?: string
  /** replaces #include <color_fragment> (diffuseColor available) */
  fragmentColor?: string
  /** code after #include <normal_fragment_maps> (view-space 'normal' can be perturbed) */
  fragmentNormal?: string
  /** code just before opaque_fragment; 'outgoingLight' available */
  fragmentOutgoing?: string
  /** skip the aerial-perspective haze (e.g. car interior overlays) */
  noAtmosphere?: boolean
  /** cloud shadow modulation on direct light */
  cloudShadows?: boolean
  /** GLSL expression (0..1) multiplying the sun, e.g. baked terrain self-shadowing */
  sunVis?: string
  /** key for program caching */
  key: string
}

const SHARED_NAMES = Object.keys(U) as (keyof SharedUniforms)[]

/**
 * Patches a built-in three material (Lambert / Standard / Physical / Basic) to use
 * the shared atmosphere, cloud shadows and optional custom vertex/fragment code.
 */
export function patchMaterial<T extends Material>(mat: T, o: PatchOptions): T {
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    for (const n of SHARED_NAMES) shader.uniforms[n] = U[n] as IUniform
    if (o.uniforms) Object.assign(shader.uniforms, o.uniforms)

    let vs = shader.vertexShader
    let fs = shader.fragmentShader

    vs = vs.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
uniform vec3 uViewPos;
uniform vec3 uViewDir;
uniform float uPov;
varying vec3 vAtmoWorld;
${GLSL_NOISE}
${o.vertexPars ?? ''}`,
    )
    if (o.vertexBegin) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vertexBegin}`)

    if (o.vertexWorld) {
      vs = vs.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 vfWorld = vec4(transformed, 1.0);
  ${o.vertexWorld}
  mvPosition = viewMatrix * vfWorld;
  gl_Position = projectionMatrix * mvPosition;
  vAtmoWorld = vfWorld.xyz;
}`,
      )
    } else {
      vs = vs.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 vfW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    vfW = instanceMatrix * vfW;
  #endif
  vAtmoWorld = (modelMatrix * vfW).xyz;
}`,
      )
    }
    // shadow coords need the displaced world position too
    if (o.vertexWorld) {
      vs = vs.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  worldPosition = vec4(vAtmoWorld, 1.0);
#endif`,
      )
    }
    if (o.vertexEnd) vs = vs.replace(/}\s*$/, `${o.vertexEnd}\n}`)

    fs = fs.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
uniform vec3 uViewPos;
uniform float uPov;
varying vec3 vAtmoWorld;
${GLSL_NOISE}
${GLSL_ATMO}
${GLSL_CLOUDS}`,
    )
    // material-specific declarations go last so they can use lights / shadow helpers
    fs = fs.replace('void main() {', `${o.fragmentPars ?? ''}\nvoid main() {`)
    if (o.fragmentColor) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragmentColor}`)
    if (o.fragmentNormal) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${o.fragmentNormal}`)
    if (o.cloudShadows) fs = fs.replace('#include <lights_fragment_begin>', lightsWithClouds(o.sunVis))
    const outgoing = `${o.fragmentOutgoing ?? ''}
${o.noAtmosphere ? '' : 'outgoingLight = vfAtmosphere(outgoingLight, vAtmoWorld);'}
#include <opaque_fragment>`
    fs = fs.replace('#include <opaque_fragment>', outgoing)
    fs = fs.replace('#include <fog_fragment>', '')
    shader.vertexShader = vs
    shader.fragmentShader = fs
  }
  mat.customProgramCacheKey = () => o.key
  return mat
}

/** lights_fragment_begin with cloud shading (and optional baked visibility) folded into the sun. */
function lightsWithClouds(sunVis?: string): string {
  const src = ShaderChunk.lights_fragment_begin
  const needle = 'getDirectionalLightInfo( directionalLight, directLight );'
  const extra = sunVis ? ` * (${sunVis})` : ''
  return src.replace(needle, `${needle}\n\t\tdirectLight.color *= vfCloudShade(vAtmoWorld)${extra};`)
}

/**
 * Derivative-based bump mapping (after three's perturbNormalArb): tilts the
 * view-space normal by the screen-space gradient of a world-space height (metres).
 */
export const GLSL_BUMP = /* glsl */ `
vec3 vfBump(vec3 N, vec3 viewPos, float h, float faceDir) {
  vec2 dH = vec2(dFdx(h), dFdy(h));
  vec3 sx = dFdx(viewPos);
  vec3 sy = dFdy(viewPos);
  vec3 R1 = cross(sy, N);
  vec3 R2 = cross(N, sx);
  float det = dot(sx, R1) * faceDir;
  vec3 grad = sign(det) * (dH.x * R1 + dH.y * R2);
  return normalize(abs(det) * N - grad);
}
`

/** Shadow-only factor for the first directional light (1 = lit). */
export const GLSL_SUN_SHADOW = /* glsl */ `
float vfSunShadow() {
  float s = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow dls = directionalLightShadows[ 0 ];
    s = getShadow( directionalShadowMap[ 0 ], dls.shadowMapSize, dls.shadowIntensity, dls.shadowBias, dls.shadowRadius, vDirectionalShadowCoord[ 0 ] );
  #endif
  return s;
}
`

/**
 * Patches a depth / distance material so shadow casters move exactly like the
 * visible geometry (wind sway, LOD fades). Shares vertex code with patchMaterial.
 */
export function patchDepthMaterial<T extends Material>(mat: T, o: PatchOptions): T {
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    for (const n of SHARED_NAMES) shader.uniforms[n] = U[n] as IUniform
    if (o.uniforms) Object.assign(shader.uniforms, o.uniforms)
    let vs = shader.vertexShader
    vs = vs.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
uniform vec3 uViewPos;
uniform vec3 uViewDir;
uniform float uPov;
varying vec3 vAtmoWorld;
${GLSL_NOISE}
${o.vertexPars ?? ''}`,
    )
    if (o.vertexBegin) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vertexBegin}`)
    if (o.vertexWorld) {
      vs = vs.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 vfWorld = vec4(transformed, 1.0);
  ${o.vertexWorld}
  mvPosition = viewMatrix * vfWorld;
  gl_Position = projectionMatrix * mvPosition;
  vAtmoWorld = vfWorld.xyz;
}`,
      )
      vs = vs.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  worldPosition = vec4(vAtmoWorld, 1.0);
#endif`,
      )
    }
    if (o.vertexEnd) vs = vs.replace(/}\s*$/, `${o.vertexEnd}\n}`)
    let fs = shader.fragmentShader
    if (o.fragmentPars || o.fragmentColor) {
      fs = fs.replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec3 uViewPos;
uniform float uPov;
varying vec3 vAtmoWorld;
${GLSL_NOISE}
${o.fragmentPars ?? ''}`,
      )
      // depth materials have no colour stage: run discard logic at the clipping stage
      if (o.fragmentColor) fs = fs.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${o.fragmentColor}`)
    }
    shader.vertexShader = vs
    shader.fragmentShader = fs
  }
  mat.customProgramCacheKey = () => o.key + '-depth'
  return mat
}
