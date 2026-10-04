/**
 * Procedural ambience (no audio files). Off until the visitor turns it on.
 * Layers: wind, rustling leaves, distant birds; in the car a soft engine and
 * tyre hum; inside the covered bridge plank thumps and a wooden reverb.
 */

function noiseBuffer(ctx: AudioContext, seconds: number, kind: 'white' | 'brown' | 'crackle'): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1
    if (kind === 'white') d[i] = w
    else if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    } else {
      // sparse papery crackle for dry leaves
      const p = Math.random()
      d[i] = p < 0.0035 ? w : w * 0.06
    }
  }
  // seamless loop
  const fade = Math.min(2048, n >> 3)
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    d[i] = d[i] * t + d[n - fade + i] * (1 - t)
  }
  return buf
}

function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay)
  }
  return buf
}

export interface AudioState {
  /** 0 aerial .. 1 in the car */
  pov: number
  /** gust activity 0..1 */
  gust: number
  /** car speed m/s */
  speed: number
  /** 0..1 inside the covered bridge */
  bridge: number
}

export class Ambience {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private outside!: BiquadFilterNode
  private windGain!: GainNode
  private windFilter!: BiquadFilterNode
  private rustleGain!: GainNode
  private engineGain!: GainNode
  private engineFilter!: BiquadFilterNode
  private osc1!: OscillatorNode
  private osc2!: OscillatorNode
  private roadGain!: GainNode
  private roadFilter!: BiquadFilterNode
  private wet!: GainNode
  private birdTimer = 2
  private plankTimer = 0
  enabled = false

  private init() {
    const ctx = new AudioContext()
    this.ctx = ctx
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 3
    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(comp).connect(ctx.destination)
    // everything outdoors goes through a filter that muffles inside the bridge
    this.outside = ctx.createBiquadFilter()
    this.outside.type = 'lowpass'
    this.outside.frequency.value = 18000
    this.outside.connect(this.master)
    // reverb send
    const conv = ctx.createConvolver()
    conv.buffer = impulse(ctx, 1.6, 2.6)
    this.wet = ctx.createGain()
    this.wet.gain.value = 0
    this.wet.connect(conv).connect(this.master)

    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.start()
      return s
    }
    // wind
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'lowpass'
    this.windFilter.frequency.value = 420
    this.windFilter.Q.value = 0.6
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0.2
    loop(noiseBuffer(ctx, 6, 'brown')).connect(this.windFilter).connect(this.windGain).connect(this.outside)
    // rustle
    const rf = ctx.createBiquadFilter()
    rf.type = 'bandpass'
    rf.frequency.value = 3800
    rf.Q.value = 0.5
    this.rustleGain = ctx.createGain()
    this.rustleGain.gain.value = 0.05
    loop(noiseBuffer(ctx, 3.3, 'crackle')).connect(rf).connect(this.rustleGain).connect(this.outside)
    // engine: a soft, low vintage purr
    this.osc1 = ctx.createOscillator()
    this.osc1.type = 'sawtooth'
    this.osc1.frequency.value = 42
    this.osc2 = ctx.createOscillator()
    this.osc2.type = 'triangle'
    this.osc2.frequency.value = 84
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 180
    this.engineGain = ctx.createGain()
    this.engineGain.gain.value = 0
    this.osc1.connect(this.engineFilter)
    this.osc2.connect(this.engineFilter)
    this.engineFilter.connect(this.engineGain).connect(this.master)
    this.engineGain.connect(this.wet)
    this.osc1.start()
    this.osc2.start()
    // tyres on asphalt
    this.roadFilter = ctx.createBiquadFilter()
    this.roadFilter.type = 'bandpass'
    this.roadFilter.frequency.value = 380
    this.roadFilter.Q.value = 0.7
    this.roadGain = ctx.createGain()
    this.roadGain.gain.value = 0
    loop(noiseBuffer(ctx, 4, 'brown')).connect(this.roadFilter).connect(this.roadGain).connect(this.master)
    this.roadGain.connect(this.wet)
  }

  toggle(): boolean {
    if (!this.ctx) this.init()
    this.enabled = !this.enabled
    const ctx = this.ctx!
    if (ctx.state === 'suspended') void ctx.resume()
    this.master.gain.cancelScheduledValues(ctx.currentTime)
    this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, ctx.currentTime, 0.4)
    return this.enabled
  }

  update(dt: number, s: AudioState) {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    const t = ctx.currentTime
    const k = 0.25
    const gust = Math.min(1, s.gust)
    this.windGain.gain.setTargetAtTime(0.16 + 0.55 * gust + 0.05 * s.pov * Math.min(1, s.speed / 12), t, k)
    this.windFilter.frequency.setTargetAtTime(360 + 900 * gust + 200 * s.pov * Math.min(1, s.speed / 12), t, k)
    this.rustleGain.gain.setTargetAtTime((0.035 + 0.22 * gust) * (1 - 0.5 * s.bridge), t, k)
    const sp = Math.min(1, s.speed / 13)
    this.engineGain.gain.setTargetAtTime(s.pov * (0.05 + 0.05 * sp), t, k)
    this.osc1.frequency.setTargetAtTime(38 + 26 * sp, t, 0.5)
    this.osc2.frequency.setTargetAtTime(76 + 52 * sp, t, 0.5)
    this.roadGain.gain.setTargetAtTime(s.pov * sp * 0.22 * (1 - 0.4 * s.bridge), t, k)
    // the bridge: the world outside goes soft, wood rings around you
    this.outside.frequency.setTargetAtTime(18000 - 16500 * s.bridge, t, 0.15)
    this.wet.gain.setTargetAtTime(0.85 * s.bridge, t, 0.12)
    if (s.bridge > 0.3 && s.speed > 1) {
      this.plankTimer -= dt
      if (this.plankTimer <= 0) {
        this.plankTimer = 2.6 / Math.max(2, s.speed)
        this.thump(0.18 * s.bridge)
        setTimeout(() => this.thump(0.14 * s.bridge), (2.6 / Math.max(2, s.speed)) * 400)
      }
    }
    // birds: sparse, more from the sky than the car
    this.birdTimer -= dt
    if (this.birdTimer <= 0) {
      this.birdTimer = 3 + Math.random() * 7
      if (s.bridge < 0.3) this.chirp(0.05 * (1 - 0.5 * s.pov))
    }
  }

  private thump(gain: number) {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(110, t)
    o.frequency.exponentialRampToValueAtTime(52, t + 0.12)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.22)
    o.connect(g)
    g.connect(this.master)
    g.connect(this.wet)
    o.start(t)
    o.stop(t + 0.3)
  }

  private chirp(gain: number) {
    const ctx = this.ctx!
    const t0 = ctx.currentTime
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.random() * 1.6 - 0.8
    pan.connect(this.outside)
    const notes = 2 + Math.floor(Math.random() * 4)
    const base = 2600 + Math.random() * 1800
    for (let i = 0; i < notes; i++) {
      const t = t0 + i * (0.09 + Math.random() * 0.05)
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), t)
      o.frequency.exponentialRampToValueAtTime(base * (1.15 + Math.random() * 0.3), t + 0.06)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(gain, t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.08)
      o.connect(g).connect(pan)
      o.start(t)
      o.stop(t + 0.1)
    }
  }

  whoosh() {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(ctx, 0.7, 'white')
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 1.2
    f.frequency.setValueAtTime(500, t)
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.45)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.22, t + 0.08)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6)
    src.connect(f).connect(g).connect(this.master)
    src.start(t)
    src.stop(t + 0.7)
  }
}
