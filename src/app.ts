import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three'
import { AerialRig, applyPose, type CameraPose } from './camera/aerial'
import { AdaptiveResolution, type Quality } from './config'
import { PovRig } from './camera/pov'
import { diveEase, divePose, riseEase, risePose } from './camera/transition'
import { smoothstep } from './core/noise'
import { pickGround } from './core/pick'
import { Input } from './input'
import { U } from './render/shared'
import { buildBridge, type BridgeBuild } from './world/bridge'
import { buildBuildings, type BuildingsBuild } from './world/buildings'
import { GroundDetail } from './world/grass'
import { buildProps } from './world/props'
import { makeLeafAtlas } from './render/leafTexture'
import { buildCar, type CarModel } from './world/car'
import { Driver } from './world/drive'
import { buildRoadMesh } from './world/roadMesh'
import { buildSky } from './world/sky'
import { Terrain } from './world/terrain'
import { buildTerrainMesh } from './world/terrainMesh'
import { Forest, U_WIND_VIS, buildFarLumps, makeMaterials, placeTrees } from './world/trees'
import { UndergrowthKit } from './world/undergrowth'
import { WindField } from './world/wind'
import { Leaves, WindshieldLeaf } from './world/leaves'
import { Birds, Smoke } from './world/ambient'
import { buildWater } from './world/water'
import { Meadow } from './world/meadow'

export interface AppOptions {
  canvas: HTMLCanvasElement
  shot: boolean
  quality: Quality
}

export type Mode = 'aerial' | 'dive' | 'pov' | 'rise'

const clonePose = (p: CameraPose): CameraPose => ({ pos: p.pos.clone(), target: p.target.clone(), fov: p.fov, roll: p.roll })

export class App {
  renderer: WebGLRenderer
  scene = new Scene()
  camera: PerspectiveCamera
  sun: DirectionalLight
  hemi: HemisphereLight
  terrain!: Terrain
  forest!: Forest
  wind: WindField
  input: Input
  driver!: Driver
  car!: CarModel
  pov!: PovRig
  aerial = new AerialRig()
  env: Texture | null = null
  bridge!: BridgeBuild
  buildings!: BuildingsBuild
  ground!: GroundDetail
  meadow!: Meadow
  leaves!: Leaves
  windshield!: WindshieldLeaf
  smoke!: Smoke
  birds!: Birds
  /** fired when a windshield leaf is peeled away (for the whoosh) */
  onWhoosh: () => void = () => {}
  private flurried = false
  private heroTimer = 12
  /** eye adaptation: the bridge interior darkens, the valley beyond dazzles */
  exposure = 1.08
  baseExposure = 1.08

  mode: Mode = 'aerial'
  modeT = 0
  /** callbacks for the UI layer */
  onMode: (m: Mode) => void = () => {}
  onCarHover: (over: boolean) => void = () => {}
  onWindDrag: () => void = () => {}
  onFrame: (dt: number) => void = () => {}

  pose: CameraPose = { pos: new Vector3(), target: new Vector3(), fov: 30, roll: 0 }
  private aerialPose: CameraPose = { pos: new Vector3(), target: new Vector3(), fov: 30, roll: 0 }
  private povPose: CameraPose = { pos: new Vector3(), target: new Vector3(), fov: 60, roll: 0 }
  private startPose: CameraPose | null = null
  /** debug: fixed camera "x,y,z,tx,ty,tz,fov" from the URL */
  camOverride: number[] | null = null
  /** debug: deterministic timestep for screenshots */
  fixedDt = 0
  reducedMotion = false

  private windLast: Vector3 | null = null
  private pickTmp = new Vector3()
  private nextAmbientGust = 6
  private last = performance.now()
  elapsed = 0
  stats = { build: {} as Record<string, number>, trees: 0 }
  private carScreen = new Vector3()
  carHover = false
  /** how big the car is drawn (a diorama cheat so it reads from the sky) */
  carScale = 1
  private adaptive: AdaptiveResolution

  constructor(readonly opts: AppOptions) {
    const r = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.shot,
    })
    r.setPixelRatio(opts.quality.pixelRatio)
    this.adaptive = new AdaptiveResolution(opts.quality.pixelRatio)
    r.setSize(window.innerWidth, window.innerHeight, false)
    r.outputColorSpace = SRGBColorSpace
    r.toneMapping = ACESFilmicToneMapping
    r.toneMappingExposure = 1.08
    r.shadowMap.enabled = true
    r.shadowMap.type = PCFShadowMap
    this.renderer = r

    this.camera = new PerspectiveCamera(30, window.innerWidth / window.innerHeight, 2, 30000)

    // golden-hour sun, low in the west-north-west
    const sunDir = new Vector3(-0.72, 0.27, -0.64).normalize()
    U.uSunDir.value.copy(sunDir)
    U.uSunColor.value.set('#ffc890')
    this.sun = new DirectionalLight(U.uSunColor.value.clone(), 6.0)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(opts.quality.shadowMap, opts.quality.shadowMap)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.6
    this.sun.shadow.radius = 2.2
    // the light sits still; only its frustum bounds move (texel-snapped, no swimming)
    this.sun.position.copy(sunDir).multiplyScalar(6000)
    this.sun.target.position.set(0, 0, 0)
    this.scene.add(this.sun, this.sun.target)
    this.sun.updateMatrixWorld()
    this.sun.target.updateMatrixWorld()
    this.hemi = new HemisphereLight(new Color('#b4cbe8'), new Color('#6b5038'), 1.85)
    this.scene.add(this.hemi)

    this.wind = new WindField()
    this.input = new Input(opts.canvas, {
      hover: (nx, ny) => this.onHover(nx, ny),
      dragStart: (nx, ny) => this.onDragStart(nx, ny),
      drag: (nx, ny, vx, vy) => this.onDrag(nx, ny, vx, vy),
      dragEnd: () => this.onDragEnd(),
      tap: (nx, ny, px, py) => this.onTap(nx, ny, px, py),
      zoom: (d) => {
        if (this.mode === 'aerial') this.aerial.addZoom(d)
      },
      leave: () => {
        this.aerial.setPointer(0, 0)
        this.pov?.setGlance(0, 0)
        this.setCarHover(false)
      },
    })

    window.addEventListener('resize', () => this.resize())
  }

  private time<T>(name: string, f: () => T): T {
    const t0 = performance.now()
    const v = f()
    this.stats.build[name] = Math.round(performance.now() - t0)
    return v
  }

  build() {
    this.terrain = this.time('terrain', () => new Terrain())
    const tm = this.time('terrainMesh', () => buildTerrainMesh(this.terrain, U.uSunDir.value))
    this.scene.add(tm.mesh)
    this.scene.add(this.time('road', () => buildRoadMesh(this.terrain)))
    const sky = buildSky()
    this.scene.add(sky)
    // the sky, pre-filtered, is what the car's paint and chrome reflect
    this.env = this.time('env', () => {
      const pm = new PMREMGenerator(this.renderer)
      const s = new Scene()
      s.add(sky.clone())
      const rt = pm.fromScene(s, 0, 0.1, 100)
      pm.dispose()
      return rt.texture
    })
    const q = this.opts.quality
    U.uLodRange.value.set(q.nearRange[0], q.nearRange[1], q.nearRange[2], q.nearRange[3])
    const trees = this.time('treePlace', () => placeTrees(this.terrain, tm.sunVisAt, U.uSunDir.value, q.treeDensity))
    this.stats.trees = trees.count
    const hueCount = [0, 0, 0, 0, 0]
    for (let i = 0; i < trees.count; i++) hueCount[trees.hue[i]]++
    ;(this.stats as Record<string, unknown>).hues = ['orange', 'gold', 'red', 'evergreen', 'yg']
      .map((h, i) => `${h}:${Math.round((hueCount[i] / trees.count) * 100)}%`)
      .join(' ')
    this.forest = this.time('forest', () => new Forest(trees, this.terrain, { near: q.nearTrees }))
    this.scene.add(this.forest.group)
    const lumps = this.time('lumps', () => buildFarLumps(this.terrain, tm.groundAt, tm.sunVisAt, U.uSunDir.value, this.forest.leafTex, q.lumpDensity))
    ;(this.stats as Record<string, unknown>).lumps = lumps.userData.count
    this.scene.add(lumps)

    this.bridge = this.time('bridge', () => buildBridge(this.terrain))
    this.scene.add(this.bridge.group)
    this.scene.add(buildWater(this.terrain, this.env))
    this.buildings = this.time('buildings', () => buildBuildings(this.terrain))
    this.scene.add(this.buildings.group)
    this.scene.add(this.time('props', () => buildProps(this.terrain, this.buildings.mailboxes)).group)
    const atlas = makeLeafAtlas()
    const underMats = makeMaterials('under', this.forest.leafTex)
    const kit = new UndergrowthKit(underMats.mat, underMats.depth)
    this.ground = this.time('ground', () => new GroundDetail(this.terrain, trees, atlas, q.grassDensity, kit, tm.sunVisAt))
    this.scene.add(this.ground.group)
    this.meadow = this.time('meadow', () => new Meadow(tm.ground, this.forest.leafTex, q.grassDensity))
    this.scene.add(this.meadow.group)
    this.leaves = new Leaves(this.terrain, this.forest, this.wind, atlas, q.leaves)
    this.scene.add(this.leaves.mesh)
    this.scene.add(this.camera)
    this.windshield = new WindshieldLeaf(this.camera, atlas)
    this.windshield.onWhoosh = () => this.onWhoosh()
    this.smoke = new Smoke(this.buildings.chimneys.map((c) => c.pos), this.wind)
    this.scene.add(this.smoke.mesh)
    this.birds = new Birds(this.terrain)
    this.scene.add(this.birds.mesh)

    this.car = buildCar(this.env)
    this.scene.add(this.car.root)
    // start in the open meadow just past the covered bridge, where the car reads from the sky
    this.driver = new Driver(this.terrain, this.terrain.bridge.s1 + 22)
    this.pov = new PovRig(this.terrain, this.driver)
    this.resize()
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // portrait screens need a wider lens to keep the composition
    const portrait = h > w
    this.aerial.setFraming(portrait)
    if (this.pov) this.pov.fov = portrait ? 72 : 56
  }

  // ------------------------------------------------------------------ modes

  enterRoad() {
    if (this.mode !== 'aerial') return
    this.startPose = clonePose(this.pose)
    this.pov.resetPrime()
    this.setMode('dive')
  }

  private riseFromPov = false

  leaveRoad() {
    if (this.mode !== 'pov' && this.mode !== 'dive') return
    // from the road the rise rides with the car; mid-dive it starts where we are
    this.riseFromPov = this.mode === 'pov'
    this.startPose = clonePose(this.pose)
    this.setMode('rise')
  }

  private setMode(m: Mode) {
    this.mode = m
    this.modeT = 0
    this.windLast = null
    this.setCarHover(false)
    this.onMode(m)
  }

  get diveDuration() {
    return this.reducedMotion ? 2.4 : 4.6
  }

  get riseDuration() {
    return this.reducedMotion ? 2.4 : 4.8
  }

  // ------------------------------------------------------------------ input

  private onHover(nx: number, ny: number) {
    if (this.mode === 'aerial') {
      this.aerial.setPointer(nx, ny)
      this.setCarHover(this.hitCar(nx, ny))
    } else if (this.mode === 'pov') {
      this.pov.setGlance(nx, ny, 0.55)
      this.stirAir(nx, ny)
    }
  }

  private lastStir = { x: 0, y: 0, t: 0 }
  /** POV: moving the pointer disturbs the air just around the car */
  private stirAir(nx: number, ny: number) {
    const now = this.elapsed
    const dt = Math.max(1 / 120, now - this.lastStir.t)
    const vx = (nx - this.lastStir.x) / dt, vy = (ny - this.lastStir.y) / dt
    this.lastStir = { x: nx, y: ny, t: now }
    const p = this.leaves.pointer
    p.on = true
    const ndc = new Vector3(nx, ny, 0.5).unproject(this.camera)
    p.origin.copy(this.camera.position)
    p.dir.copy(ndc).sub(this.camera.position).normalize()
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
    p.push.copy(right).multiplyScalar(vx * 2.2).addScaledVector(up, vy * 2.2)
    p.strength = Math.min(1, p.strength + Math.hypot(vx, vy) * 0.25)
  }

  private onDragStart(nx: number, ny: number) {
    if (this.mode === 'aerial') {
      this.windLast = null
      if (pickGround(this.terrain, this.camera, nx, ny, this.pickTmp)) this.windLast = this.pickTmp.clone()
    }
  }

  private onDrag(nx: number, ny: number, vx: number, vy: number) {
    if (this.mode === 'aerial') {
      this.windDrag(nx, ny, vx, vy)
      this.onWindDrag()
    } else if (this.mode === 'pov') {
      this.pov.setGlance(nx, ny, 1)
      this.stirAir(nx, ny)
    }
  }

  private onDragEnd() {
    this.windLast = null
    if (this.mode === 'pov') this.pov.setGlance(0, 0)
  }

  private onTap(nx: number, ny: number, _px: number, _py: number) {
    if (this.mode === 'aerial' && this.hitCar(nx, ny)) this.enterRoad()
  }

  private setCarHover(v: boolean) {
    if (v === this.carHover) return
    this.carHover = v
    this.opts.canvas.style.cursor = v ? 'pointer' : ''
    this.onCarHover(v)
  }

  /** Screen-space hit test with a generous radius — the car is tiny from the sky. */
  hitCar(nx: number, ny: number): boolean {
    const p = this.carScreenPos()
    if (!p) return false
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight
    const dx = ((nx - p.x) * w) / 2, dy = ((ny - p.y) * h) / 2
    return Math.hypot(dx, dy) < Math.max(30, this.carPixelSize() * 1.4)
  }

  /** car centre in NDC (or null if behind the camera) */
  carScreenPos(): Vector3 | null {
    this.carScreen.copy(this.driver.pos)
    this.carScreen.y += 1.2 * this.carScale
    this.carScreen.project(this.camera)
    if (this.carScreen.z > 1) return null
    return this.carScreen
  }

  carPixelSize(): number {
    const d = this.camera.position.distanceTo(this.driver.pos)
    const h = this.renderer.domElement.clientHeight
    return ((4.6 * this.carScale) / (2 * d * Math.tan((this.camera.fov * Math.PI) / 360))) * h
  }

  private windDrag(nx: number, ny: number, vx: number, vy: number) {
    const hit = this.pickTmp
    if (!pickGround(this.terrain, this.camera, nx, ny, hit)) return
    const last = this.windLast
    if (!last) {
      this.windLast = hit.clone()
      return
    }
    const dx = hit.x - last.x, dz = hit.z - last.z
    const d = Math.hypot(dx, dz)
    if (d < 9) return
    const speed = Math.hypot(vx, vy)
    const strength = Math.min(1, Math.max(0.35, 0.3 + speed / 1500))
    const camDist = this.camera.position.distanceTo(hit)
    const radius = Math.min(95, Math.max(28, camDist * 0.045))
    const n = Math.ceil(d / (radius * 0.45))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      this.wind.gust(last.x + dx * t, last.z + dz * t, dx, dz, strength, radius)
    }
    last.copy(hit)
  }

  /** Now and then a natural gust rolls through on its own. */
  private ambientGusts(dt: number) {
    this.nextAmbientGust -= dt
    if (this.nextAmbientGust > 0) return
    this.nextAmbientGust = 16 + Math.random() * 22
    const dir = this.wind.ambientDir
    const cx = -200 + Math.random() * 500, cz = -400 + Math.random() * 600
    const across = { x: -dir.y, z: dir.x }
    const strength = 0.32 + Math.random() * 0.18
    for (let k = -3; k <= 3; k++) {
      this.wind.gust(cx + across.x * k * 40 - dir.x * 200, cz + across.z * k * 40 - dir.y * 200, dir.x, dir.y, strength, 80)
    }
  }

  // ------------------------------------------------------------------ shadows

  private lightView = new Matrix4()
  private lightInv = new Matrix4()
  private shadowKey = ''

  /** Fit the (stationary) sun's orthographic frustum around a ground region, texel-snapped. */
  fitShadow(cx: number, cz: number, half: number) {
    const cam = this.sun.shadow.camera
    if (this.shadowKey === '') {
      this.lightView.lookAt(this.sun.position, this.sun.target.position, new Vector3(0, 1, 0))
      this.lightView.setPosition(this.sun.position)
      this.lightInv.copy(this.lightView).invert()
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
    const p = new Vector3()
    const g = this.terrain.heightAt(cx, cz)
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) for (const y of [g - 60, g + 140]) {
      p.set(cx + dx * half, y, cz + dz * half).applyMatrix4(this.lightInv)
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }
    // constant size per half-extent, origin snapped to whole shadow texels
    const size = Math.max(maxX - minX, maxY - minY)
    const texel = size / this.sun.shadow.mapSize.x
    const mx = Math.floor((minX + maxX - size) / 2 / texel) * texel
    const my = Math.floor((minY + maxY - size) / 2 / texel) * texel
    cam.left = mx
    cam.right = mx + size
    cam.bottom = my
    cam.top = my + size
    cam.near = Math.max(1, -maxZ - 600)
    cam.far = -minZ + 600
    cam.updateProjectionMatrix()
  }

  /** Wide shadows for the diorama, tight crisp ones around a low camera. */
  updateShadowFit() {
    const c = this.camera.position
    const above = c.y - this.terrain.heightAt(c.x, c.z)
    if (above > 520) {
      if (this.shadowKey !== 'aerial') this.fitShadow(30, -110, 1000)
      this.shadowKey = 'aerial'
      return
    }
    const fwd = new Vector3()
    this.camera.getWorldDirection(fwd)
    fwd.y = 0
    fwd.normalize()
    // grows smoothly with height during the dive / rise; fixed while driving
    const half = Math.round(Math.min(1000, 150 + Math.max(0, above - 20) * 1.7) / 25) * 25
    const lead = half * 0.6
    const cx = Math.round((c.x + fwd.x * lead) / 3) * 3
    const cz = Math.round((c.z + fwd.z * lead) / 3) * 3
    const key = `${cx},${cz},${half}`
    if (this.shadowKey !== key) this.fitShadow(cx, cz, half)
    this.shadowKey = key
  }

  /** what the ambience needs to know this frame */
  audioState() {
    const c = this.camera.position
    const above = c.y - this.terrain.heightAt(c.x, c.z)
    return {
      pov: 1 - smoothstep(4, 120, above),
      gust: Math.min(1, this.wind.activity / 18),
      speed: this.driver.v,
      bridge: this.bridge.depthInside(c),
    }
  }

  // ------------------------------------------------------------------ living things

  private updateLife(dt: number, above: number) {
    const D = this.driver
    const lv = this.leaves
    const inCar = this.mode === 'pov' || (this.mode === 'dive' && this.modeT > this.diveDuration * 0.7) || (this.mode === 'rise' && this.modeT < this.riseDuration * 0.2)
    lv.car.on = above < 60
    lv.car.pos.copy(D.pos)
    lv.car.fwd.copy(D.fwd)
    lv.car.vel.copy(D.fwd).multiplyScalar(D.v)
    lv.pointer.strength *= Math.exp(-dt * 3)
    if (lv.pointer.strength < 0.01) lv.pointer.on = false
    // the windshield: a sphere just in front of the eye
    const ws = this.windshield
    const eye = this.pov.eyeWorld(new Vector3())
    lv.windshield = {
      center: eye.clone().addScaledVector(D.fwd, 1.1),
      radius: 0.85,
      ready: this.mode === 'pov' && !ws.busy && ws.cooldown <= 0 && D.v > 4 && !this.reducedMotion,
      land: (tile, color, sx, sy) => ws.land(tile, color, sx, sy),
    }
    // once in a while send a leaf on a path that meets the glass
    if (lv.windshield.ready) {
      this.heroTimer -= dt
      if (this.heroTimer <= 0) {
        this.heroTimer = 4 + Math.random() * 4
        const ahead = D.v * 1.6
        const p = eye.clone().addScaledVector(D.fwd, ahead)
        this.leavesHero(p)
      }
    }
    // diving through the canopy shakes a few leaves loose around the camera
    if (this.mode === 'dive') {
      const u = this.modeT / this.diveDuration
      if (!this.flurried && u > 0.6 && !this.reducedMotion) {
        this.flurried = true
        lv.flurry(this.camera.position.clone().addScaledVector(new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2), -8), 26)
      }
    } else this.flurried = false
    lv.update(dt, this.camera.position, this.mode === 'aerial' ? 'aerial' : inCar ? 'pov' : 'moving')
    ws.update(dt)
    this.smoke.update(dt)
    const look = new Vector3()
    this.camera.getWorldDirection(look)
    this.birds.update(dt, this.camera.position, look, above < 100)
  }

  private leavesHero(p: Vector3) {
    const d = this.forest.d
    let pick = -1
    this.forest.forEachNear(p.x, p.z, 30, (i) => {
      if (d.hue[i] !== 3 && (pick < 0 || Math.random() < 0.3)) pick = i
    })
    const c = pick >= 0 ? { r: d.tint[pick * 3], g: d.tint[pick * 3 + 1], b: d.tint[pick * 3 + 2] } : { r: 0.7, g: 0.25, b: 0.05 }
    const col = new Color(c.r, c.g, c.b).multiplyScalar(1.25)
    this.leaves.spawn(p.x, p.y + 1.9, p.z, 0, -0.4, 0, col, 0.12)
  }

  // ------------------------------------------------------------------ frame

  frame() {
    const now = performance.now()
    const dt = this.fixedDt || Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    this.elapsed += dt
    U.uTime.value = this.elapsed
    this.modeT += dt
    // a few high clouds drift over with the breeze; their shadows slide across the hills
    U.uCloudOffset.value.x -= this.wind.ambientDir.x * 7 * dt
    U.uCloudOffset.value.y -= this.wind.ambientDir.y * 7 * dt

    // the car never stops driving; from the sky it potters a little slower
    const sky = this.mode === 'aerial' ? 1 : this.mode === 'pov' ? 0 : this.mode === 'dive' ? 1 - Math.min(1, this.modeT / this.diveDuration) : Math.min(1, this.modeT / this.riseDuration)
    this.driver.update(dt, 1 - 0.28 * sky)
    this.pov.reducedMotion = this.reducedMotion
    this.aerial.reducedMotion = this.reducedMotion
    this.pov.update(dt)
    this.aerial.update(dt)
    this.aerial.pose(this.aerialPose)
    this.pov.pose(this.povPose)

    switch (this.mode) {
      case 'aerial':
        Object.assign(this.pose, clonePose(this.aerialPose))
        break
      case 'pov':
        Object.assign(this.pose, clonePose(this.povPose))
        break
      case 'dive': {
        const u = Math.min(1, this.modeT / this.diveDuration)
        divePose(diveEase(u), this.startPose!, this.driver.pos, this.driver.fwd, this.povPose, this.pose)
        if (u >= 1) this.setMode('pov')
        break
      }
      case 'rise': {
        const u = Math.min(1, this.modeT / this.riseDuration)
        const from = this.riseFromPov ? this.povPose : this.startPose!
        risePose(riseEase(u), from, this.driver.pos, this.driver.fwd, this.aerialPose, this.pose)
        if (u >= 1) this.setMode('aerial')
        break
      }
    }
    if (this.camOverride) {
      const c = this.camOverride
      this.pose.pos.set(c[0], c[1], c[2])
      this.pose.target.set(c[3], c[4], c[5])
      this.pose.fov = c[6] ?? this.pose.fov
      this.pose.roll = 0
    }

    // near plane follows altitude: millimetres at the windshield, metres in the sky
    const cp = this.pose.pos
    const above = cp.y - this.terrain.heightAt(cp.x, cp.z)
    const near = 0.08 + 2.4 * smoothstep(25, 400, above)
    if (Math.abs(this.camera.near - near) > 0.01) {
      this.camera.near = near
      this.camera.updateProjectionMatrix()
    }
    applyPose(this.camera, this.pose)
    U.uViewPos.value.copy(this.camera.position)
    this.camera.getWorldDirection(U.uViewDir.value)

    // car: drawn larger from the sky so it reads as a tiny toy on the road
    const dCar = this.camera.position.distanceTo(this.driver.pos)
    this.carScale = 1 + 1.1 * smoothstep(40, 900, dCar)
    const car = this.car
    car.root.position.copy(this.driver.pos)
    car.root.quaternion.copy(this.driver.quat)
    car.root.scale.setScalar(this.carScale)
    car.body.rotation.set(this.driver.pitch, 0, this.driver.roll)
    car.body.position.y = 0.012 * Math.sin(this.elapsed * 9.0) * Math.min(1, this.driver.v / 8)
    for (const w of car.wheels) w.rotation.x += (this.driver.v * dt) / 0.36
    const atWheel = this.camera.position.distanceTo(this.pov.eyeWorld(new Vector3())) < 2.5
    for (const c of car.cabin) c.visible = !atWheel

    // sway is exaggerated from high up so a gust is still legible a kilometre away
    U_WIND_VIS.value = 1 + 3.6 * smoothstep(120, 900, above)
    U.uPov.value = 1 - smoothstep(30, 300, above)
    this.ambientGusts(dt)
    this.wind.update(dt)
    this.forest.update(this.camera.position)
    this.ground.update(this.camera.position, above)
    this.meadow.update(above)
    this.updateLife(dt, above)
    this.updateShadowFit()
    const inside = this.bridge.depthInside(this.camera.position)
    const goal = this.baseExposure * (1 + 0.95 * inside)
    // adapting up to the dark is slower than clamping down after the bright exit
    const rate = goal > this.exposure ? 0.85 : 1.25
    this.exposure += (goal - this.exposure) * (1 - Math.exp(-dt * rate))
    this.renderer.toneMappingExposure = this.exposure
    if (!this.opts.shot && !this.fixedDt) {
      const pr = this.adaptive.sample(dt)
      if (pr) this.renderer.setPixelRatio(pr)
    }
    this.renderer.render(this.scene, this.camera)
    this.onFrame(dt)
  }

  start(onFrame?: (n: number) => boolean) {
    let n = 0
    const loop = () => {
      this.frame()
      n++
      // in screenshot mode the caller stops the loop once the frame is settled
      if (onFrame && !onFrame(n)) return
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
}
