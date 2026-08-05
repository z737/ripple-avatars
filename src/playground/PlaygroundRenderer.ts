/* ---------------------------------------------------------------------------
   Two engines behind one draw.

   `analytic` is a single fragment pass with no render targets: closed-form radial
   waves and their exact gradients, evaluated per pixel. Cheap, exactly
   reproducible, and the only one that can give analytic normals at the three
   offsets chromatic refraction needs.

   `medium` adds a simulation pass — one physical scalar field on a 256 lattice,
   stepped at a fixed real timestep, holding (displacement, velocity) state. Its
   interference is genuine superposition and it reflects off its own boundary.

   Transient ripples live in a fixed 4-slot ring buffer, and feed whichever engine
   is active: a coordinate displacement in analytic mode, a force in the medium.
   Nothing in the frame loop allocates.
   --------------------------------------------------------------------------- */

import vertSrc from '../engine/ripple.vert.glsl?raw'
import artSrc from './art.frag.glsl?raw'
import mediumSrc from './medium.frag.glsl?raw'
import { AudioFeatures, SILENT } from './audio'
import { TIER_SIZE, Tier, detectTier, prefersReducedMotion } from './gpu'
import { Internals, internals } from './internals'
import {
  IDLE_BREATHE,
  IDLE_MOTION,
  chromaticToOffset,
  densityToFreq,
  grainToAmp,
  INTERACTION_REF_FREQ,
  MEDIUM_BASE_SIZE,
  QUALITY_LATTICE,
  QUALITY_RENDER_SCALE,
  mediumDt,
  viscosityToGamma,
  REFLECT_DAMPING,
  MEDIUM_ABSORB_GAMMA,
  MEDIUM_ABSORB_WIDTH,
  MEDIUM_DOMAIN,
  MEDIUM_TAP_ACC,
  MEDIUM_TAP_REF,
  MEDIUM_DRIVE_SIGMA,
  MEDIUM_GAIN,
  MEDIUM_MIN,
  toMediumUv,
  chromaticToInkGlow,
  chromaticToInkHue,
  chromaticToInkLayers,
  chromaticToInkSplit,
  thicknessToStroke,
  interactionToDisplacement,
  interferenceToMix,
  lightIntensityToAmount,
  lightVector,
  densityToWaveSpeed,
  loudnessToDrive,
  mediumDepthDivisor,
  mediumSourceWeight,
  pitchToOmega0,
  resonanceToSpread,
  MEDIUM_TAP_HZ,
  MEDIUM_TAP_WIDTH,
  resolveSource,
  shadowDepthToAmount,
  stretchToScale,
  thicknessToProfile,
  vibrationToOmega0,
  warpToAmp,
  waveDepthToScale,
} from './mapping'
import { baseTone, hexToOklab, meshAttractors, oklabToRgb } from './palettes'
import {
  DEBUG_INDEX,
  DebugMode,
  PG_SHAPE_INDEX,
  INK_BLEND_INDEX,
  PgConfig,
  SURFACE_METALLIC,
} from './params'

const MAX_SRC = 4
const MAX_MESH = 6
const MAX_INT = 4

/** A ripple is dropped once its amplitude falls below this fraction of its
 *  birth strength. Culling rather than letting it asymptote is what lets the
 *  surface return *exactly* to the seed-defined state. */
const CULL = 0.01

/** Cap on catch-up steps per frame, so returning from a long pause cannot burst
 *  hundreds of them at once. */
const SIM_MAX_STEPS = 8

interface Ripple {
  alive: boolean
  x: number
  y: number
  born: number
  strength: number
  freq: number
  speed: number
  decay: number
  width: number
}

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

export class PlaygroundRenderer {
  readonly canvas: HTMLCanvasElement
  readonly tier: Tier

  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private locs = new Map<string, WebGLUniformLocation | null>()

  // --- oscillator medium ---
  private mediumProg: WebGLProgram | null = null
  private mTex: WebGLTexture[] = []
  private mFbo: WebGLFramebuffer[] = []
  /** Index of the texture holding the current state.
   *
   *  Two buffers is enough now: the state is (displacement, velocity), which is
   *  complete, so a step reads one texture and writes the other. The earlier
   *  leapfrog also needed u(n-1), and reading that from the render target is the
   *  texture feedback loop GL forbids — it needed three. */
  private mCur = 0
  private mediumReady = false
  /** current lattice pitch; changes with quality, which recreates the targets */
  private mSize = MEDIUM_BASE_SIZE
  private quality = 'auto'
  private displaySize = 500
  /** false until the lattice has been driven up from cold */
  private mWarm = false
  private simAccum = 0
  private drivePhase = new Float32Array(MAX_SRC)

  private cfg: PgConfig | null = null
  private derived: Internals | null = null
  private debug: DebugMode = 'composite'
  private renderSize: number

  private raf = 0
  private running = false
  private last = 0
  private clock = 0
  private waveTime = 0
  private reduced = prefersReducedMotion()

  private pointer = { x: 0.5, y: 0.5, active: false, lastMove: performance.now() }
  private emit = { x: 0.5, y: 0.5, at: 0 }

  private ripples: Ripple[] = Array.from({ length: MAX_INT }, () => ({
    alive: false,
    x: 0,
    y: 0,
    born: 0,
    strength: 0,
    freq: 40,
    speed: 0.6,
    decay: 2,
    width: 0.07,
  }))

  private audio: AudioFeatures = SILENT
  private audioSource: { read(dt: number): AudioFeatures } | null = null
  private onsetTarget = 0
  private throttle = 0

  // scratch, reused every frame — the loop must not allocate
  private srcA = new Float32Array(MAX_SRC * 4)
  private srcB = new Float32Array(MAX_SRC * 4)
  private srcC = new Float32Array(MAX_SRC * 4)
  private meshLab = new Float32Array(MAX_MESH * 3)
  private meshPos = new Float32Array(MAX_MESH * 4)
  private int0 = new Float32Array(MAX_INT * 4)
  private int1 = new Float32Array(MAX_INT * 4)
  private driveBuf = new Float32Array(MAX_SRC * 4)
  private mImp = new Float32Array(MAX_INT * 4)
  private rampLab = new Float32Array(4 * 3)

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
    const fs = compile(gl, gl.FRAGMENT_SHADER, artSrc)
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

    this.tier = detectTier(gl)
    this.renderSize = TIER_SIZE[this.tier]
    this.mediumReady = this.initMedium()
    this.last = performance.now()
  }

  /** Lattice targets: two textures ping-ponged. The state is (displacement,
   *  velocity), which is complete, so a step reads one and writes the other. */
  private initMedium(): boolean {
    const gl = this.gl
    // RGBA16F is a core texture format, but rendering to it needs one of these.
    if (
      !gl.getExtension('EXT_color_buffer_float') &&
      !gl.getExtension('EXT_color_buffer_half_float')
    ) {
      return false
    }

    try {
      const vs = compile(gl, gl.VERTEX_SHADER, vertSrc)
      const fs = compile(gl, gl.FRAGMENT_SHADER, mediumSrc)
      const prog = gl.createProgram()!
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) ?? 'medium link failed')
      }
      this.mediumProg = prog
    } catch {
      return false
    }

    return this.allocMedium()
  }

  /** Allocate the two state targets at the current lattice pitch. Separate from
   *  initMedium so a quality change can reallocate without recompiling. */
  private allocMedium(): boolean {
    const gl = this.gl
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, this.mSize, this.mSize, 0,
        gl.RGBA, gl.HALF_FLOAT, null
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return false
      }
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      this.mTex.push(tex)
      this.mFbo.push(fbo)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return true
  }

  /** Whether the medium engine can run in this context. */
  get canUseMedium() {
    return this.mediumReady
  }

  private u(name: string) {
    let loc = this.locs.get('a:' + name)
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.prog, name)
      this.locs.set('a:' + name, loc)
    }
    return loc
  }

  private mu(name: string) {
    let loc = this.locs.get('m:' + name)
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.mediumProg!, name)
      this.locs.set('m:' + name, loc)
    }
    return loc
  }

  // -------------------------------------------------------------------------
  // inputs
  // -------------------------------------------------------------------------
  setConfig(cfg: PgConfig) {
    this.cfg = cfg
    this.derived = internals(cfg)
    this.wake()
  }

  setDebug(mode: DebugMode) {
    this.debug = mode
    this.wake()
  }

  /** Quality controls two things: how finely the medium is resolved, and how far
   *  the art pass supersamples. The medium's *physics* is unchanged — the
   *  timestep scales with the lattice pitch to hold the Courant number, so
   *  frequencies and wavelengths stay identical across settings. */
  setQuality(q: string) {
    if (q === this.quality) return
    this.quality = q
    const want = QUALITY_LATTICE[q] ?? MEDIUM_BASE_SIZE
    if (this.mediumReady && want !== this.mSize) {
      const gl = this.gl
      this.mFbo.forEach((f) => gl.deleteFramebuffer(f))
      this.mTex.forEach((t) => gl.deleteTexture(t))
      this.mFbo = []
      this.mTex = []
      this.mSize = want
      // The lattice starts cold; the taps drive it back up.
      this.mediumReady = this.allocMedium()
      this.mWarm = false
    }
    this.applyRenderSize()
    this.wake()
  }

  /** Displayed size in CSS pixels. The internal resolution follows from it and
   *  the quality multiplier, so a 32px avatar costs 32px of work rather than
   *  rendering at 640 and throwing it away. */
  setDisplaySize(px: number) {
    this.displaySize = Math.max(16, Math.round(px))
    this.applyRenderSize()
  }

  private applyRenderSize() {
    const tier = TIER_SIZE[this.tier] / 500 // auto keeps the old tier behaviour
    const scale = (QUALITY_RENDER_SCALE[this.quality] ?? 1) * (this.quality === 'auto' ? tier : 1)
    this.setRenderSize(Math.min(2048, Math.max(64, Math.round(this.displaySize * scale))))
  }

  setRenderSize(px: number) {
    // Floor of 64, not 160: a 32px avatar should cost 32px of work. It is not
    // zero, though — below about 64 there are too few fragments for the grain to
    // read as texture or for the ridge edges to antialias at all.
    this.renderSize = Math.max(64, Math.round(px))
    this.wake()
  }

  setAudioSource(source: { read(dt: number): AudioFeatures } | null) {
    this.audioSource = source
    if (!source) this.audio = SILENT
    this.wake()
  }

  /** Pointer position in canvas UV space, y down.
   *
   *  Emission is throttled on distance, speed and elapsed time together, so a
   *  drag lays down a handful of overlapping disturbances rather than one per
   *  mouse event. Slow movement gets broad low-frequency deformation, fast
   *  movement gets tight strong impulses. */
  setPointer(x: number, y: number, active: boolean) {
    const now = performance.now()
    // Clamped: the first event of a session, or one arriving after the tab was
    // throttled, would otherwise divide by a gap of seconds and report a
    // stationary pointer.
    const dtMs = Math.min(Math.max(now - this.pointer.lastMove, 8), 250)
    const speed = Math.hypot(x - this.pointer.x, y - this.pointer.y) / (dtMs / 1000)

    this.pointer.x = x
    this.pointer.y = y
    this.pointer.active = active
    this.pointer.lastMove = now

    if (!active) return

    const moved = Math.hypot(x - this.emit.x, y - this.emit.y)
    const since = (now - this.emit.at) / 1000
    const fast = Math.min(speed / 2.2, 1)

    // Far enough, or long enough while still moving.
    if (moved > 0.055 + 0.05 * (1 - fast) || (since > 0.12 && moved > 0.012)) {
      // Floor, not a ramp from nothing: a slow drag should be a gentle broad
      // deformation, and gentle still has to be visible.
      this.spawn(x, y, 0.5 + 0.5 * fast, fast)
      this.emit.x = x
      this.emit.y = y
      this.emit.at = now
    }
    this.wake()
  }

  clearPointer() {
    this.pointer.active = false
  }

  /** A tap or click: one strong radial impulse. */
  tap(x: number, y: number) {
    this.spawn(x, y, 1, 0.75)
    this.emit.x = x
    this.emit.y = y
    this.emit.at = performance.now()
    this.wake()
  }

  /** `broad` widens and slows the ripple — used for bass, which should displace
   *  the surface rather than add another fine ring. */
  private spawn(x: number, y: number, strength: number, fast: number, broad = 0) {
    const slot = this.freeSlot()
    const r = this.ripples[slot]
    r.alive = true
    r.x = x
    r.y = y
    r.born = this.clock
    r.strength = strength
    // internal, never exposed: fast flicks ring tighter and higher
    r.freq = (26 + 44 * fast) * (1 - 0.55 * broad)
    r.speed = 0.42 + 0.3 * fast + 0.25 * broad
    // Slow enough to still be reading a second or two later. At the old rate a
    // ripple was gone before the eye had finished following it.
    r.decay = 1.3 - 0.5 * fast - 0.35 * broad
    r.width = (0.075 + 0.05 * (1 - fast)) * (1 + 1.6 * broad)
  }

  /** Prefer a dead slot; otherwise recycle the oldest live one. */
  private freeSlot(): number {
    let oldest = 0
    let oldestBorn = Infinity
    for (let i = 0; i < MAX_INT; i++) {
      if (!this.ripples[i].alive) return i
      if (this.ripples[i].born < oldestBorn) {
        oldestBorn = this.ripples[i].born
        oldest = i
      }
    }
    return oldest
  }

  private get liveRipples() {
    let n = 0
    for (let i = 0; i < MAX_INT; i++) if (this.ripples[i].alive) n++
    return n
  }

  // -------------------------------------------------------------------------
  // loop
  // -------------------------------------------------------------------------
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
    const gl = this.gl
    gl.deleteProgram(this.prog)
    if (this.mediumProg) gl.deleteProgram(this.mediumProg)
    this.mFbo.forEach((f) => gl.deleteFramebuffer(f))
    this.mTex.forEach((t) => gl.deleteTexture(t))
  }

  private get motion() {
    return this.reduced ? 0 : IDLE_MOTION
  }

  private get mediumActive() {
    return this.cfg?.engine === 'medium' && this.mediumReady
  }

  /** One lattice step, mediumDt(size) seconds of real time.
   *
   *  Under reduced motion the drive phases hold still, so the medium rings down
   *  to its static solution and the frame settles rather than pulsing. */
  private stepMedium() {
    const gl = this.gl
    const cfg = this.cfg!
    const d = this.derived!

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mFbo[1 - this.mCur])
    gl.viewport(0, 0, this.mSize, this.mSize)
    gl.useProgram(this.mediumProg!)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.mTex[this.mCur])
    gl.uniform1i(this.mu('uState'), 0)

    gl.uniform2f(this.mu('uTexel'), 1 / this.mSize, 1 / this.mSize)
    const dt = mediumDt(this.mSize)
    gl.uniform1f(this.mu('uDt'), dt)
    // c^2/h^2, so the shader's raw five-point stencil is already the Laplacian
    const c = densityToWaveSpeed(cfg.density)
    const h = MEDIUM_DOMAIN / this.mSize
    gl.uniform1f(this.mu('uC2H2'), (c * c) / (h * h))
    // A reflective boundary needs a low-loss medium or nothing survives the round
    // trip and the toggle appears to do nothing.
    const gamma = viscosityToGamma(cfg.viscosity) * (cfg.reflect ? REFLECT_DAMPING : 1)
    gl.uniform1f(this.mu('uGamma'), gamma)
    const tapAcc = MEDIUM_TAP_ACC
    // Reflection just switches the absorbing layer off — a free boundary is what
    // the lattice does naturally; the sponge is what suppresses it.
    gl.uniform2f(
      this.mu('uAbsorb'),
      MEDIUM_ABSORB_WIDTH,
      cfg.reflect ? 0 : MEDIUM_ABSORB_GAMMA
    )

    // Voice pitch retunes the medium itself, so the points ring at the speaker's
    // pitch rather than being pushed at it. Resonance closes the spread.
    const voiced = this.audio.pitch > 0 && this.audio.clarity > 0.2
    const w0 = voiced ? pitchToOmega0(this.audio.pitch) : vibrationToOmega0(cfg.vibration)
    gl.uniform4f(
      this.mu('uOmega0'),
      w0,
      cfg.pointFrequency ? w0 * resonanceToSpread(cfg.resonance) : 0,
      0,
      d.freqScale
    )
    gl.uniform2f(this.mu('uFreqPhase'), d.freqPhase[0], d.freqPhase[1])

    // --- taps ---------------------------------------------------------------
    // The origins strike the surface at a slow rate; loudness sets how hard.
    // Silence means no forcing at all, so the field rings down and goes still.
    const voiceAmp = voiced ? loudnessToDrive(this.audio.volume) : 0
    const tapOmega = Math.PI * 2 * MEDIUM_TAP_HZ

    const n = Math.min(cfg.waves, cfg.sources.length, MAX_SRC)
    const still = this.motion === 0
    for (let i = 0; i < n; i++) {
      const s = cfg.sources[i]
      const r = resolveSource(s, cfg.resonance)

      // Origins keep their own ratio, so they tap slightly out of step and their
      // ripples arrive at different times rather than as one synchronised front.
      if (!still) {
        this.drivePhase[i] = (this.drivePhase[i] + tapOmega * r.ratio * dt) % (Math.PI * 2)
      }

      const balance = mediumSourceWeight(cfg.interference, i)
      const amp = voiced ? voiceAmp : this.audioSource ? 0 : 1

      const o = i * 4
      this.driveBuf[o] = toMediumUv(s.x)
      this.driveBuf[o + 1] = toMediumUv(s.y)
      this.driveBuf[o + 2] = this.drivePhase[i] + r.phase
      // normalised by W0^2 so raising Vibration changes the rate, not the depth
      this.driveBuf[o + 3] =
        tapAcc * Math.pow(w0 / MEDIUM_TAP_REF, 2) * s.amp * balance * amp
    }
    gl.uniform1i(this.mu('uSrcCount'), n)
    gl.uniform4fv(this.mu('uDrive'), this.driveBuf)
    gl.uniform1f(this.mu('uTapWidth'), MEDIUM_TAP_WIDTH)
    // radii are in field units; the shader measures in lattice uv
    gl.uniform1f(this.mu('uDriveSigma'), MEDIUM_DRIVE_SIGMA / MEDIUM_DOMAIN)

    // --- transient excitation, injected over a short window so a dropped frame
    // cannot swallow one
    let ni = 0
    for (let i = 0; i < MAX_INT; i++) {
      const rip = this.ripples[i]
      if (!rip.alive || ni >= MAX_INT) continue
      const age = this.clock - rip.born
      if (age > 0.09) continue
      const o = ni * 4
      this.mImp[o] = toMediumUv(rip.x)
      this.mImp[o + 1] = toMediumUv(rip.y)
      this.mImp[o + 2] = rip.width / MEDIUM_DOMAIN
      this.mImp[o + 3] =
        rip.strength *
        Math.exp(-age / 0.03) *
        cfg.interaction *
        tapAcc *
        Math.pow(w0 / MEDIUM_TAP_REF, 2) *
        0.35
      ni++
    }
    gl.uniform1i(this.mu('uImpCount'), ni)
    gl.uniform4fv(this.mu('uImp'), this.mImp)

    gl.drawArrays(gl.TRIANGLES, 0, 3)

    this.mCur = 1 - this.mCur
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private frame() {
    const now = performance.now()
    const dt = Math.min((now - this.last) / 1000, 0.05)
    this.last = now
    this.clock += dt

    if (this.audioSource) {
      this.audio = this.audioSource.read(dt)
      // A transient excites the surface at one of its own wave origins, rather
      // than drawing something new on top of it.
      if (this.audio.onset && this.cfg) {
        const src = this.cfg.sources[this.onsetTarget % Math.max(this.cfg.waves, 1)]
        this.onsetTarget++
        if (src) {
          this.spawn(src.x, src.y, 0.35 + 0.6 * this.audio.volume, 0.5, this.audio.bass)
        }
      }
    }

    // Retire ripples that have decayed past visibility. Culling — rather than
    // letting them asymptote — is what makes the return to base exact.
    for (let i = 0; i < MAX_INT; i++) {
      const r = this.ripples[i]
      if (r.alive && Math.exp(-(this.clock - r.born) * r.decay) < CULL) r.alive = false
    }

    const live = this.liveRipples
    const quiet = this.audio.volume < 0.01

    // A still avatar with nothing happening does not need 60fps.
    if (live === 0 && quiet && !this.pointer.active && now - this.pointer.lastMove > 4000) {
      this.throttle += dt
      if (this.throttle < 1 / 30) return
    }
    this.throttle = 0

    this.waveTime += dt * (this.motion + this.audio.mid * 1.6)

    if (this.mediumActive) {
      // Coming up from cold takes hundreds of steps — the time for a wave to
      // cross the lattice. Run those in one go rather than making the user watch
      // the field fade in over several seconds.
      if (!this.mWarm) {
        for (let i = 0; i < 700; i++) this.stepMedium()
        this.mWarm = true
      }
      const sdt = mediumDt(this.mSize)
      this.simAccum = Math.min(this.simAccum + dt, 0.05)
      let steps = Math.min(Math.floor(this.simAccum / sdt), SIM_MAX_STEPS)
      this.simAccum -= steps * sdt
      while (steps-- > 0) this.stepMedium()
    }

    this.draw()

    // Nothing is animating and nothing is left to settle: park the loop. With
    // idle drift on, the scene is never idle, so this only fires under
    // prefers-reduced-motion.
    if (this.motion === 0 && quiet && live === 0 && !this.pointer.active) this.stop()
  }

  // -------------------------------------------------------------------------
  // draw
  // -------------------------------------------------------------------------
  /** One frame at the current render size. `sizeOverride` is for the exporter,
   *  which resizes the canvas, draws, reads back, then restores. */
  draw(sizeOverride?: number) {
    const cfg = this.cfg
    const d = this.derived
    if (!cfg || !d) return

    const gl = this.gl
    const size = sizeOverride ?? this.renderSize
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size
      this.canvas.height = size
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, size, size)
    gl.useProgram(this.prog)
    const u = (n: string) => this.u(n)

    gl.uniform2f(u('uResolution'), size, size)
    gl.uniform1f(u('uWaveTime'), this.waveTime)

    // --- sources ------------------------------------------------------------
    const freq = densityToFreq(cfg.density)
    const [gx, gy] = stretchToScale(cfg.stretch)
    const n = Math.min(cfg.waves, cfg.sources.length, MAX_SRC)

    for (let i = 0; i < n; i++) {
      const s = cfg.sources[i]
      const r = resolveSource(s, cfg.resonance)
      const o = i * 4
      this.srcA[o] = s.x
      this.srcA[o + 1] = s.y
      this.srcA[o + 2] = freq * r.ratio
      this.srcA[o + 3] = r.phase
      this.srcB[o] = s.rot
      this.srcB[o + 1] = s.power
      this.srcB[o + 2] = r.drift
      this.srcB[o + 3] = s.amp
      this.srcC[o] = 1 / Math.max(s.sx * gx, 1e-3)
      this.srcC[o + 1] = 1 / Math.max(s.sy * gy, 1e-3)
      this.srcC[o + 2] = s.wander
      this.srcC[o + 3] = 0
    }
    gl.uniform1i(u('uSrcCount'), n)
    gl.uniform4fv(u('uSrcA'), this.srcA)
    gl.uniform4fv(u('uSrcB'), this.srcB)
    gl.uniform4fv(u('uSrcC'), this.srcC)

    // Slow breathing of ring spacing — the moiré reference's trick, and the
    // cheapest way to keep a static composition from looking frozen.
    gl.uniform1f(
      u('uBreathe'),
      1 + IDLE_BREATHE * Math.sin(this.waveTime * 0.3) + IDLE_BREATHE * 0.5 * Math.sin(this.waveTime * 0.17 + 1)
    )

    // --- engine -------------------------------------------------------------
    const useMedium = this.mediumActive
    const engineIndex =
      cfg.engine === 'heatmap' ? 3 : cfg.engine === 'ink' ? 2 : useMedium ? 1 : 0
    gl.uniform1i(u('uEngine'), engineIndex)

    // --- heatmap ramp -------------------------------------------------------
    // Sorted by lightness so the scale reads as a monotone heat scale rather than
    // as arbitrary bands. Sorting here rather than reordering the mesh upload
    // keeps each colour on its own attractor in the material views.
    const ramp = cfg.colors
      .slice(0, 4)
      .map((c) => hexToOklab(c))
      .sort((a, b) => a[0] - b[0])
    for (let i = 0; i < ramp.length; i++) {
      this.rampLab[i * 3] = ramp[i][0]
      this.rampLab[i * 3 + 1] = ramp[i][1]
      this.rampLab[i * 3 + 2] = ramp[i][2]
    }
    gl.uniform1i(u('uRampCount'), ramp.length)
    gl.uniform3fv(u('uRampLab'), this.rampLab)

    // --- ink engine ---------------------------------------------------------
    // Split is a fraction of one fringe spacing, so it never exceeds a whole
    // cell and flood the paper at high density.
    gl.uniform1f(u('uStroke'), thicknessToStroke(cfg.thickness))
    gl.uniform1i(u('uInkLayers'), chromaticToInkLayers(cfg.chromatic))
    gl.uniform1f(
      u('uInkSplit'),
      (chromaticToInkSplit(cfg.chromatic) * Math.PI * 2) / freq
    )
    gl.uniform1f(u('uInkHue'), chromaticToInkHue(cfg.chromatic))
    gl.uniform1f(u('uInkGlow'), chromaticToInkGlow(cfg.chromatic))
    gl.uniform1f(u('uInkRot'), d.inkRot)
    gl.uniform1i(u('uInkBlend'), INK_BLEND_INDEX[cfg.inkBlend])
    if (useMedium) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.mTex[this.mCur])
      gl.uniform1i(u('uMediumTex'), 0)
      gl.uniform2f(u('uMediumTexel'), MEDIUM_DOMAIN / this.mSize, MEDIUM_DOMAIN / this.mSize)
      gl.uniform2f(u('uMediumMap'), 1 / MEDIUM_DOMAIN, -MEDIUM_MIN / MEDIUM_DOMAIN)
      gl.uniform1f(u('uMediumGain'), MEDIUM_GAIN)
      gl.uniform2f(u('uMediumStretch'), 1 / gx, 1 / gy)
    }

    gl.uniform1f(u('uMix'), interferenceToMix(cfg.interference))
    gl.uniform1f(u('uFringe'), cfg.fringe)
    gl.uniform1f(u('uProfile'), thicknessToProfile(cfg.thickness))
    // Normalising by the field's spatial frequency keeps slope — and therefore
    // the lighting — stable as Density changes. The medium's wavelength comes
    // from the dispersion relation rather than from the source frequency.
    gl.uniform1f(
      u('uDepth'),
      waveDepthToScale(cfg.waveDepth) /
        (useMedium ? mediumDepthDivisor() : freq)
    )
    gl.uniform1f(u('uWarp'), warpToAmp(cfg.warp))
    gl.uniform4f(u('uWarpFreq'), d.warpFreq[0], d.warpFreq[1], d.warpFreq[2], d.warpFreq[3])
    gl.uniform4f(u('uWarpPhase'), d.warpPhase[0], d.warpPhase[1], d.warpPhase[2], d.warpPhase[3])

    // --- transient ripples --------------------------------------------------
    // These displace the wave field's coordinates rather than adding height, so
    // the amplitude packed here is a distance in UV. The whole scale is folded
    // in on this side, which keeps the displacement and the Jacobian the shader
    // derives from it scaled by exactly the same factor.
    const disp = interactionToDisplacement(cfg.interaction) * (1 + this.audio.volume * 0.5)
    let ni = 0
    for (let i = 0; i < MAX_INT; i++) {
      const r = this.ripples[i]
      if (!r.alive) continue
      const o = ni * 4
      this.int0[o] = r.x
      this.int0[o + 1] = r.y
      this.int0[o + 2] = this.clock - r.born
      this.int0[o + 3] = r.strength * disp * (INTERACTION_REF_FREQ / r.freq)
      this.int1[o] = r.freq
      this.int1[o + 1] = r.speed
      this.int1[o + 2] = r.decay
      this.int1[o + 3] = r.width
      ni++
    }
    gl.uniform1i(u('uIntCount'), ni)
    gl.uniform4fv(u('uInt0'), this.int0)
    gl.uniform4fv(u('uInt1'), this.int1)
    // Gate only — the magnitude above already carries the slider.
    gl.uniform1f(u('uInteraction'), disp > 0 ? 1 : 0)

    // --- material -----------------------------------------------------------
    // Attractor placement comes from the seed, the colours from the user's
    // selection, and the paper tone is derived from those colours.
    const attractors = meshAttractors(cfg.colors, cfg.seed)
    const meshCount = Math.min(attractors.length, MAX_MESH)
    for (let i = 0; i < meshCount; i++) {
      const a = attractors[i]
      const lab = hexToOklab(a.color)
      this.meshLab[i * 3] = lab[0]
      this.meshLab[i * 3 + 1] = lab[1]
      this.meshLab[i * 3 + 2] = lab[2]
      const o = i * 4
      this.meshPos[o] = a.x
      this.meshPos[o + 1] = a.y
      this.meshPos[o + 2] = a.radius
      this.meshPos[o + 3] = a.falloff
    }
    gl.uniform1i(u('uMeshCount'), meshCount)
    gl.uniform3fv(u('uMeshLab'), this.meshLab)
    gl.uniform4fv(u('uMeshPos'), this.meshPos)

    const base = baseTone(cfg.colors, cfg.darkBase, cfg.engine === 'ink')
    gl.uniform3f(u('uNeutralLab'), base.neutral[0], base.neutral[1], base.neutral[2])
    const matte = oklabToRgb(base.matte)
    gl.uniform3f(u('uMatte'), matte[0], matte[1], matte[2])
    gl.uniform1f(u('uMesh'), cfg.mesh)
    // Fewer colours need less neutral: with one or two pastels a heavy floor
    // averages the whole frame to one tone and no gradient survives.
    gl.uniform1f(u('uNeutralFloor'), 0.06 + 0.04 * meshCount)

    // --- light --------------------------------------------------------------
    const [lx, ly, lz] = lightVector(cfg.lightAngle)
    gl.uniform3f(u('uLightDir'), lx, ly, lz)
    gl.uniform1f(u('uLightIntensity'), lightIntensityToAmount(cfg.lightIntensity))
    gl.uniform1f(u('uShadowDepth'), shadowDepthToAmount(cfg.shadowDepth))
    gl.uniform1f(u('uAmbient'), d.ambient)
    gl.uniform1f(u('uMetallic'), SURFACE_METALLIC[cfg.surface])
    gl.uniform1f(u('uSpecular'), d.specular)

    gl.uniform1f(u('uChromatic'), chromaticToOffset(cfg.chromatic))
    gl.uniform1f(u('uExposure'), d.exposure)
    gl.uniform1f(u('uContrast'), d.contrast)

    const a = this.audio
    gl.uniform4f(u('uAudio'), a.volume, a.bass, a.mid, a.high)

    // Grain scales with render size, so a 1024px export reads like the 500px
    // preview instead of turning into fine dust.
    gl.uniform1f(u('uGrain'), grainToAmp(cfg.grain))
    gl.uniform1f(u('uGrainScale'), Math.max(1, size / 640))

    gl.uniform1i(u('uShape'), PG_SHAPE_INDEX[cfg.shape])
    gl.uniform1f(u('uShapeSize'), d.shapeSize)
    gl.uniform1f(u('uShapeSoft'), d.shapeSoft)

    gl.uniform1i(u('uDebug'), DEBUG_INDEX[this.debug])

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
