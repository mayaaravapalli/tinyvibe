import type { App, Mode } from '../app'

const ICON = {
  soundOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5m0-5l-5 5"/></svg>`,
  soundOn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>`,
  motion: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12c2.5-4 5-4 7.5 0s5 4 7.5 0 2.5-1.5 3-1.5"/></svg>`,
  motionOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18"/></svg>`,
  hide: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`,
}

export interface UiHooks {
  toggleSound(): boolean
  setReducedMotion(v: boolean): void
}

/**
 * The almost-invisible interface. The world is the interface; this only
 * whispers: a title, one hint, a label on the car, the way back up.
 */
export class Ui {
  private root: HTMLElement
  private hint: HTMLElement
  private carTag: HTMLElement
  private aerialBtn: HTMLButtonElement
  private soundBtn: HTMLButtonElement
  private motionBtn: HTMLButtonElement
  private hideBtn: HTMLButtonElement
  private hidden = false
  private t = 0
  private dragged = false
  private hintShownAt = -1
  private hintDone = false
  private carTagReady = false
  private reduced: boolean

  constructor(private app: App, private hooks: UiHooks) {
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const root = document.createElement('div')
    root.className = 'vf-ui'
    root.innerHTML = `
      <header class="vf-title">
        <h1>VERMONT <span>//</span> FALL</h1>
        <p>Peak foliage. Stay awhile.</p>
      </header>
      <div class="vf-hint" role="status" aria-live="polite">Drag across the forest to make wind.</div>
      <button class="vf-cartag" type="button" aria-label="Enter the road: ride along in the car">
        <span class="vf-cartag-dot"></span><span class="vf-cartag-line"></span><span class="vf-cartag-text">Enter the road</span>
      </button>
      <button class="vf-aerial" type="button" aria-label="Return to the aerial view"><span aria-hidden="true">↑</span> AERIAL VIEW</button>
      <nav class="vf-controls" aria-label="Experience settings">
        <button type="button" class="vf-ctl vf-sound" aria-pressed="false" title="Sound (M)">${ICON.soundOff}</button>
        <button type="button" class="vf-ctl vf-motion" aria-pressed="false" title="Reduce motion">${ICON.motion}</button>
        <button type="button" class="vf-ctl vf-hide" title="Hide interface (H)">${ICON.hide}</button>
      </nav>
      <button class="vf-show" type="button" aria-label="Show interface (H)" title="Show interface (H)"></button>
    `
    document.body.appendChild(root)
    this.root = root
    this.hint = root.querySelector('.vf-hint')!
    this.carTag = root.querySelector('.vf-cartag')!
    this.aerialBtn = root.querySelector('.vf-aerial')!
    this.soundBtn = root.querySelector('.vf-sound')!
    this.motionBtn = root.querySelector('.vf-motion')!
    this.hideBtn = root.querySelector('.vf-hide')!

    this.carTag.addEventListener('click', () => app.enterRoad())
    this.aerialBtn.addEventListener('click', () => app.leaveRoad())
    this.soundBtn.addEventListener('click', () => this.setSound(hooks.toggleSound()))
    this.motionBtn.addEventListener('click', () => this.setReduced(!this.reduced))
    this.hideBtn.addEventListener('click', () => this.setHidden(true))
    root.querySelector('.vf-show')!.addEventListener('click', () => this.setHidden(false))

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return
      const k = e.key.toLowerCase()
      if (k === 'escape' || k === 'a') app.leaveRoad()
      else if (k === 'enter' && app.mode === 'aerial' && document.activeElement === document.body) app.enterRoad()
      else if (k === 'h') this.setHidden(!this.hidden)
      else if (k === 'm') this.setSound(hooks.toggleSound())
    })

    app.onMode = (m) => this.onMode(m)
    app.onCarHover = (over) => this.carTag.classList.toggle('is-hot', over)
    this.setReduced(this.reduced)
    this.onMode(app.mode)
  }

  noteDrag() {
    if (!this.dragged) {
      this.dragged = true
      if (this.hintShownAt >= 0) this.hideHint()
    }
  }

  private hideHint() {
    this.hint.classList.remove('is-on')
    this.hintDone = true
  }

  private setSound(on: boolean) {
    this.soundBtn.innerHTML = on ? ICON.soundOn : ICON.soundOff
    this.soundBtn.setAttribute('aria-pressed', String(on))
    this.soundBtn.classList.toggle('is-on', on)
  }

  private setReduced(v: boolean) {
    this.reduced = v
    this.motionBtn.innerHTML = v ? ICON.motionOff : ICON.motion
    this.motionBtn.setAttribute('aria-pressed', String(v))
    this.motionBtn.classList.toggle('is-on', v)
    this.motionBtn.title = v ? 'Reduced motion is on' : 'Reduce motion'
    this.hooks.setReducedMotion(v)
    document.documentElement.classList.toggle('vf-reduced', v)
  }

  private setHidden(v: boolean) {
    this.hidden = v
    this.root.classList.toggle('is-hidden', v)
  }

  private onMode(m: Mode) {
    this.root.dataset.mode = m
    this.aerialBtn.classList.toggle('is-on', m === 'pov' || m === 'dive')
    if (m !== 'aerial') {
      this.carTag.classList.remove('is-on')
      // the wind hint belongs to the sky view
      this.hint.classList.remove('is-on')
    } else if (this.hintShownAt >= 0 && !this.hintDone) {
      this.hint.classList.add('is-on')
    }
  }

  update(dt: number) {
    this.t += dt
    const app = this.app
    // the wind hint: shortly after arrival, gone after the first gust or a while
    if (!this.hintDone && this.hintShownAt < 0 && this.t > 1.6 && app.mode === 'aerial') {
      this.hint.classList.add('is-on')
      this.hintShownAt = this.t
    }
    if (!this.hintDone && this.hintShownAt >= 0 && this.t - this.hintShownAt > 11) this.hideHint()
    if (!this.carTagReady && (this.t > 9 || (this.dragged && this.t - this.hintShownAt > 2.5))) this.carTagReady = true

    // the car label rides with the car on screen
    const show = this.carTagReady && app.mode === 'aerial' && app.modeT > 1.2
    const p = show ? app.carScreenPos() : null
    if (p && Math.abs(p.x) < 0.96 && Math.abs(p.y) < 0.92) {
      const w = window.innerWidth, h = window.innerHeight
      const x = (p.x * 0.5 + 0.5) * w
      const y = (-p.y * 0.5 + 0.5) * h
      this.carTag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      this.carTag.classList.add('is-on')
    } else {
      this.carTag.classList.remove('is-on')
    }
  }
}
