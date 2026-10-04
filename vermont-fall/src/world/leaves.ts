import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Texture,
} from 'three'
import { mulberry32 } from '../core/noise'
import { patchMaterial } from '../render/shared'
import type { Terrain } from './terrain'
import type { Forest } from './trees'
import type { WindField } from './wind'

const FREE = 0
const FALL = 1
const REST = 2

/**
 * Individual autumn leaves. Most stay on the trees; the few that fall are meant
 * to feel special: they glide and flutter, catch gusts, skitter along the road,
 * and are stirred up by the car and by the pointer's breath of air.
 */
export class Leaves {
  readonly mesh: InstancedMesh
  readonly max: number
  private pos: Float32Array
  private vel: Float32Array
  private axis: Float32Array
  private ang: Float32Array
  private spin: Float32Array
  private phase: Float32Array
  private size: Float32Array
  private state: Uint8Array
  private age: Float32Array
  private rest: Float32Array
  private tile: Float32Array
  /** per-leaf colour; render slots are compacted each frame */
  private lcol: Float32Array
  private slotTile: Float32Array
  private flutterDir: Float32Array
  private cursor = 0
  private rnd = mulberry32(2024)
  private col = new Color()
  private m = new Matrix4()
  private q = new Quaternion()
  private v = new Vector3()
  private s = new Vector3()
  private air = { x: 0, z: 0, e: 0 }
  private hit = { d: 0, s: 0, lat: 0 }
  private ambientTimer = 0
  private skitterTimer = 6
  active = 0

  /** POV disturbances, set every frame by the app */
  car = { on: false, pos: new Vector3(), vel: new Vector3(), fwd: new Vector3() }
  pointer = { on: false, origin: new Vector3(), dir: new Vector3(), push: new Vector3(), strength: 0 }
  /** leaves that cross this sphere may land on the windshield */
  windshield: { center: Vector3; radius: number; ready: boolean; land: (tile: number, color: Color, sx: number, sy: number) => void } | null = null

  constructor(private T: Terrain, private forest: Forest, private wind: WindField, atlas: Texture, max = 700) {
    this.max = max
    this.pos = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.axis = new Float32Array(max * 3)
    this.ang = new Float32Array(max)
    this.spin = new Float32Array(max)
    this.phase = new Float32Array(max)
    this.size = new Float32Array(max)
    this.state = new Uint8Array(max)
    this.age = new Float32Array(max)
    this.rest = new Float32Array(max)
    this.tile = new Float32Array(max)
    this.lcol = new Float32Array(max * 3)
    this.slotTile = new Float32Array(max)
    this.flutterDir = new Float32Array(max)
    const geo = curledLeaf()
    geo.setAttribute('aTile', new InstancedBufferAttribute(this.slotTile, 1))
    const mat = patchMaterial(new MeshLambertMaterial({ map: atlas, alphaTest: 0.5, side: DoubleSide }), {
      key: 'leaf-particles',
      cloudShadows: true,
      vertexPars: 'attribute float aTile;',
      vertexBegin: /* glsl */ `
        vMapUv = vMapUv * 0.5 + vec2(mod(aTile, 2.0), floor(aTile / 2.0)) * 0.5;
      `,
      vertexWorld: /* glsl */ `
        vec4 c0 = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // never smaller than a few pixels, so a falling leaf still reads from the sky
        float dv = distance(c0.xyz, uViewPos);
        float grow = max(1.0, dv * 0.0021 / max(length(instanceMatrix[0].xyz), 1e-4));
        vfWorld = modelMatrix * instanceMatrix * vec4(transformed * grow, 1.0);
      `,
      fragmentOutgoing: /* glsl */ `
        // thin leaves glow when the low sun is behind them
        vec3 V = normalize(cameraPosition - vAtmoWorld);
        float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
        outgoingLight += diffuseColor.rgb * uSunColor * back * 0.6;
      `,
    })
    this.mesh = new InstancedMesh(geo, mat, max)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
    this.mesh.name = 'leaves'
    // instance colours
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, this.col.set(1, 1, 1))
  }

  private alloc(): number {
    for (let k = 0; k < this.max; k++) {
      const i = (this.cursor + k) % this.max
      if (this.state[i] === FREE) {
        this.cursor = (i + 1) % this.max
        return i
      }
    }
    // pool full: recycle the oldest resting leaf
    let oldest = -1, age = -1
    for (let i = 0; i < this.max; i++) if (this.state[i] === REST && this.age[i] > age) { age = this.age[i]; oldest = i }
    return oldest
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: Color, size = 0.11) {
    const i = this.alloc()
    if (i < 0) return -1
    const r = this.rnd
    this.pos.set([x, y, z], i * 3)
    this.vel.set([vx, vy, vz], i * 3)
    const ax = r() - 0.5, ay = r() - 0.5, az = r() - 0.5
    const al = Math.hypot(ax, ay, az) || 1
    this.axis.set([ax / al, ay / al, az / al], i * 3)
    this.ang[i] = r() * 6.28
    this.spin[i] = (r() - 0.5) * 7
    this.phase[i] = r() * 6.28
    this.flutterDir[i] = r() * 6.28
    this.size[i] = size * (0.8 + r() * 0.45)
    this.state[i] = FALL
    this.age[i] = 0
    this.rest[i] = 6 + r() * 14
    this.tile[i] = Math.floor(r() * 4)
    this.lcol[i * 3] = color.r
    this.lcol[i * 3 + 1] = color.g
    this.lcol[i * 3 + 2] = color.b
    return i
  }

  /** a leaf lets go of a particular tree */
  dropFrom(tree: number, push: Vector3 | null, color?: Color, size = 0.11) {
    const d = this.forest.d
    const r = this.rnd
    if (d.hue[tree] === 3) return // conifers keep their needles
    const h = d.height[tree]
    const a = r() * 6.28
    const rad = h * 0.22 * Math.sqrt(r())
    const x = d.x[tree] + Math.cos(a) * rad
    const z = d.z[tree] + Math.sin(a) * rad
    const y = d.y[tree] + h * (0.45 + 0.45 * r())
    this.col.setRGB(d.tint[tree * 3], d.tint[tree * 3 + 1], d.tint[tree * 3 + 2])
    if (color) this.col.copy(color)
    // individual leaves are a touch brighter than the crown's shadowed mass
    this.col.multiplyScalar(1.15 + r() * 0.2)
    this.spawn(x, y, z, push ? push.x : 0, push ? push.y : 0.3, push ? push.z : 0, this.col, size)
  }

  /** ground height including the road surface */
  private ground(x: number, z: number): number {
    const T = this.T
    if (T.roadNearest(x, z, 5.7, this.hit)) {
      if (T.isOnBridge(this.hit.s)) return T.bridge.deckY
      return T.roadYAt(this.hit.s) + (this.hit.d > 3.3 ? -0.05 : 0.0)
    }
    return T.heightAt(x, z)
  }

  update(dt: number, view: Vector3, mode: 'aerial' | 'pov' | 'moving') {
    dt = Math.min(dt, 1 / 20)
    this.autoSpawn(dt, view, mode)
    const r = this.rnd
    let n = 0
    const P = this.pos, V = this.vel
    const car = this.car, ptr = this.pointer
    for (let i = 0; i < this.max; i++) {
      const st = this.state[i]
      if (st === FREE) continue
      this.age[i] += dt
      const o = i * 3
      let x = P[o], y = P[o + 1], z = P[o + 2]
      let vx = V[o], vy = V[o + 1], vz = V[o + 2]
      this.wind.sample(x, z, this.air)
      let ax = this.air.x, ay = 0, az = this.air.z
      // the car pushes air aside, lifts and drags leaves along in its wake
      if (car.on) {
        const dx = x - car.pos.x, dy = y - car.pos.y, dz = z - car.pos.z
        const d2 = dx * dx + dz * dz
        if (d2 < 64 && dy < 4) {
          const f = 1 - Math.sqrt(d2) / 8
          const sp = car.vel.length()
          const along = dx * car.fwd.x + dz * car.fwd.z
          if (along > -0.5) {
            // ahead of the car the air rides up over the hood and the glass
            ay += sp * 0.12 * f
          } else {
            // behind it, the wake drags leaves along, lifts them and flings them aside
            const side = (dx * car.fwd.z - dz * car.fwd.x) > 0 ? 1 : -1
            ax += car.vel.x * 0.65 * f + car.fwd.z * side * sp * 0.35 * f
            az += car.vel.z * 0.65 * f - car.fwd.x * side * sp * 0.35 * f
            ay += sp * 0.32 * f
          }
        }
      }
      // the pointer's breath of air around the car
      if (ptr.on && ptr.strength > 0.01) {
        const dx = x - ptr.origin.x, dy = y - ptr.origin.y, dz = z - ptr.origin.z
        const t = dx * ptr.dir.x + dy * ptr.dir.y + dz * ptr.dir.z
        if (t > 0.5 && t < 28) {
          const px = dx - ptr.dir.x * t, py = dy - ptr.dir.y * t, pz = dz - ptr.dir.z * t
          const d = Math.sqrt(px * px + py * py + pz * pz)
          const rad = 1.2 + t * 0.12
          if (d < rad) {
            const f = (1 - d / rad) * ptr.strength
            ax += ptr.push.x * f
            ay += ptr.push.y * f + 1.4 * f
            az += ptr.push.z * f
          }
        }
      }
      const g = this.ground(x, z)
      if (st === FALL) {
        // glide-and-flutter: side-to-side swings on the way down
        this.phase[i] += dt * (2.4 + (i % 7) * 0.12)
        const fd = this.flutterDir[i] + this.age[i] * 0.4
        const sw = Math.sin(this.phase[i]) * 1.9
        ax += Math.cos(fd) * sw
        az += Math.sin(fd) * sw
        vx += (ax - vx) * Math.min(1, dt * 2.2)
        vz += (az - vz) * Math.min(1, dt * 2.2)
        vy += (ay - 9.8 * 0.16 - vy) * Math.min(1, dt * 3.4) + Math.cos(this.phase[i] * 2) * dt * 1.2
        this.ang[i] += this.spin[i] * dt * (0.6 + Math.hypot(vx, vz) * 0.15)
        x += vx * dt
        y += vy * dt
        z += vz * dt
        if (y <= g + 0.012) {
          y = g + 0.012
          if (Math.hypot(ax, az) > 4.5 && r() < 0.5) {
            vy = 0.6 + r() * 1.4 // caught again
          } else {
            this.state[i] = REST
            this.age[i] = 0
            vy = 0
          }
        }
        // windshield
        const ws = this.windshield
        if (ws && ws.ready) {
          const dx = x - ws.center.x, dy = y - ws.center.y, dz = z - ws.center.z
          if (dx * dx + dy * dy + dz * dz < ws.radius * ws.radius) {
            this.col.fromArray(this.lcol, i * 3)
            ws.land(this.tile[i], this.col, (r() - 0.5) * 0.7, -0.05 + (r() - 0.5) * 0.4)
            this.state[i] = FREE
            continue
          }
        }
      } else {
        // resting: lie flat; strong air slides them, very strong air lifts them again
        const a = Math.hypot(ax, az)
        if (a > 2.2) {
          vx += (ax * 0.55 - vx) * Math.min(1, dt * 3)
          vz += (az * 0.55 - vz) * Math.min(1, dt * 3)
          this.ang[i] += (vx + vz) * dt * 1.5
          if (a > 5 + r() * 6 || ay > 1.2) {
            this.state[i] = FALL
            vy = 1.2 + r() * 2.2
          }
        } else {
          vx *= Math.exp(-dt * 4)
          vz *= Math.exp(-dt * 4)
        }
        x += vx * dt
        z += vz * dt
        y = this.ground(x, z) + 0.012
        // from the sky a resting leaf is only a speck: let it go quickly
        if (mode === 'aerial') this.age[i] += dt * 3
        if (this.age[i] > this.rest[i]) {
          this.state[i] = FREE
          continue
        }
      }
      if (Math.abs(x) > 1400 || Math.abs(z) > 1400) {
        this.state[i] = FREE
        continue
      }
      P[o] = x; P[o + 1] = y; P[o + 2] = z
      V[o] = vx; V[o + 1] = vy; V[o + 2] = vz
      // orientation: tumbling while falling, flat when resting
      const fade = this.state[i] === REST ? Math.min(1, (this.rest[i] - this.age[i]) / 1.5) : 1
      if (this.state[i] === REST) this.q.setFromAxisAngle(this.v.set(0, 1, 0), this.ang[i])
      else this.q.setFromAxisAngle(this.v.fromArray(this.axis, o), this.ang[i])
      const sz = this.size[i] * Math.max(0, fade)
      this.m.compose(this.v.set(x, y, z), this.q, this.s.set(sz, sz, sz))
      this.mesh.setMatrixAt(n, this.m)
      const ic = this.mesh.instanceColor!
      ic.array[n * 3] = this.lcol[o]
      ic.array[n * 3 + 1] = this.lcol[o + 1]
      ic.array[n * 3 + 2] = this.lcol[o + 2]
      this.slotTile[n] = this.tile[i]
      n++
    }
    ;(this.mesh.geometry.getAttribute('aTile') as InstancedBufferAttribute).needsUpdate = true
    this.mesh.count = n
    this.active = n
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  private autoSpawn(dt: number, view: Vector3, mode: 'aerial' | 'pov' | 'moving') {
    const r = this.rnd
    const d = this.forest.d
    // gusts tear a few leaves loose where they pass
    const act = this.wind.activity
    if (act > 0.5) {
      const want = Math.min(40, act * 0.35) * dt
      let k = Math.floor(want) + (r() < want % 1 ? 1 : 0)
      while (k-- > 0) {
        // pick a tree under a random gust cell
        const p = this.wind.randomGustPoint(r)
        if (!p) break
        let pick = -1
        this.forest.forEachNear(p.x, p.z, 25, (i) => {
          if (pick < 0 || r() < 0.2) pick = i
        })
        if (pick >= 0) this.dropFrom(pick, this.v.set(p.dx * 4, 0.8, p.dz * 4))
      }
    }
    // a slow ambient fall near what you are looking at
    this.ambientTimer -= dt
    if (this.ambientTimer <= 0) {
      if (mode === 'aerial') {
        this.ambientTimer = 0.25 + r() * 0.4
        const t = Math.floor(r() * d.count)
        if (Math.abs(d.x[t] - 40) < 700 && Math.abs(d.z[t] + 100) < 700) this.dropFrom(t, null)
      } else {
        this.ambientTimer = 0.18 + r() * 0.32
        // a tree beside the road ahead lets one go: they drift across the windshield view
        const c = this.car
        const ahead = 8 + r() * 42
        const px = view.x + c.fwd.x * ahead, pz = view.z + c.fwd.z * ahead
        let pick = -1
        this.forest.forEachNear(px, pz, 14, (i) => {
          if (pick < 0 || r() < 0.3) pick = i
        })
        if (pick >= 0) this.dropFrom(pick, null, undefined, 0.13 + r() * 0.05)
      }
    }
    // now and then a little eddy chases a handful of leaves across the road ahead
    if (mode !== 'aerial') {
      this.skitterTimer -= dt
      if (this.skitterTimer <= 0) {
        this.skitterTimer = 9 + r() * 14
        const c = this.car
        const ahead = 20 + r() * 25
        const side = r() > 0.5 ? 1 : -1
        const bx = view.x + c.fwd.x * ahead + c.fwd.z * side * 5
        const bz = view.z + c.fwd.z * ahead - c.fwd.x * side * 5
        for (let k = 0; k < 4 + Math.floor(r() * 5); k++) {
          const x = bx + (r() - 0.5) * 3, z = bz + (r() - 0.5) * 3
          const y = this.ground(x, z) + 0.05
          this.col.setHSL(0.03 + r() * 0.08, 0.7, 0.32 + r() * 0.15)
          const i = this.spawn(x, y, z, -c.fwd.z * side * (3 + r() * 2), 0.6 + r(), c.fwd.x * side * (3 + r() * 2), this.col, 0.1)
          if (i >= 0) this.state[i] = 1
        }
      }
    }
  }

  /** burst of leaves around the camera as it dives through the canopy */
  flurry(center: Vector3, n: number) {
    const r = this.rnd
    let pick = -1
    this.forest.forEachNear(center.x, center.z, 30, (i) => {
      if (pick < 0 || r() < 0.25) pick = i
    })
    for (let k = 0; k < n; k++) {
      const x = center.x + (r() - 0.5) * 14, y = center.y + (r() - 0.5) * 6, z = center.z + (r() - 0.5) * 14
      if (pick >= 0) this.col.setRGB(this.forest.d.tint[pick * 3], this.forest.d.tint[pick * 3 + 1], this.forest.d.tint[pick * 3 + 2]).multiplyScalar(1.2)
      else this.col.setHSL(0.06, 0.8, 0.4)
      this.spawn(x, y, z, (r() - 0.5) * 2, r() * 0.5, (r() - 0.5) * 2, this.col)
    }
  }
}

/** a gently cupped leaf: 2x2 grid bent along its midrib */
function curledLeaf(): BufferGeometry {
  const g = new PlaneGeometry(1, 1, 2, 2)
  const p = g.getAttribute('position') as BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i)
    p.setZ(i, x * x * 0.35 - y * y * 0.12)
  }
  g.computeVertexNormals()
  return g
}

/**
 * The rare leaf that lands on the windshield: pinned to the camera for a beat,
 * trembling, before the airflow peels it away.
 */
export class WindshieldLeaf {
  readonly mesh: Mesh
  private t = -1
  private hold = 1.6
  private sx = 0
  private sy = 0
  private spin = 0
  private dir = 1
  cooldown = 25
  onWhoosh: () => void = () => {}

  constructor(private cam: PerspectiveCamera, atlas: Texture) {
    const g = curledLeaf()
    const mat = new MeshLambertMaterial({ map: atlas, alphaTest: 0.5, side: DoubleSide, emissive: new Color('#5a2a08'), emissiveIntensity: 0.6 })
    this.mesh = new Mesh(g, mat)
    this.mesh.visible = false
    this.mesh.renderOrder = 20
    this.mesh.frustumCulled = false
    ;(mat as MeshLambertMaterial).depthTest = false
    cam.add(this.mesh)
  }

  get busy() {
    return this.t >= 0
  }

  land(tile: number, color: Color, sx: number, sy: number) {
    if (this.t >= 0) return
    this.t = 0
    this.sx = sx
    this.sy = sy
    this.spin = (Math.random() - 0.5) * 1.2
    this.dir = Math.random() > 0.5 ? 1 : -1
    this.hold = 1.1 + Math.random() * 0.9
    const mat = this.mesh.material as MeshLambertMaterial
    mat.color.copy(color).multiplyScalar(1.1)
    mat.emissive.copy(color).multiplyScalar(0.35)
    // pick the atlas tile by offsetting uv via texture transform on a cloned map
    if (mat.map) {
      if (!mat.userData.cloned) {
        mat.map = mat.map.clone()
        mat.userData.cloned = true
      }
      mat.map.repeat.set(0.5, 0.5)
      mat.map.offset.set((tile % 2) * 0.5, Math.floor(tile / 2) * 0.5)
      mat.map.needsUpdate = true
    }
    this.mesh.visible = true
    this.cooldown = 40 + Math.random() * 40
  }

  update(dt: number) {
    if (this.t < 0) {
      this.cooldown -= dt
      return
    }
    this.t += dt
    const d = 0.62
    const h = Math.tan((this.cam.fov * Math.PI) / 360) * d
    const w = h * this.cam.aspect
    let x = this.sx * w
    let y = this.sy * h
    let rot = this.spin
    let s = 0.15
    if (this.t < 0.18) {
      // the soft slap of landing
      s *= 0.75 + 0.25 * (this.t / 0.18)
    } else if (this.t < this.hold) {
      // pinned, trembling in the airflow
      const tr = this.t * 38
      x += Math.sin(tr) * 0.0025
      y += Math.cos(tr * 1.3) * 0.0018
      rot += Math.sin(this.t * 9) * 0.05
    } else {
      // whoosh: the airflow peels it up and away over the roof
      const u = this.t - this.hold
      if (u < 0.02) this.onWhoosh()
      x += this.dir * u * u * 2.2 * w
      y += u * u * 3.4 * h
      rot += this.dir * u * 7
      s *= 1 + u * 1.5
      if (u > 0.9) {
        this.t = -1
        this.mesh.visible = false
        return
      }
    }
    this.mesh.position.set(x, y, -d)
    this.mesh.rotation.set(0.25, 0.1, rot)
    this.mesh.scale.setScalar(s)
  }
}
