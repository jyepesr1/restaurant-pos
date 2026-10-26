import { newId } from '@pos/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Grupo, Opcion } from '../ui/Opciones'
import { sala } from './contexto'
import { type Caja, FiguraElemento, Lienzo, posicion, useEscala } from './LienzoPlano'
import { MarcoSala } from './MarcoSala'
import type { CatalogoEdicion, FormaMesa, TipoElemento } from './motor'
import {
  type BorradorZona,
  borradorDeZona,
  CUADRICULA,
  cambiosDeZona,
  type ElementoPlano,
  FORMAS,
  limites,
  type MesaPlano,
  measure,
  move,
  nuevaMesa,
  nuevoElemento,
  problemasDeZona,
  rotate,
  siguienteNombre,
  TIPOS_ELEMENTO,
  variasMesas,
  zonaNueva,
} from './plano'

// Editor del plano (tarea 1.2), para la caja o una tablet: cada zona o piso con sus mesas y lo
// demás del salón (paredes, puertas, plantas, la barra, textos). Se arrastra para mover, la
// esquina cambia el tamaño, y el panel de al lado cambia nombre, forma, puestos y giro. Con el
// teclado: las flechas mueven 10 cm (con Mayúsculas, 50) y R gira 15°. Los cambios se guardan
// juntos con "Guardar"; mientras tanto se pueden descartar.

type Seleccion = { type: 'table' | 'element'; id: string } | null
type Arrastre = {
  /** El dedo o el mouse que arrastra: un segundo dedo no lo interrumpe. */
  puntero: number
  id: string
  type: 'table' | 'element'
  mode: 'move' | 'measure'
  start: { x: number; y: number }
  original: { x: number; y: number; width: number; height: number; rotation: number }
}

const field =
  'min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-lg focus-visible:outline-3 focus-visible:outline-foco'

export function PlanoEditor() {
  const avisar = useAvisar()
  const [c, setC] = useState<CatalogoEdicion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [b, setB] = useState<BorradorZona | null>(null)
  const [seleccion, setSeleccion] = useState<Seleccion>(null)
  const [guardando, setGuardando] = useState(false)
  const [exit, setSalir] = useState<null | (() => void)>(null)
  // "Agregar varias mesas a la vez": abierto o no, y lo elegido.
  const [varias, setVarias] = useState<{
    shape: FormaMesa
    quantity: number
    porFila: number
  } | null>(null)

  // Una zona nueva que no se ha tocado no cuenta como cambio: su nombre inicial queda aquí.
  const [nombreInicial, setNombreInicial] = useState('')
  const abrirZona = useCallback((x: CatalogoEdicion, id?: string) => {
    const zone = x.zones.find((z) => z.id === id && z.active) ?? x.zones.find((z) => z.active)
    setB(zone ? borradorDeZona(x, zone.id) : { ...zonaNueva(x), name: 'Salón' })
    setNombreInicial(zone ? '' : 'Salón')
    setSeleccion(null)
    setHistorial([])
  }, [])

  const cargar = useCallback(
    (zonaId?: string) =>
      sala
        .catalogoParaEditar()
        .then((x) => {
          setC(x)
          setError(null)
          abrirZona(x, zonaId)
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo traer el plano')),
    [abrirZona],
  )
  useEffect(() => {
    void cargar()
  }, [cargar])

  // Deshacer: se guarda el borrador de antes de cada cambio. Un arrastre manda muchos cambios
  // seguidos; cuentan como uno si llegan a menos de medio segundo.
  const [historial, setHistorial] = useState<BorradorZona[]>([])
  const ultimoCambio = useRef(0)
  // Un error del hub se limpia en cuanto se vuelve a editar.
  const editar = (fresh: BorradorZona) => {
    setError(null)
    if (b && Date.now() - ultimoCambio.current > 500) setHistorial((h) => [...h.slice(-49), b])
    ultimoCambio.current = Date.now()
    setB(fresh)
  }
  const undo = () => {
    const previous = historial.at(-1)
    if (!previous) return
    setHistorial((h) => h.slice(0, -1))
    setB(previous)
    setSeleccion(null)
  }
  // El foco va a lo que se acaba de agregar o duplicar (si no, queda lejos en el orden de Tab).
  const [enfocar, setEnfocar] = useState<string | null>(null)
  const changes = c && b ? cambiosDeZona(c, b) : []
  const issues = c && b ? problemasDeZona(c, b) : []
  const sucio = b?.fresh
    ? b.tables.some((m) => m.active) ||
      b.elements.some((e) => e.active) ||
      b.name.trim() !== nombreInicial
    : changes.length > 0

  // Recargar o cerrar la pestaña con cambios: el navegador pregunta.
  useEffect(() => {
    if (!sucio) return
    const avisar = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', avisar)
    return () => window.removeEventListener('beforeunload', avisar)
  }, [sucio])

  // Ctrl/⌘+Z deshace (fuera de los campos de texto, que tienen su propio deshacer).
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      if ((e.target as HTMLElement | null)?.closest('input, textarea')) return
      e.preventDefault()
      deshacerRef.current()
    }
    window.addEventListener('keydown', alTeclear)
    return () => window.removeEventListener('keydown', alTeclear)
  }, [])
  const deshacerRef = useRef(undo)
  deshacerRef.current = undo

  /** Antes de dejar la zona con cambios, pregunta. */
  const siSePuede = (action: () => void) => (sucio ? setSalir(() => action) : action())

  const guardar = async (): Promise<boolean> => {
    if (!b || !c) return false
    setGuardando(true)
    try {
      await sala.editarCatalogo(changes)
      avisar(b.active ? `Guardaste ${b.name.trim()}` : `Archivaste ${b.name.trim()}`)
      await cargar(b.active ? b.id : undefined)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar')
      return false
    } finally {
      setGuardando(false)
    }
  }

  if (!c || !b)
    return (
      <MarcoSala title="Plano" back="/">
        <p className="p-6 text-texto-suave" role={error ? 'alert' : undefined}>
          {error ?? 'Cargando el plano…'}
        </p>
      </MarcoSala>
    )

  const zones = c.zones.filter((z) => z.active)
  const pisosDistintos = new Set(zones.map((z) => z.level)).size > 1
  const nombresUsados = [
    ...c.tables.filter((m) => m.active && m.zone_id !== b.id).map((m) => m.name),
    ...b.tables.filter((m) => m.active).map((m) => m.name),
  ]
  const agregarMesa = (shape: FormaMesa) => {
    const m = nuevaMesa(b, shape, nombresUsados)
    editar({ ...b, tables: [...b.tables, m] })
    setSeleccion({ type: 'table', id: m.id })
    setEnfocar(m.id)
  }
  const agregarVarias = () => {
    if (!varias) return
    const newOnes = variasMesas(b, varias.shape, varias.quantity, varias.porFila, nombresUsados)
    editar({ ...b, tables: [...b.tables, ...newOnes] })
    setVarias(null)
    avisar(
      `Agregaste ${newOnes.length} mesas: de la ${newOnes[0]?.name} a la ${newOnes.at(-1)?.name}`,
    )
  }
  const agregarElemento = (type: TipoElemento) => {
    const e = nuevoElemento(b, type)
    editar({ ...b, elements: [...b.elements, e] })
    setSeleccion({ type: 'element', id: e.id })
    setEnfocar(e.id)
  }

  return (
    <MarcoSala title="Plano" back="/" protegerSalida={siSePuede}>
      <div className="mx-auto flex max-w-7xl flex-col gap-3 p-3">
        <Grupo etiqueta="Zona" className="flex flex-wrap gap-2">
          {zones.map((z) => (
            <Opcion
              key={z.id}
              elegida={z.id === b.id}
              alElegir={() => z.id !== b.id && siSePuede(() => abrirZona(c, z.id))}
            >
              {pisosDistintos ? `${z.name} · piso ${z.level}` : z.name}
            </Opcion>
          ))}
          {b.fresh && (
            <Opcion elegida alElegir={() => {}}>
              {b.name || 'Zona nueva'}
            </Opcion>
          )}
          <Boton
            icono="more"
            onClick={() =>
              siSePuede(() => {
                setB(zonaNueva(c))
                setNombreInicial('')
                setSeleccion(null)
              })
            }
          >
            Nueva zona
          </Boton>
          <Boton icono="undo" disabled={historial.length === 0} onClick={undo}>
            Deshacer
          </Boton>
        </Grupo>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Agregar mesa:</span>
          {(Object.keys(FORMAS) as FormaMesa[]).map((f, i) => (
            <Boton
              key={f}
              id={i === 0 ? 'add-table' : undefined}
              icono="more"
              onClick={() => agregarMesa(f)}
            >
              {FORMAS[f].name}
            </Boton>
          ))}
          <Boton
            variant={varias ? 'main' : 'secondary'}
            aria-expanded={varias !== null}
            onClick={() => setVarias(varias ? null : { shape: 'square', quantity: 10, porFila: 5 })}
          >
            Varias a la vez…
          </Boton>
        </div>
        {varias && (
          <fieldset className="flex flex-wrap items-end gap-3 rounded-2xl border border-borde bg-superficie p-3">
            <legend className="px-1 font-semibold">Varias mesas iguales, en filas</legend>
            <Grupo etiqueta="Forma" className="flex flex-wrap gap-2">
              {(Object.keys(FORMAS) as FormaMesa[]).map((f) => (
                <Opcion
                  key={f}
                  elegida={varias.shape === f}
                  alElegir={() => setVarias({ ...varias, shape: f })}
                >
                  {FORMAS[f].name}
                </Opcion>
              ))}
            </Grupo>
            <span className="w-28">
              <Numero
                etiqueta="Cuántas"
                value={varias.quantity}
                min={1}
                max={60}
                onChange={(quantity) => setVarias({ ...varias, quantity })}
              />
            </span>
            <span className="w-28">
              <Numero
                etiqueta="Por fila"
                value={varias.porFila}
                min={1}
                max={20}
                onChange={(porFila) => setVarias({ ...varias, porFila })}
              />
            </span>
            <Boton variant="main" onClick={agregarVarias}>
              {`Agregar ${varias.quantity}`}
            </Boton>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Agregar al plano:</span>
          {(Object.keys(TIPOS_ELEMENTO) as TipoElemento[]).map((t) => (
            <Boton key={t} icono="more" onClick={() => agregarElemento(t)}>
              {TIPOS_ELEMENTO[t].name}
            </Boton>
          ))}
        </div>

        <div className="flex flex-col gap-3 md:flex-row">
          <div className="min-w-0 flex-1">
            <LienzoEditable
              b={b}
              seleccion={seleccion}
              alElegir={setSeleccion}
              onChange={editar}
              enfocar={enfocar}
              alEnfocar={() => setEnfocar(null)}
            />
            <p className="mt-2 text-texto-suave">
              Arrastra para mover; la esquina cambia el tamaño. Con el teclado, las flechas mueven{' '}
              {CUADRICULA} cm (con Mayúsculas, 50), la R gira 15° y Ctrl+Z deshace.
            </p>
          </div>
          <aside className="w-full shrink-0 rounded-2xl border border-borde bg-superficie p-4 md:w-80">
            {seleccion ? (
              <Propiedades
                b={b}
                seleccion={seleccion}
                onChange={editar}
                alElegir={(s) => {
                  setSeleccion(s)
                  if (s) setEnfocar(s.id)
                }}
                alSoltar={() => {
                  setSeleccion(null)
                  document.getElementById('add-table')?.focus()
                }}
                nombresUsados={nombresUsados}
              />
            ) : (
              <PropiedadesZona c={c} b={b} onChange={editar} />
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
              <Boton
                onClick={() => {
                  const action = exit
                  setSalir(null)
                  setError(null)
                  action()
                }}
              >
                Descartar los cambios
              </Boton>
              {issues.length === 0 && (
                <Boton
                  disabled={guardando}
                  onClick={async () => {
                    const action = exit
                    setSalir(null)
                    if (await guardar()) action()
                  }}
                >
                  Guardar y seguir
                </Boton>
              )}
              {/* El foco va a la opción segura. */}
              <Boton variant="main" autoFocus onClick={() => setSalir(null)}>
                Seguir editando
              </Boton>
            </>
          ) : (
            <>
              <Boton
                disabled={!sucio || guardando}
                onClick={() => siSePuede(() => abrirZona(c, b.fresh ? undefined : b.id))}
              >
                Descartar
              </Boton>
              <Boton
                variant="main"
                large
                disabled={!sucio || issues.length > 0 || guardando}
                onClick={() => void guardar()}
              >
                {guardando ? 'Guardando…' : sucio ? 'Guardar' : 'Sin cambios'}
              </Boton>
            </>
          )}
        </div>
      </div>
    </MarcoSala>
  )
}

/** El plano de la zona, con arrastre, tamaño y teclado. */
function LienzoEditable({
  b,
  seleccion,
  alElegir,
  onChange,
  enfocar,
  alEnfocar,
}: {
  b: BorradorZona
  seleccion: Seleccion
  alElegir: (s: Seleccion) => void
  onChange: (b: BorradorZona) => void
  enfocar: string | null
  alEnfocar: () => void
}) {
  useEffect(() => {
    if (!enfocar) return
    document.getElementById(`shape-${enfocar}`)?.focus()
    alEnfocar()
  })
  const tables = b.tables.filter((m) => m.active)
  const elements = b.elements.filter((e) => e.active)
  const arrastre = useRef<Arrastre | null>(null)
  // Mientras se arrastra, el lienzo no cambia de tamaño ni de escala (si no, todo "salta").
  const [fija, setFija] = useState<Caja | null>(null)
  const register = fija ?? limites([...tables, ...elements], 120)
  const { ref, escala } = useEscala(register, 1)

  const actualizar = (
    type: 'table' | 'element',
    id: string,
    f: <T extends MesaPlano | ElementoPlano>(x: T) => T,
  ) =>
    onChange(
      type === 'table'
        ? { ...b, tables: b.tables.map((m) => (m.id === id ? f(m) : m)) }
        : { ...b, elements: b.elements.map((e) => (e.id === id ? f(e) : e)) },
    )

  const empezar = (
    e: React.PointerEvent,
    type: 'table' | 'element',
    g: MesaPlano | ElementoPlano,
    mode: Arrastre['mode'],
  ) => {
    e.stopPropagation()
    if (arrastre.current) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    alElegir({ type, id: g.id })
    arrastre.current = {
      puntero: e.pointerId,
      id: g.id,
      type,
      mode,
      start: { x: e.clientX, y: e.clientY },
      original: { x: g.x, y: g.y, width: g.width, height: g.height, rotation: g.rotation },
    }
    setFija(register)
  }
  const seguir = (e: React.PointerEvent) => {
    const a = arrastre.current
    if (!a || a.puntero !== e.pointerId || escala === 0) return
    const dx = (e.clientX - a.start.x) / escala
    const dy = (e.clientY - a.start.y) / escala
    if (a.mode === 'move') {
      actualizar(a.type, a.id, (x) => move(x, a.original.x + dx, a.original.y + dy))
      return
    }
    // El ancho y el largo van en los ejes de la figura: si está girada, el movimiento de la
    // pantalla se pasa a sus ejes.
    const rad = (a.original.rotation * Math.PI) / 180
    const lx = dx * Math.cos(rad) + dy * Math.sin(rad)
    const ly = -dx * Math.sin(rad) + dy * Math.cos(rad)
    actualizar(a.type, a.id, (x) => measure(x, a.original.width + lx, a.original.height + ly))
  }
  const terminar = (e: React.PointerEvent) => {
    if (arrastre.current?.puntero !== e.pointerId) return
    arrastre.current = null
    setFija(null)
  }
  const teclear = (
    e: React.KeyboardEvent,
    type: 'table' | 'element',
    g: MesaPlano | ElementoPlano,
  ) => {
    const step = e.shiftKey ? 50 : CUADRICULA
    const flechas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const d = flechas[e.key]
    if (d) {
      e.preventDefault()
      actualizar(type, g.id, (x) => move(x, x.x + d[0], x.y + d[1]))
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      actualizar(type, g.id, (x) => rotate(x, 15))
    } else if (e.key === 'Escape') alElegir(null)
  }

  const figura = (
    type: 'table' | 'element',
    g: MesaPlano | ElementoPlano,
    content: React.ReactNode,
    etiqueta: string,
    isRound: boolean,
  ) => {
    const elegida = seleccion?.id === g.id
    return (
      <div
        key={g.id}
        style={{ ...posicion(g, register, escala), zIndex: elegida ? 10 : undefined }}
      >
        <button
          id={`shape-${g.id}`}
          type="button"
          aria-label={etiqueta}
          aria-pressed={elegida}
          onPointerDown={(e) => empezar(e, type, g, 'move')}
          onPointerMove={seguir}
          onPointerUp={terminar}
          onPointerCancel={terminar}
          onKeyDown={(e) => teclear(e, type, g)}
          onClick={() => alElegir({ type, id: g.id })}
          className={`h-full w-full touch-none cursor-move focus-visible:outline-3 focus-visible:outline-foco ${isRound ? 'rounded-full' : 'rounded-lg'} ${elegida ? 'ring-4 ring-accion-fuerte' : ''}`}
        >
          {content}
        </button>
        {elegida && (
          <span
            aria-hidden="true"
            onPointerDown={(e) => empezar(e, type, g, 'measure')}
            onPointerMove={seguir}
            onPointerUp={terminar}
            onPointerCancel={terminar}
            // 48 px para el dedo; el cuadrito que se ve es más pequeño.
            className="absolute -right-6 -bottom-6 flex size-12 touch-none cursor-nwse-resize items-center justify-center"
          >
            <span className="size-6 rounded-md border-2 border-white bg-accion-fuerte" />
          </span>
        )}
      </div>
    )
  }

  return (
    <Lienzo
      register={register}
      escala={escala}
      refContenedor={ref}
      etiqueta={`Plano de ${b.name || 'la zona nueva'}`}
      alTocarFondo={() => alElegir(null)}
    >
      {elements.map((e) =>
        figura(
          'element',
          e,
          <FiguraElemento type={e.type} text={e.text} escala={escala} />,
          `${TIPOS_ELEMENTO[e.type].name}${e.text ? ` «${e.text}»` : ''}`,
          e.type === 'plant',
        ),
      )}
      {tables.map((m) =>
        figura(
          'table',
          m,
          <span
            className={`flex h-full w-full items-center justify-center border-2 border-libre-fuerte bg-superficie font-titulo text-xl font-bold text-libre-texto ${m.shape === 'round' ? 'rounded-full' : 'rounded-lg'}`}
          >
            <span style={m.rotation ? { transform: `rotate(${-m.rotation}deg)` } : undefined}>
              {m.name}
            </span>
          </span>,
          `Mesa ${m.name}, ${FORMAS[m.shape].name.toLowerCase()}, ${m.capacity} puestos`,
          m.shape === 'round',
        ),
      )}
    </Lienzo>
  )
}

function Numero({
  etiqueta,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  etiqueta: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step?: number
}) {
  // Lo escrito se guarda tal cual mientras se teclea ("1" camino a "150", "-" camino a "-1"); el
  // número se confirma al salir del campo o con Enter. Si no vale, vuelve al que había.
  const [text, setTexto] = useState(String(value))
  const [editando, setEditando] = useState(false)
  const vale = (t: string) => {
    const n = Number(t)
    return t.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
  }
  const confirm = () => {
    setEditando(false)
    if (vale(text)) onChange(Number(text))
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="font-semibold">{etiqueta}</span>
      <input
        type="number"
        inputMode="numeric"
        className={`${field} cifras`}
        value={editando ? text : String(value)}
        min={min}
        max={max}
        step={step}
        onFocus={() => {
          setTexto(String(value))
          setEditando(true)
        }}
        onChange={(e) => {
          setTexto(e.target.value)
          // Las flechitas del campo dan números válidos: se aplican de una vez.
          if (vale(e.target.value)) onChange(Number(e.target.value))
        }}
        onBlur={confirm}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm()
        }}
      />
    </label>
  )
}

function Propiedades({
  b,
  seleccion,
  onChange,
  alElegir,
  alSoltar,
  nombresUsados,
}: {
  b: BorradorZona
  seleccion: NonNullable<Seleccion>
  onChange: (b: BorradorZona) => void
  alElegir: (s: Seleccion) => void
  alSoltar: () => void
  nombresUsados: string[]
}) {
  const table = seleccion.type === 'table' ? b.tables.find((m) => m.id === seleccion.id) : undefined
  const element =
    seleccion.type === 'element' ? b.elements.find((e) => e.id === seleccion.id) : undefined
  const g = table ?? element
  if (!g) return null
  const cambiarMesa = (partial: Partial<MesaPlano>) =>
    onChange({ ...b, tables: b.tables.map((m) => (m.id === g.id ? { ...m, ...partial } : m)) })
  const cambiarElemento = (partial: Partial<ElementoPlano>) =>
    onChange({
      ...b,
      elements: b.elements.map((e) => (e.id === g.id ? { ...e, ...partial } : e)),
    })
  const patch = (partial: Partial<MesaPlano & ElementoPlano>) =>
    table ? cambiarMesa(partial) : cambiarElemento(partial)
  // La copia queda al lado del original, con lo mismo, y elegida (así se ve dónde quedó).
  const duplicateSelected = () => {
    const lado = { x: g.x + g.width + CUADRICULA * 2, y: g.y }
    if (table) {
      const copy: MesaPlano = {
        ...move(table, lado.x, lado.y),
        id: newId(),
        fresh: true,
        name: siguienteNombre(nombresUsados),
      }
      onChange({ ...b, tables: [...b.tables, copy] })
      alElegir({ type: 'table', id: copy.id })
    } else if (element) {
      const copy: ElementoPlano = {
        ...move(element, lado.x, lado.y),
        id: newId(),
        fresh: true,
      }
      onChange({ ...b, elements: [...b.elements, copy] })
      alElegir({ type: 'element', id: copy.id })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {table ? `Mesa ${table.name}` : TIPOS_ELEMENTO[(element as ElementoPlano).type].name}
        </h2>
        <Boton variant="ghost" onClick={alSoltar}>
          Listo
        </Boton>
      </div>
      {table && (
        <>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nombre o número</span>
            <input
              className={field}
              value={table.name}
              maxLength={20}
              onChange={(e) => cambiarMesa({ name: e.target.value })}
            />
          </label>
          <Grupo etiqueta="Forma" className="flex flex-wrap gap-2">
            {(Object.keys(FORMAS) as FormaMesa[]).map((f) => (
              <Opcion
                key={f}
                elegida={table.shape === f}
                alElegir={() => cambiarMesa({ shape: f })}
              >
                {FORMAS[f].name}
              </Opcion>
            ))}
          </Grupo>
          <Numero
            etiqueta="Puestos"
            value={table.capacity}
            min={1}
            max={100}
            onChange={(capacity) => cambiarMesa({ capacity })}
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
            onChange={(e) => cambiarElemento({ text: e.target.value })}
          />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Numero
          etiqueta="Ancho (cm)"
          value={g.width}
          min={20}
          max={10_000}
          step={CUADRICULA}
          onChange={(width) => patch(measure(g, width, g.height))}
        />
        <Numero
          etiqueta="Largo (cm)"
          value={g.height}
          min={20}
          max={10_000}
          step={CUADRICULA}
          onChange={(height) => patch(measure(g, g.width, height))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Girar:</span>
        <Boton onClick={() => patch(rotate(g, -15))}>−15°</Boton>
        <Boton onClick={() => patch(rotate(g, 15))}>+15°</Boton>
        <Boton onClick={() => patch(rotate(g, 90))}>90°</Boton>
        <span className="cifras text-texto-suave">{`${g.rotation}°`}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Boton icono="more" onClick={duplicateSelected}>
          Duplicar
        </Boton>
        <Boton
          onClick={() => {
            patch({ active: false })
            alSoltar()
          }}
        >
          Quitar del plano
        </Boton>
      </div>
    </div>
  )
}

function PropiedadesZona({
  c,
  b,
  onChange,
}: {
  c: CatalogoEdicion
  b: BorradorZona
  onChange: (b: BorradorZona) => void
}) {
  const tables = b.tables.filter((m) => m.active).length
  // Lo archivado se puede volver a poner (con su nombre y su lugar).
  const enBorrador = new Set(b.tables.filter((m) => m.active).map((m) => m.id))
  const archivadas = c.tables.filter((m) => m.zone_id === b.id && !enBorrador.has(m.id))
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
      <Numero
        etiqueta="Piso"
        value={b.level}
        min={-5}
        max={100}
        onChange={(level) => onChange({ ...b, level })}
      />
      <p className="text-texto-suave">
        {`${tables === 1 ? '1 mesa' : `${tables} mesas`}. Toca una mesa o un elemento para cambiarlo.`}
      </p>
      {archivadas.length > 0 && (
        <details>
          <summary className="flex min-h-12 cursor-pointer items-center font-semibold">
            {`Mesas quitadas (${archivadas.length})`}
          </summary>
          <ul className="flex flex-col gap-1">
            {archivadas.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span>{`Mesa ${m.name}`}</span>
                <Boton onClick={() => back(m.id)}>Volver a ponerla</Boton>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!b.fresh && (
        <Boton onClick={() => onChange({ ...b, active: !b.active })}>
          {b.active ? 'Archivar esta zona (y sus mesas)' : 'Mejor no archivarla'}
        </Boton>
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
