/**
 * Pointer / touch / wheel input, normalised into a few intentions:
 * hover (parallax, cursor), drag (wind), tap (select), zoom.
 */
export interface InputHandlers {
  hover(nx: number, ny: number, px: number, py: number): void
  dragStart(nx: number, ny: number): void
  drag(nx: number, ny: number, vx: number, vy: number): void
  dragEnd(): void
  tap(nx: number, ny: number, px: number, py: number): void
  zoom(delta: number): void
  leave(): void
}

export class Input {
  private pointers = new Map<number, { x: number; y: number }>()
  private down: { id: number; x: number; y: number; t: number } | null = null
  private dragging = false
  private pinchDist = 0
  private lastMove = { x: 0, y: 0, t: 0 }
  /** most recent pointer position in normalised device coords */
  nx = 0
  ny = 0
  active = false

  constructor(private el: HTMLElement, private h: InputHandlers) {
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('pointercancel', this.onUp)
    el.addEventListener('pointerleave', () => {
      this.active = false
      if (!this.down) h.leave()
    })
    el.addEventListener('wheel', (e) => {
      e.preventDefault()
      h.zoom(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0012))
    }, { passive: false })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private toNdc(e: PointerEvent) {
    const r = this.el.getBoundingClientRect()
    return {
      nx: ((e.clientX - r.left) / r.width) * 2 - 1,
      ny: -((e.clientY - r.top) / r.height) * 2 + 1,
      px: e.clientX - r.left,
      py: e.clientY - r.top,
    }
  }

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pointers.size === 2) {
      // second finger: switch to pinch-zoom, abandon any wind stroke
      if (this.dragging) this.h.dragEnd()
      this.dragging = false
      this.down = null
      const [a, b] = [...this.pointers.values()]
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      return
    }
    if (this.pointers.size > 2) return
    this.el.setPointerCapture?.(e.pointerId)
    this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }
    this.lastMove = { x: e.clientX, y: e.clientY, t: performance.now() }
    const p = this.toNdc(e)
    this.nx = p.nx
    this.ny = p.ny
  }

  private onMove = (e: PointerEvent) => {
    const p = this.toNdc(e)
    this.nx = p.nx
    this.ny = p.ny
    this.active = true
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (this.pinchDist > 0) this.h.zoom(-Math.log(d / this.pinchDist) * 1.4)
      this.pinchDist = d
      return
    }
    const now = performance.now()
    if (this.down && e.pointerId === this.down.id) {
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y)
      if (!this.dragging && moved > 6) {
        this.dragging = true
        this.h.dragStart(p.nx, p.ny)
      }
      if (this.dragging) {
        const dt = Math.max(1, now - this.lastMove.t) / 1000
        this.h.drag(p.nx, p.ny, (e.clientX - this.lastMove.x) / dt, (e.clientY - this.lastMove.y) / dt)
      }
    } else {
      this.h.hover(p.nx, p.ny, p.px, p.py)
    }
    this.lastMove = { x: e.clientX, y: e.clientY, t: now }
  }

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) this.pinchDist = 0
    if (!this.down || e.pointerId !== this.down.id) return
    if (this.dragging) this.h.dragEnd()
    else {
      const p = this.toNdc(e)
      if (performance.now() - this.down.t < 600) this.h.tap(p.nx, p.ny, p.px, p.py)
    }
    this.dragging = false
    this.down = null
  }

  get isDragging() {
    return this.dragging
  }
}
