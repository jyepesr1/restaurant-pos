import { newId } from '@pos/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Group, Option } from '../ui/Options'
import { useNotify } from '../ui/toasts'
import { floor } from './context'
import type { EditableCatalog, ElementType, TableShape } from './engine'
import { FloorFrame } from './FloorFrame'
import { type Box, Canvas, ElementShape, placement, useScale } from './FloorPlanCanvas'
import {
  bounds,
  ELEMENT_TYPES,
  type FloorPlanElement,
  type FloorPlanTable,
  GRID,
  measure,
  move,
  newElement,
  newTable,
  newZone,
  nextName,
  rotate,
  SHAPES,
  severalTables,
  type ZoneDraft,
  zoneChanges,
  zoneDraft,
  zoneIssues,
} from './floor-plan'

// Floor plan editor (task 1.2), for the register or a tablet: each zone or floor with its tables
// and the rest of the dining room (walls, doors, plants, the bar, texts). Drag to move, the
// corner changes the size, and the side panel changes name, shape, seats and rotation. With the
// keyboard: the arrows move 10 cm (with Shift, 50) and R rotates 15°. The changes are saved
// together with "Guardar"; until then they can be discarded.

type EditorSelection = { type: 'table' | 'element'; id: string } | null
type Drag = {
  /** The finger or mouse that drags: a second finger does not interrupt it. */
  pointer: number
  id: string
  type: 'table' | 'element'
  mode: 'move' | 'measure'
  start: { x: number; y: number }
  original: { x: number; y: number; width: number; height: number; rotation: number }
}

const field =
  'min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-lg focus-visible:outline-3 focus-visible:outline-foco'

export function FloorPlanEditor() {
  const notify = useNotify()
  const [c, setC] = useState<EditableCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [b, setB] = useState<ZoneDraft | null>(null)
  const [selection, setSelection] = useState<EditorSelection>(null)
  const [saving, setSaving] = useState(false)
  const [exit, setExit] = useState<null | (() => void)>(null)
  // "Agregar varias mesas a la vez": open or not, and what was chosen.
  const [several, setSeveral] = useState<{
    shape: TableShape
    quantity: number
    perRow: number
  } | null>(null)

  // A new zone that has not been touched does not count as a change: its initial name stays here.
  const [initialName, setInitialName] = useState('')
  const openZone = useCallback((x: EditableCatalog, id?: string) => {
    const zone = x.zones.find((z) => z.id === id && z.active) ?? x.zones.find((z) => z.active)
    setB(zone ? zoneDraft(x, zone.id) : { ...newZone(x), name: 'Salón' })
    setInitialName(zone ? '' : 'Salón')
    setSelection(null)
    setHistory([])
  }, [])

  const load = useCallback(
    (zoneId?: string) =>
      floor
        .catalogForEditing()
        .then((x) => {
          setC(x)
          setError(null)
          openZone(x, zoneId)
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo traer el plano')),
    [openZone],
  )
  useEffect(() => {
    void load()
  }, [load])

  // Undo: the draft from before each change is saved. A drag sends many changes in a
  // row; they count as one if they arrive less than half a second apart.
  const [history, setHistory] = useState<ZoneDraft[]>([])
  const lastChange = useRef(0)
  // A hub error is cleared as soon as editing resumes.
  const edit = (fresh: ZoneDraft) => {
    setError(null)
    if (b && Date.now() - lastChange.current > 500) setHistory((h) => [...h.slice(-49), b])
    lastChange.current = Date.now()
    setB(fresh)
  }
  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((h) => h.slice(0, -1))
    setB(previous)
    setSelection(null)
  }
  // Focus goes to what was just added or duplicated (otherwise, it is far away in the Tab order).
  const [focus, setFocus] = useState<string | null>(null)
  const changes = c && b ? zoneChanges(c, b) : []
  const issues = c && b ? zoneIssues(c, b) : []
  const dirty = b?.fresh
    ? b.tables.some((m) => m.active) ||
      b.elements.some((e) => e.active) ||
      b.name.trim() !== initialName
    : changes.length > 0

  // Reloading or closing the tab with changes: the browser asks.
  useEffect(() => {
    if (!dirty) return
    const notify = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', notify)
    return () => window.removeEventListener('beforeunload', notify)
  }, [dirty])

  // Ctrl/⌘+Z undoes (outside text fields, which have their own undo).
  useEffect(() => {
    const onKeystroke = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      if ((e.target as HTMLElement | null)?.closest('input, textarea')) return
      e.preventDefault()
      undoRef.current()
    }
    window.addEventListener('keydown', onKeystroke)
    return () => window.removeEventListener('keydown', onKeystroke)
  }, [])
  const undoRef = useRef(undo)
  undoRef.current = undo

  /** Before leaving the zone with changes, it asks. */
  const ifPossible = (action: () => void) => (dirty ? setExit(() => action) : action())

  const save = async (): Promise<boolean> => {
    if (!b || !c) return false
    setSaving(true)
    try {
      await floor.editCatalog(changes)
      notify(b.active ? `Guardaste ${b.name.trim()}` : `Archivaste ${b.name.trim()}`)
      await load(b.active ? b.id : undefined)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar')
      return false
    } finally {
      setSaving(false)
    }
  }

  if (!c || !b)
    return (
      <FloorFrame title="Plano" back="/">
        <p className="p-6 text-texto-suave" role={error ? 'alert' : undefined}>
          {error ?? 'Cargando el plano…'}
        </p>
      </FloorFrame>
    )

  const zones = c.zones.filter((z) => z.active)
  const differentLevels = new Set(zones.map((z) => z.level)).size > 1
  const usedNames = [
    ...c.tables.filter((m) => m.active && m.zone_id !== b.id).map((m) => m.name),
    ...b.tables.filter((m) => m.active).map((m) => m.name),
  ]
  const addTable = (shape: TableShape) => {
    const m = newTable(b, shape, usedNames)
    edit({ ...b, tables: [...b.tables, m] })
    setSelection({ type: 'table', id: m.id })
    setFocus(m.id)
  }
  const addSeveral = () => {
    if (!several) return
    const newOnes = severalTables(b, several.shape, several.quantity, several.perRow, usedNames)
    edit({ ...b, tables: [...b.tables, ...newOnes] })
    setSeveral(null)
    notify(
      `Agregaste ${newOnes.length} mesas: de la ${newOnes[0]?.name} a la ${newOnes.at(-1)?.name}`,
    )
  }
  const addElement = (type: ElementType) => {
    const e = newElement(b, type)
    edit({ ...b, elements: [...b.elements, e] })
    setSelection({ type: 'element', id: e.id })
    setFocus(e.id)
  }

  return (
    <FloorFrame title="Plano" back="/" guardExit={ifPossible}>
      <div className="mx-auto flex max-w-7xl flex-col gap-3 p-3">
        <Group label="Zona" className="flex flex-wrap gap-2">
          {zones.map((z) => (
            <Option
              key={z.id}
              selected={z.id === b.id}
              onChoose={() => z.id !== b.id && ifPossible(() => openZone(c, z.id))}
            >
              {differentLevels ? `${z.name} · piso ${z.level}` : z.name}
            </Option>
          ))}
          {b.fresh && (
            <Option selected onChoose={() => {}}>
              {b.name || 'Zona nueva'}
            </Option>
          )}
          <Button
            icon="more"
            onClick={() =>
              ifPossible(() => {
                setB(newZone(c))
                setInitialName('')
                setSelection(null)
              })
            }
          >
            Nueva zona
          </Button>
          <Button icon="undo" disabled={history.length === 0} onClick={undo}>
            Deshacer
          </Button>
        </Group>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Agregar mesa:</span>
          {(Object.keys(SHAPES) as TableShape[]).map((f, i) => (
            <Button
              key={f}
              id={i === 0 ? 'add-table' : undefined}
              icon="more"
              onClick={() => addTable(f)}
            >
              {SHAPES[f].name}
            </Button>
          ))}
          <Button
            variant={several ? 'main' : 'secondary'}
            aria-expanded={several !== null}
            onClick={() =>
              setSeveral(several ? null : { shape: 'square', quantity: 10, perRow: 5 })
            }
          >
            Varias a la vez…
          </Button>
        </div>
        {several && (
          <fieldset className="flex flex-wrap items-end gap-3 rounded-2xl border border-borde bg-superficie p-3">
            <legend className="px-1 font-semibold">Varias mesas iguales, en filas</legend>
            <Group label="Forma" className="flex flex-wrap gap-2">
              {(Object.keys(SHAPES) as TableShape[]).map((f) => (
                <Option
                  key={f}
                  selected={several.shape === f}
                  onChoose={() => setSeveral({ ...several, shape: f })}
                >
                  {SHAPES[f].name}
                </Option>
              ))}
            </Group>
            <span className="w-28">
              <NumberField
                label="Cuántas"
                value={several.quantity}
                min={1}
                max={60}
                onChange={(quantity) => setSeveral({ ...several, quantity })}
              />
            </span>
            <span className="w-28">
              <NumberField
                label="Por fila"
                value={several.perRow}
                min={1}
                max={20}
                onChange={(perRow) => setSeveral({ ...several, perRow })}
              />
            </span>
            <Button variant="main" onClick={addSeveral}>
              {`Agregar ${several.quantity}`}
            </Button>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Agregar al plano:</span>
          {(Object.keys(ELEMENT_TYPES) as ElementType[]).map((t) => (
            <Button key={t} icon="more" onClick={() => addElement(t)}>
              {ELEMENT_TYPES[t].name}
            </Button>
          ))}
        </div>

        <div className="flex flex-col gap-3 md:flex-row">
          <div className="min-w-0 flex-1">
            <EditableCanvas
              b={b}
              selection={selection}
              onChoose={setSelection}
              onChange={edit}
              focus={focus}
              onFocused={() => setFocus(null)}
            />
            <p className="mt-2 text-texto-suave">
              Arrastra para mover; la esquina cambia el tamaño. Con el teclado, las flechas mueven{' '}
              {GRID} cm (con Mayúsculas, 50), la R gira 15° y Ctrl+Z deshace.
            </p>
          </div>
          <aside className="w-full shrink-0 rounded-2xl border border-borde bg-superficie p-4 md:w-80">
            {selection ? (
              <Properties
                b={b}
                selection={selection}
                onChange={edit}
                onChoose={(s) => {
                  setSelection(s)
                  if (s) setFocus(s.id)
                }}
                onRelease={() => {
                  setSelection(null)
                  document.getElementById('add-table')?.focus()
                }}
                usedNames={usedNames}
              />
            ) : (
              <ZoneProperties c={c} b={b} onChange={edit} />
            )}
          </aside>
        </div>

        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-borde bg-fondo py-3">
          <p
            className="flex-1 text-alerta-texto"
            role={error ? 'alert' : undefined}
            aria-live="polite"
          >
            {exit ? 'Tienes cambios sin guardar en esta zona.' : (error ?? issues[0] ?? '')}
          </p>
          {exit ? (
            <>
              <Button
                onClick={() => {
                  const action = exit
                  setExit(null)
                  setError(null)
                  action()
                }}
              >
                Descartar los cambios
              </Button>
              {issues.length === 0 && (
                <Button
                  disabled={saving}
                  onClick={async () => {
                    const action = exit
                    setExit(null)
                    if (await save()) action()
                  }}
                >
                  Guardar y seguir
                </Button>
              )}
              {/* Focus goes to the safe option. */}
              <Button variant="main" autoFocus onClick={() => setExit(null)}>
                Seguir editando
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={!dirty || saving}
                onClick={() => ifPossible(() => openZone(c, b.fresh ? undefined : b.id))}
              >
                Descartar
              </Button>
              <Button
                variant="main"
                large
                disabled={!dirty || issues.length > 0 || saving}
                onClick={() => void save()}
              >
                {saving ? 'Guardando…' : dirty ? 'Guardar' : 'Sin cambios'}
              </Button>
            </>
          )}
        </div>
      </div>
    </FloorFrame>
  )
}

/** The zone's floor plan, with dragging, resizing and keyboard. */
function EditableCanvas({
  b,
  selection,
  onChoose,
  onChange,
  focus,
  onFocused,
}: {
  b: ZoneDraft
  selection: EditorSelection
  onChoose: (s: EditorSelection) => void
  onChange: (b: ZoneDraft) => void
  focus: string | null
  onFocused: () => void
}) {
  useEffect(() => {
    if (!focus) return
    document.getElementById(`shape-${focus}`)?.focus()
    onFocused()
  })
  const tables = b.tables.filter((m) => m.active)
  const elements = b.elements.filter((e) => e.active)
  const drag = useRef<Drag | null>(null)
  // While dragging, the canvas does not change size or scale (otherwise, everything "jumps").
  const [fixed, setFixed] = useState<Box | null>(null)
  const box = fixed ?? bounds([...tables, ...elements], 120)
  const { ref, scale } = useScale(box, 1)

  const update = (
    type: 'table' | 'element',
    id: string,
    f: <T extends FloorPlanTable | FloorPlanElement>(x: T) => T,
  ) =>
    onChange(
      type === 'table'
        ? { ...b, tables: b.tables.map((m) => (m.id === id ? f(m) : m)) }
        : { ...b, elements: b.elements.map((e) => (e.id === id ? f(e) : e)) },
    )

  const start = (
    e: React.PointerEvent,
    type: 'table' | 'element',
    g: FloorPlanTable | FloorPlanElement,
    mode: Drag['mode'],
  ) => {
    e.stopPropagation()
    if (drag.current) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onChoose({ type, id: g.id })
    drag.current = {
      pointer: e.pointerId,
      id: g.id,
      type,
      mode,
      start: { x: e.clientX, y: e.clientY },
      original: { x: g.x, y: g.y, width: g.width, height: g.height, rotation: g.rotation },
    }
    setFixed(box)
  }
  const proceed = (e: React.PointerEvent) => {
    const a = drag.current
    if (!a || a.pointer !== e.pointerId || scale === 0) return
    const dx = (e.clientX - a.start.x) / scale
    const dy = (e.clientY - a.start.y) / scale
    if (a.mode === 'move') {
      update(a.type, a.id, (x) => move(x, a.original.x + dx, a.original.y + dy))
      return
    }
    // Width and length go along the shape's axes: if it is rotated, the screen movement
    // is converted to its axes.
    const rad = (a.original.rotation * Math.PI) / 180
    const lx = dx * Math.cos(rad) + dy * Math.sin(rad)
    const ly = -dx * Math.sin(rad) + dy * Math.cos(rad)
    update(a.type, a.id, (x) => measure(x, a.original.width + lx, a.original.height + ly))
  }
  const finish = (e: React.PointerEvent) => {
    if (drag.current?.pointer !== e.pointerId) return
    drag.current = null
    setFixed(null)
  }
  const handleKey = (
    e: React.KeyboardEvent,
    type: 'table' | 'element',
    g: FloorPlanTable | FloorPlanElement,
  ) => {
    const step = e.shiftKey ? 50 : GRID
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const d = arrows[e.key]
    if (d) {
      e.preventDefault()
      update(type, g.id, (x) => move(x, x.x + d[0], x.y + d[1]))
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      update(type, g.id, (x) => rotate(x, 15))
    } else if (e.key === 'Escape') onChoose(null)
  }

  const figure = (
    type: 'table' | 'element',
    g: FloorPlanTable | FloorPlanElement,
    content: React.ReactNode,
    labelText: string,
    isRound: boolean,
  ) => {
    const selected = selection?.id === g.id
    return (
      <div key={g.id} style={{ ...placement(g, box, scale), zIndex: selected ? 10 : undefined }}>
        <button
          id={`shape-${g.id}`}
          type="button"
          aria-label={labelText}
          aria-pressed={selected}
          onPointerDown={(e) => start(e, type, g, 'move')}
          onPointerMove={proceed}
          onPointerUp={finish}
          onPointerCancel={finish}
          onKeyDown={(e) => handleKey(e, type, g)}
          onClick={() => onChoose({ type, id: g.id })}
          className={`h-full w-full touch-none cursor-move focus-visible:outline-3 focus-visible:outline-foco ${isRound ? 'rounded-full' : 'rounded-lg'} ${selected ? 'ring-4 ring-accion-fuerte' : ''}`}
        >
          {content}
        </button>
        {selected && (
          <span
            aria-hidden="true"
            onPointerDown={(e) => start(e, type, g, 'measure')}
            onPointerMove={proceed}
            onPointerUp={finish}
            onPointerCancel={finish}
            // 48 px for the finger; the small square that shows is smaller.
            className="absolute -right-6 -bottom-6 flex size-12 touch-none cursor-nwse-resize items-center justify-center"
          >
            <span className="size-6 rounded-md border-2 border-white bg-accion-fuerte" />
          </span>
        )}
      </div>
    )
  }

  return (
    <Canvas
      box={box}
      scale={scale}
      containerRef={ref}
      label={`Plano de ${b.name || 'la zona nueva'}`}
      onBackgroundTap={() => onChoose(null)}
    >
      {elements.map((e) =>
        figure(
          'element',
          e,
          <ElementShape type={e.type} text={e.text} scale={scale} />,
          `${ELEMENT_TYPES[e.type].name}${e.text ? ` «${e.text}»` : ''}`,
          e.type === 'plant',
        ),
      )}
      {tables.map((m) =>
        figure(
          'table',
          m,
          <span
            className={`flex h-full w-full items-center justify-center border-2 border-libre-fuerte bg-superficie font-titulo text-xl font-bold text-libre-texto ${m.shape === 'round' ? 'rounded-full' : 'rounded-lg'}`}
          >
            <span style={m.rotation ? { transform: `rotate(${-m.rotation}deg)` } : undefined}>
              {m.name}
            </span>
          </span>,
          `Mesa ${m.name}, ${SHAPES[m.shape].name.toLowerCase()}, ${m.capacity} puestos`,
          m.shape === 'round',
        ),
      )}
    </Canvas>
  )
}

function NumberField({
  label: labelText,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step?: number
}) {
  // What is typed is kept as is while typing ("1" on the way to "150", "-" on the way to "-1");
  // the number is confirmed when leaving the field or with Enter. If it is not valid, it goes back
  // to the previous one.
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const isValid = (t: string) => {
    const n = Number(t)
    return t.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
  }
  const confirm = () => {
    setEditing(false)
    if (isValid(text)) onChange(Number(text))
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="font-semibold">{labelText}</span>
      <input
        type="number"
        inputMode="numeric"
        className={`${field} cifras`}
        value={editing ? text : String(value)}
        min={min}
        max={max}
        step={step}
        onFocus={() => {
          setText(String(value))
          setEditing(true)
        }}
        onChange={(e) => {
          setText(e.target.value)
          // The field's little arrows give valid numbers: they are applied at once.
          if (isValid(e.target.value)) onChange(Number(e.target.value))
        }}
        onBlur={confirm}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm()
        }}
      />
    </label>
  )
}

function Properties({
  b,
  selection,
  onChange,
  onChoose,
  onRelease,
  usedNames,
}: {
  b: ZoneDraft
  selection: NonNullable<EditorSelection>
  onChange: (b: ZoneDraft) => void
  onChoose: (s: EditorSelection) => void
  onRelease: () => void
  usedNames: string[]
}) {
  const table = selection.type === 'table' ? b.tables.find((m) => m.id === selection.id) : undefined
  const element =
    selection.type === 'element' ? b.elements.find((e) => e.id === selection.id) : undefined
  const g = table ?? element
  if (!g) return null
  const changeTable = (partial: Partial<FloorPlanTable>) =>
    onChange({ ...b, tables: b.tables.map((m) => (m.id === g.id ? { ...m, ...partial } : m)) })
  const changeElement = (partial: Partial<FloorPlanElement>) =>
    onChange({
      ...b,
      elements: b.elements.map((e) => (e.id === g.id ? { ...e, ...partial } : e)),
    })
  const patch = (partial: Partial<FloorPlanTable & FloorPlanElement>) =>
    table ? changeTable(partial) : changeElement(partial)
  // The copy stays next to the original, with the same, and selected (so it shows where it went).
  const duplicateSelected = () => {
    const side = { x: g.x + g.width + GRID * 2, y: g.y }
    if (table) {
      const copy: FloorPlanTable = {
        ...move(table, side.x, side.y),
        id: newId(),
        fresh: true,
        name: nextName(usedNames),
      }
      onChange({ ...b, tables: [...b.tables, copy] })
      onChoose({ type: 'table', id: copy.id })
    } else if (element) {
      const copy: FloorPlanElement = {
        ...move(element, side.x, side.y),
        id: newId(),
        fresh: true,
      }
      onChange({ ...b, elements: [...b.elements, copy] })
      onChoose({ type: 'element', id: copy.id })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {table ? `Mesa ${table.name}` : ELEMENT_TYPES[(element as FloorPlanElement).type].name}
        </h2>
        <Button variant="ghost" onClick={onRelease}>
          Listo
        </Button>
      </div>
      {table && (
        <>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nombre o número</span>
            <input
              className={field}
              value={table.name}
              maxLength={20}
              onChange={(e) => changeTable({ name: e.target.value })}
            />
          </label>
          <Group label="Forma" className="flex flex-wrap gap-2">
            {(Object.keys(SHAPES) as TableShape[]).map((f) => (
              <Option
                key={f}
                selected={table.shape === f}
                onChoose={() => changeTable({ shape: f })}
              >
                {SHAPES[f].name}
              </Option>
            ))}
          </Group>
          <NumberField
            label="Puestos"
            value={table.capacity}
            min={1}
            max={100}
            onChange={(capacity) => changeTable({ capacity })}
          />
        </>
      )}
      {element?.type === 'text' && (
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Texto</span>
          <input
            className={field}
            value={element.text ?? ''}
            maxLength={60}
            onChange={(e) => changeElement({ text: e.target.value })}
          />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Ancho (cm)"
          value={g.width}
          min={20}
          max={10_000}
          step={GRID}
          onChange={(width) => patch(measure(g, width, g.height))}
        />
        <NumberField
          label="Largo (cm)"
          value={g.height}
          min={20}
          max={10_000}
          step={GRID}
          onChange={(height) => patch(measure(g, g.width, height))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Girar:</span>
        <Button onClick={() => patch(rotate(g, -15))}>−15°</Button>
        <Button onClick={() => patch(rotate(g, 15))}>+15°</Button>
        <Button onClick={() => patch(rotate(g, 90))}>90°</Button>
        <span className="cifras text-texto-suave">{`${g.rotation}°`}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button icon="more" onClick={duplicateSelected}>
          Duplicar
        </Button>
        <Button
          onClick={() => {
            patch({ active: false })
            onRelease()
          }}
        >
          Quitar del plano
        </Button>
      </div>
    </div>
  )
}

function ZoneProperties({
  c,
  b,
  onChange,
}: {
  c: EditableCatalog
  b: ZoneDraft
  onChange: (b: ZoneDraft) => void
}) {
  const tables = b.tables.filter((m) => m.active).length
  // What is archived can be put back (with its name and its place).
  const inDraft = new Set(b.tables.filter((m) => m.active).map((m) => m.id))
  const archivedStaff = c.tables.filter((m) => m.zone_id === b.id && !inDraft.has(m.id))
  const back = (id: string) => {
    const m = c.tables.find((x) => x.id === id)
    if (!m) return
    const rest = b.tables.filter((x) => x.id !== id)
    onChange({
      ...b,
      tables: [
        ...rest,
        {
          id: m.id,
          fresh: false,
          name: m.name,
          shape: m.shape,
          capacity: m.capacity,
          active: true,
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
          rotation: m.rotation,
        },
      ],
    })
  }
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{b.fresh ? 'Zona nueva' : 'Esta zona'}</h2>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Nombre</span>
        <input
          className={field}
          value={b.name}
          placeholder="Terraza"
          maxLength={80}
          onChange={(e) => onChange({ ...b, name: e.target.value })}
        />
      </label>
      <NumberField
        label="Piso"
        value={b.level}
        min={-5}
        max={100}
        onChange={(level) => onChange({ ...b, level })}
      />
      <p className="text-texto-suave">
        {`${tables === 1 ? '1 mesa' : `${tables} mesas`}. Toca una mesa o un elemento para cambiarlo.`}
      </p>
      {archivedStaff.length > 0 && (
        <details>
          <summary className="flex min-h-12 cursor-pointer items-center font-semibold">
            {`Mesas quitadas (${archivedStaff.length})`}
          </summary>
          <ul className="flex flex-col gap-1">
            {archivedStaff.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span>{`Mesa ${m.name}`}</span>
                <Button onClick={() => back(m.id)}>Volver a ponerla</Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!b.fresh && (
        <Button onClick={() => onChange({ ...b, active: !b.active })}>
          {b.active ? 'Archivar esta zona (y sus mesas)' : 'Mejor no archivarla'}
        </Button>
      )}
      {!b.active && (
        <p className="rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Al guardar, la zona y sus mesas dejan de verse en el salón. Una mesa con un pedido abierto
          no se puede archivar.
        </p>
      )}
    </div>
  )
}
