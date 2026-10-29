import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import type { ElementType, Geometry } from './engine'

// Floor plan canvas: draws the room scaled to the available width (1 cm of the plan can be less
// or more than 1 px). Shared by the editor and the tables view. Tables and elements are HTML
// (buttons), not a canvas: that way they can be tapped, focused and read by the screen reader.

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The scale that fits the box in the container's width (without enlarging too much). */
export function useScale(box: Box, maxSeen = 1.5) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const scale = width > 0 ? Math.min(maxSeen, width / box.width) : 0
  return { ref, scale }
}

/** Style to place something with its geometry inside the canvas. */
export function placement(g: Geometry, box: Box, scale: number): CSSProperties {
  return {
    position: 'absolute',
    left: (g.x - box.x) * scale,
    top: (g.y - box.y) * scale,
    width: g.width * scale,
    height: g.height * scale,
    transform: g.rotation ? `rotate(${g.rotation}deg)` : undefined,
  }
}

export function Canvas({
  box,
  scale,
  containerRef,
  label,
  children,
  onBackgroundTap,
}: {
  box: Box
  scale: number
  containerRef: React.RefObject<HTMLDivElement | null>
  label: string
  children: ReactNode
  onBackgroundTap?: () => void
}) {
  return (
    <div ref={containerRef} className="w-full">
      {/* Tapping the background only clears the editor's selection; on a keyboard, Escape. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
      <section
        aria-label={label}
        className="relative overflow-hidden rounded-2xl border border-divider bg-surface [background-image:radial-gradient(var(--color-divider)_1.5px,transparent_1.5px)]"
        style={{
          height: Math.max(200, box.height * scale),
          backgroundSize: `${50 * scale}px ${50 * scale}px`,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onBackgroundTap?.()
        }}
      >
        {scale > 0 && children}
      </section>
    </div>
  )
}

/**
 * The seats around a table, by its capacity: in a circle if round, along the long sides (and one
 * at each end if they fit) if square or rectangular, and all in front if it is a bar spot. They
 * are only drawing: the table's button tells the screen reader the seats.
 */
export function Seats({
  shape,
  width,
  height,
  places,
  cssClass,
}: {
  shape: string
  /** The table's on-screen size (px). */
  width: number
  height: number
  places: number
  cssClass: string
}) {
  if (places <= 0) return null
  const length = Math.max(8, Math.min(26, Math.min(width, height) * 0.32))
  const background = Math.max(5, length * 0.42)
  const gap = Math.max(3, length * 0.18)
  const seats: { x: number; y: number; angle: number }[] = []
  if (shape === 'round') {
    const radio = Math.max(width, height) / 2 + gap + background / 2
    for (let i = 0; i < places; i++) {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / places
      seats.push({
        x: width / 2 + radio * Math.cos(angle),
        y: height / 2 + radio * Math.sin(angle),
        angle: (angle * 180) / Math.PI + 90,
      })
    }
  } else if (shape === 'bar') {
    for (let i = 0; i < places; i++)
      seats.push({ x: (width * (i + 0.5)) / places, y: height + gap + background / 2, angle: 0 })
  } else {
    const horizontal = width >= height
    const [side, head] = horizontal ? [width, height] : [height, width]
    const headers = places >= 6 && head >= length * 1.3 ? 2 : 0
    const onSides = places - headers
    const above = Math.ceil(onSides / 2)
    const below = onSides - above
    const row = (seatCount: number, far: boolean) => {
      for (let i = 0; i < seatCount; i++) {
        const a = (side * (i + 0.5)) / seatCount
        const b = far ? head + gap + background / 2 : -gap - background / 2
        seats.push(
          horizontal ? { x: a, y: b, angle: far ? 180 : 0 } : { x: b, y: a, angle: far ? 90 : 270 },
        )
      }
    }
    row(above, false)
    row(below, true)
    if (headers) {
      const method = head / 2
      const before = -gap - background / 2
      const after = side + gap + background / 2
      seats.push(
        horizontal ? { x: before, y: method, angle: 270 } : { x: method, y: before, angle: 0 },
        horizontal ? { x: after, y: method, angle: 90 } : { x: method, y: after, angle: 180 },
      )
    }
  }
  return (
    <>
      {seats.map((s) => (
        <span
          key={`${s.x.toFixed(1)}-${s.y.toFixed(1)}`}
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-md ${cssClass}`}
          style={{
            width: length,
            height: background,
            left: s.x - length / 2,
            top: s.y - background / 2,
            transform: `rotate(${s.angle}deg)`,
          }}
        />
      ))}
    </>
  )
}

const ELEMENT_CLASS: Record<ElementType, string> = {
  wall: 'bg-foreground/70',
  door: 'border-2 border-dashed border-muted bg-surface',
  plant: 'rounded-full bg-free-soft border-2 border-free-strong/50',
  bar: 'rounded-lg bg-neutral-soft border-2 border-neutral-strong/40',
  text: 'text-muted',
}

/** What is not a table: floor plan decoration, with its recognizable shape. */
export function ElementShape({
  type,
  text,
  scale,
}: {
  type: ElementType
  text: string | null
  scale: number
}) {
  return (
    <span
      className={`flex h-full w-full items-center justify-center overflow-hidden text-center ${ELEMENT_CLASS[type]}`}
      style={type === 'text' ? { fontSize: Math.max(14, 20 * scale) } : undefined}
    >
      {type === 'text' ? text : type === 'bar' ? <span className="text-sm">Mostrador</span> : null}
    </span>
  )
}
