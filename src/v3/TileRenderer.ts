/* ---------------------------------------------------------------------------
   v3 renderer.

   One fragment pass, no render targets. The only state is a per-tile offset and
   scale, sprung toward a hover target in JS — 16 tiles is far too few to be
   worth doing on the GPU, and keeping it here means the spring can be read and
   tuned without a readback.
   --------------------------------------------------------------------------- */

import vertSrc from '../engine/ripple.vert.glsl?raw'
import { prefersReducedMotion } from '../playground/gpu'
import { GRID, TILE_COUNT, V3Config, cellOf } from './params'
import fragSrc from './tiles.frag.glsl?raw'
import { bgRgb, shadeRgb } from './shades'

/** Spring toward the hover target. Critically damped enough not to wobble, fast
 *  enough that the grid feels responsive rather than syrupy. */
const STIFFNESS = 190
const DAMPING = 22

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
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

export class TileRenderer {
  readonly canvas: HTMLCanvasElement

  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private locs = new Map<string, WebGLUniformLocation | null>()

  private cfg: V3Config | null = null
  private renderSize = 640
  private displaySize = 500
  private selected = -1

  private raf = 0
  private running = false
  private last = 0
  private reduced = prefersReducedMotion()

  /** −1 when the pointer is outside the grid */
  private hovered = -1

  // spring state, per tile: current and velocity
  private pos = new Float32Array(TILE_COUNT * 2)
  private vel = new Float32Array(TILE_COUNT * 2)
  private scale = new Float32Array(TILE_COUNT)
  private scaleVel = new Float32Array(TILE_COUNT)

  // scratch, reused every frame
  private tileBuf = new Float32Array(TILE_COUNT * 4)
  private radiiBuf = new Float32Array(TILE_COUNT * 4)
  private colorBuf = new Float32Array(TILE_COUNT * 3)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true, // so toBlob() can read the frame back
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
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link failed:\n${gl.getProgramInfoLog(prog)}`)
    }
    this.prog = prog
    this.scale.fill(1)
    this.last = performance.now()
  }

  private u(name: string) {
    let loc = this.locs.get(name)
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.prog, name)
      this.locs.set(name, loc)
    }
    return loc
  }

  setConfig(cfg: V3Config) {
    this.cfg = cfg
    this.wake()
  }

  setSelected(index: number) {
    this.selected = index
    this.wake()
  }

  setDisplaySize(px: number) {
    this.displaySize = Math.max(16, Math.round(px))
    // A little supersampling: corners are the whole design, and at 1:1 a
    // quarter-circle against a flat edge shows its stair-step.
    this.renderSize = Math.min(2048, Math.max(64, Math.round(this.displaySize * 2)))
    this.wake()
  }

  /** Pointer in canvas UV, y down. Pass null when it leaves. */
  setPointer(p: { x: number; y: number } | null) {
    const next =
      p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
        ? Math.min(GRID - 1, Math.floor(p.y * GRID)) * GRID +
          Math.min(GRID - 1, Math.floor(p.x * GRID))
        : -1
    if (next !== this.hovered) {
      this.hovered = next
      this.wake()
    }
  }

  /** Which tile is under a UV point, ignoring the hover offsets. */
  tileAt(p: { x: number; y: number }): number {
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return -1
    return (
      Math.min(GRID - 1, Math.floor(p.y * GRID)) * GRID +
      Math.min(GRID - 1, Math.floor(p.x * GRID))
    )
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const loop = () => {
      if (!this.running) return
      this.frame()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  wake() {
    if (!this.running) this.start()
  }

  dispose() {
    this.stop()
    this.gl.deleteProgram(this.prog)
  }

  private frame() {
    const dt = Math.min((performance.now() - this.last) / 1000, 0.05)
    this.last = performance.now()

    const settled = this.step(dt)
    this.draw()

    // Nothing is animating and nothing is hovered: park the loop until the
    // pointer or a control wakes it. The mark is static by nature, so there is
    // no reason to hold a 60fps loop open on it.
    if (settled && this.hovered < 0) this.stop()
  }

  /** Advance the springs. Returns true once everything is at rest. */
  private step(dt: number): boolean {
    const cfg = this.cfg
    if (!cfg) return true

    const push = cfg.spread * 0.5 // in cell units
    const reach = 0.6 + cfg.spreadReach * 2.4
    let moving = false

    for (let i = 0; i < TILE_COUNT; i++) {
      let tx = 0
      let ty = 0
      let ts = 1

      if (this.hovered >= 0) {
        const a = cellOf(this.hovered)
        const b = cellOf(i)
        const dx = b.col - a.col
        const dy = b.row - a.row
        const dist = Math.hypot(dx, dy)

        if (i === this.hovered) {
          ts = 1 + cfg.lift * 0.22
        } else {
          // Falloff by ring distance, so the eight neighbours move most and the
          // corners of the grid barely notice.
          const falloff = Math.exp(-(dist * dist) / (reach * reach))
          const k = (push * falloff) / Math.max(dist, 1e-4)
          tx = dx * k
          ty = dy * k
          ts = 1 - cfg.lift * 0.05 * falloff
        }
      }

      if (this.reduced) {
        // Snap rather than spring: the motion is the point of the interaction,
        // so honouring the preference means arriving without the travel.
        this.pos[i * 2] = tx
        this.pos[i * 2 + 1] = ty
        this.scale[i] = ts
        continue
      }

      for (const [arr, velArr, target, idx] of [
        [this.pos, this.vel, tx, i * 2],
        [this.pos, this.vel, ty, i * 2 + 1],
      ] as const) {
        const a = (target - arr[idx]) * STIFFNESS - velArr[idx] * DAMPING
        velArr[idx] += a * dt
        arr[idx] += velArr[idx] * dt
        if (Math.abs(velArr[idx]) > 1e-4 || Math.abs(target - arr[idx]) > 1e-4) moving = true
      }

      const sa = (ts - this.scale[i]) * STIFFNESS - this.scaleVel[i] * DAMPING
      this.scaleVel[i] += sa * dt
      this.scale[i] += this.scaleVel[i] * dt
      if (Math.abs(this.scaleVel[i]) > 1e-4 || Math.abs(ts - this.scale[i]) > 1e-4) moving = true
    }

    return !moving
  }

  draw(sizeOverride?: number) {
    const cfg = this.cfg
    if (!cfg) return

    const gl = this.gl
    const size = sizeOverride ?? this.renderSize
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size
      this.canvas.height = size
    }
    gl.viewport(0, 0, size, size)
    gl.useProgram(this.prog)

    const cell = 1 / GRID
    // Gutter is taken off the cell, so raising it shrinks the tiles rather than
    // growing the mark past its frame.
    const half = (cell * (1 - cfg.gutter)) / 2

    for (let i = 0; i < TILE_COUNT; i++) {
      const c = cellOf(i)
      const o = i * 4
      this.tileBuf[o] = c.cx + this.pos[i * 2] * cell
      this.tileBuf[o + 1] = c.cy + this.pos[i * 2 + 1] * cell
      this.tileBuf[o + 2] = half * this.scale[i]
      this.tileBuf[o + 3] = 0

      const t = cfg.tiles[i]
      this.radiiBuf[o] = t.radii[0]
      this.radiiBuf[o + 1] = t.radii[1]
      this.radiiBuf[o + 2] = t.radii[2]
      this.radiiBuf[o + 3] = t.radii[3]

      const rgb = shadeRgb(cfg, t.shade)
      this.colorBuf[i * 3] = rgb[0]
      this.colorBuf[i * 3 + 1] = rgb[1]
      this.colorBuf[i * 3 + 2] = rgb[2]
    }

    gl.uniform2f(this.u('uResolution'), size, size)
    gl.uniform4fv(this.u('uTile'), this.tileBuf)
    gl.uniform4fv(this.u('uRadii'), this.radiiBuf)
    gl.uniform3fv(this.u('uColor'), this.colorBuf)
    gl.uniform1i(this.u('uSelected'), this.selected)

    const bg = bgRgb(cfg)
    gl.uniform3f(this.u('uBg'), bg[0], bg[1], bg[2])

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
