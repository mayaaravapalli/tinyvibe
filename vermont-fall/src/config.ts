/**
 * Quality tiers. Every tier keeps the composition, the colour art direction and
 * all landmarks — only density, resolution and particle budgets change.
 */
export interface Quality {
  name: 'low' | 'medium' | 'high'
  pixelRatio: number
  shadowMap: number
  treeDensity: number
  lumpDensity: number
  grassDensity: number
  leaves: number
  nearTrees: boolean
  nearRange: [number, number]
  antialias: boolean
}

const TIERS: Record<Quality['name'], Omit<Quality, 'pixelRatio'> & { maxDpr: number }> = {
  high: { name: 'high', maxDpr: 2, shadowMap: 4096, treeDensity: 1, lumpDensity: 1, grassDensity: 1, leaves: 720, nearTrees: true, nearRange: [95, 135], antialias: true },
  medium: { name: 'medium', maxDpr: 1.5, shadowMap: 2048, treeDensity: 0.78, lumpDensity: 0.6, grassDensity: 0.6, leaves: 480, nearTrees: true, nearRange: [80, 115], antialias: true },
  low: { name: 'low', maxDpr: 1.25, shadowMap: 2048, treeDensity: 0.55, lumpDensity: 0.38, grassDensity: 0.35, leaves: 280, nearTrees: true, nearRange: [60, 90], antialias: true },
}

function gpuName(): string {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  } catch {
    return ''
  }
}

export function detectQuality(override?: string | null): Quality {
  let name: Quality['name'] = 'high'
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const small = Math.min(window.screen.width, window.screen.height) < 820
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const cores = navigator.hardwareConcurrency ?? 8
  const gpu = gpuName()
  if (mobileUA || (coarse && small)) name = 'low'
  else if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(gpu) || mem <= 4 || cores <= 4) name = 'medium'
  if (override === 'low' || override === 'medium' || override === 'high') name = override
  const t = TIERS[name]
  return { ...t, pixelRatio: Math.min(window.devicePixelRatio || 1, t.maxDpr) }
}

/**
 * Keeps the frame rate comfortable by trading render resolution, never the
 * composition. Watches a rolling average and steps the pixel ratio.
 */
export class AdaptiveResolution {
  private acc = 0
  private frames = 0
  private cooldown = 3
  current: number

  constructor(private max: number, private floor = 0.6) {
    this.current = max
  }

  /** returns a new pixel ratio when it should change */
  sample(dt: number): number | null {
    this.cooldown -= dt
    this.acc += dt
    this.frames++
    if (this.acc < 1.5) return null
    const avg = this.acc / this.frames
    this.acc = 0
    this.frames = 0
    if (this.cooldown > 0) return null
    let next = this.current
    if (avg > 1 / 40) next = Math.max(this.max * this.floor, this.current - 0.15)
    else if (avg < 1 / 58 && this.current < this.max) next = Math.min(this.max, this.current + 0.1)
    if (Math.abs(next - this.current) < 0.01) return null
    this.current = next
    this.cooldown = 2
    return next
  }
}
