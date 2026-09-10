import { useCallback, useEffect, useRef, useState } from 'react'
import { exportPng } from '../engine/export'
import { randomSeed } from '../engine/prng'
import { PLATFORM_NAME, VERSIONS, VersionId, versionRoute } from '../versions'
import { configFromSeed, defaultConfig, rerollRadii, tilesFromSeed } from '../v3/genome'
import {
  CORNERS,
  CORNER_LABEL,
  GRID,
  LAYOUTS,
  LAYOUT_LABEL,
  Layout,
  TILE_COUNT,
  V3Config,
  V3RangeKey,
  V3_RANGES,
} from '../v3/params'
import { shadeRgb } from '../v3/shades'
import { TileRenderer } from '../v3/TileRenderer'
import {
  Button,
  Icons,
  Section,
  Segmented,
  Slider,
  TextField,
  VersionPicker,
} from '../ui/controls'

const CANVAS = 500
const MIN_CANVAS = 64

export default function TilesPage() {
  const [cfg, setCfg] = useState<V3Config>(defaultConfig)
  /** which tile the four radius sliders are editing; -1 for none */
  const [selected, setSelected] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [desiredSize, setDesiredSize] = useState(CANVAS)
  const [fitMax, setFitMax] = useState(CANVAS)

  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<TileRenderer | null>(null)

  const size = Math.min(desiredSize, fitMax)

  useEffect(() => {
    const fit = () => {
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

  // create once
  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const r = new TileRenderer(canvasRef.current)
      rendererRef.current = r
      r.setConfig(cfg)
      r.setDisplaySize(size)
      r.start()
      // same dev seam as v2, so the renderer can be driven from the console
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__tiles = r
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    rendererRef.current?.setConfig(cfg)
  }, [cfg])
  useEffect(() => {
    rendererRef.current?.setSelected(selected)
  }, [selected])
  useEffect(() => {
    rendererRef.current?.setDisplaySize(size)
  }, [size])

  // Pause when hidden or scrolled away — the mark parks itself once settled, but
  // a hovered grid would otherwise keep a loop open in a background tab.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !document.hidden) rendererRef.current?.start()
      else rendererRef.current?.stop()
    })
    io.observe(el)
    const onVis = () => {
      if (document.hidden) rendererRef.current?.stop()
      else rendererRef.current?.start()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const set = useCallback(
    <K extends keyof V3Config>(key: K, value: V3Config[K]) =>
      setCfg((c) => ({ ...c, [key]: value })),
    []
  )

  /** Radius window and roundness change how radii are *drawn*, so they have to
   *  redraw the deal — otherwise the sliders would only affect the next seed. */
  const setDrawParam = useCallback(
    (key: 'radiusMin' | 'radiusMax' | 'roundness', value: number) =>
      setCfg((c) => {
        const next = { ...c, [key]: value }
        // keep the window ordered whichever end the user drags
        if (next.radiusMin > next.radiusMax) {
          if (key === 'radiusMin') next.radiusMax = next.radiusMin
          else next.radiusMin = next.radiusMax
        }
        return { ...next, tiles: tilesFromSeed(c.seed, next) }
      }),
    []
  )

  const setCorner = (tile: number, corner: number, value: number) =>
    setCfg((c) => ({
      ...c,
      tiles: c.tiles.map((t, i) =>
        i === tile
          ? { ...t, radii: t.radii.map((r, j) => (j === corner ? value : r)) as typeof t.radii }
          : t
      ),
    }))

  const uvOf = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  const slider = (key: V3RangeKey & keyof V3Config) => (
    <Slider
      key={key}
      label={V3_RANGES[key].label}
      value={cfg[key] as number}
      min={0}
      max={1}
      step={0.01}
      onChange={(v) => set(key, v as V3Config[typeof key])}
    />
  )

  const tile = selected >= 0 ? cfg.tiles[selected] : null

  return (
    <div className="app">
      <header className="header">
        <VersionPicker
          name={PLATFORM_NAME}
          value="v3"
          options={VERSIONS}
          onChange={(id) => {
            window.location.hash = versionRoute(id as VersionId)
          }}
        />
        <div className="header-actions">
          <Button icon={Icons.shuffle} onClick={() => setCfg(configFromSeed(randomSeed()))}>
            Randomize
          </Button>
          <Button
            icon={Icons.download}
            onClick={() =>
              rendererRef.current &&
              exportPng(rendererRef.current, 1024, `tiles-${cfg.seed}.png`)
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
              <div className="pg-stage" style={{ width: size, height: size }}>
                <div className="tile-box" ref={boxRef}>
                  <canvas
                    ref={canvasRef}
                    onPointerMove={(e) => rendererRef.current?.setPointer(uvOf(e))}
                    onPointerLeave={() => rendererRef.current?.setPointer(null)}
                    onPointerDown={(e) => {
                      const hit = rendererRef.current?.tileAt(uvOf(e)) ?? -1
                      setSelected((s) => (s === hit ? -1 : hit))
                    }}
                  />
                </div>
              </div>
              <div className="stage-caption">
                <span className="seed-chip">{cfg.seed}</span>
                <span className="t-xs-regular">
                  {TILE_COUNT} tiles · hue {Math.round(cfg.hue)}°
                  {selected >= 0
                    ? ` · editing r${Math.floor(selected / GRID) + 1}c${(selected % GRID) + 1}`
                    : ' · click a tile to edit its corners'}
                </span>
              </div>
            </>
          )}
        </main>

        <aside className="panel">
          <Section
            icon={Icons.identity}
            title="Seed"
            supporting="The identity. Same seed, same mark."
          >
            <TextField
              label="Seed"
              value={cfg.seed}
              onChange={(seed) => setCfg(configFromSeed(seed))}
            />
            <div className="btn-row">
              <Button
                icon={Icons.shuffle}
                onClick={() => setCfg(configFromSeed(randomSeed()))}
              >
                Mark
              </Button>
              <Button
                icon={Icons.reset}
                onClick={() => setCfg((c) => rerollRadii(c, String(Math.floor(c.hue) + 1)))}
              >
                Radii
              </Button>
            </div>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Layout"
            supporting="Sixteen components either way — a grid, or a disc of 1 + 5 + 10."
          >
            <Segmented
              value={cfg.layout}
              options={LAYOUTS}
              labels={LAYOUT_LABEL}
              onChange={(v: Layout) => set('layout', v)}
            />
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Corners"
            supporting="Click a component on the canvas to adjust its four radii."
          >
            {slider('roundness')}
            <Slider
              label={V3_RANGES.radiusMin.label}
              value={cfg.radiusMin}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setDrawParam('radiusMin', v)}
            />
            <Slider
              label={V3_RANGES.radiusMax.label}
              value={cfg.radiusMax}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setDrawParam('radiusMax', v)}
            />
            {slider('gutter')}

            {tile ? (
              <>
                <hr className="panel-divider" />
                {CORNERS.map((c, j) => (
                  <Slider
                    key={c}
                    label={CORNER_LABEL[c]}
                    value={tile.radii[j]}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => setCorner(selected, j, v)}
                  />
                ))}
                <div className="btn-row">
                  <Button onClick={() => setSelected(-1)}>Done</Button>
                </div>
              </>
            ) : (
              <p className="t-xs-regular note">
                Radius min and max are the window the randomiser draws from; Roundness biases
                the draw toward the round end. Drawn radii snap to five steps so corners rhyme
                across tiles — sixteen freely random tiles read as noise rather than as one
                set.
              </p>
            )}
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.color}
            title="Colour"
            supporting="One hue, sixteen shades, stepped in OKLCH."
          >
            <Slider
              label="Hue"
              value={cfg.hue}
              min={0}
              max={359}
              step={1}
              onChange={(v) => set('hue', v)}
            />
            {slider('saturation')}
            {slider('shadeSpread')}
            <div className="swatches">
              <div className="swatch-row">
                {cfg.tiles.map((t, i) => {
                  const [r, g, b] = shadeRgb(cfg, t.shade)
                  return (
                    <span
                      key={i}
                      className="shade-chip"
                      style={{
                        background: `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`,
                      }}
                    />
                  )
                })}
              </div>
            </div>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.water}
            title="Gooey hover"
            supporting="A component lifts and fuses with the ones beside it."
          >
            {slider('goo')}
            {slider('spread')}
            {slider('spreadReach')}
            {slider('lift')}
            <p className="t-xs-regular note">
              Hovering pulls neighbours <em>toward</em> the component so their fields overlap and
              fuse — a neck of surface forms between them and thins as they part. That is a
              smooth minimum of the distance fields, not a blur-and-threshold pass, so the
              corners stay sharp everywhere the merge is not happening. Sprung rather than
              tweened, and under reduced-motion they arrive without the travel.
            </p>
          </Section>

          <hr className="panel-divider" />

          <Section
            icon={Icons.grid}
            title="Output"
            supporting="Displayed size. The render is 2x for corner quality."
          >
            <Slider
              label="Canvas size"
              value={desiredSize}
              min={MIN_CANVAS}
              max={CANVAS}
              step={1}
              onChange={(v) => setDesiredSize(Math.round(v))}
            />
          </Section>
        </aside>
      </div>
    </div>
  )
}
