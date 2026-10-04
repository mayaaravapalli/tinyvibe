import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Material,
} from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { mulberry32, Simplex2 } from '../core/noise'
import { GLSL_ATMO, U, patchMaterial } from '../render/shared'
import { CLEARINGS, TELEPHONE_RUN, type V2 } from './layout'
import type { Terrain } from './terrain'

const SRGB = 'vec3 srgb(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }'
const _m = new Matrix4()
const UP = new Vector3(0, 1, 0)

interface Inst {
  pos: Vector3
  quat: Quaternion
  scale: Vector3
}

function instanced(geo: BufferGeometry, mat: Material, list: Inst[], shadow = true): InstancedMesh {
  const m = new InstancedMesh(geo, mat, Math.max(1, list.length))
  list.forEach((it, i) => {
    _m.compose(it.pos, it.quat, it.scale)
    m.setMatrixAt(i, _m)
  })
  m.count = list.length
  m.castShadow = shadow
  m.receiveShadow = true
  m.frustumCulled = false
  return m
}

const weathered = (key: string, a: string, b: string) =>
  patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key,
    cloudShadows: true,
    fragmentPars: SRGB,
    fragmentColor: /* glsl */ `
      {
        float n = vfNoise(vec2(vAtmoWorld.y * 6.0, dot(vAtmoWorld.xz, vec2(0.7)) * 1.4));
        diffuseColor.rgb = mix(${a}, ${b}, n) * (0.85 + 0.25 * vfNoise(vAtmoWorld.xz * 3.0 + vAtmoWorld.y));
      }
    `,
  })

function roadFrame(T: Terrain, s: number) {
  const p = { x: 0, z: 0, tx: 0, tz: 0 }
  T.road.sample(s, p)
  return { x: p.x, z: p.z, tx: p.tx, tz: p.tz, rx: -p.tz, rz: p.tx }
}

function inBridge(T: Terrain, s: number, margin: number) {
  let d = Math.abs(T.road.wrap(s) - T.bridge.s)
  d = Math.min(d, T.road.length - d)
  return d < 18 + margin
}

// ------------------------------------------------------------------ telephone line

function telephone(T: Terrain, group: Group) {
  const L = T.road.length
  const s0 = TELEPHONE_RUN.from * L
  let s1 = TELEPHONE_RUN.to * L
  if (s1 < s0) s1 += L
  const lat = -6.2 // left of travel
  const poles: Inst[] = []
  const arms: Inst[] = []
  const tops: Vector3[][] = []
  const rnd = mulberry32(555)
  for (let s = s0; s < s1; s += 44 + rnd() * 6) {
    if (inBridge(T, s, 14)) continue
    const f = roadFrame(T, s)
    const x = f.x + f.rx * lat, z = f.z + f.rz * lat
    const y = T.heightAt(x, z)
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(f.tx, 0, f.tz), (rnd() - 0.5) * 0.06)
    const yaw = new Quaternion().setFromAxisAngle(UP, Math.atan2(f.tx, f.tz))
    const q = tilt.multiply(yaw)
    poles.push({ pos: new Vector3(x, y + 4.6, z), quat: q, scale: new Vector3(1, 1, 1) })
    const armPos = new Vector3(0, 4.0, 0).applyQuaternion(q).add(new Vector3(x, y + 4.6, z))
    arms.push({ pos: armPos, quat: q, scale: new Vector3(1, 1, 1) })
    const across = new Vector3(1, 0, 0).applyQuaternion(q)
    tops.push([
      armPos.clone().addScaledVector(across, -0.95).add(new Vector3(0, 0.12, 0)),
      armPos.clone().addScaledVector(across, 0.95).add(new Vector3(0, 0.12, 0)),
      armPos.clone().add(new Vector3(0, -1.1, 0)).addScaledVector(across, 0.18),
    ])
  }
  const wood = weathered('prop-pole', 'srgb(0.25, 0.20, 0.16)', 'srgb(0.36, 0.30, 0.24)')
  group.add(instanced(new CylinderGeometry(0.13, 0.17, 9.4, 7), wood, poles))
  group.add(instanced(new BoxGeometry(2.3, 0.13, 0.13), wood, arms))
  // catenary wires, swaying gently with the wind (vertex shader)
  const pos: number[] = []
  const attr: number[] = [] // x: along span (0..1), y: phase
  const seg = 14
  for (let i = 0; i < tops.length - 1; i++) {
    for (let w = 0; w < 3; w++) {
      const a = tops[i][w], b = tops[i + 1][w]
      const span = a.distanceTo(b)
      if (span > 80) continue
      const sag = span * 0.028
      for (let k = 0; k < seg; k++) {
        for (const t of [k / seg, (k + 1) / seg]) {
          const p = a.clone().lerp(b, t)
          p.y -= sag * 4 * t * (1 - t)
          pos.push(p.x, p.y, p.z)
          attr.push(t, i * 1.7 + w * 0.4)
        }
      }
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('aWire', new BufferAttribute(new Float32Array(attr), 2))
  const mat = new ShaderMaterial({
    uniforms: { uTime: U.uTime, uAmbientWind: U.uAmbientWind, uSunDir: U.uSunDir, uSunColor: U.uSunColor, uSkyZenith: U.uSkyZenith, uSkyHorizonSun: U.uSkyHorizonSun, uSkyHorizonAway: U.uSkyHorizonAway, uHazeCool: U.uHazeCool, uFogA: U.uFogA, uFogB: U.uFogB, uFogFalloff: U.uFogFalloff, uFogBase: U.uFogBase },
    vertexShader: /* glsl */ `
      attribute vec2 aWire;
      uniform float uTime;
      uniform vec2 uAmbientWind;
      varying vec3 vW;
      void main() {
        vec3 p = position;
        float belly = 4.0 * aWire.x * (1.0 - aWire.x);
        float w = 0.35 + length(uAmbientWind) * 1.2;
        p.x += belly * w * 0.12 * sin(uTime * 1.3 + aWire.y);
        p.z += belly * w * 0.12 * cos(uTime * 1.1 + aWire.y * 1.3);
        p.y += belly * 0.04 * sin(uTime * 2.1 + aWire.y * 2.0);
        vW = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      ${GLSL_ATMO}
      void main() {
        vec3 c = vec3(0.025, 0.022, 0.02);
        gl_FragColor = vec4(vfAtmosphere(c, vW), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const lines = new LineSegments(geo, mat)
  lines.frustumCulled = false
  lines.name = 'wires'
  group.add(lines)
}

// ------------------------------------------------------------------ fences

function fenceAlong(points: Vector3[], posts: Inst[], rails: Inst[], rnd: () => number) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1]
    const len = a.distanceTo(b)
    const yaw = Math.atan2(b.x - a.x, b.z - a.z)
    const q = new Quaternion().setFromAxisAngle(UP, yaw)
    posts.push({ pos: a.clone().add(new Vector3(0, 0.55, 0)), quat: q.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (rnd() - 0.5) * 0.08)), scale: new Vector3(1, 0.9 + rnd() * 0.2, 1) })
    for (const h of [0.5, 0.92]) {
      const mid = a.clone().lerp(b, 0.5).add(new Vector3(0, h, 0))
      const pitch = Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z))
      const rq = q.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch + (rnd() - 0.5) * 0.04))
      rails.push({ pos: mid, quat: rq, scale: new Vector3(1, 1, len / 2.8) })
    }
  }
}

function fences(T: Terrain, group: Group) {
  const posts: Inst[] = []
  const rails: Inst[] = []
  const rnd = mulberry32(808)
  const along = (sA: number, sB: number, lat: number) => {
    const pts: Vector3[] = []
    for (let s = sA; s <= sB; s += 2.8) {
      if (inBridge(T, s, 8)) {
        if (pts.length > 1) fenceAlong(pts.splice(0), posts, rails, rnd)
        pts.length = 0
        continue
      }
      const f = roadFrame(T, s)
      const x = f.x + f.rx * lat, z = f.z + f.rz * lat
      pts.push(new Vector3(x, T.heightAt(x, z), z))
    }
    if (pts.length > 1) fenceAlong(pts, posts, rails, rnd)
  }
  // the farm frontage and the meadow after the bridge
  along(705, 1010, 7.4)
  along(585, 700, -7.6)
  // around the hay field, inset from its ragged edge
  const field = CLEARINGS.find((c) => c.kind === 'field')!
  const poly = inset(field.poly, 9)
  const pts: Vector3[] = []
  for (let i = 0; i <= poly.length; i++) {
    const [ax, az] = poly[i % poly.length]
    const [bx, bz] = poly[(i + 1) % poly.length]
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 2.8))
    if (i === poly.length) break
    for (let k = 0; k < n; k++) {
      const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n
      // leave a gap where the road and the barn are
      const hit = { d: 0, s: 0, lat: 0 }
      if (T.roadNearest(x, z, 14, hit)) {
        if (pts.length > 1) fenceAlong(pts.splice(0), posts, rails, rnd)
        pts.length = 0
        continue
      }
      pts.push(new Vector3(x, T.heightAt(x, z), z))
    }
  }
  if (pts.length > 1) fenceAlong(pts, posts, rails, rnd)
  const wood = weathered('prop-fence', 'srgb(0.42, 0.39, 0.34)', 'srgb(0.55, 0.52, 0.46)')
  group.add(instanced(new BoxGeometry(0.16, 1.25, 0.16), wood, posts))
  group.add(instanced(new BoxGeometry(0.09, 0.13, 2.95), wood, rails))
}

function inset(poly: V2[], d: number): V2[] {
  let cx = 0, cz = 0
  for (const [x, z] of poly) {
    cx += x
    cz += z
  }
  cx /= poly.length
  cz /= poly.length
  return poly.map(([x, z]) => {
    const dx = x - cx, dz = z - cz
    const l = Math.hypot(dx, dz)
    return [x - (dx / l) * d, z - (dz / l) * d] as V2
  })
}

// ------------------------------------------------------------------ stone walls & boulders

function stoneGeometry(seed: number): BufferGeometry {
  const g = mergeVertices(new IcosahedronGeometry(1, 1))
  const n = new Simplex2(seed)
  const p = g.getAttribute('position') as BufferAttribute
  const v = new Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    const d = 1 + 0.28 * n.noise(v.x * 1.3 + v.z, v.y * 1.3 - v.x * 0.4)
    p.setXYZ(i, v.x * d, v.y * d * 0.8, v.z * d)
  }
  g.computeVertexNormals()
  return g
}

function stones(T: Terrain, group: Group) {
  const wall: Inst[] = []
  const rnd = mulberry32(1777)
  const lay = (pts: Vector3[]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      const len = a.distanceTo(b)
      const n = Math.ceil(len / 0.55)
      for (let k = 0; k < n; k++) {
        const t = k / n
        const x = a.x + (b.x - a.x) * t + (rnd() - 0.5) * 0.4
        const z = a.z + (b.z - a.z) * t + (rnd() - 0.5) * 0.4
        const y = T.heightAt(x, z)
        // two courses, the top one a little ragged and sometimes missing
        for (const c of [0, 1]) {
          if (c === 1 && rnd() < 0.25) continue
          const s = 0.32 + rnd() * 0.22
          wall.push({
            pos: new Vector3(x + (rnd() - 0.5) * 0.3, y + 0.18 + c * 0.42, z + (rnd() - 0.5) * 0.3),
            quat: new Quaternion().setFromAxisAngle(new Vector3(rnd(), rnd(), rnd()).normalize(), rnd() * 6.28),
            scale: new Vector3(s * (1 + rnd() * 0.5), s * 0.8, s),
          })
        }
      }
    }
  }
  const roadside = (sA: number, sB: number, lat: number) => {
    const pts: Vector3[] = []
    for (let s = sA; s <= sB; s += 6) {
      const f = roadFrame(T, s)
      pts.push(new Vector3(f.x + f.rx * lat, 0, f.z + f.rz * lat))
    }
    lay(pts)
  }
  roadside(2180, 2420, 8.2) // west side, past the white house
  roadside(30, 150, -8.5) // foreground forest
  roadside(1160, 1250, -7.8) // hillside climb
  // old property lines running off into the woods
  const into = (s: number, lat: number, ang: number, len: number) => {
    const f = roadFrame(T, s)
    const sx = f.x + f.rx * lat, sz = f.z + f.rz * lat
    const dx = f.rx * Math.cos(ang) - f.tx * Math.sin(ang)
    const dz = f.rz * Math.cos(ang) - f.tz * Math.sin(ang)
    const pts: Vector3[] = []
    for (let d = 0; d <= len; d += 8) pts.push(new Vector3(sx + dx * d + Math.sin(d * 0.05) * 2, 0, sz + dz * d))
    lay(pts)
  }
  into(2560, -8, 0.15, 140)
  into(320, 8, -0.1, 110)
  into(1500, 8, 0.25, 90)
  const lichen = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'prop-stone',
    cloudShadows: true,
    fragmentPars: SRGB,
    fragmentColor: /* glsl */ `
      {
        float n = vfNoise(vAtmoWorld.xz * 2.1 + vAtmoWorld.y * 3.3);
        vec3 c = mix(srgb(0.40, 0.39, 0.37), srgb(0.56, 0.55, 0.51), n);
        float moss = smoothstep(0.55, 0.85, vfNoise(vAtmoWorld.xz * 1.7 + 4.0)) * smoothstep(0.0, 0.6, vNormal.y * 0.5 + 0.5);
        c = mix(c, srgb(0.36, 0.42, 0.24), moss * 0.6);
        c = mix(c, srgb(0.70, 0.68, 0.55), smoothstep(0.8, 0.95, vfNoise(vAtmoWorld.xz * 6.0)) * 0.5);
        diffuseColor.rgb = c;
      }
    `,
  })
  group.add(instanced(stoneGeometry(3), lichen, wall))

  // boulders: some by the road (seen from the car), ledges at the overlook
  const boulders: Inst[] = []
  const hit = { d: 0, s: 0, lat: 0 }
  for (let i = 0; i < 520; i++) {
    const s = rnd() * T.road.length
    if (inBridge(T, s, 10)) continue
    const f = roadFrame(T, s)
    const lat = (rnd() > 0.5 ? 1 : -1) * (9 + rnd() * 26)
    const x = f.x + f.rx * lat, z = f.z + f.rz * lat
    if (T.roadNearest(x, z, 8.5, hit)) continue
    if (T.clearing(x, z) > 0.6 && rnd() > 0.15) continue
    const sc = 0.4 + Math.pow(rnd(), 2.5) * 2.2
    boulders.push({
      pos: new Vector3(x, T.heightAt(x, z) + sc * 0.15, z),
      quat: new Quaternion().setFromAxisAngle(UP, rnd() * 6.28),
      scale: new Vector3(sc * (1 + rnd() * 0.6), sc * 0.7, sc),
    })
  }
  // the overlook's granite ledges
  for (let i = 0; i < 26; i++) {
    const x = 110 + rnd() * 200, z = -690 - rnd() * 100
    if (T.roadNearest(x, z, 9, hit)) continue
    const sc = 1 + rnd() * 2.8
    boulders.push({ pos: new Vector3(x, T.heightAt(x, z) - sc * 0.15, z), quat: new Quaternion().setFromAxisAngle(UP, rnd() * 6.28), scale: new Vector3(sc * 1.8, sc * 0.55, sc) })
  }
  group.add(instanced(stoneGeometry(9), lichen, boulders))
}

// ------------------------------------------------------------------ signs, mailboxes, bales, pumpkins

function canvasSign(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  draw(g, w, h)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

function signs(T: Terrain, group: Group, mailboxes: { x: number; z: number; rot: number }[]) {
  const postMat = weathered('prop-post', 'srgb(0.35, 0.29, 0.22)', 'srgb(0.45, 0.38, 0.30)')
  const metal = patchMaterial(new MeshLambertMaterial({ color: new Color('#8d9194') }), { key: 'prop-metal', cloudShadows: true })
  const place = (s: number, lat: number, tex: CanvasTexture, w: number, h: number, height: number, shape: 'diamond' | 'rect' = 'rect') => {
    const f = roadFrame(T, s)
    const x = f.x + f.rx * lat, z = f.z + f.rz * lat
    const y = T.heightAt(x, z)
    const g = new Group()
    g.position.set(x, y, z)
    // face oncoming traffic
    g.rotation.y = Math.atan2(-f.tx, -f.tz)
    const post = new Mesh(new BoxGeometry(0.09, height, 0.09), shape === 'rect' && w > 1.2 ? postMat : metal)
    post.position.y = height / 2
    post.castShadow = true
    g.add(post)
    const mat = patchMaterial(new MeshLambertMaterial({ map: tex }), { key: 'prop-sign', cloudShadows: true })
    const plate = new Mesh(new PlaneGeometry(w, h), mat)
    plate.position.set(0, height + h * 0.35, 0.06)
    if (shape === 'diamond') plate.rotation.z = Math.PI / 4
    plate.castShadow = true
    g.add(plate)
    const back = new Mesh(new PlaneGeometry(w, h), metal)
    back.position.copy(plate.position).setZ(0.05)
    back.rotation.set(0, Math.PI, plate.rotation.z)
    g.add(back)
    group.add(g)
  }
  const curve = (dir: 1 | -1) =>
    canvasSign(256, 256, (g, w, h) => {
      g.fillStyle = '#e8b41f'
      g.fillRect(0, 0, w, h)
      g.strokeStyle = '#141414'
      g.lineWidth = 12
      g.strokeRect(12, 12, w - 24, h - 24)
      g.save()
      g.translate(w / 2, h / 2)
      g.rotate(-Math.PI / 4)
      g.lineWidth = 20
      g.lineCap = 'round'
      g.beginPath()
      g.moveTo(0, 70)
      g.lineTo(0, 0)
      g.quadraticCurveTo(0, -40, dir * 40, -50)
      g.stroke()
      g.beginPath()
      g.moveTo(dir * 60, -50)
      g.lineTo(dir * 25, -75)
      g.lineTo(dir * 25, -25)
      g.closePath()
      g.fillStyle = '#141414'
      g.fill()
      g.restore()
    })
  // curve warnings before the hairpin and the western S-bends
  place(1225, 5.4, curve(-1), 0.75, 0.75, 1.9, 'diamond')
  place(2630, 5.4, curve(1), 0.75, 0.75, 1.9, 'diamond')
  // scenic view
  place(
    1560,
    5.6,
    canvasSign(512, 200, (g, w, h) => {
      g.fillStyle = '#5a3a22'
      g.fillRect(0, 0, w, h)
      g.strokeStyle = '#efe6cf'
      g.lineWidth = 8
      g.strokeRect(10, 10, w - 20, h - 20)
      g.fillStyle = '#efe6cf'
      g.textAlign = 'center'
      g.font = '600 76px Georgia, serif'
      g.fillText('SCENIC VIEW', w / 2, 115)
      g.font = '500 40px Georgia, serif'
      g.fillText('¼ MILE', w / 2, 168)
    }),
    1.6,
    0.62,
    1.6,
  )
  // the foliage road
  place(
    90,
    5.6,
    canvasSign(256, 300, (g, w, h) => {
      g.fillStyle = '#f2efe6'
      g.fillRect(0, 0, w, h)
      g.fillStyle = '#1f5a34'
      g.beginPath()
      g.roundRect(18, 18, w - 36, h - 36, 26)
      g.fill()
      g.fillStyle = '#f2efe6'
      g.textAlign = 'center'
      g.font = '700 40px Arial, sans-serif'
      g.fillText('VERMONT', w / 2, 80)
      g.font = '700 132px Arial, sans-serif'
      g.fillText('100', w / 2, 218)
    }),
    0.62,
    0.72,
    1.7,
  )
  // a hand-painted farm stand sign leaning on its post
  place(
    690,
    6.4,
    canvasSign(512, 256, (g, w, h) => {
      g.fillStyle = '#8a2a1e'
      g.fillRect(0, 0, w, h)
      g.fillStyle = 'rgba(0,0,0,0.12)'
      for (let y = 0; y < h; y += 42) g.fillRect(0, y, w, 3)
      g.fillStyle = '#f4ecd8'
      g.textAlign = 'center'
      g.font = 'italic 600 64px Georgia, serif'
      g.fillText('Maple Syrup', w / 2, 92)
      g.font = '600 46px Georgia, serif'
      g.fillText('PUMPKINS · CIDER', w / 2, 168)
      g.font = 'italic 34px Georgia, serif'
      g.fillText('honor system', w / 2, 222)
    }),
    1.5,
    0.75,
    0.9,
  )
  // mailboxes at the houses
  const box = patchMaterial(new MeshLambertMaterial({ color: new Color('#2b2f30') }), { key: 'prop-mailbox', cloudShadows: true })
  const flag = patchMaterial(new MeshLambertMaterial({ color: new Color('#b82a1f') }), { key: 'prop-flag', cloudShadows: true })
  for (const mb of mailboxes) {
    const y = T.heightAt(mb.x, mb.z)
    const g = new Group()
    g.position.set(mb.x, y, mb.z)
    g.rotation.y = mb.rot + Math.PI / 2
    const post = new Mesh(new BoxGeometry(0.1, 1.1, 0.1), postMat)
    post.position.y = 0.55
    const body = new Mesh(new CylinderGeometry(0.15, 0.15, 0.5, 14, 1, false, 0, Math.PI), box)
    body.rotation.z = Math.PI / 2
    body.position.y = 1.1
    const base = new Mesh(new BoxGeometry(0.5, 0.15, 0.3), box)
    base.position.y = 1.08
    const fl = new Mesh(new BoxGeometry(0.02, 0.18, 0.07), flag)
    fl.position.set(0.05, 1.28, 0.16)
    for (const m of [post, body, base, fl]) {
      m.castShadow = true
      g.add(m)
    }
    group.add(g)
  }
}

function farmyard(T: Terrain, group: Group) {
  const rnd = mulberry32(42)
  const bales: Inst[] = []
  const hit = { d: 0, s: 0, lat: 0 }
  // round bales left in a loose line across the mown field
  for (let i = 0; i < 16; i++) {
    const t = i / 15
    const x = 560 + t * 120 + (rnd() - 0.5) * 18
    const z = -120 + t * 170 + (rnd() - 0.5) * 22
    if (T.roadNearest(x, z, 14, hit)) continue
    if (T.clearing(x, z) < 0.8) continue
    bales.push({ pos: new Vector3(x, T.heightAt(x, z) + 0.72, z), quat: new Quaternion().setFromAxisAngle(UP, rnd() * 6.28).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)), scale: new Vector3(1, 1, 1) })
  }
  const hay = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'prop-bale',
    cloudShadows: true,
    fragmentPars: SRGB,
    fragmentColor: /* glsl */ `
      {
        float n = vfNoise(vAtmoWorld.xz * 9.0 + vAtmoWorld.y * 11.0);
        diffuseColor.rgb = mix(srgb(0.62, 0.50, 0.28), srgb(0.78, 0.66, 0.38), n);
      }
    `,
  })
  group.add(instanced(new CylinderGeometry(0.75, 0.75, 1.25, 16), hay, bales))
  // pumpkins by the farm stand and on the farmhouse step
  const pumpkins: Inst[] = []
  const f = roadFrame(T, 688)
  for (let i = 0; i < 22; i++) {
    const lat = 6.6 + rnd() * 1.8
    const along = (rnd() - 0.5) * 3.2
    const x = f.x + f.rx * lat + f.tx * along, z = f.z + f.rz * lat + f.tz * along
    const s = 0.2 + rnd() * 0.16
    pumpkins.push({ pos: new Vector3(x, T.heightAt(x, z) + s * 0.6, z), quat: new Quaternion().setFromAxisAngle(UP, rnd() * 6.28), scale: new Vector3(s * 1.15, s * 0.85, s * 1.15) })
  }
  const pmat = patchMaterial(new MeshLambertMaterial({ color: 0xffffff }), {
    key: 'prop-pumpkin',
    cloudShadows: true,
    fragmentPars: SRGB,
    fragmentColor: /* glsl */ `
      {
        // ribs from the instance-local longitude
        float ribs = 0.8 + 0.2 * abs(sin(atan(vNormal.x, vNormal.z) * 5.0));
        diffuseColor.rgb = mix(srgb(0.86, 0.42, 0.08), srgb(0.95, 0.55, 0.12), vfNoise(vAtmoWorld.xz * 3.0)) * ribs;
      }
    `,
  })
  group.add(instanced(new SphereGeometry(1, 14, 10), pmat, pumpkins))
}

export interface PropsBuild {
  group: Group
}

export function buildProps(T: Terrain, mailboxes: { x: number; z: number; rot: number }[]): PropsBuild {
  const group = new Group()
  group.name = 'props'
  telephone(T, group)
  fences(T, group)
  stones(T, group)
  signs(T, group, mailboxes)
  farmyard(T, group)
  return { group }
}
