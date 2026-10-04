import { Terrain } from '../world/terrain'
import { HOUSES, BARN, CHURCH, LONE_TREES } from '../world/layout'

const t0 = performance.now()
const T = new Terrain()
const t1 = performance.now()
const params = new URLSearchParams(location.search)
const half = Number(params.get('half') ?? 1100)
const cx = Number(params.get('cx') ?? 0)
const cz = Number(params.get('cz') ?? -150)
const W = 1000
const c = document.getElementById('c') as HTMLCanvasElement
c.width = W; c.height = W
const g = c.getContext('2d')!
const img = g.createImageData(W, W)
const toWorld = (px: number) => -half + (px / W) * 2 * half
let minH = Infinity, maxH = -Infinity
const hs = new Float32Array(W * W)
for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
  const h = T.heightAt(cx + toWorld(i), cz + toWorld(j)); hs[j * W + i] = h
  minH = Math.min(minH, h); maxH = Math.max(maxH, h)
}
const pix = (2 * half) / W
for (let j = 1; j < W - 1; j++) for (let i = 1; i < W - 1; i++) {
  const h = hs[j * W + i]
  const dx = (hs[j * W + i + 1] - hs[j * W + i - 1]) / (2 * pix)
  const dz = (hs[(j + 1) * W + i] - hs[(j - 1) * W + i]) / (2 * pix)
  // light from west-south-west
  const nx = -dx, ny = 1, nz = -dz
  const l = Math.hypot(nx, ny, nz)
  const shade = Math.max(0, (nx * -0.75 + ny * 0.5 + nz * 0.35) / l)
  const x = cx + toWorld(i), z = cz + toWorld(j)
  const open = T.clearing(x, z)
  const e = (h - minH) / (maxH - minH)
  let r = 60 + 120 * e, gg = 80 + 90 * e, b = 50 + 60 * e
  if (open > 0.5) { r = 190; gg = 180; b = 110 }
  const contour = Math.abs(((h / 10) % 1 + 1) % 1 - 0.5) > 0.47 ? 0.75 : 1
  const k = (0.35 + 0.9 * shade) * contour
  const o = (j * W + i) * 4
  img.data[o] = r * k; img.data[o + 1] = gg * k; img.data[o + 2] = b * k; img.data[o + 3] = 255
}
g.putImageData(img, 0, 0)
const P = (x: number, z: number): [number, number] => [((x - cx + half) / (2 * half)) * W, ((z - cz + half) / (2 * half)) * W]
const drawPath = (xs: Float32Array, zs: Float32Array, n: number, col: string, w: number, closed: boolean) => {
  g.strokeStyle = col; g.lineWidth = w; g.beginPath()
  for (let i = 0; i < n; i++) { const [a, b] = P(xs[i], zs[i]); if (i) g.lineTo(a, b); else g.moveTo(a, b) }
  if (closed) g.closePath(); g.stroke()
}
drawPath(T.stream.xs, T.stream.zs, T.stream.n, '#4aa3ff', 3, false)
drawPath(T.road.xs, T.road.zs, T.road.n, '#222', 4, true)
// road ticks every 250 m + grade
g.font = '11px monospace'
for (let s = 0; s < T.road.length; s += 250) {
  const p = { x: 0, z: 0, tx: 0, tz: 0 }; T.road.sample(s, p)
  const [a, b] = P(p.x, p.z); g.fillStyle = '#fff'; g.fillRect(a - 2, b - 2, 4, 4)
  g.fillText(`${s}m y${T.roadYAt(s).toFixed(0)}`, a + 5, b)
}
const b = T.bridge; { const [a, bb] = P(b.x, b.z); g.fillStyle = '#c33'; g.fillRect(a - 5, bb - 5, 10, 10) }
for (const hs2 of HOUSES) { const [a, bb] = P(...hs2.pos); g.fillStyle = '#fff'; g.fillRect(a - 3, bb - 3, 6, 6) }
{ const [a, bb] = P(...BARN.pos); g.fillStyle = '#b22'; g.fillRect(a - 5, bb - 4, 10, 8) }
{ const [a, bb] = P(...CHURCH.pos); g.fillStyle = '#ff0'; g.fillRect(a - 3, bb - 3, 6, 6) }
for (const l of LONE_TREES) { const [a, bb] = P(...l.pos); g.fillStyle = '#f80'; g.beginPath(); g.arc(a, bb, 4, 0, 7); g.fill() }
// grade stats
let maxGrade = 0, maxAt = 0
for (let s = 0; s < T.road.length; s += 5) { const gr = Math.abs(T.roadYAt(s + 5) - T.roadYAt(s)) / 5; if (gr > maxGrade) { maxGrade = gr; maxAt = s } }
g.fillStyle = '#fff'; g.font = '14px monospace'
const stat = `build ${(t1 - t0).toFixed(0)}ms  len ${T.road.length.toFixed(0)}m  h ${minH.toFixed(0)}..${maxH.toFixed(0)}  maxGrade ${(maxGrade * 100).toFixed(1)}% @${maxAt}  deck ${b.deckY.toFixed(1)}`
g.fillText(stat, 10, 20); console.log(stat)
;(window as any).__ready = true
