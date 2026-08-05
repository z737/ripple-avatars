import { useCallback, useMemo, useRef, useState } from 'react'
import { PRESETS, paramsFromSeed } from './engine/genome'
import { exportPng } from './engine/export'
import { PALETTES } from './engine/palettes'
import {
  RANGES,
  RangeKey,
  RippleParams,
  SHAPES,
  STRUCTURES,
  SURFACES,
  Shape,
  Structure,
  Surface,
} from './engine/params'
import { Renderer } from './engine/Renderer'
import { randomSeed } from './engine/prng'
import { ContactSheet } from './ui/ContactSheet'
import { RippleCanvas } from './ui/RippleCanvas'
import { PLATFORM_NAME, VERSIONS, VersionId, versionRoute } from './versions'
import {
  Button,
  Icons,
  Section,
  Segmented,
  Select,
  Slider,
  TextField,
  VersionPicker,
} from './ui/controls'

const VIEWS = ['single', 'grid'] as const
type View = (typeof VIEWS)[number]

export default function App() {
  const [params, setParams] = useState<RippleParams>(() => PRESETS[0].apply())
  const [view, setView] = useState<View>('single')
  const [error, setError] = useState<string | null>(null)
  const rendererRef = useRef<Renderer | null>(null)

  // Structure and palette are seeded, but re-rolling the seed must respect an
  // explicit structure choice, so the seed drives everything else only.
  const reseed = useCallback((seed: string) => {
    setParams((prev) => ({
      ...paramsFromSeed(seed),
      structure: prev.structure,
      shape: prev.shape,
      surface: prev.surface,
      paletteId: prev.paletteId,
      speed: prev.speed,
    }))
  }, [])

  const set = useCallback(
    <K extends keyof RippleParams>(key: K, value: RippleParams[K]) =>
      setParams((p) => ({ ...p, [key]: value })),
    []
  )

  // Changing structure has to rebuild the sources, since a structure family is
  // defined by its source layout, not by a single number.
  const setStructure = useCallback((structure: Structure) => {
    setParams((p) => ({
      ...paramsFromSeed(p.seed + ':' + structure),
      seed: p.seed,
      structure,
      shape: p.shape,
      surface: p.surface,
      paletteId: p.paletteId,
      speed: p.speed,
    }))
  }, [])

  const slider = (key: RangeKey & keyof RippleParams) => {
    const r = RANGES[key]
    return (
      <Slider
        key={key}
        label={r.label}
        value={params[key] as number}
        min={r.min}
        max={r.max}
        step={r.step}
        onChange={(v) => set(key, v as RippleParams[typeof key])}
      />
    )
  }

  const gridSeeds = useMemo(
    () => Array.from({ length: 36 }, (_, i) => `${params.seed}#${i}`),
    [params.seed]
  )

  return (
    <div className="app">
      <header className="header">
        <VersionPicker
          name={PLATFORM_NAME}
          value="v1"
          options={VERSIONS}
          onChange={(id) => {
            window.location.hash = versionRoute(id as VersionId)
          }}
        />
        <div className="header-actions">
          <Segmented value={view} options={VIEWS} onChange={setView} />
          <Button icon={Icons.shuffle} onClick={() => reseed(randomSeed())}>
            Randomise
          </Button>
          <Button
            icon={Icons.download}
            onClick={() =>
              rendererRef.current &&
              exportPng(rendererRef.current, 2048, `ripple-${params.seed}.png`)
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
          ) : view === 'single' ? (
            <>
              <RippleCanvas
                params={params}
                size={520}
                renderSize={640}
                onReady={(r) => (rendererRef.current = r)}
                onError={setError}
              />
              <div className="stage-caption">
                <span className="seed-chip">{params.seed}</span>
                <span className="t-xs-regular">
                  {params.structure} · {params.shape} · {params.surface}
                </span>
              </div>
            </>
          ) : (
            <ContactSheet
              seeds={gridSeeds}
              activeSeed={params.seed}
              onPick={(seed) => {
                reseed(seed)
                setView('single')
              }}
            />
          )}
        </main>

        <aside className="panel">
          <Section
            icon={Icons.identity}
            title="Identity"
            supporting="One seed per voice. Persist it — never regenerate."
          >
            <TextField
              label="Seed"
              value={params.seed}
              onChange={(seed) => reseed(seed)}
            />
            <Select
              label="Preset"
              value=""
              options={[
                { value: '', label: 'Custom' },
                ...PRESETS.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(id) => {
                const preset = PRESETS.find((p) => p.id === id)
                if (preset) setParams(preset.apply())
              }}
            />
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.structure}
            title="Structure"
            supporting="Source layout and how the fringes interfere."
          >
            <Segmented
              value={params.structure}
              options={STRUCTURES}
              labels={{ interference: 'Interf.' }}
              onChange={setStructure}
            />
            {slider('density')}
            {slider('lineWidth')}
            {slider('interference')}
            {slider('warpAmount')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.color}
            title="Colour"
            supporting="Ink blends in OKLab so midpoints stay clean."
          >
            <Select
              label="Palette"
              value={params.paletteId}
              options={PALETTES.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(id) => set('paletteId', id)}
            />
            {slider('chromaSplit')}
            {slider('chromaPhase')}
            {slider('hueSpread')}
            {slider('coreGlow')}
            {slider('exposure')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.surface}
            title="Surface"
            supporting="Fake lighting from the field's own derivatives."
          >
            <Segmented
              value={params.surface}
              options={SURFACES}
              onChange={(s: Surface) => set('surface', s)}
            />
            {slider('bleed')}
            {slider('grain')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Shape"
            supporting="An SDF mask, independent of the ripple geometry."
          >
            <Segmented
              value={params.shape}
              options={SHAPES}
              onChange={(s: Shape) => set('shape', s)}
            />
            {slider('shapeSize')}
            {slider('shapeSoft')}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.motion}
            title="Motion"
            supporting="Keep idle drift near still. Audio comes next."
          >
            {slider('speed')}
          </Section>
        </aside>
      </div>
    </div>
  )
}
