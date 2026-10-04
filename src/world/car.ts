import {
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  Shape,
  SphereGeometry,
  BoxGeometry,
  DoubleSide,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three'
import { patchMaterial } from '../render/shared'

/**
 * A small rounded 1950s sedan — long hood, fender humps, round headlamps, chrome
 * and whitewalls. Local frame: +z forward, +y up, origin on the ground between
 * the axles.
 */
export interface CarModel {
  root: Group
  /** parts hidden when the camera sits at the windshield (roof, glass) */
  cabin: Object3D[]
  wheels: Object3D[]
  lamps: Mesh[]
  body: Group
}

function sideProfile(points: (s: Shape) => void, width: number, bevel: number): BufferGeometry {
  const s = new Shape()
  points(s)
  const g = new ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 18,
  })
  // shape x -> car +z (forward), extrusion -> car x (centred)
  g.rotateY(-Math.PI / 2)
  g.translate(width / 2, 0, 0)
  g.computeVertexNormals()
  return g
}

export function buildCar(env: Texture | null): CarModel {
  const root = new Group()
  root.name = 'car'
  const body = new Group()
  root.add(body)

  const paint = patchMaterial(
    new MeshPhysicalMaterial({
      color: new Color('#3f8d7b'),
      roughness: 0.34,
      metalness: 0.0,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
      envMap: env,
      envMapIntensity: 0.32,
    }),
    { key: 'car-paint', cloudShadows: true },
  )
  const cream = patchMaterial(
    new MeshPhysicalMaterial({ color: new Color('#e6dcc4'), roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.12, envMap: env, envMapIntensity: 0.45 }),
    { key: 'car-cream', cloudShadows: true },
  )
  const chrome = patchMaterial(
    new MeshStandardMaterial({ color: new Color('#d9dde0'), roughness: 0.16, metalness: 1, envMap: env, envMapIntensity: 1.0 }),
    { key: 'car-chrome' },
  )
  const glass = patchMaterial(
    new MeshPhysicalMaterial({ color: new Color('#1b2629'), roughness: 0.05, metalness: 0.1, envMap: env, envMapIntensity: 1.2, clearcoat: 1 }),
    { key: 'car-glass' },
  )
  const rubber = patchMaterial(new MeshStandardMaterial({ color: new Color('#161616'), roughness: 0.92 }), { key: 'car-rubber' })
  const white = patchMaterial(new MeshStandardMaterial({ color: new Color('#f1efe8'), roughness: 0.6 }), { key: 'car-white' })
  const lampMat = new MeshStandardMaterial({ color: new Color('#fff4dc'), emissive: new Color('#ffe2a8'), emissiveIntensity: 3.5, roughness: 0.2 })
  const tailMat = new MeshStandardMaterial({ color: new Color('#5a0b0b'), emissive: new Color('#d0281c'), emissiveIntensity: 1.6, roughness: 0.3 })
  const under = patchMaterial(new MeshStandardMaterial({ color: new Color('#22201e'), roughness: 1 }), { key: 'car-under' })

  const add = (g: BufferGeometry, m: Material, parent: Object3D = body) => {
    const mesh = new Mesh(g, m)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }

  // lower body: rounded tail, long hood sloping to a rounded nose
  add(
    sideProfile(
      (s) => {
        s.moveTo(-2.2, 0.36)
        s.quadraticCurveTo(-2.34, 0.74, -2.02, 0.86)
        s.lineTo(-1.2, 0.93)
        s.lineTo(0.72, 0.97)
        s.quadraticCurveTo(1.62, 0.95, 2.04, 0.8)
        s.quadraticCurveTo(2.3, 0.7, 2.27, 0.48)
        s.lineTo(2.18, 0.34)
        s.lineTo(-2.12, 0.34)
        s.closePath()
      },
      1.56,
      0.1,
    ),
    paint,
  )
  // dark underside so the car sits on the road
  const belly = add(new BoxGeometry(1.6, 0.18, 3.9), under)
  belly.position.set(0, 0.3, 0)

  // front fenders: the humps you see either side of the hood from the driver's seat
  for (const side of [-1, 1]) {
    const f = add(new CapsuleGeometry(0.23, 1.15, 6, 14), paint)
    f.rotation.x = Math.PI / 2
    f.position.set(side * 0.64, 0.79, 1.45)
    f.scale.set(1, 1, 0.9)
    const r = add(new CapsuleGeometry(0.25, 0.85, 6, 14), paint)
    r.rotation.x = Math.PI / 2
    r.position.set(side * 0.66, 0.8, -1.42)
    // headlamp in the nose of each fender
    const ring = add(new CylinderGeometry(0.15, 0.16, 0.08, 20), chrome)
    ring.rotation.x = Math.PI / 2
    ring.position.set(side * 0.64, 0.8, 2.1)
    const lamp = new Mesh(new SphereGeometry(0.125, 16, 10), lampMat)
    lamp.scale.set(1, 1, 0.45)
    lamp.position.set(side * 0.64, 0.8, 2.14)
    body.add(lamp)
    // tail lamps
    const tail = new Mesh(new SphereGeometry(0.075, 12, 8), tailMat)
    tail.position.set(side * 0.66, 0.82, -2.06)
    body.add(tail)
  }

  // cabin: glass greenhouse + cream roof (hidden in the driver's view)
  const cabin: Object3D[] = []
  const glassMesh = add(
    sideProfile(
      (s) => {
        s.moveTo(-1.28, 0.9)
        s.quadraticCurveTo(-1.02, 1.36, -0.58, 1.43)
        s.lineTo(0.12, 1.43)
        s.quadraticCurveTo(0.52, 1.39, 0.8, 0.93)
        s.closePath()
      },
      1.3,
      0.06,
    ),
    glass,
  )
  cabin.push(glassMesh)
  const roof = add(
    sideProfile(
      (s) => {
        s.moveTo(-1.16, 1.12)
        s.quadraticCurveTo(-0.98, 1.42, -0.58, 1.475)
        s.lineTo(0.1, 1.475)
        s.quadraticCurveTo(0.36, 1.45, 0.5, 1.33)
        s.lineTo(0.42, 1.3)
        s.lineTo(-1.05, 1.1)
        s.closePath()
      },
      1.34,
      0.05,
    ),
    cream,
  )
  cabin.push(roof)
  for (const side of [-1, 1]) {
    const pillar = add(new BoxGeometry(0.06, 0.46, 0.12), cream)
    pillar.position.set(side * 0.69, 1.18, -0.3)
    cabin.push(pillar)
  }

  // chrome: bumpers, grille bars, hood strip and ornament, side spear
  for (const z of [2.3, -2.27]) {
    const b = add(new CapsuleGeometry(0.075, 1.6, 6, 12), chrome)
    b.rotation.z = Math.PI / 2
    b.position.set(0, 0.42, z)
  }
  for (let i = 0; i < 4; i++) {
    const bar = add(new BoxGeometry(0.62, 0.025, 0.04), chrome)
    bar.position.set(0, 0.5 + i * 0.065, 2.26 - i * 0.012)
  }
  const strip = add(new BoxGeometry(0.03, 0.012, 1.2), chrome)
  strip.position.set(0, 0.975, 1.4)
  strip.rotation.x = 0.13
  const ornament = add(new CapsuleGeometry(0.025, 0.16, 4, 8), chrome)
  ornament.rotation.x = Math.PI / 2 - 0.25
  ornament.position.set(0, 0.9, 2.03)
  for (const side of [-1, 1]) {
    const spear = add(new BoxGeometry(0.015, 0.025, 2.6), chrome)
    spear.position.set(side * 0.885, 0.68, 0.1)
  }

  // wheels with whitewalls and chrome hubcaps
  const wheels: Object3D[] = []
  for (const [x, z] of [[-0.74, 1.32], [0.74, 1.32], [-0.74, -1.3], [0.74, -1.3]]) {
    const w = new Group()
    w.position.set(x, 0.36, z)
    const tire = new Mesh(new CylinderGeometry(0.36, 0.36, 0.22, 22), rubber)
    tire.rotation.z = Math.PI / 2
    tire.castShadow = true
    w.add(tire)
    const ww = new Mesh(new RingGeometry(0.19, 0.29, 24), white)
    ww.material.side = DoubleSide
    ww.rotation.y = (Math.sign(x) * Math.PI) / 2
    ww.position.x = Math.sign(x) * 0.112
    w.add(ww)
    const cap = new Mesh(new CylinderGeometry(0.16, 0.18, 0.05, 18), chrome)
    cap.rotation.z = Math.PI / 2
    cap.position.x = Math.sign(x) * 0.12
    w.add(cap)
    root.add(w)
    wheels.push(w)
  }

  const lamps = body.children.filter((c): c is Mesh => c instanceof Mesh && c.material === lampMat)
  return { root, cabin, wheels, lamps, body }
}
