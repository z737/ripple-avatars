import { useEffect, useRef } from 'react'
import { Renderer } from '../engine/Renderer'
import { RippleParams } from '../engine/params'

export function RippleCanvas({
  params,
  size,
  renderSize = 640,
  onReady,
  onError,
}: {
  params: RippleParams
  size: number
  renderSize?: number
  onReady?: (r: Renderer) => void
  onError?: (message: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<Renderer | null>(null)

  // create once
  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const r = new Renderer(canvasRef.current)
      rendererRef.current = r
      r.setRenderSize(renderSize)
      r.setParams(params)
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

  // push params every render — cheap, and keeps one source of truth
  useEffect(() => {
    rendererRef.current?.setParams(params)
  }, [params])

  useEffect(() => {
    rendererRef.current?.setRenderSize(renderSize)
  }, [renderSize])

  // Pause when scrolled out of view or the tab is hidden.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) rendererRef.current?.start()
      else rendererRef.current?.stop()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div className="stage-canvas-wrap" style={{ width: size, height: size }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
