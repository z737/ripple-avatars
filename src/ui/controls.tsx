import { ReactNode, useEffect, useRef } from 'react'
import { omega0At, omega0RangeHz } from '../playground/mapping'

/* Components mirroring the Vachana Playground Figma component set:
   Buttons/Secondary, Horizontal tabs, Input dropdown, Featured icon. */

export function Button({
  children,
  onClick,
  icon,
  disabled,
}: {
  children?: ReactNode
  onClick?: () => void
  icon?: ReactNode
  disabled?: boolean
}) {
  return (
    <button className="btn" onClick={onClick} disabled={disabled} type="button">
      {icon}
      {children != null && <span className="btn-label">{children}</span>}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  labels,
  onChange,
}: {
  value: T
  options: readonly T[]
  labels?: Partial<Record<T, string>>
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="tab"
          className="segmented-item"
          data-active={opt === value}
          aria-selected={opt === value}
          onClick={() => onChange(opt)}
          title={opt}
        >
          {labels?.[opt] ?? opt[0].toUpperCase() + opt.slice(1)}
        </button>
      ))}
    </div>
  )
}

function Chevron() {
  return (
    <svg className="select-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 7.5 10 12.5 15 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
      </div>
      <div className="select">
        <select value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Chevron />
      </div>
    </div>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : 1
  const v = Number.isFinite(value) ? value : min
  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
        <span className="field-value">{v.toFixed(decimals)}</span>
      </div>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

export function TextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
      </div>
      <input
        className="text-input"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="field-row">
      <span className="t-xs-semibold">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="toggle"
        data-on={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  )
}

/** The per-point frequency landscape, and the range of rates it contains.
 *
 *  Drawn from `omega0At`, the same function the simulation uses, so this is the
 *  actual field rather than an impression of it. The Hz readout is the useful
 *  half: it says outright that every point of the surface is ringing somewhere
 *  between two rates, which is otherwise invisible in a still frame. */
export function FrequencyMap({
  label,
  centre,
  spread,
  mapScale,
  phase,
}: {
  label: string
  centre: number
  spread: number
  mapScale: number
  phase: readonly [number, number]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const range = omega0RangeHz(centre, spread, mapScale, phase)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const N = 48
    const img = ctx.createImageData(N, N)
    const span = Math.max(range.hi - range.lo, 1e-4)

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const w = omega0At(i / (N - 1), j / (N - 1), centre, spread, mapScale, phase)
        const t = Math.min(1, Math.max(0, (w / (Math.PI * 2) - range.lo) / span))
        // slack (slow) regions cool and dark, stiff (fast) regions warm and light
        const o = (j * N + i) * 4
        img.data[o] = 70 + 185 * t
        img.data[o + 1] = 80 + 120 * t * t
        img.data[o + 2] = 150 - 60 * t
        img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [centre, spread, mapScale, phase, range.hi, range.lo])

  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
        <span className="field-value">
          {range.lo.toFixed(1)}–{range.hi.toFixed(1)} Hz
        </span>
      </div>
      <canvas
        ref={ref}
        width={48}
        height={48}
        className="freqmap"
        title={`Every point rings between ${range.lo.toFixed(2)} and ${range.hi.toFixed(2)} Hz`}
      />
    </div>
  )
}

/** The pigment picker: every available colour, with the ones in use selected.
 *
 *  Selecting past the maximum drops the oldest choice rather than refusing the
 *  click — exploring a set of colours shouldn't require deselecting first. The
 *  last remaining colour cannot be removed, since a mesh needs at least one. */
export function Swatches({
  label,
  rows,
  selected,
  min,
  max,
  onChange,
}: {
  label: string
  rows: string[][]
  selected: string[]
  min: number
  max: number
  onChange: (colors: string[]) => void
}) {
  const toggle = (color: string) => {
    const at = selected.indexOf(color)
    if (at >= 0) {
      if (selected.length <= min) return
      onChange(selected.filter((c) => c !== color))
      return
    }
    const next = [...selected, color]
    onChange(next.length > max ? next.slice(next.length - max) : next)
  }

  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
        <span className="field-value">
          {selected.length}/{max}
        </span>
      </div>
      <div className="swatches" role="group" aria-label={label}>
        {rows.map((row, ri) => (
          <div className="swatch-row" key={ri}>
            {row.map((color) => {
              const order = selected.indexOf(color)
              return (
                <button
                  key={color}
                  type="button"
                  className="swatch"
                  style={{ background: color }}
                  data-on={order >= 0}
                  aria-pressed={order >= 0}
                  title={color.toUpperCase()}
                  onClick={() => toggle(color)}
                >
                  {order >= 0 && <span className="swatch-order">{order + 1}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Direction controller for the light.
 *
 *  An angle in radians is not something anyone can set by number, so the dial
 *  shows where the light is and what it does: the dot is the light's position
 *  and the sphere inside is shaded by that same direction. Angle 0 is from the
 *  right, increasing clockwise, matching the shader's y-down UV space. */
export function AngleDial({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (radians: number) => void
}) {
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    const a = Math.atan2(dy, dx)
    onChange(a < 0 ? a + Math.PI * 2 : a)
  }

  const cos = Math.cos(value)
  const sin = Math.sin(value)
  const deg = Math.round((value * 180) / Math.PI)

  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
        <span className="field-value">{deg}°</span>
      </div>
      <div
        className="dial"
        role="application"
        aria-label={label}
        onPointerDown={(e) => {
          pick(e)
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* drag continues without capture */
          }
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e)
        }}
        title="Drag to move the light"
      >
        <span
          className="dial-preview"
          style={{
            background: `radial-gradient(circle at ${50 + cos * 32}% ${50 + sin * 32}%, #ffffff 0%, #cfcfcf 42%, #6f6f6f 78%, #4a4a4a 100%)`,
          }}
        />
        <span
          className="dial-dot"
          style={{ left: `${50 + cos * 42}%`, top: `${50 + sin * 42}%` }}
        />
      </div>
    </div>
  )
}

/** 2D controller. y is positive upward, which is what the label implies —
 *  the DOM's downward y is inverted here rather than in the caller. */
export function XYPad({
  label,
  value,
  onChange,
}: {
  label: string
  value: { x: number; y: number }
  onChange: (v: { x: number; y: number }) => void
}) {
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * 2 - 1
    const y = 1 - ((e.clientY - r.top) / r.height) * 2
    onChange({
      x: Math.min(1, Math.max(-1, x)),
      y: Math.min(1, Math.max(-1, y)),
    })
  }

  return (
    <div className="field">
      <div className="field-label">
        <span className="t-xs-semibold">{label}</span>
        <span className="field-value">
          {value.x.toFixed(2)}, {value.y.toFixed(2)}
        </span>
      </div>
      <div
        className="xypad"
        role="application"
        aria-label={label}
        onPointerDown={(e) => {
          // Apply first: setPointerCapture throws for a pointer the browser no
          // longer considers active, and losing the whole gesture to that would
          // be worse than losing the capture.
          pick(e)
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* drag continues without capture */
          }
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e)
        }}
        onDoubleClick={() => onChange({ x: 0, y: 0 })}
        title="Drag to elongate. Double-click to reset."
      >
        <span className="xypad-cross xypad-cross-h" />
        <span className="xypad-cross xypad-cross-v" />
        <span
          className="xypad-dot"
          style={{
            left: `${((value.x + 1) / 2) * 100}%`,
            top: `${((1 - value.y) / 2) * 100}%`,
          }}
        />
      </div>
    </div>
  )
}

export function Section({
  icon,
  title,
  supporting,
  children,
}: {
  icon: ReactNode
  title: string
  supporting: string
  children: ReactNode
}) {
  return (
    <section>
      <div className="section-head">
        <div className="featured-icon">{icon}</div>
        <div className="section-head-text">
          <div className="t-sm-semibold">{title}</div>
          <div className="t-xs-regular">{supporting}</div>
        </div>
      </div>
      <div className="section-body">{children}</div>
    </section>
  )
}

/* --- 20px line icons, matching the Figma icon set's stroke weight --------- */
const ico = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export const Icons = {
  identity: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <circle cx="10" cy="10" r="2.2" />
      <circle cx="10" cy="10" r="6.2" />
    </svg>
  ),
  structure: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <circle cx="7" cy="10" r="5" />
      <circle cx="13" cy="10" r="5" />
    </svg>
  ),
  color: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 3v14M3 10h14" />
    </svg>
  ),
  surface: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <path d="M3 13c2-3 4-3 6 0s4 3 6 0" />
      <path d="M3 8c2-3 4-3 6 0s4 3 6 0" />
    </svg>
  ),
  motion: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <path d="M3 10h3l2-5 3 10 2-5h4" />
    </svg>
  ),
  shuffle: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <path d="M3 5h3l8 10h3M14 5h3v3M3 15h3M17 12v3h-3" />
    </svg>
  ),
  download: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M3.5 14v1.5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  ),
  grid: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </svg>
  ),
  copy: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7" />
    </svg>
  ),
  origins: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="14" cy="14" r="2" />
      <path d="M8 8l4 4" strokeDasharray="1.5 2" />
    </svg>
  ),
  water: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <path d="M10 3s4 4.4 4 7a4 4 0 0 1-8 0c0-2.6 4-7 4-7Z" />
    </svg>
  ),
  audio: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
    </svg>
  ),
  reset: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <path d="M4 10a6 6 0 1 0 2-4.5M4 3v3h3" />
    </svg>
  ),
  light: (
    <svg width="20" height="20" viewBox="0 0 20 20" {...ico}>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
    </svg>
  ),
}
