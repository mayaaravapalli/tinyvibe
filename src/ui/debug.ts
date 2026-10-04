import type { App } from '../app'

/**
 * A small readout for checking how the experience runs on a given device.
 * Open the page with #debug at the end of its address, or press and hold the
 * title for a second. Returns a toggle.
 */
export function installDebug(app: App): () => void {
  const errors: string[] = []
  const prevShaderError = app.renderer.debug.onShaderError
  app.renderer.debug.onShaderError = (gl, program, vs, fs) => {
    errors.push((gl.getProgramInfoLog(program) || 'shader failed').slice(0, 90))
    prevShaderError?.(gl, program, vs, fs)
  }
  let box: HTMLPreElement | null = null
  const gl = app.renderer.getContext()
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  let frames = 0
  let acc = 0

  const tick = (dt: number) => {
    frames++
    acc += dt
    if (!box || acc < 0.5) return
    const fps = frames / acc
    frames = 0
    acc = 0
    const r = app.renderer.info.render
    const c = app.camera.position
    const above = c.y - app.terrain.heightAt(c.x, c.z)
    box.textContent = [
      `build ${__BUILD__}`,
      `tier ${app.opts.quality.name}  dpr ${app.renderer.getPixelRatio().toFixed(2)}  ${fps.toFixed(0)} fps`,
      `gpu ${gpu.slice(0, 60)}`,
      `mode ${app.mode}  above ${above.toFixed(1)} m`,
      `draws ${r.calls}  tris ${(r.triangles / 1e6).toFixed(2)}M`,
      `meadow ${app.meadow.group.visible ? 'on' : 'off'}  ground ${app.ground.visibleChunks} chunks  near trees ${app.forest.nearCount}`,
      errors.length ? `errors: ${errors.join(' | ')}` : 'no shader errors',
    ].join('\n')
  }

  const toggle = () => {
    if (box) {
      box.remove()
      box = null
      app.onFrameDebug = () => {}
      return
    }
    box = document.createElement('pre')
    box.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:50;margin:0;padding:8px 10px;border-radius:8px;background:rgba(20,14,10,.72);color:#f5ecd8;font:11px/1.45 ui-monospace,Menlo,monospace;pointer-events:none;max-width:92vw;white-space:pre-wrap'
    box.textContent = `build ${__BUILD__}`
    document.body.appendChild(box)
    frames = 0
    acc = 0
    app.onFrameDebug = tick
  }

  if (location.hash === '#debug') toggle()
  return toggle
}
