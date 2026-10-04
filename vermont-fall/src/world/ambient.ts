import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type IUniform,
} from 'three'
import { mulberry32 } from '../core/noise'
import { GLSL_ATMO, GLSL_NOISE, U, patchMaterial } from '../render/shared'
import type { Terrain } from './terrain'
import type { WindField } from './wind'

// ------------------------------------------------------------------ chimney smoke

function puffTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31)
  grad.addColorStop(0, 'rgba(255,255,255,0.9)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new CanvasTexture(c)
}

/**
 * Wood smoke from a couple of chimneys: soft billboard puffs that rise, widen,
 * thin out, and lean with the wind — they swing round when a gust passes.
 */
export class Smoke {
  readonly mesh: InstancedMesh
  private n: number
  private pos: Float32Array
  private vel: Float32Array
  private age: Float32Array
  private life: Float32Array
  private seed: Float32Array
  private alpha: Float32Array
  private sizeA: Float32Array
  private src: Vector3[]
  private next: number[]
  private rnd = mulberry32(7)
  private air = { x: 0, z: 0, e: 0 }
  private m = new Matrix4()

  constructor(sources: Vector3[], private wind: WindField, perSource = 46) {
    this.src = sources
    this.n = Math.max(1, sources.length * perSource)
    this.pos = new Float32Array(this.n * 3)
    this.vel = new Float32Array(this.n * 3)
    this.age = new Float32Array(this.n).fill(1e9)
    this.life = new Float32Array(this.n)
    this.seed = new Float32Array(this.n)
    this.alpha = new Float32Array(this.n)
    this.sizeA = new Float32Array(this.n)
    this.next = sources.map((_, i) => i * 0.3)
    const geo = new PlaneGeometry(1, 1)
    geo.setAttribute('aAlpha', new InstancedBufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage))
    geo.setAttribute('aSeed', new InstancedBufferAttribute(this.seed, 1))
    const uniforms: Record<string, IUniform> = { uMap: { value: puffTexture() } }
    for (const k of ['uTime', 'uSunDir', 'uSunColor', 'uSkyZenith', 'uSkyHorizonSun', 'uSkyHorizonAway', 'uHazeCool', 'uFogA', 'uFogB', 'uFogFalloff', 'uFogBase', 'uViewPos'] as const) uniforms[k] = U[k] as IUniform
    const mat = new ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute float aSeed;
        uniform vec3 uViewPos;
        varying vec2 vUv;
        varying float vA;
        varying vec3 vW;
        varying float vSeed;
        void main() {
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float s = length(instanceMatrix[0].xyz);
          // readable from the sky: never thinner than a few pixels
          s = max(s, distance(c, uViewPos) * 0.0045);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 w = c + (right * position.x + up * position.y) * s;
          vUv = uv;
          vA = aAlpha;
          vW = w;
          vSeed = aSeed;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uTime;
        varying vec2 vUv;
        varying float vA;
        varying vec3 vW;
        varying float vSeed;
        ${GLSL_NOISE}
        ${GLSL_ATMO}
        void main() {
          float a = texture2D(uMap, vUv).a;
          float n = vfNoise(vUv * 3.0 + vSeed * 7.0 + uTime * 0.15);
          a *= vA * (0.55 + 0.6 * n);
          if (a < 0.004) discard;
          // lit warm on the sun side, bluish grey in itself
          float sunSide = dot(normalize(vec3(vUv - 0.5, 0.3)), normalize(vec3(uSunDir.x, uSunDir.y, uSunDir.z))) * 0.5 + 0.5;
          vec3 c = mix(vec3(0.55, 0.57, 0.62), vec3(0.95, 0.86, 0.74), sunSide * 0.7);
          c = vfAtmosphere(c, vW);
          gl_FragColor = vec4(c, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    })
    this.mesh = new InstancedMesh(geo, mat, this.n)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
    this.mesh.name = 'smoke'
    for (let i = 0; i < this.n; i++) this.seed[i] = this.rnd()
  }

  update(dt: number) {
    const r = this.rnd
    for (let s = 0; s < this.src.length; s++) {
      this.next[s] -= dt
      if (this.next[s] > 0) continue
      this.next[s] = 0.32 + r() * 0.25
      // find a dead puff
      for (let i = 0; i < this.n; i++) {
        if (this.age[i] < this.life[i]) continue
        const p = this.src[s]
        this.pos.set([p.x + (r() - 0.5) * 0.3, p.y, p.z + (r() - 0.5) * 0.3], i * 3)
        this.vel.set([(r() - 0.5) * 0.2, 0.9 + r() * 0.5, (r() - 0.5) * 0.2], i * 3)
        this.age[i] = 0
        this.life[i] = 9 + r() * 5
        this.sizeA[i] = 0.6 + r() * 0.5
        break
      }
    }
    const q = new Quaternion()
    const v = new Vector3(), sc = new Vector3()
    for (let i = 0; i < this.n; i++) {
      const o = i * 3
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0
        this.m.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.m)
        continue
      }
      this.age[i] += dt
      const t = this.age[i] / this.life[i]
      this.wind.sample(this.pos[o], this.pos[o + 2], this.air)
      // smoke follows the air, buoyancy fading as it cools
      this.vel[o] += (this.air.x * 0.9 - this.vel[o]) * Math.min(1, dt * 0.8)
      this.vel[o + 2] += (this.air.z * 0.9 - this.vel[o + 2]) * Math.min(1, dt * 0.8)
      this.vel[o + 1] += (0.25 + 0.9 * (1 - t) - this.vel[o + 1]) * Math.min(1, dt * 0.6)
      this.pos[o] += this.vel[o] * dt
      this.pos[o + 1] += this.vel[o + 1] * dt
      this.pos[o + 2] += this.vel[o + 2] * dt
      const size = this.sizeA[i] * (0.6 + t * 5.5)
      this.alpha[i] = Math.min(1, t * 6) * (1 - t) * (1 - t) * 0.42
      this.m.compose(v.fromArray(this.pos, o), q, sc.set(size, size, size))
      this.mesh.setMatrixAt(i, this.m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    ;(this.mesh.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true
  }
}

// ------------------------------------------------------------------ birds

function birdGeometry(): BufferGeometry {
  // a body and two wings; aWing marks how far a vertex is out along the wing
  const pos = [
    // body
    0, 0, 0.32, -0.06, 0, -0.25, 0.06, 0, -0.25,
    // left wing
    -0.04, 0, 0.12, -0.04, 0, -0.12, -0.62, 0, -0.08,
    // right wing
    0.04, 0, 0.12, 0.62, 0, -0.08, 0.04, 0, -0.12,
  ]
  const wing = [0, 0, 0, 0, 0, 1, 0, 1, 0]
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aWing', new BufferAttribute(new Float32Array(wing), 1))
  g.computeVertexNormals()
  return g
}

/**
 * Now and then a small flock crosses the valley: dark, unhurried, wings beating
 * and gliding. Only ever one flock in the sky.
 */
export class Birds {
  readonly mesh: InstancedMesh
  private count = 7
  private t = -1
  private wait = 14
  private from = new Vector3()
  private to = new Vector3()
  private dur = 30
  private offsets: Vector3[] = []
  private phase: number[] = []
  private m = new Matrix4()
  private rnd = mulberry32(99)

  constructor(private T: Terrain) {
    const mat = patchMaterial(new MeshLambertMaterial({ color: new Color('#1d1a19'), side: DoubleSide }), {
      key: 'birds',
      vertexPars: 'attribute float aWing; attribute float aFlap;',
      vertexWorld: /* glsl */ `
        vec4 c0 = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float grow = max(1.0, distance(c0.xyz, uViewPos) * 0.0032);
        vec3 p = transformed;
        // flap: wingtips sweep up and down, with the odd glide
        float beat = sin(uTime * 9.0 + aFlap * 6.28);
        float glide = smoothstep(0.2, 0.6, sin(uTime * 0.7 + aFlap * 3.0));
        p.y += aWing * mix(beat * 0.38, 0.08, glide);
        vfWorld = modelMatrix * instanceMatrix * vec4(p * grow, 1.0);
      `,
    })
    const geo = birdGeometry()
    const flap = new Float32Array(this.count)
    for (let i = 0; i < this.count; i++) {
      flap[i] = this.rnd()
      this.phase.push(this.rnd() * 6.28)
      // loose V
      const k = Math.ceil(i / 2) * (i % 2 ? 1 : -1)
      this.offsets.push(new Vector3(k * 2.4 + (this.rnd() - 0.5) * 1.2, (this.rnd() - 0.5) * 1.5, -Math.abs(k) * 2.2 + (this.rnd() - 0.5)))
    }
    geo.setAttribute('aFlap', new InstancedBufferAttribute(flap, 1))
    this.mesh = new InstancedMesh(geo, mat, this.count)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.name = 'birds'
  }

  /** Launch a crossing that will pass through the view of a camera at `view`. */
  private launch(view: Vector3, look: Vector3, low: boolean) {
    const r = this.rnd
    // pick a point ahead of the camera and fly across it
    const ahead = low ? 90 + r() * 60 : 600 + r() * 400
    const c = view.clone().addScaledVector(look.clone().setY(0).normalize(), ahead)
    const ground = this.T.heightAt(c.x, c.z)
    c.y = ground + (low ? 55 + r() * 35 : 130 + r() * 90)
    const ang = Math.atan2(look.z, look.x) + Math.PI / 2 + (r() - 0.5) * 0.9
    const half = low ? 260 : 900
    this.from.set(c.x - Math.cos(ang) * half, c.y, c.z - Math.sin(ang) * half)
    this.to.set(c.x + Math.cos(ang) * half, c.y + (r() - 0.5) * 20, c.z + Math.sin(ang) * half)
    this.dur = (2 * half) / (low ? 11 : 14)
    this.t = 0
    this.mesh.visible = true
  }

  update(dt: number, view: Vector3, look: Vector3, low: boolean) {
    if (this.t < 0) {
      this.wait -= dt
      if (this.wait <= 0) this.launch(view, look, low)
      return
    }
    this.t += dt
    const u = this.t / this.dur
    if (u >= 1) {
      this.t = -1
      this.wait = 35 + this.rnd() * 45
      this.mesh.visible = false
      return
    }
    const dir = this.to.clone().sub(this.from).normalize()
    const center = this.from.clone().lerp(this.to, u)
    center.y += Math.sin(u * Math.PI) * 12
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir)
    const sc = new Vector3(1, 1, 1)
    for (let i = 0; i < this.count; i++) {
      const o = this.offsets[i].clone()
      o.x += Math.sin(this.t * 0.6 + this.phase[i]) * 0.8
      o.y += Math.sin(this.t * 0.9 + this.phase[i] * 2) * 0.5
      const p = o.applyQuaternion(q).add(center)
      this.m.compose(p, q, sc)
      this.mesh.setMatrixAt(i, this.m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
