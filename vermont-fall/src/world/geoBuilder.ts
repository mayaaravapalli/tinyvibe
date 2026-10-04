import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'

/**
 * Accumulates tree / plant geometry with the shared foliage vertex layout:
 *   position, normal, uv,
 *   aFol  (x = height fraction, y = random, z = occlusion, w = 0 bark / 1 solid foliage / 2 leaf card)
 *   aBark (bark colour)
 */
export class Builder {
  pos: number[] = []
  nor: number[] = []
  fol: number[] = []
  bark: number[] = []
  uv: number[] = []
  idx: number[] = []

  get vertexCount() {
    return this.pos.length / 3
  }

  add(geo: BufferGeometry, fol: (i: number, p: Vector3, n: Vector3) => [number, number, number, number], barkCol: Color) {
    const base = this.pos.length / 3
    const p = geo.getAttribute('position')
    const n = geo.getAttribute('normal')
    const P = new Vector3()
    const Nn = new Vector3()
    for (let i = 0; i < p.count; i++) {
      P.fromBufferAttribute(p, i)
      Nn.fromBufferAttribute(n, i)
      this.pos.push(P.x, P.y, P.z)
      this.nor.push(Nn.x, Nn.y, Nn.z)
      this.fol.push(...fol(i, P, Nn))
      this.bark.push(barkCol.r, barkCol.g, barkCol.b)
      this.uv.push(0, 0)
    }
    const index = geo.getIndex()
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i))
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i)
  }

  vertex(p: Vector3, n: Vector3, fol: [number, number, number, number], bark: Color, u = 0, v = 0): number {
    this.pos.push(p.x, p.y, p.z)
    this.nor.push(n.x, n.y, n.z)
    this.fol.push(fol[0], fol[1], fol[2], fol[3])
    this.bark.push(bark.r, bark.g, bark.b)
    this.uv.push(u, v)
    return this.pos.length / 3 - 1
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c)
  }

  build(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3))
    g.setAttribute('aFol', new BufferAttribute(new Float32Array(this.fol), 4))
    g.setAttribute('aBark', new BufferAttribute(new Float32Array(this.bark), 3))
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}
