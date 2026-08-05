import fragSrc from './ripple.frag.glsl?raw'
import vertSrc from './ripple.vert.glsl?raw'
import { hexToRgb, paletteById } from './palettes'
import { RippleParams, SHAPE_INDEX, SURFACE_LIGHT } from './params'

const MAX_SRC = 4
const MAX_INK = 5

const UNIFORMS = [
  'uResolution', 'uTime', 'uSpeed',
  'uSourceCount', 'uSrcA', 'uSrcB', 'uSrcC',
  'uInterference', 'uDensity', 'uLineWidth', 'uBleed',
  'uWarpAmount', 'uWarpScale', 'uWarpOctaves',
  'uLayers', 'uChromaSplit', 'uChromaPhase', 'uChromaDir', 'uHueSpread', 'uCoreGlow',
  'uInkCount', 'uInk', 'uInkPos', 'uPaperA', 'uPaperB', 'uMatte',
  'uExposure', 'uContrast',
  'uLight', 'uLightDir',
  'uGrain', 'uGrainScale',
  'uShape', 'uShapeSize', 'uShapeSoft',
] as const

type UniformName = (typeof UNIFORMS)[number]

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`Shader compile failed:\n${log}`)
  }
  return sh
}

export class Renderer {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private loc = new Map<UniformName, WebGLUniformLocation | null>()

  private raf = 0
  private startTime = performance.now()
  private params: RippleParams | null = null
  private running = false

  /** Render resolution, deliberately decoupled from devicePixelRatio — a
   *  500 CSS-px avatar at DPR 3 would be 1500² for no visible gain here. */
  private renderSize = 640

  // scratch buffers, reused every frame
  private srcA = new Float32Array(MAX_SRC * 4)
  private srcB = new Float32Array(MAX_SRC * 4)
  private srcC = new Float32Array(MAX_SRC * 4)
  private ink = new Float32Array(MAX_INK * 3)
  private inkPos = new Float32Array(MAX_INK * 2)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true, // needed so toBlob() can read the frame
      powerPreference: 'low-power',
    })
    if (!gl) throw new Error('WebGL2 is not available in this browser.')
    this.gl = gl

    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc)
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc)
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link failed:\n${gl.getProgramInfoLog(prog)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    this.program = prog
    gl.useProgram(prog)

    for (const n of UNIFORMS) this.loc.set(n, gl.getUniformLocation(prog, n))
  }

  setRenderSize(px: number) {
    this.renderSize = Math.max(160, Math.round(px))
  }

  setParams(p: RippleParams) {
    this.params = p
  }

  start() {
    if (this.running) return
    this.running = true
    const loop = () => {
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  dispose() {
    this.stop()
    this.gl.deleteProgram(this.program)
  }

  /** One frame at the current render size. Also used by the exporter, which
   *  temporarily resizes the canvas, draws, reads back, then restores. */
  draw(sizeOverride?: number) {
    const p = this.params
    if (!p) return
    const gl = this.gl
    const size = sizeOverride ?? this.renderSize

    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size
      this.canvas.height = size
    }
    gl.viewport(0, 0, size, size)
    gl.useProgram(this.program)

    const u = (n: UniformName) => this.loc.get(n) ?? null
    const t = (performance.now() - this.startTime) / 1000

    gl.uniform2f(u('uResolution'), size, size)
    gl.uniform1f(u('uTime'), t)
    gl.uniform1f(u('uSpeed'), p.speed)

    // --- sources ---
    const n = Math.min(p.sources.length, MAX_SRC)
    this.srcA.fill(0)
    this.srcB.fill(0)
    this.srcC.fill(0)
    for (let i = 0; i < n; i++) {
      const s = p.sources[i]
      this.srcA.set([s.x, s.y, s.sx, s.sy], i * 4)
      this.srcB.set([s.rot, s.freq, s.phase, s.power], i * 4)
      this.srcC.set([s.drift, s.amp, 0, 0], i * 4)
    }
    gl.uniform1i(u('uSourceCount'), n)
    gl.uniform4fv(u('uSrcA'), this.srcA)
    gl.uniform4fv(u('uSrcB'), this.srcB)
    gl.uniform4fv(u('uSrcC'), this.srcC)

    gl.uniform1f(u('uInterference'), p.interference)
    gl.uniform1f(u('uDensity'), p.density)
    gl.uniform1f(u('uLineWidth'), p.lineWidth)
    gl.uniform1f(u('uBleed'), p.bleed)

    gl.uniform1f(u('uWarpAmount'), p.warpAmount)
    gl.uniform1f(u('uWarpScale'), p.warpScale)
    gl.uniform1i(u('uWarpOctaves'), p.warpOctaves)

    gl.uniform1i(u('uLayers'), p.layers)
    gl.uniform1f(u('uChromaSplit'), p.chromaSplit)
    gl.uniform1f(u('uChromaPhase'), p.chromaPhase)
    gl.uniform2f(u('uChromaDir'), Math.cos(p.chromaAngle), Math.sin(p.chromaAngle))
    gl.uniform1f(u('uHueSpread'), p.hueSpread)
    gl.uniform1f(u('uCoreGlow'), p.coreGlow)

    // --- colour ---
    const pal = paletteById(p.paletteId)
    const inkCount = Math.min(pal.ink.length, MAX_INK)
    this.ink.fill(0)
    this.inkPos.fill(0)
    for (let i = 0; i < inkCount; i++) {
      const stop = pal.ink[i]
      this.ink.set(hexToRgb(stop.color), i * 3)
      this.inkPos.set([stop.x, stop.y], i * 2)
    }
    gl.uniform1i(u('uInkCount'), inkCount)
    gl.uniform3fv(u('uInk'), this.ink)
    gl.uniform2fv(u('uInkPos'), this.inkPos)
    gl.uniform3fv(u('uPaperA'), hexToRgb(pal.paperA))
    gl.uniform3fv(u('uPaperB'), hexToRgb(pal.paperB))
    gl.uniform3fv(u('uMatte'), hexToRgb(pal.matte))

    gl.uniform1f(u('uExposure'), p.exposure)
    gl.uniform1f(u('uContrast'), p.contrast)

    gl.uniform1f(u('uLight'), SURFACE_LIGHT[p.surface])
    gl.uniform2f(u('uLightDir'), Math.cos(p.lightAngle), Math.sin(p.lightAngle))

    // Grain scales with render size so a 2048 export reads the same as the
    // 640 preview instead of turning into fine dust.
    gl.uniform1f(u('uGrain'), p.grain)
    gl.uniform1f(u('uGrainScale'), Math.max(1, size / 640))

    gl.uniform1i(u('uShape'), SHAPE_INDEX[p.shape])
    gl.uniform1f(u('uShapeSize'), p.shapeSize)
    gl.uniform1f(u('uShapeSoft'), p.shapeSoft)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
