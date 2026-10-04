import '@fontsource-variable/fraunces/wght-italic.css'
import '@fontsource-variable/geist-mono'
import { App } from './app'
import { detectQuality } from './config'
import './style.css'
import { Ui } from './ui/ui'
import { Ambience } from './audio/audio'
import { installDebug } from './ui/debug'

const params = new URLSearchParams(location.search)
const canvas = document.getElementById('scene') as HTMLCanvasElement
const veil = document.createElement('div')
veil.className = 'vf-veil'
veil.innerHTML = '<div class="vf-veil-title">VERMONT <span>//</span> FALL</div>'
document.body.appendChild(veil)

const quality = detectQuality(params.get('q'))
const app = new App({ canvas, shot: params.has('shot'), quality })

declare global {
  interface Window {
    __vf: App
    __ready: boolean
  }
}

// let the veil paint before the (synchronous) world build
requestAnimationFrame(() =>
  setTimeout(() => {
    const t0 = performance.now()
    app.build()
    const buildMs = performance.now() - t0
    window.__vf = app
    const toggleDebug = installDebug(app)
    if (params.get('cam')) app.camOverride = params.get('cam')!.split(',').map(Number)

    const audio = new Ambience()
    const ui = params.has('noui')
      ? null
      : new Ui(app, {
          toggleSound: () => audio.toggle(),
          setReducedMotion: (v) => (app.reducedMotion = v),
          toggleDebug,
        })
    ;(window as unknown as { __ui: Ui | null }).__ui = ui
    app.onWindDrag = () => ui?.noteDrag()
    app.onWhoosh = () => audio.whoosh()
    app.onFrame = (dt) => {
      ui?.update(dt)
      audio.update(dt, app.audioState())
    }

    let first = true
    const lift = () => {
      if (!first) return
      first = false
      veil.classList.add('is-gone')
      setTimeout(() => veil.remove(), 2000)
    }

    if (params.has('shot')) {
      veil.remove()
      const want = Number(params.get('frames') ?? 2)
      let ft = performance.now()
      app.start((n) => {
        const now = performance.now()
        console.log(`frame ${n} ${(now - ft).toFixed(0)}ms`)
        ft = now
        if (n >= want) {
          console.log('build', buildMs.toFixed(0), JSON.stringify(app.stats))
          window.__ready = true
          return false
        }
        return true
      })
    } else {
      app.start((n) => {
        if (n === 2) lift()
        return true
      })
    }
  }, 30),
)
