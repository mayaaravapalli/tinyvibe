import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace, type Texture } from 'three'
import { mulberry32 } from '../core/noise'

export type LeafShape = 'maple' | 'oak' | 'birch' | 'aspen'

/** Trace a leaf outline centred at the origin pointing up (-y), unit length. */
export function leafPath(g: CanvasRenderingContext2D | Path2D, shape: LeafShape) {
  const pts: [number, number][] = []
  const n = 72
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2
    let r: number
    switch (shape) {
      case 'maple': {
        // five pointed lobes with notches between them; flattened base
        const lobes = Math.pow(Math.abs(Math.cos(2.5 * t)), 0.6)
        const teeth = 0.06 * Math.pow(Math.abs(Math.cos(11 * t)), 3)
        r = 0.48 + 0.42 * lobes + teeth
        if (Math.sin(t) > 0.55) r *= 0.72 // the stem notch at the bottom
        break
      }
      case 'oak': {
        const lobes = 0.5 + 0.5 * Math.cos(7 * t)
        r = (0.55 + 0.25 * lobes) * (0.75 + 0.35 * Math.abs(Math.sin(t)))
        break
      }
      case 'aspen':
        r = 0.62 + 0.04 * Math.cos(16 * t)
        break
      default: // birch: ovate with a point and fine teeth
        r = 0.55 * (1 + 0.45 * Math.max(0, -Math.sin(t))) + 0.03 * Math.cos(24 * t)
    }
    pts.push([Math.cos(t) * r * (shape === 'birch' ? 0.75 : 1), Math.sin(t) * r])
  }
  g.moveTo(pts[0][0], pts[0][1])
  for (const [x, y] of pts) g.lineTo(x, y)
  g.closePath()
}

/**
 * Foliage atlas (grayscale, tinted in the shader):
 *   left half  — a loose cluster of broad leaves for deciduous cards
 *   right half — a drooping needle spray for spruce / pine boughs (u runs stem -> tip)
 */
export function makeLeafClusterTexture(size = 256): Texture {
  const c = document.createElement('canvas')
  c.width = size * 2
  c.height = size
  const g = c.getContext('2d')!
  const rnd = mulberry32(31337)
  g.clearRect(0, 0, size * 2, size)
  const shapes: LeafShape[] = ['maple', 'maple', 'birch', 'oak']
  const count = 30
  for (let i = 0; i < count; i++) {
    // points in a soft disc, denser in the middle
    const a = rnd() * Math.PI * 2
    const rr = Math.pow(rnd(), 0.7) * size * 0.36
    const x = size / 2 + Math.cos(a) * rr
    const y = size / 2 + Math.sin(a) * rr
    const s = size * (0.075 + rnd() * 0.06)
    const shape = shapes[Math.floor(rnd() * shapes.length)]
    const lum = Math.floor(150 + rnd() * 105)
    g.save()
    g.translate(x, y)
    g.rotate(a + Math.PI / 2 + (rnd() - 0.5) * 1.4)
    g.scale(s, s)
    g.beginPath()
    leafPath(g, shape)
    g.fillStyle = `rgb(${lum},${lum},${lum})`
    g.fill()
    // midrib + a couple of veins, a touch darker
    g.strokeStyle = `rgba(0,0,0,0.18)`
    g.lineWidth = 0.05
    g.beginPath()
    g.moveTo(0, 0.6)
    g.lineTo(0, -0.75)
    g.moveTo(0, 0.1)
    g.lineTo(0.45, -0.35)
    g.moveTo(0, 0.1)
    g.lineTo(-0.45, -0.35)
    g.stroke()
    g.restore()
  }
  // needle spray: a main stem with side shoots, each bristling with short needles
  g.save()
  g.translate(size, 0)
  g.lineCap = 'round'
  const stemY = size * 0.5
  const needle = (x: number, y: number, ang: number, len: number) => {
    const l = Math.floor(120 + rnd() * 110)
    g.strokeStyle = `rgb(${l},${l},${l})`
    g.lineWidth = 2.2
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
    g.stroke()
  }
  const shoot = (x0: number, y0: number, x1: number, y1: number, nl: number) => {
    const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / 3.2)
    const a = Math.atan2(y1 - y0, x1 - x0)
    for (let i = 0; i < n; i++) {
      const t = i / n
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t
      const taper = 1 - 0.55 * t
      needle(x, y, a - 1.0 - rnd() * 0.4, nl * taper * (0.7 + rnd() * 0.5))
      needle(x, y, a + 1.0 + rnd() * 0.4, nl * taper * (0.7 + rnd() * 0.5))
    }
  }
  const pad = 8
  shoot(pad, stemY, size - pad, stemY + size * 0.04, 15)
  for (let i = 0; i < 9; i++) {
    const t = 0.08 + i * 0.1
    const x = pad + (size - 2 * pad) * t
    const side = i % 2 ? 1 : -1
    const len = size * (0.3 - 0.18 * t) * (0.8 + rnd() * 0.4)
    shoot(x, stemY, x + len * 0.75, stemY + side * len * 0.6, 11)
  }
  g.restore()
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  return tex
}

/** 2x2 atlas of single leaves for falling / fallen leaves. */
export function makeLeafAtlas(size = 256): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const shapes: LeafShape[] = ['maple', 'oak', 'birch', 'aspen']
  const h = size / 2
  shapes.forEach((shape, i) => {
    const cx = (i % 2) * h + h / 2
    const cy = Math.floor(i / 2) * h + h / 2
    g.save()
    g.translate(cx, cy)
    g.scale(h * 0.44, h * 0.44)
    g.beginPath()
    leafPath(g, shape)
    const grad = g.createRadialGradient(0, 0.1, 0.05, 0, 0, 1)
    grad.addColorStop(0, 'rgb(255,255,255)')
    grad.addColorStop(1, 'rgb(205,205,205)')
    g.fillStyle = grad
    g.fill()
    g.strokeStyle = 'rgba(60,40,30,0.35)'
    g.lineWidth = 0.03
    g.stroke()
    g.strokeStyle = 'rgba(70,40,20,0.35)'
    g.lineWidth = 0.035
    g.beginPath()
    g.moveTo(0, 0.95)
    g.lineTo(0, -0.8)
    for (const k of [-1, 1]) {
      g.moveTo(0, 0.15)
      g.lineTo(0.5 * k, -0.4)
      g.moveTo(0, 0.35)
      g.lineTo(0.62 * k, 0.12)
    }
    g.stroke()
    g.restore()
  })
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = LinearMipmapLinearFilter
  return tex
}

// ------------------------------------------------------------------ foliage atlas (4 x 2 tiles)
//
// Channels are data, not colour:  R = shading (veins, edges, light falloff)
//                                 G = per-leaf random (hue drift in the shader)
//                                 B = mask: woody stem (trees/shrubs) or flower centre (asters)
//                                 A = coverage

export const ATLAS_COLS = 4
export const ATLAS_ROWS = 2
export const TILE = {
  maple: 0,
  oak: 1,
  birch: 2,
  needles: 3,
  fern: 4,
  sumac: 5,
  goldenrod: 6,
  aster: 7,
} as const

/** uv rectangle of a tile, inset a little so tiles never bleed or confuse tile lookups */
export function tileUv(tile: number, u: number, v: number): [number, number] {
  const col = tile % ATLAS_COLS
  const row = Math.floor(tile / ATLAS_COLS)
  const iu = 0.015 + u * 0.97
  const iv = 0.015 + v * 0.97
  return [(col + iu) / ATLAS_COLS, (row + iv) / ATLAS_ROWS]
}

export function makeFoliageAtlas(tile = 512): Texture {
  const c = document.createElement('canvas')
  c.width = tile * ATLAS_COLS
  c.height = tile * ATLAS_ROWS
  const g = c.getContext('2d')!
  g.clearRect(0, 0, c.width, c.height)
  const rnd = mulberry32(90210)
  // canvas y grows downwards, uv v upwards: row 0 of the atlas is the bottom of the canvas
  const at = (t: number, draw: () => void) => {
    const col = t % ATLAS_COLS
    const row = Math.floor(t / ATLAS_COLS)
    g.save()
    g.translate(col * tile, (ATLAS_ROWS - 1 - row) * tile)
    g.beginPath()
    g.rect(0, 0, tile, tile)
    g.clip()
    draw()
    g.restore()
  }
  const col = (r: number, gg: number, b: number) => `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`

  /** one broad leaf: shape, light falloff, midrib and side veins */
  const leaf = (x: number, y: number, size: number, ang: number, shape: LeafShape, petiole: number) => {
    const gv = rnd() * 255
    g.save()
    g.translate(x, y)
    g.rotate(ang)
    // petiole (woody mask)
    if (petiole > 0) {
      g.strokeStyle = col(90, 0, 255)
      g.lineWidth = Math.max(1.5, size * 0.05)
      g.beginPath()
      g.moveTo(0, size * 0.5)
      g.lineTo(0, size * (0.5 + petiole))
      g.stroke()
    }
    g.scale(size, size)
    g.beginPath()
    leafPath(g, shape)
    const grad = g.createRadialGradient(0, 0.25, 0.05, 0, 0, 0.95)
    const top = 225 + rnd() * 30
    grad.addColorStop(0, col(top, gv, 0))
    grad.addColorStop(1, col(top * 0.72, gv, 0))
    g.fillStyle = grad
    g.fill()
    g.lineWidth = 0.035
    g.strokeStyle = col(top * 0.55, gv, 0)
    g.stroke()
    // veins
    g.strokeStyle = col(top * 0.68, gv, 0)
    g.lineWidth = 0.03
    g.beginPath()
    g.moveTo(0, 0.5)
    g.lineTo(0, -0.78)
    const n = shape === 'maple' ? 2 : 4
    for (let k = 0; k < n; k++) {
      const yy = 0.35 - k * 0.3
      for (const s of [-1, 1]) {
        g.moveTo(0, yy)
        g.lineTo(s * (shape === 'maple' ? 0.62 : 0.4), yy - (shape === 'maple' ? 0.45 : 0.28))
      }
    }
    g.stroke()
    g.restore()
  }

  /** a spray of leaves on twigs, arranged like a real cluster */
  const cluster = (shape: LeafShape, count: number, sizeMin: number, sizeMax: number, twigs: number) => {
    const cx = tile / 2, cy = tile / 2
    // twigs first, under the leaves
    g.strokeStyle = col(70, 0, 255)
    g.lineCap = 'round'
    const tips: [number, number][] = []
    for (let t = 0; t < twigs; t++) {
      const a = (t / twigs) * Math.PI * 2 + rnd() * 0.6
      const len = tile * (0.22 + rnd() * 0.16)
      g.lineWidth = tile * 0.012
      g.beginPath()
      g.moveTo(cx, cy + tile * 0.08)
      const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len * 0.85
      g.quadraticCurveTo(cx + Math.cos(a) * len * 0.4, cy + Math.sin(a) * len * 0.2, ex, ey)
      g.stroke()
      tips.push([ex, ey])
    }
    for (let i = 0; i < count; i++) {
      let x: number, y: number, a: number
      if (tips.length && rnd() < 0.6) {
        const [tx, ty] = tips[Math.floor(rnd() * tips.length)]
        x = tx + (rnd() - 0.5) * tile * 0.12
        y = ty + (rnd() - 0.5) * tile * 0.12
        a = Math.atan2(y - cy, x - cx) + Math.PI / 2 + (rnd() - 0.5) * 1.2
      } else {
        const ang = rnd() * Math.PI * 2
        const r = Math.pow(rnd(), 0.75) * tile * 0.34
        x = cx + Math.cos(ang) * r
        y = cy + Math.sin(ang) * r
        a = ang + Math.PI / 2 + (rnd() - 0.5) * 1.4
      }
      const s = tile * (sizeMin + rnd() * (sizeMax - sizeMin))
      leaf(x, y, s, a, shape, 0.35)
    }
  }

  at(TILE.maple, () => cluster('maple', 15, 0.1, 0.15, 5))
  at(TILE.oak, () => cluster('oak', 14, 0.1, 0.15, 4))
  at(TILE.birch, () => cluster('birch', 30, 0.055, 0.085, 6))

  // needle spray: a woody stem, side shoots, short needles
  at(TILE.needles, () => {
    g.lineCap = 'round'
    const shoot = (x0: number, y0: number, x1: number, y1: number, nl: number) => {
      const gv = rnd() * 255
      g.strokeStyle = col(80, gv, 255)
      g.lineWidth = tile * 0.006
      g.beginPath()
      g.moveTo(x0, y0)
      g.lineTo(x1, y1)
      g.stroke()
      const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / (tile * 0.0065))
      const a = Math.atan2(y1 - y0, x1 - x0)
      for (let i = 0; i < n; i++) {
        const t = i / n
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t
        const taper = 1 - 0.5 * t
        for (const s of [-1, 1]) {
          const l = 135 + rnd() * 110
          g.strokeStyle = col(l, gv, 0)
          g.lineWidth = tile * 0.0045
          const aa = a + s * (0.95 + rnd() * 0.45)
          const len = nl * taper * (0.75 + rnd() * 0.5)
          g.beginPath()
          g.moveTo(x, y)
          g.lineTo(x + Math.cos(aa) * len, y + Math.sin(aa) * len)
          g.stroke()
        }
      }
    }
    const pad = tile * 0.02
    const sy = tile * 0.5
    shoot(pad, sy, tile - pad, sy + tile * 0.04, tile * 0.03)
    for (let i = 0; i < 10; i++) {
      const t = 0.06 + i * 0.09
      const x = pad + (tile - 2 * pad) * t
      const side = i % 2 ? 1 : -1
      const len = tile * (0.3 - 0.18 * t) * (0.8 + rnd() * 0.4)
      shoot(x, sy, x + len * 0.75, sy + side * len * 0.62, tile * 0.022)
    }
  })

  // hay-scented fern: an arching frond, base at the bottom of the tile (v = 0)
  at(TILE.fern, () => {
    const baseX = tile / 2
    const h = tile * 0.96
    g.strokeStyle = col(150, 128, 0)
    g.lineWidth = tile * 0.008
    g.beginPath()
    g.moveTo(baseX, tile)
    g.lineTo(baseX, tile - h)
    g.stroke()
    const pairs = 22
    for (let i = 1; i < pairs; i++) {
      const t = i / pairs
      const y = tile - h * t
      const w = tile * 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.4)
      for (const s of [-1, 1]) {
        const gv = rnd() * 255
        // a pinna: a narrow blade with lobed edges (pinnules)
        g.save()
        g.translate(baseX, y + s * tile * 0.006)
        g.rotate(s * (Math.PI / 2 - 0.35 - t * 0.3))
        const L = w
        const lobes = Math.max(3, Math.floor(L / (tile * 0.022)))
        g.beginPath()
        g.moveTo(0, 0)
        for (let k = 0; k <= lobes; k++) {
          const u = k / lobes
          const ww = tile * 0.028 * (1 - u * 0.8) * (k % 2 ? 1 : 0.55)
          g.lineTo(u * L, -ww)
        }
        for (let k = lobes; k >= 0; k--) {
          const u = k / lobes
          const ww = tile * 0.028 * (1 - u * 0.8) * (k % 2 ? 1 : 0.55)
          g.lineTo(u * L, ww)
        }
        g.closePath()
        g.fillStyle = col(190 + rnd() * 60, gv, 0)
        g.fill()
        g.restore()
      }
    }
  })

  // staghorn sumac: three pinnate compound leaves fanning out
  at(TILE.sumac, () => {
    const cx = tile / 2, cy = tile * 0.9
    for (let f = 0; f < 3; f++) {
      const a = -Math.PI / 2 + (f - 1) * 0.55
      const len = tile * (0.78 - Math.abs(f - 1) * 0.12)
      const ex = cx + Math.cos(a) * len, ey = cy + Math.sin(a) * len
      g.strokeStyle = col(110, 40, 255)
      g.lineWidth = tile * 0.009
      g.beginPath()
      g.moveTo(cx, cy)
      g.lineTo(ex, ey)
      g.stroke()
      const n = 8
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 0.6)
        const px = cx + (ex - cx) * t, py = cy + (ey - cy) * t
        for (const s of [-1, 1]) {
          const la = a + s * 1.05
          leaf(px + Math.cos(la) * tile * 0.05, py + Math.sin(la) * tile * 0.05, tile * 0.1, la + Math.PI / 2, 'birch', 0)
        }
      }
      leaf(ex, ey, tile * 0.1, a + Math.PI / 2, 'birch', 0)
    }
  })

  // goldenrod gone to seed: a stalk whose top splits into arching sprays of fluff
  at(TILE.goldenrod, () => {
    g.lineCap = 'round'
    const baseX = tile * 0.5
    const topY = tile * 0.42
    g.strokeStyle = col(120, 60, 255)
    g.lineWidth = tile * 0.011
    g.beginPath()
    g.moveTo(baseX, tile)
    g.quadraticCurveTo(baseX - tile * 0.02, tile * 0.7, baseX + tile * 0.02, topY)
    g.stroke()
    const sprays = 7
    for (let k = 0; k < sprays; k++) {
      const t = k / (sprays - 1)
      const sx = baseX + tile * 0.02, sy = topY + (1 - t) * tile * 0.12
      const side = k % 2 ? 1 : -1
      const len = tile * (0.16 + 0.2 * Math.sin(Math.PI * (0.25 + 0.6 * t)))
      const ex = sx + side * len * 0.75, ey = sy - len * 0.55
      g.strokeStyle = col(120, 60, 255)
      g.lineWidth = tile * 0.005
      g.beginPath()
      g.moveTo(sx, sy)
      g.quadraticCurveTo(sx + side * len * 0.2, ey - len * 0.25, ex, ey + len * 0.1)
      g.stroke()
      // fluff along the upper side of each arching spray
      for (let i = 0; i < 70; i++) {
        const u = Math.pow(rnd(), 0.8)
        const x = sx + (ex - sx) * u + (rnd() - 0.5) * tile * 0.025
        const y = sy + (ey - sy) * u - Math.sin(u * Math.PI) * len * 0.22 - rnd() * tile * 0.03
        g.fillStyle = col(150 + rnd() * 105, rnd() * 255, 0)
        g.beginPath()
        g.arc(x, y, tile * (0.004 + rnd() * 0.007), 0, Math.PI * 2)
        g.fill()
      }
    }
  })

  // New England asters: small daisies on branching stems (B marks the yellow centres)
  at(TILE.aster, () => {
    const baseX = tile * 0.5
    g.strokeStyle = col(110, 30, 255)
    g.lineWidth = tile * 0.008
    const heads: [number, number][] = []
    for (let s = 0; s < 7; s++) {
      const a = -Math.PI / 2 + (rnd() - 0.5) * 1.3
      const len = tile * (0.45 + rnd() * 0.4)
      const ex = baseX + Math.cos(a) * len, ey = tile + Math.sin(a) * len
      g.beginPath()
      g.moveTo(baseX, tile)
      g.quadraticCurveTo(baseX + Math.cos(a) * len * 0.3, tile - len * 0.6, ex, ey)
      g.stroke()
      heads.push([ex, ey])
    }
    for (const [hx, hy] of heads) {
      for (let k = 0; k < 3; k++) {
        const x = hx + (rnd() - 0.5) * tile * 0.12, y = hy + (rnd() - 0.5) * tile * 0.1
        const r = tile * (0.03 + rnd() * 0.015)
        const gv = rnd() * 255
        for (let p = 0; p < 16; p++) {
          const pa = (p / 16) * Math.PI * 2
          g.strokeStyle = col(200 + rnd() * 55, gv, 0)
          g.lineWidth = tile * 0.007
          g.beginPath()
          g.moveTo(x, y)
          g.lineTo(x + Math.cos(pa) * r, y + Math.sin(pa) * r)
          g.stroke()
        }
        g.fillStyle = col(230, gv, 255)
        g.beginPath()
        g.arc(x, y, r * 0.32, 0, Math.PI * 2)
        g.fill()
      }
    }
  })

  const tex = new CanvasTexture(c)
  tex.colorSpace = NoColorSpace
  tex.premultiplyAlpha = false
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  return tex
}
