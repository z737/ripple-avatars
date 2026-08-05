/* ---------------------------------------------------------------------------
   Microphone excitation.

   Privacy: this reads live FFT magnitudes from an AnalyserNode and nothing
   else. No MediaRecorder, no buffering of samples, no persistence, no network
   call — the audio never leaves the tab, and stop() releases the track so the
   browser's recording indicator clears.

   The features drive the existing physical system rather than replacing the
   image with a bar visualiser: volume becomes ripple energy, bass becomes wave
   displacement in the water sim, mids advance the interference clock, highs
   widen chromatic separation, and onsets emit a single impulse.
   --------------------------------------------------------------------------- */

export interface AudioFeatures {
  volume: number
  bass: number
  mid: number
  high: number
  /** true on the frame a transient is detected */
  onset: boolean
  /** detected fundamental in Hz, 0 when there is no pitched sound */
  pitch: number
  /** 0..1 confidence in that pitch */
  clarity: number
}

export const SILENT: AudioFeatures = {
  volume: 0,
  bass: 0,
  mid: 0,
  high: 0,
  onset: false,
  pitch: 0,
  clarity: 0,
}

/** Pitch range to search, in Hz. Comfortably covers a speaking voice from a low
 *  male fundamental to a high female one, without straying into the harmonics
 *  that would produce octave errors. */
const PITCH_MIN = 70
const PITCH_MAX = 500
/** Below this the autocorrelation peak is noise, not a fundamental. */
const CLARITY_FLOOR = 0.25

const band = (bins: Uint8Array, from: number, to: number) => {
  let s = 0
  const hi = Math.min(to, bins.length - 1)
  for (let i = from; i <= hi; i++) s += bins[i]
  return s / Math.max(hi - from + 1, 1) / 255
}

/** Envelope follower: fast attack, slow release, so speech reads as a swell
 *  instead of a flicker. */
function follow(prev: number, target: number, dt: number) {
  const k = target > prev ? 1 - Math.exp(-dt / 0.045) : 1 - Math.exp(-dt / 0.28)
  return prev + (target - prev) * k
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  // explicit buffer type: getByteFrequencyData will not accept a view that
  // might be backed by a SharedArrayBuffer
  private bins: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))
  /** time-domain window, for pitch — the frequency bins are far too coarse to
   *  resolve a fundamental (at 1024 fftSize a bin is ~47Hz wide, which is most
   *  of an octave down at the bottom of the vocal range) */
  private wave: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0))

  private env = { volume: 0, bass: 0, mid: 0, high: 0 }
  private fluxAvg = 0
  private prevEnergy = 0
  private cooldown = 0
  private pitchHz = 0
  private pitchClarity = 0

  get active() {
    return this.analyser !== null
  }

  async start(): Promise<void> {
    if (this.analyser) return
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser has no microphone API.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    })
    const ctx = new AudioContext()
    await ctx.resume()

    const analyser = ctx.createAnalyser()
    // 2048 samples is ~43ms at 48kHz — three periods of a 70Hz fundamental,
    // which is the minimum autocorrelation needs to lock on to it.
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.6
    ctx.createMediaStreamSource(stream).connect(analyser)

    this.stream = stream
    this.ctx = ctx
    this.analyser = analyser
    this.bins = new Uint8Array(analyser.frequencyBinCount)
    this.wave = new Float32Array(analyser.fftSize)
  }

  /** Fundamental frequency by autocorrelation.
   *
   *  Normalised against the zero-lag energy so the peak height doubles as a
   *  confidence measure, which is what lets unvoiced sounds — breath, sibilants,
   *  room noise — be rejected rather than reported as a random pitch. The peak is
   *  refined by parabolic interpolation, because at these lags one sample of
   *  quantisation is several Hz. */
  private detectPitch(sampleRate: number): { hz: number; clarity: number } {
    const buf = this.wave
    const n = buf.length

    let energy = 0
    for (let i = 0; i < n; i++) energy += buf[i] * buf[i]
    if (energy < 1e-4) return { hz: 0, clarity: 0 }

    const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX))
    const maxLag = Math.min(n - 1, Math.ceil(sampleRate / PITCH_MIN))

    let bestLag = -1
    let bestVal = 0
    let prev = 0
    let rising = false

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = 0; i < n - lag; i++) sum += buf[i] * buf[i + lag]
      const norm = sum / (n - lag) / (energy / n)

      // Take the first *local* maximum above the floor rather than the global
      // one: the global peak often sits an octave down, at twice the true lag.
      if (norm > prev) rising = true
      else if (rising && prev > CLARITY_FLOOR) {
        bestLag = lag - 1
        bestVal = prev
        break
      } else rising = false

      if (norm > bestVal) {
        bestVal = norm
        bestLag = lag
      }
      prev = norm
    }

    if (bestLag < minLag + 1 || bestLag > maxLag - 1 || bestVal < CLARITY_FLOOR) {
      return { hz: 0, clarity: 0 }
    }

    // parabolic refinement around the peak
    const at = (lag: number) => {
      let s = 0
      for (let i = 0; i < n - lag; i++) s += buf[i] * buf[i + lag]
      return s / (n - lag)
    }
    const y0 = at(bestLag - 1)
    const y1 = at(bestLag)
    const y2 = at(bestLag + 1)
    const denom = 2 * (2 * y1 - y0 - y2)
    const shift = denom !== 0 ? (y2 - y0) / denom : 0

    const hz = sampleRate / (bestLag + Math.max(-1, Math.min(1, shift)))
    if (hz < PITCH_MIN || hz > PITCH_MAX) return { hz: 0, clarity: 0 }
    return { hz, clarity: Math.min(1, bestVal) }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.env = { volume: 0, bass: 0, mid: 0, high: 0 }
    this.prevEnergy = 0
    this.fluxAvg = 0
    this.pitchHz = 0
    this.pitchClarity = 0
  }

  read(dt: number): AudioFeatures {
    const a = this.analyser
    if (!a || !this.ctx) return SILENT

    a.getByteFrequencyData(this.bins)
    const nyquist = this.ctx.sampleRate / 2
    const binOf = (hz: number) => Math.round((hz / nyquist) * this.bins.length)

    const bass = band(this.bins, binOf(20), binOf(250))
    const mid = band(this.bins, binOf(250), binOf(2000))
    const high = band(this.bins, binOf(2000), binOf(8000))
    const volume = Math.min(1, (bass * 0.5 + mid + high * 0.7) / 1.6)

    this.env.volume = follow(this.env.volume, volume, dt)
    this.env.bass = follow(this.env.bass, bass, dt)
    this.env.mid = follow(this.env.mid, mid, dt)
    this.env.high = follow(this.env.high, high, dt)

    // Spectral flux against a rolling average — a fixed threshold either misses
    // quiet speech or fires continuously on loud speech.
    const energy = bass + mid
    const flux = Math.max(0, energy - this.prevEnergy)
    this.prevEnergy = energy
    this.fluxAvg += (flux - this.fluxAvg) * Math.min(1, dt / 0.35)

    this.cooldown = Math.max(0, this.cooldown - dt)
    let onset = false
    if (flux > this.fluxAvg * 2.2 + 0.02 && this.cooldown === 0) {
      onset = true
      this.cooldown = 0.12
    }

    // --- pitch ---------------------------------------------------------------
    a.getFloatTimeDomainData(this.wave)
    const p = this.detectPitch(this.ctx.sampleRate)
    if (p.hz > 0) {
      // Glide rather than jump. Pitch estimates rattle by a few Hz frame to
      // frame, and driving a resonant medium with a rattling frequency smears
      // the standing pattern instead of holding it.
      const k = 1 - Math.exp(-dt / 0.07)
      this.pitchHz = this.pitchHz > 0 ? this.pitchHz + (p.hz - this.pitchHz) * k : p.hz
      this.pitchClarity = p.clarity
    } else {
      // Hold the last pitch and let confidence fall away, so a consonant in the
      // middle of a word does not reset the vibration.
      this.pitchClarity *= Math.exp(-dt / 0.18)
    }

    return {
      ...this.env,
      onset,
      pitch: this.pitchClarity > 0.05 ? this.pitchHz : 0,
      clarity: this.pitchClarity,
    }
  }
}
