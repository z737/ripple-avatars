import { useCallback, useEffect, useRef, useState } from 'react'
import { exportPng } from '../engine/export'
import { randomSeed } from '../engine/prng'
import { AudioEngine } from '../playground/audio'
import {
  configFromSeed,
  defaultConfig,
  reroll,
  resetOrigins,
  setPattern,
  setWaves,
} from '../playground/genome'
import { internals } from '../playground/internals'
import { TIER_SIZE } from '../playground/gpu'
import {
  MEDIUM_DOMAIN,
  QUALITY_RENDER_SCALE,
  resonanceToSpread,
  vibrationToOmega0,
} from '../playground/mapping'
import { MAX_COLORS, MIN_COLORS, PASTEL_ROWS } from '../playground/palettes'
import { PlaygroundRenderer } from '../playground/PlaygroundRenderer'
import {
  DEBUG_LABEL,
  DEBUG_MODES,
  DebugMode,
  ENGINES,
  ENGINE_LABEL,
  Engine,
  PATTERNS,
  PATTERN_LABEL,
  PG_RANGES,
  PG_SHAPES,
  PgConfig,
  PgRangeKey,
  PgShape,
  Pattern,
  QUALITIES,
  QUALITY_LABEL,
  LATTICES,
  LATTICE_LABEL,
  LATTICE_SIZE,
  LATTICE_COST,
  Lattice,
  Quality,
  SHAPE_LABEL,
  SURFACES,
  SURFACE_LABEL,
  Surface,
  WAVE_COUNTS,
  WaveCount,
} from '../playground/params'
import { PLATFORM_NAME, VERSIONS, VersionId, versionRoute } from '../versions'
import { PlaygroundCanvas } from '../ui/PlaygroundCanvas'
import {
  AngleDial,
  Button,
  FrequencyMap,
  Icons,
  Section,
  Segmented,
  Select,
  Slider,
  Swatches,
  TextField,
  Toggle,
  VersionPicker,
  XYPad,
} from '../ui/controls'

/** Display size. The internal render resolution is chosen by GPU tier and is
 *  deliberately not tied to devicePixelRatio — see playground/gpu.ts. */
const CANVAS = 500
/** An avatar has to survive being tiny — a favicon-sized preview is the point of
 *  the size slider, not an afterthought. */
const MIN_CANVAS = 32

/** Debug views are developer tooling, not part of the playground. Ask for them
 *  with #/v2?debug */
const wantsDebug = () =>
  typeof window !== 'undefined' &&
  (window.location.hash.includes('debug') || window.location.search.includes('debug'))

export default function PlaygroundPage() {
  const [cfg, setCfg] = useState<PgConfig>(defaultConfig)
  const [edit, setEdit] = useState(false)
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const [audioOn, setAudioOn] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** what the user asked for; the shown size clamps this to what fits, without
   *  overwriting it — otherwise narrowing the window once would lose the setting
   *  permanently */
  const [desiredSize, setDesiredSize] = useState(CANVAS)
  const [debug, setDebug] = useState<DebugMode>('composite')
  const [showDebug] = useState(wantsDebug)
  const [mediumAvailable, setMediumAvailable] = useState(true)
  const [quality, setQuality] = useState<Quality>('auto')
  const [lattice, setLattice] = useState<Lattice>('normal')
  /** measured frame time, so the lattice choice can be made against a number */
  const [frameMs, setFrameMs] = useState(0)
  /** largest square the viewport allows; the size slider is capped by it */
  const [fitMax, setFitMax] = useState(CANVAS)

  const rendererRef = useRef<PlaygroundRenderer | null>(null)
  const audioRef = useRef<AudioEngine | null>(null)
  const rerollCount = useRef(0)

  // the medium's frequency map is seeded, so the panel reads it from the same
  // derived values the renderer uploads
  const derived = internals(cfg)

  const size = Math.min(desiredSize, fitMax)

  // mirrors the renderer's own sizing, purely so the panel can state it
  const renderedPx = Math.min(
    2048,
    Math.max(
      64,
      Math.round(
        size *
          (QUALITY_RENDER_SCALE[quality] ?? 1) *
          (quality === 'auto' ? TIER_SIZE[rendererRef.current?.tier ?? 'normal'] / 500 : 1)
      )
    )
  )

  // Square, and never wider than the viewport allows.
  useEffect(() => {
    const fit = () => {
      // A hidden or not-yet-laid-out viewport reports 0. Refitting on that would
      // collapse the canvas to the minimum, so leave the last good value alone.
      if (window.innerWidth < 1 || window.innerHeight < 1) return
      setFitMax(
        Math.max(
          MIN_CANVAS,
          Math.min(CANVAS, window.innerWidth - 400, window.innerHeight - 220)
        )
      )
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  // Quality and displayed size decide the internal resolution together.
  useEffect(() => {
    rendererRef.current?.setQuality(quality)
  }, [quality])
  useEffect(() => {
    rendererRef.current?.setLattice(LATTICE_SIZE[lattice])
  }, [lattice])

  // Polled rather than pushed per frame: this is a readout, and re-rendering the
  // whole panel 60 times a second to display it would itself cost more than the
  // difference it is there to measure.
  useEffect(() => {
    const id = setInterval(() => setFrameMs(rendererRef.current?.frameMs ?? 0), 500)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    rendererRef.current?.setDisplaySize(size)
  }, [size])

  useEffect(() => () => audioRef.current?.stop(), [])

  useEffect(() => {
    rendererRef.current?.setDebug(debug)
  }, [debug])

  const set = useCallback(
    <K extends keyof PgConfig>(key: K, value: PgConfig[K]) =>
      setCfg((c) => ({ ...c, [key]: value })),
    []
  )

  const reseed = useCallback((seed: string) => setCfg(configFromSeed(seed)), [])

  const slider = (key: PgRangeKey & keyof PgConfig) => (
    <Slider
      key={key}
      label={PG_RANGES[key].label}
      value={cfg[key] as number}
      min={0}
      max={1}
      step={0.01}
      onChange={(v) => set(key, v as PgConfig[typeof key])}
    />
  )

  const copySeed = async () => {
    try {
      await navigator.clipboard.writeText(cfg.seed)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  const toggleAudio = async (on: boolean) => {
    setAudioError(null)
    if (!on) {
      audioRef.current?.stop()
      audioRef.current = null
      setAudioOn(false)
      set('audio', false)
      return
    }
    try {
      const engine = new AudioEngine()
      await engine.start()
      audioRef.current = engine
      setAudioOn(true)
      set('audio', true)
    } catch (e) {
      audioRef.current = null
      setAudioOn(false)
      set('audio', false)
      setAudioError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone permission was declined.'
          : e instanceof Error
            ? e.message
            : String(e)
      )
    }
  }

  return (
    <div className="app">
      <header className="header">
        <VersionPicker
          name={PLATFORM_NAME}
          value="v2"
          options={VERSIONS}
          onChange={(id) => {
            window.location.hash = versionRoute(id as VersionId)
          }}
        />
        <div className="header-actions">
          <Button icon={Icons.shuffle} onClick={() => reseed(randomSeed())}>
            Randomize
          </Button>
          <Button
            icon={Icons.download}
            onClick={() =>
              rendererRef.current &&
              exportPng(rendererRef.current, 1024, `ripple-${cfg.seed}.png`)
            }
          >
            Export
          </Button>
        </div>
      </header>

      <div className="body">
        <main className="stage">
          {error ? (
            <div className="error">
              <div className="t-sm-semibold" style={{ marginBottom: 8 }}>
                Could not start the renderer
              </div>
              {error}
            </div>
          ) : (
            <>
              <PlaygroundCanvas
                cfg={cfg}
                size={size}
                edit={edit}
                selected={selected}
                onSelect={setSelected}
                onMove={(i, x, y) =>
                  setCfg((c) => ({
                    ...c,
                    sources: c.sources.map((s, j) => (j === i ? { ...s, x, y } : s)),
                  }))
                }
                onReady={(r) => {
                  rendererRef.current = r
                  r.setDebug(debug)
                  r.setQuality(quality)
                  r.setDisplaySize(size)
                  setMediumAvailable(r.canUseMedium)
                  if (!r.canUseMedium) set('engine', 'analytic')
                }}
                onError={setError}
                audio={audioOn ? audioRef.current : null}
              />
              <div className="stage-caption">
                <span className="seed-chip">{cfg.seed}</span>
                <span className="t-xs-regular">
                  {PATTERN_LABEL[cfg.pattern]} · {cfg.waves} waves ·{' '}
                  {cfg.shape === 'full' ? 'full frame' : SHAPE_LABEL[cfg.shape]}
                  {debug !== 'composite' && ` · debug: ${DEBUG_LABEL[debug]}`}
                </span>
              </div>
            </>
          )}
        </main>

        <aside className="panel">
          <Section
            icon={Icons.identity}
            title="Seed"
            supporting="The identity. Same seed and settings, same avatar."
          >
            <TextField label="Seed" value={cfg.seed} onChange={reseed} />
            <div className="btn-row">
              <Button icon={Icons.shuffle} onClick={() => reseed(randomSeed())}>
                Randomize
              </Button>
              <Button icon={Icons.copy} onClick={copySeed}>
                {copied ? 'Copied' : 'Copy seed'}
              </Button>
            </div>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.origins}
            title="Waves"
            supporting="Origins may sit outside the frame — that is where the long arcs come from."
          >
            <Segmented
              value={String(cfg.waves)}
              options={WAVE_COUNTS.map(String)}
              onChange={(v) => setCfg((c) => setWaves(c, Number(v) as WaveCount))}
            />
            <Toggle label="Edit origins" checked={edit} onChange={setEdit} />
            <div className="btn-row">
              <Button
                icon={Icons.shuffle}
                onClick={() => setCfg((c) => reroll(c, String(++rerollCount.current)))}
              >
                Origins
              </Button>
              <Button icon={Icons.reset} onClick={() => setCfg(resetOrigins)}>
                Reset
              </Button>
            </div>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.structure}
            title="Geometry"
            supporting="The waves build a surface. Interference sets additive against multiplicative height."
          >
            <Segmented
              value={cfg.engine}
              options={ENGINES}
              labels={ENGINE_LABEL}
              onChange={(e: Engine) => set('engine', e)}
            />
            {cfg.engine === 'medium' && (
              <>
                {slider('vibration')}
                <Toggle
                  label="Point frequency"
                  checked={cfg.pointFrequency}
                  onChange={(v) => set('pointFrequency', v)}
                />
                {cfg.pointFrequency && <FrequencyMap
                  label="Point frequency"
                  centre={vibrationToOmega0(cfg.vibration)}
                  spread={
                    vibrationToOmega0(cfg.vibration) * resonanceToSpread(cfg.resonance)
                  }
                  mapScale={derived.freqScale}
                  phase={derived.freqPhase}
                />}
                <p className="t-xs-regular note">
                  The origins tap the surface rather than holding it, so between taps each
                  region rings at its own rate. Vibration sets that rate, and more waves come
                  with it.{' '}
                  {cfg.pointFrequency
                    ? 'Resonance below closes the spread until every point agrees, which turns beating, irregular structure into one clean coherent pattern.'
                    : 'With point frequency off the medium is uniform — one frequency everywhere, and a plainer, more regular surface.'}
                </p>
              </>
            )}
            {!mediumAvailable && (
              <p className="t-xs-regular note note-warn">
                The medium engine needs float render targets, which this browser does not
                expose. Analytic only.
              </p>
            )}
            <Select
              label="Pattern"
              value={cfg.pattern}
              options={PATTERNS.map((p) => ({ value: p, label: PATTERN_LABEL[p] }))}
              onChange={(p) => setCfg((c) => setPattern(c, p as Pattern))}
            />
            {slider('density')}
            {slider('thickness')}
            {slider('interference')}
            {slider('resonance')}
            {slider('fringe')}
            {slider('waveDepth')}
            {slider('warp')}
            <XYPad label="Stretch" value={cfg.stretch} onChange={(v) => set('stretch', v)} />
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.light}
            title="Light"
            supporting="Moving the light moves the highlights and shadows. The geometry does not change."
          >
            <AngleDial
              label="Light angle"
              value={cfg.lightAngle}
              onChange={(a) => set('lightAngle', a)}
            />
            {slider('lightIntensity')}
            {slider('shadowDepth')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.color}
            title="Pigment"
            supporting="One continuous mesh gradient. Chromatic refracts it at steep slopes only."
          >
            <Swatches
              label="Pigment"
              rows={PASTEL_ROWS}
              selected={cfg.colors}
              min={MIN_COLORS}
              max={MAX_COLORS}
              onChange={(colors) => set('colors', colors)}
            />
            <Toggle
              label="Ink base"
              checked={cfg.darkBase}
              onChange={(v) => set('darkBase', v)}
            />
            {slider('mesh')}
            {slider('chromatic')}
            {slider('grain')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.color}
            title="Oil film"
            supporting="A thin iridescent film over the surface. Hue comes from height, not pigment."
          >
            <Toggle
              label="Oil film"
              checked={cfg.oilFilm}
              onChange={(v) => set('oilFilm', v)}
            />
            {cfg.oilFilm && slider('iridescence')}
            <p className="t-xs-regular note">
              Thin-film interference: the colour of a soap bubble or a slick on wet
              tarmac, where hue is set by how thick the film is. Here that thickness is
              the wave height, so the bands follow the surface instead of the palette.
              Weighted toward grazing angles, so it rides on the surface as a reflection
              would rather than staining the material underneath.
            </p>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.motion}
            title="Optics"
            supporting="Two more ways a surface can behave toward light. Independent of the physics."
          >
            {slider('translucency')}
            {slider('anisotropy')}
            <AngleDial
              label="Sheen direction"
              value={cfg.anisotropyAngle}
              onChange={(v) => set('anisotropyAngle', v)}
            />
            <p className="t-xs-regular note">
              Translucency wraps the light around the terminator and lets thin, steep
              parts glow from behind, which is the difference between wax and plastic.
              Anisotropic sheen stretches the highlight along one axis, so it streaks like
              brushed metal or satin rather than pooling in a dot.
            </p>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Shape"
            supporting="An SDF silhouette, independent of the ripple geometry."
          >
            <Segmented
              value={cfg.shape}
              options={PG_SHAPES}
              labels={SHAPE_LABEL}
              onChange={(s: PgShape) => set('shape', s)}
            />
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.water}
            title="Interaction"
            supporting="Drag across the canvas. Up to four ripples live at once and interfere."
          >
            {slider('interaction')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.surface}
            title="Behaviour"
            supporting="How the surface carries a wave, and how it takes the light."
          >
            <Segmented
              value={cfg.surface}
              options={SURFACES}
              labels={SURFACE_LABEL}
              onChange={(v: Surface) => set('surface', v)}
            />
            {slider('viscosity')}
            <Toggle
              label="Edge reflection"
              checked={cfg.reflect}
              onChange={(v) => set('reflect', v)}
            />
            <p className="t-xs-regular note">
              {cfg.engine === 'medium'
                ? 'Viscosity is how fast the medium dissipates — slippery water through to syrup. Reflection lets waves bounce off the boundary and build standing structure instead of being absorbed.'
                : 'Viscosity and reflection are properties of the medium; switch the engine to Medium for them to take effect.'}
            </p>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Output"
            supporting="Rendering quality and the size the avatar is shown at."
          >
            <Segmented
              value={quality}
              options={QUALITIES}
              labels={QUALITY_LABEL}
              onChange={(q: Quality) => setQuality(q)}
            />
            <Slider
              label="Canvas size"
              value={desiredSize}
              min={MIN_CANVAS}
              max={CANVAS}
              step={1}
              onChange={(v) => setDesiredSize(Math.round(v))}
            />
            <p className="t-xs-regular note">
              {size} x {size} px shown, rendered at {renderedPx} x {renderedPx}. High and
              Ultra supersample, which is what removes the stair-stepping on steep ridges.
            </p>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Lattice"
            supporting="How finely the medium's physics is resolved. The steepest cost in the app."
          >
            <Segmented
              value={lattice}
              options={LATTICES}
              labels={LATTICE_LABEL}
              onChange={(l: Lattice) => setLattice(l)}
            />
            <p className="t-xs-regular note">
              {cfg.engine === 'medium' ? (
                <>
                  {LATTICE_SIZE[lattice]} x {LATTICE_SIZE[lattice]} oscillators, so the
                  visible frame is {Math.round(LATTICE_SIZE[lattice] / MEDIUM_DOMAIN)} across.{' '}
                  {lattice === 'normal'
                    ? 'The calibration point.'
                    : `About ${LATTICE_COST[lattice]}x the work of 384 — cost goes as size cubed, since a finer lattice also needs proportionally more steps per second.`}{' '}
                  Wavelengths do not change; the finest detail the medium can carry does.
                  Switching restarts the field, so it re-warms for a moment.
                  {frameMs > 0 && (
                    <>
                      {' '}
                      Measured now: <strong>{frameMs.toFixed(1)} ms/frame</strong>,{' '}
                      {(1000 / frameMs).toFixed(0)} fps.
                    </>
                  )}
                </>
              ) : (
                'The lattice is the Medium engine’s simulation grid; switch the engine to Medium for this to take effect.'
              )}
            </p>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.audio}
            title="Audio reaction"
            supporting="Onsets emit ripples into the same surface. Bass broadens them, highs widen refraction."
          >
            <Toggle label="Microphone" checked={audioOn} onChange={toggleAudio} />
            <p className="t-xs-regular note">
              The FFT runs in this tab only. Nothing is recorded, stored or uploaded.
            </p>
            {audioError && <p className="t-xs-regular note note-warn">{audioError}</p>}
          </Section>

          {showDebug && (
            <>
              <hr className="panel-divider" />
              <Section
                icon={Icons.structure}
                title="Debug"
                supporting="Developer views of each stage of the pipeline."
              >
                <Select
                  label="View"
                  value={debug}
                  options={DEBUG_MODES.map((m) => ({ value: m, label: DEBUG_LABEL[m] }))}
                  onChange={(m) => setDebug(m as DebugMode)}
                />
              </Section>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
