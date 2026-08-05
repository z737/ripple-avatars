import { useEffect, useRef } from 'react'
import { AudioEngine } from '../playground/audio'
import { PlaygroundRenderer } from '../playground/PlaygroundRenderer'
import { ORIGIN_MAX, ORIGIN_MIN, PgConfig } from '../playground/params'

/** How far past the canvas the origin editor reaches, as a fraction of the
 *  canvas box. Sources may sit at -0.5..1.5; the drag keeps mapping linearly
 *  past the overlay, and handles beyond it pin to the edge. */
const EDIT_MARGIN = 0.25

const clampOrigin = (v: number) => Math.min(ORIGIN_MAX, Math.max(ORIGIN_MIN, v))

export function PlaygroundCanvas({
  cfg,
  size,
  edit,
  selected,
  onSelect,
  onMove,
  onReady,
  onError,
  audio,
}: {
  cfg: PgConfig
  size: number
  edit: boolean
  selected: number
  onSelect: (i: number) => void
  onMove: (index: number, x: number, y: number) => void
  onReady?: (r: PlaygroundRenderer) => void
  onError?: (message: string) => void
  audio: AudioEngine | null
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<PlaygroundRenderer | null>(null)
  const dragRef = useRef<number | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const r = new PlaygroundRenderer(canvasRef.current)
      rendererRef.current = r
      // dev handle, for poking at the renderer from the console
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ripple = r
      r.setConfig(cfg)
      r.start()
      onReady?.(r)
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
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
    rendererRef.current?.setAudioSource(audio)
  }, [audio])

  // Pause when scrolled out of view or the tab is hidden.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !document.hidden) rendererRef.current?.start()
      else rendererRef.current?.stop()
    })
    io.observe(el)

    const onVisibility = () => {
      if (document.hidden) rendererRef.current?.stop()
      else rendererRef.current?.start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  /** client coords -> canvas uv, y down, unclamped so drags can leave the box */
  const toUv = (clientX: number, clientY: number) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }
  }

  const handles = cfg.sources.slice(0, cfg.waves)

  return (
    <div className="pg-stage" style={{ width: size, height: size }}>
      <div className="pg-canvas-box" ref={boxRef}>
        <canvas
          ref={canvasRef}
          onPointerMove={(e) => {
            const p = toUv(e.clientX, e.clientY)
            rendererRef.current?.setPointer(p.x, p.y, true)
          }}
          onPointerDown={(e) => {
            const p = toUv(e.clientX, e.clientY)
            rendererRef.current?.tap(p.x, p.y)
          }}
          onPointerLeave={() => rendererRef.current?.clearPointer()}
        />
      </div>

      {/* Handles only exist in edit mode — preview draws nothing over the
          artwork. The overlay itself is transparent to the pointer so hover
          water still reaches the canvas underneath. */}
      {edit && (
        <div className="pg-origins" style={{ inset: `${-EDIT_MARGIN * 100}%` }}>
          <div className="pg-origins-frame" />

          {handles.map((s, i) => {
            const span = 1 + EDIT_MARGIN * 2
            const outside = s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1
            const pos = (v: number) => `${Math.min(100, Math.max(0, ((v + EDIT_MARGIN) / span) * 100))}%`
            return (
              <button
                key={i}
                type="button"
                className="pg-handle"
                data-active={i === selected}
                data-outside={outside}
                style={{ left: pos(s.x), top: pos(s.y) }}
                title={`Origin ${i + 1} — ${s.x.toFixed(2)}, ${s.y.toFixed(2)}`}
                onPointerDown={(e) => {
                  dragRef.current = i
                  onSelect(i)
                  // Capture on the handle: the drag keeps mapping linearly even
                  // once the pointer leaves the overlay, which is how a source
                  // reaches the far end of the -0.5..1.5 range.
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId)
                  } catch {
                    /* drag continues without capture */
                  }
                }}
                onPointerMove={(e) => {
                  if (dragRef.current !== i) return
                  const p = toUv(e.clientX, e.clientY)
                  onMove(i, clampOrigin(p.x), clampOrigin(p.y))
                }}
                onPointerUp={() => (dragRef.current = null)}
                onPointerCancel={() => (dragRef.current = null)}
              >
                <span className="pg-handle-num">{i + 1}</span>
              </button>
            )
          })}

          {/* An off-frame source still needs to be findable, so it leaves a
              marker on the edge it went out through. */}
          {handles.map((s, i) => {
            if (s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1) return null
            const span = 1 + EDIT_MARGIN * 2
            const clamp = (v: number) => `${((Math.min(1, Math.max(0, v)) + EDIT_MARGIN) / span) * 100}%`
            return (
              <span
                key={`edge-${i}`}
                className="pg-edge"
                style={{ left: clamp(s.x), top: clamp(s.y) }}
                aria-hidden="true"
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
