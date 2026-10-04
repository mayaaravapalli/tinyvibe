import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace, type Texture } from 'three'
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
