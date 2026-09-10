/* ---------------------------------------------------------------------------
   v3 renderer.

   One fragment pass, no render targets. The only state is a per-tile offset and
   scale, sprung toward a hover target in JS — 16 tiles is far too few to be
   worth doing on the GPU, and keeping it here means the spring can be read and
   tuned without a readback.
   --------------------------------------------------------------------------- */

import vertSrc from '../engine/ripple.vert.glsl?raw'
import { prefersReducedMotion } from '../playground/gpu'
import { AbstractMask, abstractFromSeed } from './abstract'
import { GRID, RINGS, TILE_COUNT, V3Config, cellOf, polarCellOf } from './params'
import fragSrc from './tiles.frag.glsl?raw'
import { shadeRgb } from './shades'

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
  /** Abstract drives its hover off the pointer *position*, not off which
   *  component is under it, so the field can sit between two blobs and pull
   *  them together. Kept after the pointer leaves so the goo springs down
   *  where it was rather than snapping back to the origin. */
  private ptr = { x: 0.5, y: 0.5 }
  private ptrOn = false

  private mask: AbstractMask | null = null
  private maskKey = ''
  private maskTex: WebGLTexture | null = null

  // spring state, per tile: current and velocity
  private pos = new Float32Array(TILE_COUNT * 2)
  private vel = new Float32Array(TILE_COUNT * 2)
  private scale = new Float32Array(TILE_COUNT)
  private scaleVel = new Float32Array(TILE_COUNT)
  /** 0 at rest, 1 while hovering — the goo is an *interaction*, not a style, so
   *  the mark stays crisp until the pointer arrives. */
  private gooAmt = 0
  private gooVel = 0

  // scratch, reused every frame
  private tileBuf = new Float32Array(TILE_COUNT * 4)
  private radiiBuf = new Float32Array(TILE_COUNT * 4)
  private colorBuf = new Float32Array(TILE_COUNT * 3)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      // Transparent so the mark composites onto the page: there is no plate
      // behind the components for them to displace against.
      alpha: true,
      premultipliedAlpha: true,
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

    // NEAREST and no mips: an integer texture is not filterable, and a cell id
    // has no meaningful interpolation anyway.
    this.maskTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // A 1x1 placeholder, so the sampler is always backed even in the layouts
    // that never read it.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8UI, 1, 1, 0, gl.RG_INTEGER,
      gl.UNSIGNED_BYTE, new Uint8Array([0, 0]))
  }

  /** Rebuild the abstract mask, but only when something it depends on moved —
   *  growing 4096 cells on every slider tick would stutter the drag. */
  private syncMask(cfg: V3Config) {
    if (cfg.layout !== 'abstract') return
    const key = [
      cfg.seed,
      cfg.absGrid,
      cfg.absDensity.toFixed(3),
      cfg.absBond.toFixed(3),
    ].join('|')
    if (key === this.maskKey && this.mask) return

    this.maskKey = key
    this.mask = abstractFromSeed(cfg.seed, {
      grid: cfg.absGrid,
      density: cfg.absDensity,
      bond: cfg.absBond,
    })

    // Interleave component and cluster into one two-channel fetch, rather than
    // paying a second texture lookup per cell per fragment for the group.
    const n = this.mask.grid * this.mask.grid
    const packed = new Uint8Array(n * 2)
    for (let i = 0; i < n; i++) {
      packed[i * 2] = this.mask.cells[i]
      packed[i * 2 + 1] = this.mask.groups[i]
    }

    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8UI, this.mask.grid, this.mask.grid, 0,
      gl.RG_INTEGER, gl.UNSIGNED_BYTE, packed)
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
    this.syncMask(cfg)
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
    const next = p ? this.tileAt(p) : -1
    const abstract = this.cfg?.layout === 'abstract'

    if (p) {
      // Abstract follows the pointer continuously, so every move is a redraw;
      // the other layouts only care when it crosses into another component.
      if (abstract && (p.x !== this.ptr.x || p.y !== this.ptr.y)) {
        this.ptr = { x: p.x, y: p.y }
        this.wake()
      }
      const inside = p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
      if (inside !== this.ptrOn) {
        this.ptrOn = inside
        this.wake()
      }
    } else if (this.ptrOn) {
      this.ptrOn = false
      this.wake()
    }

    if (next !== this.hovered) {
      this.hovered = next
      this.wake()
    }
  }

  /** True while the interaction should be running. Abstract reacts anywhere on
   *  the canvas — including over a gap between blobs, which is exactly where
   *  the reach-out is most visible — so it cannot key off tileAt. */
  private get hoverOn() {
    return this.cfg?.layout === 'abstract' ? this.ptrOn : this.hovered >= 0
  }

  /** Which component is under a UV point, ignoring the hover offsets. */
  tileAt(p: { x: number; y: number }): number {
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return -1

    if (this.cfg?.layout === 'abstract') {
      const m = this.mask
      if (!m) return -1
      const col = Math.min(m.grid - 1, Math.floor(p.x * m.grid))
      const row = Math.min(m.grid - 1, Math.floor(p.y * m.grid))
      return m.cells[row * m.grid + col] - 1
    }

    if (this.cfg?.layout === 'circle') {
      const qx = p.x - 0.5
      const qy = p.y - 0.5
      const rad = Math.hypot(qx, qy)
      if (rad > 0.5) return -1
      // find the ring the radius falls in, then the slot within it
      for (let i = 0; i < TILE_COUNT; i++) {
        const c = polarCellOf(i, 0)
        if (Math.abs(rad - c.rMid) > c.rHalf) continue
        if (c.ring === 0) return i
        let d = Math.atan2(qy, qx) - c.aMid
        d = Math.atan2(Math.sin(d), Math.cos(d))
        if (Math.abs(d) <= c.aHalf) return i
      }
      return -1
    }

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
    if (this.maskTex) this.gl.deleteTexture(this.maskTex)
  }

  private frame() {
    const dt = Math.min((performance.now() - this.last) / 1000, 0.05)
    this.last = performance.now()

    const settled = this.step(dt)
    this.draw()

    // Nothing is animating and nothing is hovered: park the loop until the
    // pointer or a control wakes it. The mark is static by nature, so there is
    // no reason to hold a 60fps loop open on it.
    if (settled && !this.hoverOn) this.stop()
  }

  /** Advance the springs. Returns true once everything is at rest. */
  private step(dt: number): boolean {
    const cfg = this.cfg
    if (!cfg) return true

    let moving = false

    // The goo itself springs in and out, so merging and separating are as smooth
    // as the movement that causes them.
    const gooTarget = this.hoverOn ? 1 : 0
    if (this.reduced) {
      this.gooAmt = gooTarget
    } else {
      const ga = (gooTarget - this.gooAmt) * STIFFNESS - this.gooVel * DAMPING
      this.gooVel += ga * dt
      this.gooAmt += this.gooVel * dt
      if (Math.abs(this.gooVel) > 1e-4 || Math.abs(gooTarget - this.gooAmt) > 1e-4) {
        moving = true
      }
    }

    // Abstract has nothing per-component to spring: its cells are fixed at grid
    // positions in the mask, and the interaction is a field over the canvas
    // rather than sixteen offsets. Only the goo amount moves.
    if (cfg.layout === 'abstract') return !moving

    // Negative: components move *toward* the hovered one so their fields touch
    // and the smooth minimum fuses them. Pushing apart would separate the very
    // fields the goo needs to overlap.
    const pull = -cfg.spread * 0.42
    const reach = 0.5 + cfg.spreadReach * 1.6


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
          const k = (pull * falloff) / Math.max(dist, 1e-4)
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
    // Gutter is taken off the cell, so raising it shrinks the components rather
    // than growing the mark past its frame.
    const half = (cell * (1 - cfg.gutter)) / 2
    const circle = cfg.layout === 'circle'
    const abstract = cfg.layout === 'abstract'

    for (let i = 0; i < TILE_COUNT; i++) {
      const o = i * 4

      if (circle) {
        const p = polarCellOf(i, cfg.gutter)
        // The stored offset is (radial, tangential) in circle mode. Tangential
        // has to be divided by the radius to become an angle, or the outer ring
        // would swing much further than the inner one for the same offset.
        const dr = this.pos[i * 2 + 1] * cell
        const dt = p.rMid > 1e-3 ? (this.pos[i * 2] * cell) / p.rMid : 0
        this.tileBuf[o] = Math.max(p.rMid + dr, 0)
        this.tileBuf[o + 1] = p.aMid + dt
        this.tileBuf[o + 2] = p.rHalf * this.scale[i]
        this.tileBuf[o + 3] = p.aHalf * (p.ring === 0 ? 1 : this.scale[i])
      } else {
        const c = cellOf(i)
        this.tileBuf[o] = c.cx + this.pos[i * 2] * cell
        this.tileBuf[o + 1] = c.cy + this.pos[i * 2 + 1] * cell
        this.tileBuf[o + 2] = half * this.scale[i]
        this.tileBuf[o + 3] = half * this.scale[i]
      }

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
    gl.uniform1i(this.u('uSelected'), abstract ? -1 : this.selected)
    gl.uniform1i(this.u('uLayout'), abstract ? 2 : circle ? 1 : 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    gl.uniform1i(this.u('uMask'), 0)

    if (abstract) {
      const G = this.mask?.grid ?? cfg.absGrid
      const cw = 1 / G
      // Fixed, not gutter-driven. Gutter and goo would be two controls over the
      // same thing here — how much of a cell survives the merge — and the goo
      // is the one that also shapes the fillet. Cells sit just short of
      // touching so the merge has something to close.
      const cellHalf = (cw * 0.92) / 2

      // Unlike the other layouts, the base goo is *not* gated on hover. Each of
      // the sixteen components is a cluster of adjacent cells, and they have to
      // stay fused for it to read as one blob at all — the hover adds to this,
      // it does not create it.
      //
      // The range is far wider than the other layouts get. Two touching squares
      // merged with a small k still have a staircase outline; the fillet has to
      // be an appreciable fraction of a cell before a cluster reads as one
      // organic mass rather than as the pixels it was assembled from. Measured
      // against the references, that turn happens around 0.9 of a cell.
      const goo = cw * (0.35 + 1.15 * cfg.goo)
      // Sized to clear the channel, not guessed. Two clusters are left one
      // empty cell apart, so their edges are cw - 0.92cw*... — about 1.1 cells
      // of clear air. The hover fillet has to exceed that to bridge it at all,
      // which is why this range starts well above the other layouts'.
      const hoverGoo = cw * (0.55 + 1.7 * cfg.spread) * this.gooAmt
      const hoverR = 0.05 + 0.2 * cfg.spreadReach
      const hoverGrow = (0.12 + 0.5 * cfg.lift) * this.gooAmt

      // How far a cell can still touch this fragment. sminBlend clamps h, so a
      // field beyond k contributes exactly zero — this bound is not a heuristic.
      // A fragment sits anywhere in its own cell, hence the half-cell slack.
      const influence = cellHalf * (1 + hoverGrow) + goo + hoverGoo
      const reach = Math.min(3, Math.max(1, Math.floor(influence / cw + 0.5)))

      gl.uniform1i(this.u('uGridN'), G)
      gl.uniform1f(this.u('uCellHalf'), cellHalf)
      gl.uniform1f(this.u('uAbsRadius'), cfg.absRadius)
      gl.uniform1i(this.u('uReach'), reach)
      gl.uniform2f(this.u('uPointer'), this.ptr.x, this.ptr.y)
      gl.uniform1f(this.u('uHover'), this.gooAmt)
      gl.uniform1f(this.u('uHoverR'), hoverR)
      gl.uniform1f(this.u('uHoverGoo'), hoverGoo)
      gl.uniform1f(this.u('uHoverGrow'), hoverGrow)
      gl.uniform1f(this.u('uGoo'), goo)
    } else {
      // Goo in uv units, scaled by the *layout's own* component size — the
      // disc's rings are narrower than a grid cell, so a single absolute radius
      // that looks right on the grid fuses the whole disc into one blob.
      const compSize = circle ? 0.5 / RINGS.length : cell
      gl.uniform1f(this.u('uGoo'), cfg.goo * compSize * 0.6 * this.gooAmt)
    }

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
