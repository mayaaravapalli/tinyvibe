import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  Vector4,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../core/noise'
import { U, patchMaterial } from '../render/shared'
import { BRIDGE } from './layout'
import type { Terrain } from './terrain'

// interior half-width, wall height, board pitch and gap (metres)
const HALF = 3.05
const WALL_H = 4.2
const PITCH = 0.36
const GAP = 0.075
const WINDOWS = [-12.5, -4.2, 4.2, 12.5]
const WIN_W = 1.3
const WIN_Y0 = 1.55
const WIN_Y1 = 2.55

export interface BridgeBuild {
  group: Group
  /** true when a world point is inside the bridge barrel */
  contains(p: Vector3): boolean
  /** 0..1 how deep inside the barrel along its axis */
  depthInside(p: Vector3): number
  center: Vector3
  axis: Vector3
  /** the dusty light blades, hidden while they have faded out */
  shafts: Group
}

class Merge {
  parts: BufferGeometry[] = []
  box(w: number, h: number, d: number, m: Matrix4) {
    const g = new BoxGeometry(w, h, d)
    g.applyMatrix4(m)
    this.parts.push(g)
  }
  geo(): BufferGeometry {
    const g = mergeGeometries(this.parts, false)!
    g.computeBoundingSphere()
    return g
  }
}

const M = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
  const m = new Matrix4()
  m.makeRotationFromQuaternion(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rx))
  if (ry) m.premultiply(new Matrix4().makeRotationY(ry))
  if (rz) m.premultiply(new Matrix4().makeRotationZ(rz))
  m.setPosition(x, y, z)
  return m
}

function signTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 256
  const g = c.getContext('2d')!
  g.fillStyle = '#efe6d2'
  g.fillRect(0, 0, 1024, 256)
  g.strokeStyle = '#3a2a22'
  g.lineWidth = 8
  g.strokeRect(14, 14, 996, 228)
  g.fillStyle = '#2b1d18'
  g.textAlign = 'center'
  g.font = '600 64px Georgia, "Times New Roman", serif'
  g.fillText('ONE DOLLAR FINE', 512, 104)
  g.font = '500 40px Georgia, "Times New Roman", serif'
  g.fillText('FOR DRIVING FASTER THAN A WALK', 512, 162)
  g.fillText('ON THIS BRIDGE', 512, 210)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** GLSL: is a point inside the bridge lit through the board gaps / windows? */
const SLITS = /* glsl */ `
uniform vec4 uBridgeO;   // xyz origin (deck centre), w = length
uniform vec3 uBridgeX;   // across
uniform vec3 uBridgeZ;   // along
float vfBridgeSun(vec3 wp) {
  vec3 d = wp - uBridgeO.xyz;
  vec3 p = vec3(dot(d, uBridgeX), d.y, dot(d, uBridgeZ));
  vec3 s = vec3(dot(uSunDir, uBridgeX), uSunDir.y, dot(uSunDir, uBridgeZ));
  float L = uBridgeO.w;
  // outside the barrel: ordinary daylight
  if (abs(p.z) > L * 0.5 + 0.2 || abs(p.x) > ${(HALF + 0.12).toFixed(2)} || p.y > ${(WALL_H + 0.3).toFixed(2)}) return 1.0;
  float wall = sign(s.x) * ${HALF.toFixed(2)};
  float t = (wall - p.x) / (abs(s.x) < 1e-3 ? 1e-3 : s.x);
  vec3 h = p + s * max(t, 0.0);
  if (abs(h.z) > L * 0.5) return 1.0;          // in through the open portal
  if (h.y > ${WALL_H.toFixed(2)}) return 0.0;   // the roof
  float lit = 0.0;
  // board gaps, slightly irregular
  float k = (h.z + L * 0.5) / ${PITCH.toFixed(3)};
  float gap = ${(GAP / PITCH).toFixed(3)} * (0.7 + 0.6 * vfHash12(vec2(floor(k), sign(s.x))));
  float fw = max(fwidth(k), 1e-3);
  lit = max(lit, smoothstep(1.0 - gap - fw, 1.0 - gap + fw, fract(k)));
  // windows
  float iny = step(${WIN_Y0.toFixed(2)}, h.y) * step(h.y, ${WIN_Y1.toFixed(2)});
  ${WINDOWS.map((wz) => `lit = max(lit, iny * step(abs(h.z - (${wz.toFixed(2)})), ${(WIN_W / 2).toFixed(2)}));`).join('\n  ')}
  return lit;
}
`

export function buildBridge(T: Terrain): BridgeBuild {
  const b = T.bridge
  const L = BRIDGE.length
  const group = new Group()
  group.name = 'covered-bridge'
  const axis = new Vector3(b.dirX, 0, b.dirZ).normalize()
  const across = new Vector3(axis.z, 0, -axis.x)
  const center = new Vector3(b.x, b.deckY, b.z)
  group.position.copy(center)
  // local +z along the road, +x across
  group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(across, new Vector3(0, 1, 0), axis))

  const bridgeU = {
    uBridgeO: { value: new Vector4(center.x, center.y, center.z, L) },
    uBridgeX: { value: across.clone() },
    uBridgeZ: { value: axis.clone() },
  }
  const rnd = mulberry32(1872)

  // ---------------------------------------------------------------- walls
  const walls = new Merge()
  for (const side of [-1, 1]) {
    for (let z = -L / 2 + PITCH / 2; z < L / 2; z += PITCH) {
      const w = PITCH - GAP * (0.7 + 0.6 * rnd())
      const x = side * (HALF + 0.04)
      const inWin = WINDOWS.some((wz) => Math.abs(z - wz) < WIN_W / 2)
      if (inWin) {
        walls.box(0.06, WIN_Y0 - 0.1, w, M(x, (WIN_Y0 + 0.1) / 2, z))
        walls.box(0.06, WALL_H - WIN_Y1, w, M(x, (WALL_H + WIN_Y1) / 2, z))
      } else {
        walls.box(0.06, WALL_H - 0.1, w, M(x, (WALL_H + 0.1) / 2, z))
      }
    }
    // window trim
    for (const wz of WINDOWS) {
      walls.box(0.1, 0.08, WIN_W + 0.16, M(side * (HALF + 0.08), WIN_Y0 - 0.04, wz))
      walls.box(0.1, 0.08, WIN_W + 0.16, M(side * (HALF + 0.08), WIN_Y1 + 0.04, wz))
    }
  }
  // gable ends: boards above the portal
  const gable = new Merge()
  for (const end of [-1, 1]) {
    const z = end * (L / 2 + 0.03)
    for (let x = -3.6; x <= 3.6; x += 0.32) {
      const top = 4.25 + 1.62 * (1 - Math.abs(x) / 3.6)
      const h = top - 4.25
      if (h > 0.05) gable.box(0.29, h, 0.06, M(x, 4.25 + h / 2, z))
    }
    // side boards either side of the opening
    for (const sx of [-1, 1]) gable.box(0.5, WALL_H, 0.08, M(sx * (HALF + 0.3), WALL_H / 2, z))
  }

  const redWood = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bridge-wood',
    cloudShadows: true,
    uniforms: bridgeU,
    vertexPars: 'varying vec3 vBN;',
    vertexBegin: 'vBN = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);',
    fragmentPars: /* glsl */ `
      varying vec3 vBN;
      uniform vec4 uBridgeO;
      uniform vec3 uBridgeX;
      vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
    `,
    fragmentColor: /* glsl */ `
      {
        vec3 d = vAtmoWorld - uBridgeO.xyz;
        float lx = dot(d, uBridgeX);
        // faces turned towards the axis are the unpainted inside
        float inward = step(0.5, -sign(lx) * dot(vBN, uBridgeX));
        float grain = vfNoise(vec2(vAtmoWorld.y * 9.0, dot(d, vec3(uBridgeX.z, 0.0, -uBridgeX.x)) * 2.8));
        float weather = vfFbm(vAtmoWorld.xz * 0.6 + vAtmoWorld.y * 0.9);
        vec3 red = mix(srgb(0.55, 0.16, 0.11), srgb(0.47, 0.13, 0.10), grain) * (0.82 + 0.3 * weather);
        red = mix(red, srgb(0.52, 0.42, 0.38), smoothstep(0.62, 0.85, weather) * 0.35);
        vec3 inner = mix(srgb(0.34, 0.27, 0.21), srgb(0.27, 0.21, 0.16), grain) * (0.85 + 0.25 * weather);
        diffuseColor.rgb = mix(red, inner, inward);
      }
    `,
  })
  const wallMesh = new Mesh(walls.geo(), redWood)
  wallMesh.castShadow = true
  wallMesh.receiveShadow = true
  group.add(wallMesh)
  const gableMesh = new Mesh(gable.geo(), redWood)
  gableMesh.castShadow = true
  gableMesh.receiveShadow = true
  group.add(gableMesh)

  // ---------------------------------------------------------------- interior structure (lit by slits)
  const inner = new Merge()
  for (const side of [-1, 1]) {
    const x = side * (HALF - 0.12)
    // Town lattice: criss-crossed planks
    for (const dir of [-1, 1]) {
      for (let z = -L / 2 + 2.4; z <= L / 2 - 2.4; z += 1.1) {
        inner.box(0.07, 0.24, 5.2, M(x, 2.05, z, dir * Math.PI / 4))
      }
    }
    // chords
    inner.box(0.24, 0.32, L, M(x, 0.42, 0))
    inner.box(0.24, 0.32, L, M(x, 3.75, 0))
  }
  // tie beams and rafters overhead
  for (let z = -L / 2 + 1.2; z < L / 2; z += 2.4) {
    inner.box(2 * HALF, 0.22, 0.22, M(0, 4.05, z))
    for (const side of [-1, 1]) inner.box(3.9, 0.14, 0.14, M(side * 1.8, 5.05, z, 0, 0, side * -0.42))
  }
  // floor beams under the deck
  for (let z = -L / 2 + 1; z < L / 2; z += 3) inner.box(2 * HALF + 0.6, 0.35, 0.3, M(0, -0.45, z))

  const innerWood = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bridge-inner',
    cloudShadows: true,
    uniforms: bridgeU,
    sunVis: 'vfBridgeSun(vAtmoWorld)',
    fragmentPars: /* glsl */ `
      ${SLITS}
      vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
    `,
    fragmentColor: /* glsl */ `
      {
        float grain = vfNoise(vAtmoWorld.xz * 3.0 + vAtmoWorld.y * 7.0);
        diffuseColor.rgb = mix(srgb(0.36, 0.28, 0.21), srgb(0.28, 0.21, 0.15), grain);
      }
    `,
  })
  const innerMesh = new Mesh(inner.geo(), innerWood)
  innerMesh.castShadow = true
  innerMesh.receiveShadow = false
  group.add(innerMesh)

  // ---------------------------------------------------------------- deck
  const deck = new Merge()
  deck.box(2 * HALF + 0.3, 0.3, L + 0.4, M(0, -0.15, 0))
  const deckMat = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bridge-deck',
    cloudShadows: true,
    uniforms: bridgeU,
    sunVis: 'vfBridgeSun(vAtmoWorld + vec3(0.0, 0.02, 0.0))',
    fragmentPars: /* glsl */ `
      ${SLITS}
      vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
    `,
    fragmentColor: /* glsl */ `
      {
        vec3 d = vAtmoWorld - uBridgeO.xyz;
        float along = dot(d, uBridgeZ);
        float acr = dot(d, uBridgeX);
        float plank = floor(along / 0.24);
        float seam = smoothstep(0.0, 0.04, fract(along / 0.24)) * smoothstep(1.0, 0.94, fract(along / 0.24));
        float tone = vfHash12(vec2(plank, 3.0));
        vec3 c = mix(srgb(0.42, 0.33, 0.24), srgb(0.30, 0.23, 0.16), tone);
        c *= 0.75 + 0.25 * seam;
        // wheel tracks worn pale
        c = mix(c, srgb(0.5, 0.42, 0.33), exp(-pow((abs(acr) - 0.9) / 0.35, 2.0)) * 0.35);
        c *= 0.85 + 0.25 * vfNoise(vec2(acr * 3.0, along * 0.6));
        diffuseColor.rgb = c;
      }
    `,
  })
  const deckMesh = new Mesh(deck.geo(), deckMat)
  deckMesh.receiveShadow = false
  deckMesh.castShadow = true
  group.add(deckMesh)

  // ---------------------------------------------------------------- roof
  const roof = new Merge()
  const pitch = Math.atan2(1.65, 3.75)
  for (const side of [-1, 1]) {
    roof.box(4.15, 0.14, L + 1.4, M(side * 1.86, 5.08, 0, 0, 0, -side * pitch))
  }
  const roofMat = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bridge-roof',
    cloudShadows: true,
    fragmentPars: 'vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }',
    fragmentColor: /* glsl */ `
      {
        // weathered cedar shingles: staggered courses
        vec2 q = vec2(dot(vAtmoWorld.xz, vec2(0.7, 0.7)) * 3.2, vAtmoWorld.y * 7.5);
        float row = floor(q.y);
        float sh = vfHash12(vec2(floor(q.x + row * 0.5), row));
        float edge = smoothstep(0.0, 0.12, fract(q.y));
        vec3 c = mix(srgb(0.30, 0.27, 0.25), srgb(0.40, 0.36, 0.32), sh) * (0.7 + 0.3 * edge);
        c = mix(c, srgb(0.33, 0.37, 0.25), smoothstep(0.65, 0.9, vfNoise(vAtmoWorld.xz * 0.7)) * 0.4);
        diffuseColor.rgb = c;
      }
    `,
  })
  const roofMesh = new Mesh(roof.geo(), roofMat)
  roofMesh.castShadow = true
  roofMesh.receiveShadow = true
  group.add(roofMesh)

  // ---------------------------------------------------------------- portal trim + signs
  const trim = new Merge()
  for (const end of [-1, 1]) {
    const z = end * (L / 2 + 0.09)
    for (const sx of [-1, 1]) trim.box(0.18, WALL_H + 0.2, 0.06, M(sx * (HALF + 0.05), (WALL_H + 0.2) / 2, z))
    trim.box(2 * HALF + 0.3, 0.2, 0.06, M(0, WALL_H + 0.1, z))
    // barge boards along the gable
    for (const sx of [-1, 1]) trim.box(4.1, 0.16, 0.08, M(sx * 1.86, 5.1, z + end * 0.62, 0, 0, -sx * pitch))
  }
  const white = patchMaterial(new MeshLambertMaterial({ color: new Color('#ece5d6') }), { key: 'bridge-trim', cloudShadows: true })
  const trimMesh = new Mesh(trim.geo(), white)
  trimMesh.castShadow = true
  trimMesh.receiveShadow = true
  group.add(trimMesh)

  const signMat = patchMaterial(new MeshLambertMaterial({ map: signTexture() }), { key: 'bridge-sign', cloudShadows: true })
  for (const end of [-1, 1]) {
    const sign = new Mesh(new PlaneGeometry(2.6, 0.65), signMat)
    sign.position.set(0, 4.72, end * (L / 2 + 0.16))
    sign.rotation.y = end > 0 ? 0 : Math.PI
    group.add(sign)
  }

  // ---------------------------------------------------------------- stone abutments
  const stones = new Merge()
  for (const end of [-1, 1]) {
    const z0 = end * (L / 2 - 2.6)
    for (let y = -0.55; y > -9; y -= 0.55) {
      for (let x = -3.8; x < 3.8; x += 0.9) {
        const w = 0.8 + rnd() * 0.25
        const off = (Math.round(y / 0.55) % 2) * 0.45
        stones.box(w, 0.5, 3.4 + rnd() * 0.4, M(x + off, y, z0 + (rnd() - 0.5) * 0.15))
      }
    }
  }
  const stoneMat = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'bridge-stone',
    cloudShadows: true,
    fragmentPars: 'vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }',
    fragmentColor: /* glsl */ `
      {
        float n = vfNoise(vAtmoWorld.xz * 1.7 + vAtmoWorld.y * 2.3);
        vec3 c = mix(srgb(0.44, 0.43, 0.40), srgb(0.58, 0.56, 0.52), n);
        c = mix(c, srgb(0.40, 0.45, 0.33), smoothstep(0.65, 0.85, vfNoise(vAtmoWorld.xz * 0.9 + 3.0)) * 0.5);
        diffuseColor.rgb = c;
      }
    `,
  })
  const stoneMesh = new Mesh(stones.geo(), stoneMat)
  stoneMesh.castShadow = true
  stoneMesh.receiveShadow = true
  group.add(stoneMesh)

  // ---------------------------------------------------------------- light shafts
  const shafts = buildShafts(across, axis, L)
  group.add(shafts)

  const local = new Vector3()
  const inv = new Matrix4()
  group.updateMatrixWorld()
  inv.copy(group.matrixWorld).invert()
  const toLocal = (p: Vector3) => local.copy(p).applyMatrix4(inv)
  return {
    group,
    shafts,
    center,
    axis,
    contains(p: Vector3) {
      const q = toLocal(p)
      return Math.abs(q.z) < L / 2 && Math.abs(q.x) < HALF && q.y > -0.5 && q.y < WALL_H + 1
    },
    depthInside(p: Vector3) {
      const q = toLocal(p)
      if (Math.abs(q.x) > HALF || q.y < -0.5 || q.y > WALL_H + 1) return 0
      return Math.max(0, Math.min(1, (L / 2 - Math.abs(q.z)) / 6))
    },
  }
}

/** how strongly the light shafts show: only inside the barrel or right at the portal */
export const SHAFT_U = { value: 0 }

/** Soft blades of dusty sunlight through the windows and the widest board gaps. */
function buildShafts(across: Vector3, axis: Vector3, L: number): Group {
  const g = new Group()
  const sunW = U.uSunDir.value
  const s = new Vector3(sunW.dot(across), sunW.y, sunW.dot(axis))
  const side = Math.sign(s.x) || 1
  const mat = new ShaderMaterial({
    uniforms: { uTime: U.uTime, uColor: { value: new Color('#ffd9a3') }, uShaft: SHAFT_U },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vW;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uShaft;
      varying vec2 vUv;
      varying vec3 vW;
      float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      void main() {
        // soft across the blade, fading towards the floor
        float across = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
        float along = smoothstep(0.0, 0.12, vUv.y) * (0.35 + 0.65 * (1.0 - vUv.y));
        // drifting dust
        vec2 q = vec2(vUv.x * 9.0, vUv.y * 30.0 - uTime * 0.25);
        float dust = step(0.985, h(floor(q))) * 2.5;
        float a = across * along * (0.16 + dust * 0.25) * uShaft;
        gl_FragColor = vec4(uColor * a, 1.0);
      }
    `,
  })
  const addBlade = (z: number, y0: number, y1: number, width: number) => {
    // a quad from the wall opening, extruded along the incoming light
    const start = new Vector3(side * HALF, (y0 + y1) / 2, z)
    const dir = s.clone().multiplyScalar(-1)
    const t = Math.min((start.y + 0.05) / Math.max(0.05, -dir.y), (2 * HALF) / Math.max(0.05, Math.abs(dir.x)))
    const end = start.clone().addScaledVector(dir, t)
    const len = start.distanceTo(end)
    const geo = new PlaneGeometry(width, len)
    // plane local: x across blade (along bridge), y along the shaft
    const pos = geo.getAttribute('position')
    const uv = new Float32BufferAttribute(new Float32Array(pos.count * 2), 2)
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / width + 0.5, 0.5 - pos.getY(i) / len)
    geo.setAttribute('uv', uv)
    const m = new Mesh(geo, mat)
    const yAxis = end.clone().sub(start).normalize().multiplyScalar(-1)
    const xAxis = new Vector3(0, 0, 1)
    const zAxis = new Vector3().crossVectors(xAxis, yAxis).normalize()
    const xFix = new Vector3().crossVectors(yAxis, zAxis).normalize()
    m.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(xFix, yAxis, zAxis))
    m.position.copy(start).add(end).multiplyScalar(0.5)
    m.renderOrder = 10
    m.frustumCulled = false
    g.add(m)
    // a second, crossed plane so the blade has volume from any angle
    const m2 = m.clone()
    m2.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2))
    g.add(m2)
  }
  for (const wz of WINDOWS) addBlade(wz, WIN_Y0, WIN_Y1, WIN_W * 0.95)
  const rnd = mulberry32(77)
  for (let i = 0; i < 9; i++) {
    const z = -L / 2 + 2 + rnd() * (L - 4)
    addBlade(z, 0.6, WALL_H - 0.3, 0.12)
  }
  return g
}
