import { useEffect, useRef } from 'react'
import { Renderer } from '../engine/Renderer'
import { paramsFromSeed } from '../engine/genome'

/** GL render size. Rendering natively at the ~96px cell size would put the
 *  ripple cells below the pixel rate, and the shader's fwidth antialiasing
 *  would correctly — but uselessly — fade them to flat mush. Reference image 1's
 *  contact sheet is downscaled art, not low-detail art. */
const GL_SIZE = 384
/** Cell backing store, for a crisp result on retina. */
const CELL_SIZE = 192

/** Renders many seeds through ONE offscreen GL context, blitting each result
 *  into a small 2D canvas. No PNG encoding anywhere — toDataURL/toBlob on 36
 *  cells is what makes a sheet like this crawl.
 *
 *  This is also the mount policy the production avatar list should use: static
 *  by default, live only on interaction. 36 concurrent WebGL canvases is the
 *  wrong answer regardless of how cheap the shader is. */
export function ContactSheet({
  seeds,
  activeSeed,
  onPick,
}: {
  seeds: string[]
  activeSeed: string
  onPick: (seed: string) => void
}) {
  const cellsRef = useRef<(HTMLCanvasElement | null)[]>([])

  useEffect(() => {
    const glCanvas = document.createElement('canvas')
    let renderer: Renderer
    try {
      renderer = new Renderer(glCanvas)
    } catch {
      return
    }
    renderer.setRenderSize(GL_SIZE)

    let cancelled = false
    let i = 0

    const step = () => {
      if (cancelled) {
        renderer.dispose()
        return
      }
      // a few per frame — fast enough to feel instant, still yields to the UI
      for (let n = 0; n < 4 && i < seeds.length; n++, i++) {
        const cell = cellsRef.current[i]
        if (!cell) continue
        renderer.setParams({ ...paramsFromSeed(seeds[i]), speed: 0 })
        renderer.draw(GL_SIZE)

        cell.width = CELL_SIZE
        cell.height = CELL_SIZE
        const ctx = cell.getContext('2d')
        if (!ctx) continue
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(glCanvas, 0, 0, CELL_SIZE, CELL_SIZE)
      }
      if (i < seeds.length) requestAnimationFrame(step)
      else renderer.dispose()
    }
    requestAnimationFrame(step)

    return () => {
      cancelled = true
    }
  }, [seeds])

  return (
    <div className="sheet">
      {seeds.map((seed, idx) => (
        <button
          key={seed}
          type="button"
          className="sheet-cell"
          data-active={seed === activeSeed}
          onClick={() => onPick(seed)}
          title={seed}
        >
          <canvas ref={(el) => (cellsRef.current[idx] = el)} />
        </button>
      ))}
    </div>
  )
}
