import { nuevoId } from '@pos/core'
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
  girar,
  limites,
  type MesaPlano,
  medir,
  mover,
  nuevaMesa,
  nuevoElemento,
  problemasDeZona,
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

type Seleccion = { tipo: 'mesa' | 'elemento'; id: string } | null
type Arrastre = {
  /** El dedo o el mouse que arrastra: un segundo dedo no lo interrumpe. */
  puntero: number
  id: string
  tipo: 'mesa' | 'elemento'
  modo: 'mover' | 'medir'
  inicio: { x: number; y: number }
  original: { x: number; y: number; ancho: number; alto: number; rotacion: number }
}

const campo =
  'min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-lg focus-visible:outline-3 focus-visible:outline-foco'

export function PlanoEditor() {
  const avisar = useAvisar()
  const [c, setC] = useState<CatalogoEdicion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [b, setB] = useState<BorradorZona | null>(null)
  const [seleccion, setSeleccion] = useState<Seleccion>(null)
  const [guardando, setGuardando] = useState(false)
  const [salir, setSalir] = useState<null | (() => void)>(null)
  // "Agregar varias mesas a la vez": abierto o no, y lo elegido.
  const [varias, setVarias] = useState<{
    forma: FormaMesa
    cantidad: number
    porFila: number
  } | null>(null)

  // Una zona nueva que no se ha tocado no cuenta como cambio: su nombre inicial queda aquí.
  const [nombreInicial, setNombreInicial] = useState('')
  const abrirZona = useCallback((x: CatalogoEdicion, id?: string) => {
    const zona = x.zonas.find((z) => z.id === id && z.activo) ?? x.zonas.find((z) => z.activo)
    setB(zona ? borradorDeZona(x, zona.id) : { ...zonaNueva(x), nombre: 'Salón' })
    setNombreInicial(zona ? '' : 'Salón')
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
  const editar = (nuevo: BorradorZona) => {
    setError(null)
    if (b && Date.now() - ultimoCambio.current > 500) setHistorial((h) => [...h.slice(-49), b])
    ultimoCambio.current = Date.now()
    setB(nuevo)
  }
  const deshacer = () => {
    const anterior = historial.at(-1)
    if (!anterior) return
    setHistorial((h) => h.slice(0, -1))
    setB(anterior)
    setSeleccion(null)
  }
  // El foco va a lo que se acaba de agregar o duplicar (si no, queda lejos en el orden de Tab).
  const [enfocar, setEnfocar] = useState<string | null>(null)
  const cambios = c && b ? cambiosDeZona(c, b) : []
  const problemas = c && b ? problemasDeZona(c, b) : []
  const sucio = b?.nuevo
    ? b.mesas.some((m) => m.activo) ||
      b.elementos.some((e) => e.activo) ||
      b.nombre.trim() !== nombreInicial
    : cambios.length > 0

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
  const deshacerRef = useRef(deshacer)
  deshacerRef.current = deshacer

  /** Antes de dejar la zona con cambios, pregunta. */
  const siSePuede = (accion: () => void) => (sucio ? setSalir(() => accion) : accion())

  const guardar = async (): Promise<boolean> => {
    if (!b || !c) return false
    setGuardando(true)
    try {
      await sala.editarCatalogo(cambios)
      avisar(b.activo ? `Guardaste ${b.nombre.trim()}` : `Archivaste ${b.nombre.trim()}`)
      await cargar(b.activo ? b.id : undefined)
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
      <MarcoSala titulo="Plano" volver="/">
        <p className="p-6 text-texto-suave" role={error ? 'alert' : undefined}>
          {error ?? 'Cargando el plano…'}
        </p>
      </MarcoSala>
    )

  const zonas = c.zonas.filter((z) => z.activo)
  const pisosDistintos = new Set(zonas.map((z) => z.piso)).size > 1
  const nombresUsados = [
    ...c.mesas.filter((m) => m.activo && m.zona_id !== b.id).map((m) => m.nombre),
    ...b.mesas.filter((m) => m.activo).map((m) => m.nombre),
  ]
  const agregarMesa = (forma: FormaMesa) => {
    const m = nuevaMesa(b, forma, nombresUsados)
    editar({ ...b, mesas: [...b.mesas, m] })
    setSeleccion({ tipo: 'mesa', id: m.id })
    setEnfocar(m.id)
  }
  const agregarVarias = () => {
    if (!varias) return
    const nuevas = variasMesas(b, varias.forma, varias.cantidad, varias.porFila, nombresUsados)
    editar({ ...b, mesas: [...b.mesas, ...nuevas] })
    setVarias(null)
    avisar(
      `Agregaste ${nuevas.length} mesas: de la ${nuevas[0]?.nombre} a la ${nuevas.at(-1)?.nombre}`,
    )
  }
  const agregarElemento = (tipo: TipoElemento) => {
    const e = nuevoElemento(b, tipo)
    editar({ ...b, elementos: [...b.elementos, e] })
    setSeleccion({ tipo: 'elemento', id: e.id })
    setEnfocar(e.id)
  }

  return (
    <MarcoSala titulo="Plano" volver="/" protegerSalida={siSePuede}>
      <div className="mx-auto flex max-w-7xl flex-col gap-3 p-3">
        <Grupo etiqueta="Zona" className="flex flex-wrap gap-2">
          {zonas.map((z) => (
            <Opcion
              key={z.id}
              elegida={z.id === b.id}
              alElegir={() => z.id !== b.id && siSePuede(() => abrirZona(c, z.id))}
            >
              {pisosDistintos ? `${z.nombre} · piso ${z.piso}` : z.nombre}
            </Opcion>
          ))}
          {b.nuevo && (
            <Opcion elegida alElegir={() => {}}>
              {b.nombre || 'Zona nueva'}
            </Opcion>
          )}
          <Boton
            icono="mas"
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
          <Boton icono="deshacer" disabled={historial.length === 0} onClick={deshacer}>
            Deshacer
          </Boton>
        </Grupo>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Agregar mesa:</span>
          {(Object.keys(FORMAS) as FormaMesa[]).map((f, i) => (
            <Boton
              key={f}
              id={i === 0 ? 'agregar-mesa' : undefined}
              icono="mas"
              onClick={() => agregarMesa(f)}
            >
              {FORMAS[f].nombre}
            </Boton>
          ))}
          <Boton
            variante={varias ? 'principal' : 'secundario'}
            aria-expanded={varias !== null}
            onClick={() =>
              setVarias(varias ? null : { forma: 'cuadrada', cantidad: 10, porFila: 5 })
            }
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
                  elegida={varias.forma === f}
                  alElegir={() => setVarias({ ...varias, forma: f })}
                >
                  {FORMAS[f].nombre}
                </Opcion>
              ))}
            </Grupo>
            <span className="w-28">
              <Numero
                etiqueta="Cuántas"
                valor={varias.cantidad}
                min={1}
                max={60}
                alCambiar={(cantidad) => setVarias({ ...varias, cantidad })}
              />
            </span>
            <span className="w-28">
              <Numero
                etiqueta="Por fila"
                valor={varias.porFila}
                min={1}
                max={20}
                alCambiar={(porFila) => setVarias({ ...varias, porFila })}
              />
            </span>
            <Boton variante="principal" onClick={agregarVarias}>
              {`Agregar ${varias.cantidad}`}
            </Boton>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Agregar al plano:</span>
          {(Object.keys(TIPOS_ELEMENTO) as TipoElemento[]).map((t) => (
            <Boton key={t} icono="mas" onClick={() => agregarElemento(t)}>
              {TIPOS_ELEMENTO[t].nombre}
            </Boton>
          ))}
        </div>

        <div className="flex flex-col gap-3 md:flex-row">
          <div className="min-w-0 flex-1">
            <LienzoEditable
              b={b}
              seleccion={seleccion}
              alElegir={setSeleccion}
              alCambiar={editar}
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
                alCambiar={editar}
                alElegir={(s) => {
                  setSeleccion(s)
                  if (s) setEnfocar(s.id)
                }}
                alSoltar={() => {
                  setSeleccion(null)
                  document.getElementById('agregar-mesa')?.focus()
                }}
                nombresUsados={nombresUsados}
              />
            ) : (
              <PropiedadesZona c={c} b={b} alCambiar={editar} />
            )}
          </aside>
        </div>

        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-borde bg-fondo py-3">
          <p
            className="flex-1 text-alerta-texto"
            role={error ? 'alert' : undefined}
            aria-live="polite"
          >
            {salir ? 'Tienes cambios sin guardar en esta zona.' : (error ?? problemas[0] ?? '')}
          </p>
          {salir ? (
            <>
              <Boton
                onClick={() => {
                  const accion = salir
                  setSalir(null)
                  setError(null)
                  accion()
                }}
              >
                Descartar los cambios
              </Boton>
              {problemas.length === 0 && (
                <Boton
                  disabled={guardando}
                  onClick={async () => {
                    const accion = salir
                    setSalir(null)
                    if (await guardar()) accion()
                  }}
                >
                  Guardar y seguir
                </Boton>
              )}
              {/* El foco va a la opción segura. */}
              <Boton variante="principal" autoFocus onClick={() => setSalir(null)}>
                Seguir editando
              </Boton>
            </>
          ) : (
            <>
              <Boton
                disabled={!sucio || guardando}
                onClick={() => siSePuede(() => abrirZona(c, b.nuevo ? undefined : b.id))}
              >
                Descartar
              </Boton>
              <Boton
                variante="principal"
                grande
                disabled={!sucio || problemas.length > 0 || guardando}
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
  alCambiar,
  enfocar,
  alEnfocar,
}: {
  b: BorradorZona
  seleccion: Seleccion
  alElegir: (s: Seleccion) => void
  alCambiar: (b: BorradorZona) => void
  enfocar: string | null
  alEnfocar: () => void
}) {
  useEffect(() => {
    if (!enfocar) return
    document.getElementById(`figura-${enfocar}`)?.focus()
    alEnfocar()
  })
  const mesas = b.mesas.filter((m) => m.activo)
  const elementos = b.elementos.filter((e) => e.activo)
  const arrastre = useRef<Arrastre | null>(null)
  // Mientras se arrastra, el lienzo no cambia de tamaño ni de escala (si no, todo "salta").
  const [fija, setFija] = useState<Caja | null>(null)
  const caja = fija ?? limites([...mesas, ...elementos], 120)
  const { ref, escala } = useEscala(caja, 1)

  const actualizar = (
    tipo: 'mesa' | 'elemento',
    id: string,
    f: <T extends MesaPlano | ElementoPlano>(x: T) => T,
  ) =>
    alCambiar(
      tipo === 'mesa'
        ? { ...b, mesas: b.mesas.map((m) => (m.id === id ? f(m) : m)) }
        : { ...b, elementos: b.elementos.map((e) => (e.id === id ? f(e) : e)) },
    )

  const empezar = (
    e: React.PointerEvent,
    tipo: 'mesa' | 'elemento',
    g: MesaPlano | ElementoPlano,
    modo: Arrastre['modo'],
  ) => {
    e.stopPropagation()
    if (arrastre.current) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    alElegir({ tipo, id: g.id })
    arrastre.current = {
      puntero: e.pointerId,
      id: g.id,
      tipo,
      modo,
      inicio: { x: e.clientX, y: e.clientY },
      original: { x: g.x, y: g.y, ancho: g.ancho, alto: g.alto, rotacion: g.rotacion },
    }
    setFija(caja)
  }
  const seguir = (e: React.PointerEvent) => {
    const a = arrastre.current
    if (!a || a.puntero !== e.pointerId || escala === 0) return
    const dx = (e.clientX - a.inicio.x) / escala
    const dy = (e.clientY - a.inicio.y) / escala
    if (a.modo === 'mover') {
      actualizar(a.tipo, a.id, (x) => mover(x, a.original.x + dx, a.original.y + dy))
      return
    }
    // El ancho y el largo van en los ejes de la figura: si está girada, el movimiento de la
    // pantalla se pasa a sus ejes.
    const rad = (a.original.rotacion * Math.PI) / 180
    const lx = dx * Math.cos(rad) + dy * Math.sin(rad)
    const ly = -dx * Math.sin(rad) + dy * Math.cos(rad)
    actualizar(a.tipo, a.id, (x) => medir(x, a.original.ancho + lx, a.original.alto + ly))
  }
  const terminar = (e: React.PointerEvent) => {
    if (arrastre.current?.puntero !== e.pointerId) return
    arrastre.current = null
    setFija(null)
  }
  const teclear = (
    e: React.KeyboardEvent,
    tipo: 'mesa' | 'elemento',
    g: MesaPlano | ElementoPlano,
  ) => {
    const paso = e.shiftKey ? 50 : CUADRICULA
    const flechas: Record<string, [number, number]> = {
      ArrowLeft: [-paso, 0],
      ArrowRight: [paso, 0],
      ArrowUp: [0, -paso],
      ArrowDown: [0, paso],
    }
    const d = flechas[e.key]
    if (d) {
      e.preventDefault()
      actualizar(tipo, g.id, (x) => mover(x, x.x + d[0], x.y + d[1]))
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      actualizar(tipo, g.id, (x) => girar(x, 15))
    } else if (e.key === 'Escape') alElegir(null)
  }

  const figura = (
    tipo: 'mesa' | 'elemento',
    g: MesaPlano | ElementoPlano,
    contenido: React.ReactNode,
    etiqueta: string,
    redonda: boolean,
  ) => {
    const elegida = seleccion?.id === g.id
    return (
      <div key={g.id} style={{ ...posicion(g, caja, escala), zIndex: elegida ? 10 : undefined }}>
        <button
          id={`figura-${g.id}`}
          type="button"
          aria-label={etiqueta}
          aria-pressed={elegida}
          onPointerDown={(e) => empezar(e, tipo, g, 'mover')}
          onPointerMove={seguir}
          onPointerUp={terminar}
          onPointerCancel={terminar}
          onKeyDown={(e) => teclear(e, tipo, g)}
          onClick={() => alElegir({ tipo, id: g.id })}
          className={`h-full w-full touch-none cursor-move focus-visible:outline-3 focus-visible:outline-foco ${redonda ? 'rounded-full' : 'rounded-lg'} ${elegida ? 'ring-4 ring-accion-fuerte' : ''}`}
        >
          {contenido}
        </button>
        {elegida && (
          <span
            aria-hidden="true"
            onPointerDown={(e) => empezar(e, tipo, g, 'medir')}
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
      caja={caja}
      escala={escala}
      refContenedor={ref}
      etiqueta={`Plano de ${b.nombre || 'la zona nueva'}`}
      alTocarFondo={() => alElegir(null)}
    >
      {elementos.map((e) =>
        figura(
          'elemento',
          e,
          <FiguraElemento tipo={e.tipo} texto={e.texto} escala={escala} />,
          `${TIPOS_ELEMENTO[e.tipo].nombre}${e.texto ? ` «${e.texto}»` : ''}`,
          e.tipo === 'planta',
        ),
      )}
      {mesas.map((m) =>
        figura(
          'mesa',
          m,
          <span
            className={`flex h-full w-full items-center justify-center border-2 border-libre-fuerte bg-superficie font-titulo text-xl font-bold text-libre-texto ${m.forma === 'redonda' ? 'rounded-full' : 'rounded-lg'}`}
          >
            <span style={m.rotacion ? { transform: `rotate(${-m.rotacion}deg)` } : undefined}>
              {m.nombre}
            </span>
          </span>,
          `Mesa ${m.nombre}, ${FORMAS[m.forma].nombre.toLowerCase()}, ${m.capacidad} puestos`,
          m.forma === 'redonda',
        ),
      )}
    </Lienzo>
  )
}

function Numero({
  etiqueta,
  valor,
  alCambiar,
  min,
  max,
  paso = 1,
}: {
  etiqueta: string
  valor: number
  alCambiar: (n: number) => void
  min: number
  max: number
  paso?: number
}) {
  // Lo escrito se guarda tal cual mientras se teclea ("1" camino a "150", "-" camino a "-1"); el
  // número se confirma al salir del campo o con Enter. Si no vale, vuelve al que había.
  const [texto, setTexto] = useState(String(valor))
  const [editando, setEditando] = useState(false)
  const vale = (t: string) => {
    const n = Number(t)
    return t.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
  }
  const confirmar = () => {
    setEditando(false)
    if (vale(texto)) alCambiar(Number(texto))
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="font-semibold">{etiqueta}</span>
      <input
        type="number"
        inputMode="numeric"
        className={`${campo} cifras`}
        value={editando ? texto : String(valor)}
        min={min}
        max={max}
        step={paso}
        onFocus={() => {
          setTexto(String(valor))
          setEditando(true)
        }}
        onChange={(e) => {
          setTexto(e.target.value)
          // Las flechitas del campo dan números válidos: se aplican de una vez.
          if (vale(e.target.value)) alCambiar(Number(e.target.value))
        }}
        onBlur={confirmar}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirmar()
        }}
      />
    </label>
  )
}

function Propiedades({
  b,
  seleccion,
  alCambiar,
  alElegir,
  alSoltar,
  nombresUsados,
}: {
  b: BorradorZona
  seleccion: NonNullable<Seleccion>
  alCambiar: (b: BorradorZona) => void
  alElegir: (s: Seleccion) => void
  alSoltar: () => void
  nombresUsados: string[]
}) {
  const mesa = seleccion.tipo === 'mesa' ? b.mesas.find((m) => m.id === seleccion.id) : undefined
  const elemento =
    seleccion.tipo === 'elemento' ? b.elementos.find((e) => e.id === seleccion.id) : undefined
  const g = mesa ?? elemento
  if (!g) return null
  const cambiarMesa = (parcial: Partial<MesaPlano>) =>
    alCambiar({ ...b, mesas: b.mesas.map((m) => (m.id === g.id ? { ...m, ...parcial } : m)) })
  const cambiarElemento = (parcial: Partial<ElementoPlano>) =>
    alCambiar({
      ...b,
      elementos: b.elementos.map((e) => (e.id === g.id ? { ...e, ...parcial } : e)),
    })
  const cambiar = (parcial: Partial<MesaPlano & ElementoPlano>) =>
    mesa ? cambiarMesa(parcial) : cambiarElemento(parcial)
  // La copia queda al lado del original, con lo mismo, y elegida (así se ve dónde quedó).
  const duplicar = () => {
    const lado = { x: g.x + g.ancho + CUADRICULA * 2, y: g.y }
    if (mesa) {
      const copia: MesaPlano = {
        ...mover(mesa, lado.x, lado.y),
        id: nuevoId(),
        nuevo: true,
        nombre: siguienteNombre(nombresUsados),
      }
      alCambiar({ ...b, mesas: [...b.mesas, copia] })
      alElegir({ tipo: 'mesa', id: copia.id })
    } else if (elemento) {
      const copia: ElementoPlano = {
        ...mover(elemento, lado.x, lado.y),
        id: nuevoId(),
        nuevo: true,
      }
      alCambiar({ ...b, elementos: [...b.elementos, copia] })
      alElegir({ tipo: 'elemento', id: copia.id })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {mesa ? `Mesa ${mesa.nombre}` : TIPOS_ELEMENTO[(elemento as ElementoPlano).tipo].nombre}
        </h2>
        <Boton variante="fantasma" onClick={alSoltar}>
          Listo
        </Boton>
      </div>
      {mesa && (
        <>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nombre o número</span>
            <input
              className={campo}
              value={mesa.nombre}
              maxLength={20}
              onChange={(e) => cambiarMesa({ nombre: e.target.value })}
            />
          </label>
          <Grupo etiqueta="Forma" className="flex flex-wrap gap-2">
            {(Object.keys(FORMAS) as FormaMesa[]).map((f) => (
              <Opcion key={f} elegida={mesa.forma === f} alElegir={() => cambiarMesa({ forma: f })}>
                {FORMAS[f].nombre}
              </Opcion>
            ))}
          </Grupo>
          <Numero
            etiqueta="Puestos"
            valor={mesa.capacidad}
            min={1}
            max={100}
            alCambiar={(capacidad) => cambiarMesa({ capacidad })}
          />
        </>
      )}
      {elemento?.tipo === 'texto' && (
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Texto</span>
          <input
            className={campo}
            value={elemento.texto ?? ''}
            maxLength={60}
            onChange={(e) => cambiarElemento({ texto: e.target.value })}
          />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Numero
          etiqueta="Ancho (cm)"
          valor={g.ancho}
          min={20}
          max={10_000}
          paso={CUADRICULA}
          alCambiar={(ancho) => cambiar(medir(g, ancho, g.alto))}
        />
        <Numero
          etiqueta="Largo (cm)"
          valor={g.alto}
          min={20}
          max={10_000}
          paso={CUADRICULA}
          alCambiar={(alto) => cambiar(medir(g, g.ancho, alto))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Girar:</span>
        <Boton onClick={() => cambiar(girar(g, -15))}>−15°</Boton>
        <Boton onClick={() => cambiar(girar(g, 15))}>+15°</Boton>
        <Boton onClick={() => cambiar(girar(g, 90))}>90°</Boton>
        <span className="cifras text-texto-suave">{`${g.rotacion}°`}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Boton icono="mas" onClick={duplicar}>
          Duplicar
        </Boton>
        <Boton
          onClick={() => {
            cambiar({ activo: false })
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
  alCambiar,
}: {
  c: CatalogoEdicion
  b: BorradorZona
  alCambiar: (b: BorradorZona) => void
}) {
  const mesas = b.mesas.filter((m) => m.activo).length
  // Lo archivado se puede volver a poner (con su nombre y su lugar).
  const enBorrador = new Set(b.mesas.filter((m) => m.activo).map((m) => m.id))
  const archivadas = c.mesas.filter((m) => m.zona_id === b.id && !enBorrador.has(m.id))
  const volver = (id: string) => {
    const m = c.mesas.find((x) => x.id === id)
    if (!m) return
    const resto = b.mesas.filter((x) => x.id !== id)
    alCambiar({
      ...b,
      mesas: [
        ...resto,
        {
          id: m.id,
          nuevo: false,
          nombre: m.nombre,
          forma: m.forma,
          capacidad: m.capacidad,
          activo: true,
          x: m.x,
          y: m.y,
          ancho: m.ancho,
          alto: m.alto,
          rotacion: m.rotacion,
        },
      ],
    })
  }
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{b.nuevo ? 'Zona nueva' : 'Esta zona'}</h2>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Nombre</span>
        <input
          className={campo}
          value={b.nombre}
          placeholder="Terraza"
          maxLength={80}
          onChange={(e) => alCambiar({ ...b, nombre: e.target.value })}
        />
      </label>
      <Numero
        etiqueta="Piso"
        valor={b.piso}
        min={-5}
        max={100}
        alCambiar={(piso) => alCambiar({ ...b, piso })}
      />
      <p className="text-texto-suave">
        {`${mesas === 1 ? '1 mesa' : `${mesas} mesas`}. Toca una mesa o un elemento para cambiarlo.`}
      </p>
      {archivadas.length > 0 && (
        <details>
          <summary className="flex min-h-12 cursor-pointer items-center font-semibold">
            {`Mesas quitadas (${archivadas.length})`}
          </summary>
          <ul className="flex flex-col gap-1">
            {archivadas.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span>{`Mesa ${m.nombre}`}</span>
                <Boton onClick={() => volver(m.id)}>Volver a ponerla</Boton>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!b.nuevo && (
        <Boton onClick={() => alCambiar({ ...b, activo: !b.activo })}>
          {b.activo ? 'Archivar esta zona (y sus mesas)' : 'Mejor no archivarla'}
        </Boton>
      )}
      {!b.activo && (
        <p className="rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Al guardar, la zona y sus mesas dejan de verse en el salón. Una mesa con un pedido abierto
          no se puede archivar.
        </p>
      )}
    </div>
  )
}
