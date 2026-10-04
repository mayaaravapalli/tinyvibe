import { BufferAttribute, BufferGeometry, Mesh, MeshLambertMaterial } from 'three'
import { GLSL_SUN_SHADOW, patchMaterial } from '../render/shared'
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
      ${GLSL_SUN_SHADOW}
      vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
      float vfLine(float x, float c, float w) {
        float fw = max(fwidth(x), 1e-4);
        float d = abs(x - c) - w * 0.5;
        return 1.0 - smoothstep(-fw, fw, d);
      }
    `,
    fragmentColor: /* glsl */ `
      float vfPolish = 0.0;
      float vfAsphalt = 0.0;
      {
        float u = vRoadUv.x;
        float v = vRoadUv.y;
        float au = abs(u);
        vec2 wp = vAtmoWorld.xz;
        float px = fwidth(u);
        float detail = 1.0 - smoothstep(0.02, 0.12, px);
        // the road is resurfaced in sections: some lengths are newer and darker,
        // older ones bleached pale grey by sun and salt
        float section = vfNoise(vec2(floor(v / 140.0) * 3.7, 2.0));
        float age = mix(0.0, 1.0, section) * 0.7 + 0.3 * vfFbm(vec2(u * 0.15, v * 0.02));
        vec3 asph = mix(srgb(0.25, 0.25, 0.255), srgb(0.40, 0.395, 0.385), age);
        // aggregate speckle
        float agg = vfNoise(wp * 9.0) * 0.6 + vfNoise(wp * 23.0) * 0.4;
        asph *= mix(1.0, 0.86 + 0.28 * agg, detail);
        asph *= 0.94 + 0.12 * vfNoise(wp * 0.9);
        // wheel tracks polished darker; a faint oil streak down the middle of each lane
        float tracks = exp(-pow((au - 0.85) / 0.32, 2.0)) + exp(-pow((au - 2.45) / 0.32, 2.0));
        asph *= 1.0 - 0.12 * tracks;
        float oil = exp(-pow((au - 1.65) / 0.22, 2.0)) * (0.6 + 0.4 * vfNoise(vec2(v * 0.3, u)));
        asph *= 1.0 - 0.18 * oil;
        vfPolish = tracks;
        // the odd patched utility cut: a little fresher and darker, edged by a sealed seam
        vec2 pc = vec2(floor(v / 11.0), floor((u + 3.3) / 3.3));
        float ph = vfHash12(pc * 1.31 + 4.0);
        if (ph > 0.93) {
          vec2 pl = vec2(fract(v / 11.0) * 11.0, fract((u + 3.3) / 3.3) * 3.3);
          vec2 lo = vec2(1.6 + 3.3 * vfHash12(pc + 7.0), 0.35 + 0.6 * vfHash12(pc + 9.0));
          vec2 hi = lo + vec2(2.5 + 3.0 * vfHash12(pc + 3.0), 1.4 + 0.8 * vfHash12(pc + 5.0));
          hi = min(hi, vec2(10.6, 3.15));
          vec2 dd = min(pl - lo, hi - pl);
          float din = min(dd.x, dd.y);
          float fw = max(fwidth(din), 1e-3);
          float inside = smoothstep(-fw, fw, din);
          float seam = 1.0 - smoothstep(0.02, 0.06 + fw, abs(din));
          asph *= mix(1.0, 0.8 + 0.1 * agg, inside);
          asph *= 1.0 - 0.3 * seam * detail;
        }
        // tar snakes: wandering sealed cracks along the lanes and across the road
        float snake = abs(u - (1.25 + 1.4 * (vfNoise(vec2(v * 0.035, 3.0)) - 0.5)));
        float snakeOn = smoothstep(0.45, 0.6, vfNoise(vec2(v * 0.015, 1.0)));
        float trans = abs(fract(v / 17.0 + 0.3 * vfNoise(vec2(u * 0.4, floor(v / 17.0)))) - 0.5) * 17.0;
        float transOn = step(0.45, vfHash12(vec2(floor(v / 17.0), 5.0)));
        float tar = max(smoothstep(0.05, 0.015, snake) * snakeOn, smoothstep(0.06, 0.02, trans) * transOn);
        asph = mix(asph, srgb(0.12, 0.12, 0.12), tar * 0.6 * detail);
        // the old edge crumbles: the asphalt frays raggedly into the gravel
        float fray = 3.34 + 0.16 * (vfNoise(wp * 2.3) - 0.5) + 0.1 * (vfNoise(wp * 9.0) - 0.5);
        float shoulder = smoothstep(fray - 0.03, fray + 0.03, au);
        asph *= 1.0 - 0.25 * smoothstep(fray - 0.4, fray, au) * vfNoise(wp * 5.0);
        // markings: faded, chipped, and worn through where tyres cut the corners
        float wear = smoothstep(0.15, 0.6, vfNoise(vec2(u * 5.0, v * 1.4)) * 0.6 + vfNoise(wp * 13.0) * 0.4 + 0.15);
        float worn = 1.0 - 0.6 * smoothstep(0.55, 0.8, vfNoise(vec2(v * 0.04, 8.0)));
        float edge = vfLine(au, 3.05, 0.11) * wear * worn;
        float yel = (vfLine(u, -0.11, 0.1) + vfLine(u, 0.11, 0.1)) * wear;
        float vis = 1.0 - smoothstep(0.2, 0.7, px);
        vec3 col = asph;
        col = mix(col, srgb(0.80, 0.79, 0.74), edge * vis * 0.9);
        col = mix(col, srgb(0.78, 0.60, 0.20), clamp(yel, 0.0, 1.0) * vis * 0.9);
        vfAsphalt = 1.0 - shoulder;
        // fine crushed gravel: a grainy, low-contrast mix of greys and tans (fades when tiny on screen)
        float pf = 1.0 - smoothstep(0.5, 2.0, length(fwidth(wp)) * 40.0);
        float g1 = vfNoise(wp * 34.0), g2 = vfNoise(wp * 71.0 + 5.0);
        vec3 grav = mix(srgb(0.46, 0.43, 0.38), srgb(0.53, 0.49, 0.42), vfNoise(wp * 1.3));
        grav *= mix(1.0, 0.86 + 0.18 * g1 + 0.12 * (g2 - 0.5), pf);
        grav = mix(grav, srgb(0.50, 0.43, 0.32), smoothstep(0.55, 0.8, vfNoise(wp * 0.7)) * 0.4);
        grav = mix(grav, srgb(0.56, 0.50, 0.40), (1.0 - smoothstep(3.4, 4.0, au)) * 0.5);
        col = mix(col, grav, shoulder);
        float ragged = au + (vfNoise(wp * 1.6) - 0.5) * 0.9 + (vfNoise(wp * 6.0) - 0.5) * 0.35;
        float verge = smoothstep(4.5, 5.0, ragged);
        vec3 thatch = mix(srgb(0.40, 0.33, 0.19), srgb(0.50, 0.42, 0.24), vfNoise(wp * 3.0)) * 0.8;
        col = mix(col, thatch, verge);
        // fallen leaves: blown to the edges, swept out of the wheel tracks
        vec2 lp = wp * 3.2;
        vec2 lid = floor(lp);
        float lr = vfHash12(lid + 17.0);
        vec2 q = fract(lp) - 0.5 - (vfHash22(lid) - 0.5) * 0.5;
        float la = lr * 6.2831;
        q = mat2(cos(la), -sin(la), sin(la), cos(la)) * q;
        float shape = 1.0 - smoothstep(0.8, 1.0, length(q / vec2(0.27, 0.16)));
        float leafDens = mix(0.03, 0.5, smoothstep(2.4, 3.6, au)) * (1.0 - 0.8 * tracks) * (0.4 + 0.8 * vfNoise(wp * 0.15));
        float leafOn = shape * step(1.0 - leafDens, vfHash12(lid + 3.0)) * detail;
        vec3 leafC = lr > 0.72 ? srgb(0.72, 0.30, 0.09) : lr > 0.48 ? srgb(0.80, 0.56, 0.16) : lr > 0.28 ? srgb(0.55, 0.13, 0.08) : srgb(0.42, 0.27, 0.14);
        col = mix(col, leafC * (0.8 + 0.3 * vfNoise(lp * 3.0)), leafOn);
        vfPolish *= 1.0 - leafOn;
        diffuseColor.rgb = col;
      }
    `,
    fragmentOutgoing: /* glsl */ `
      {
        // low sun glinting off the polished asphalt ahead: the golden-hour road shine
        vec3 V = normalize(cameraPosition - vAtmoWorld);
        vec3 H = normalize(V + uSunDir);
        float nh = max(dot(vec3(0.0, 1.0, 0.0), H), 0.0);
        float glint = pow(nh, 60.0) * 0.5 + pow(nh, 12.0) * 0.08;
        float sh = vfSunShadow() * vfCloudShade(vAtmoWorld);
        outgoingLight += uSunColor * glint * sh * vfAsphalt * (0.35 + 0.65 * vfPolish);
      }
    `,
  })
  const mesh = new Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'road'
  return mesh
}
