/** Anything that owns a canvas and can redraw itself at a given size. Both
 *  renderers satisfy this structurally. */
export interface Exportable {
  canvas: HTMLCanvasElement
  draw(size?: number): void
  start(): void
  stop(): void
}

/** Render one frame at an arbitrary size and download it.
 *  The canvas is resized, drawn, captured, then restored — no second context. */
export async function exportPng(
  renderer: Exportable,
  size: number,
  filename: string
): Promise<void> {
  renderer.stop()

  const prevW = renderer.canvas.width
  try {
    renderer.draw(size)
    const blob = await new Promise<Blob | null>((res) =>
      renderer.canvas.toBlob(res, 'image/png')
    )
    if (!blob) throw new Error('Canvas capture returned no data.')

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    renderer.draw(prevW)
    renderer.start()
  }
}
