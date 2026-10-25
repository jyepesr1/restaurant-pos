import { nuevoId } from '@pos/core'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { buscar } from '../ui/busqueda'
import { Etiqueta } from '../ui/Etiqueta'
import { pesos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import {
  type BorradorGrupo,
  type BorradorProducto,
  borradorDeGrupo,
  borradorDeProducto,
  cambiosDeGrupo,
  cambiosDeProducto,
  grupoNuevo,
  leerPesos,
  problemasDeGrupo,
  problemasDeProducto,
  productoNuevo,
  productosConGrupo,
  productosDeGrupo,
} from './borradores'
import { sala, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'
import type { CambioCatalogo, CatalogoEdicion } from './motor'

// Editor de la carta (tarea 1.1), en la caja: productos con sus tamaños (copa o botella) y sus
// grupos de opciones (término, sabor, adicionales con precio), categorías y estaciones. Al
// guardar, el hub avisa a todos los equipos y les llega la carta nueva. Nada se borra: lo que se
// quita se archiva y se puede volver a poner.
//
// Con solo el permiso `editar_precios` se ven todos los campos pero solo se cambian precios.

type Pestana = 'productos' | 'opciones' | 'categorias'
const ARCHIVADOS = 'archivados'

const campo =
  'min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-lg disabled:opacity-60 focus-visible:outline-3 focus-visible:outline-foco'

export function Carta() {
  const { sesion } = useSala()
  const avisar = useAvisar()
  const [c, setC] = useState<CatalogoEdicion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pestana, setPestana] = useState<Pestana>('productos')
  const [producto, setProducto] = useState<BorradorProducto | null>(null)
  const [grupo, setGrupo] = useState<BorradorGrupo | null>(null)
  const puedeTodo = sesion?.permisos.includes('editar_catalogo') ?? false

  const cargar = useCallback(
    () =>
      sala
        .catalogoParaEditar()
        .then((x) => {
          setC(x)
          setError(null)
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo traer la carta')),
    [],
  )
  useEffect(() => {
    void cargar()
  }, [cargar])

  /** Guarda en el hub; devuelve el mensaje de error, o `null` si quedó guardado. */
  const guardar = async (cambios: CambioCatalogo[], hecho: string) => {
    try {
      await sala.editarCatalogo(cambios)
      await cargar()
      avisar(hecho)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'No se pudo guardar'
    }
  }

  return (
    <MarcoSala titulo="Carta" volver="/">
      <div className="mx-auto max-w-4xl p-3">
        <Grupo etiqueta="Qué editar" className="mb-4 flex flex-wrap gap-2">
          <Opcion elegida={pestana === 'productos'} alElegir={() => setPestana('productos')}>
            Productos
          </Opcion>
          <Opcion elegida={pestana === 'opciones'} alElegir={() => setPestana('opciones')}>
            Grupos de opciones
          </Opcion>
          <Opcion elegida={pestana === 'categorias'} alElegir={() => setPestana('categorias')}>
            Categorías y estaciones
          </Opcion>
        </Grupo>
        {!puedeTodo && (
          <p className="mb-3 rounded-xl bg-neutro-suave p-3 text-neutro-texto">
            Tu rol solo puede cambiar precios.
          </p>
        )}
        {error && (
          <div className="mb-3 flex flex-wrap items-center gap-3" role="alert">
            <span className="text-alerta-texto">{error}</span>
            <Boton onClick={() => void cargar()}>Intentar de nuevo</Boton>
          </div>
        )}
        {!c ? (
          !error && <p className="text-texto-suave">Cargando la carta…</p>
        ) : pestana === 'productos' ? (
          <ListaProductos
            c={c}
            puedeTodo={puedeTodo}
            alAbrir={(id) => setProducto(borradorDeProducto(c, id))}
            alCrear={(categoriaId) => setProducto(productoNuevo(c, categoriaId))}
          />
        ) : pestana === 'opciones' ? (
          <ListaGrupos
            c={c}
            puedeTodo={puedeTodo}
            alAbrir={(id) => setGrupo(borradorDeGrupo(c, id))}
            alCrear={() => setGrupo(grupoNuevo())}
          />
        ) : (
          <Categorias c={c} puedeTodo={puedeTodo} guardar={guardar} />
        )}
      </div>
      {c && producto && (
        <PanelProducto
          c={c}
          inicial={producto}
          puedeTodo={puedeTodo}
          alCerrar={() => setProducto(null)}
          alGuardar={async (b) => {
            const r = await guardar(cambiosDeProducto(c, b), `Guardaste ${b.nombre.trim()}`)
            if (!r) setProducto(null)
            return r
          }}
        />
      )}
      {c && grupo && (
        <PanelGrupo
          c={c}
          inicial={grupo}
          puedeTodo={puedeTodo}
          alCerrar={() => setGrupo(null)}
          alGuardar={async (g) => {
            const r = await guardar(cambiosDeGrupo(c, g), `Guardaste ${g.nombre.trim()}`)
            if (!r) setGrupo(null)
            return r
          }}
        />
      )}
    </MarcoSala>
  )
}

// ── Listas ─────────────────────────────────────────────────────────────

function Fila({
  titulo,
  detalle,
  extremo,
  archivado,
  alTocar,
}: {
  titulo: string
  detalle?: string
  extremo?: string
  archivado: boolean
  alTocar: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={alTocar}
        className="flex min-h-14 w-full items-center gap-3 border-b border-borde px-3 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
      >
        <span className="flex-1">
          <span className="font-semibold">{titulo}</span>
          {detalle && <span className="block text-sm text-texto-suave">{detalle}</span>}
        </span>
        {archivado && <Etiqueta tono="neutro">Archivado</Etiqueta>}
        {extremo && <span className="cifras">{extremo}</span>}
      </button>
    </li>
  )
}

function ListaProductos({
  c,
  puedeTodo,
  alAbrir,
  alCrear,
}: {
  c: CatalogoEdicion
  puedeTodo: boolean
  alAbrir: (id: string) => void
  alCrear: (categoriaId: string) => void
}) {
  const categorias = c.categorias.filter((x) => x.activo)
  const [categoria, setCategoria] = useState(categorias[0]?.id ?? ARCHIVADOS)
  const [busqueda, setBusqueda] = useState('')
  const variantesDe = (id: string) => c.variantes.filter((v) => v.producto_id === id && v.activo)
  const lista = busqueda.trim()
    ? buscar(c.productos, busqueda, (p) => p.nombre)
    : categoria === ARCHIVADOS
      ? // También los activos de una categoría archivada: no salen en la carta de los equipos.
        c.productos.filter((p) => !p.activo || !categorias.some((x) => x.id === p.categoria_id))
      : c.productos.filter((p) => p.categoria_id === categoria && p.activo)

  return (
    <section aria-label="Productos">
      <div className="mb-3 flex flex-wrap gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Buscar un producto</span>
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar un producto"
            className={campo}
          />
        </label>
        {puedeTodo && (
          <Boton
            variante="principal"
            icono="mas"
            disabled={categorias.length === 0}
            onClick={() =>
              alCrear(categoria === ARCHIVADOS ? (categorias[0]?.id ?? '') : categoria)
            }
          >
            Nuevo producto
          </Boton>
        )}
      </div>
      {!busqueda.trim() && (
        <Grupo etiqueta="Categorías" className="-mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {categorias.map((x) => (
            <Opcion key={x.id} elegida={x.id === categoria} alElegir={() => setCategoria(x.id)}>
              {x.nombre}
            </Opcion>
          ))}
          <Opcion elegida={categoria === ARCHIVADOS} alElegir={() => setCategoria(ARCHIVADOS)}>
            Archivados
          </Opcion>
        </Grupo>
      )}
      <ul className="rounded-2xl border border-borde bg-superficie">
        {lista.length === 0 && (
          <li className="p-6 text-center text-texto-suave">No hay productos aquí.</li>
        )}
        {lista.map((p) => {
          const variantes = variantesDe(p.id)
          return (
            <Fila
              key={p.id}
              titulo={p.nombre}
              detalle={
                [
                  variantes.map((v) => v.nombre).join(' · '),
                  p.activo && !categorias.some((x) => x.id === p.categoria_id)
                    ? 'Su categoría está archivada'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' — ') || undefined
              }
              extremo={variantes.length > 0 ? `desde ${pesos(p.precio)}` : pesos(p.precio)}
              archivado={!p.activo}
              alTocar={() => alAbrir(p.id)}
            />
          )
        })}
      </ul>
    </section>
  )
}

function ListaGrupos({
  c,
  puedeTodo,
  alAbrir,
  alCrear,
}: {
  c: CatalogoEdicion
  puedeTodo: boolean
  alAbrir: (id: string) => void
  alCrear: () => void
}) {
  const reglas = (minimo: number, maximo: number) =>
    minimo === 0
      ? `Opcional, hasta ${maximo}`
      : minimo === maximo
        ? `Obligatorio: elige ${minimo}`
        : `Elige de ${minimo} a ${maximo}`
  const grupos = [...c.grupos].sort((a, b) => Number(b.activo) - Number(a.activo))
  return (
    <section aria-label="Grupos de opciones">
      <p className="mb-3 text-texto-suave">
        Un grupo de opciones se pide al tomar el producto: el término de la carne, el sabor o
        adicionales con precio. Un mismo grupo sirve para varios productos.
      </p>
      {puedeTodo && (
        <Boton variante="principal" icono="mas" className="mb-3" onClick={alCrear}>
          Nuevo grupo de opciones
        </Boton>
      )}
      <ul className="rounded-2xl border border-borde bg-superficie">
        {grupos.length === 0 && (
          <li className="p-6 text-center text-texto-suave">Todavía no hay grupos de opciones.</li>
        )}
        {grupos.map((g) => {
          // Los nombres de los productos distinguen dos grupos que se llaman igual ("Sabor").
          const usan = productosDeGrupo(c, g.id).map((p) => p.nombre)
          const quienes =
            usan.length === 0
              ? 'ningún producto'
              : usan.length <= 2
                ? usan.join(' y ')
                : `${usan.slice(0, 2).join(', ')} y ${usan.length - 2} más`
          return (
            <Fila
              key={g.id}
              titulo={g.nombre}
              detalle={`${reglas(g.minimo, g.maximo)} · ${quienes}`}
              archivado={!g.activo}
              alTocar={() => alAbrir(g.id)}
            />
          )
        })}
      </ul>
    </section>
  )
}

// ── Campos ─────────────────────────────────────────────────────────────

function Campo({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control llega en `children`
    <label className="mb-4 flex flex-col gap-1">
      <span className="font-semibold">{etiqueta}</span>
      {children}
    </label>
  )
}

/** Monto en pesos: acepta "40.900" o "40900" y lo muestra con puntos al salir del campo. */
function CampoPesos({
  valor,
  alCambiar,
  alValidar,
  etiqueta,
  disabled,
}: {
  valor: number
  alCambiar: (pesos: number) => void
  /** Avisa si lo escrito es un monto válido: con uno mal escrito no se puede guardar. */
  alValidar: (valido: boolean) => void
  etiqueta: string
  disabled?: boolean
}) {
  const formato = (n: number) => n.toLocaleString('es-CO')
  const [texto, setTexto] = useState(formato(valor))
  const id = useId()
  const valido = leerPesos(texto) !== null
  return (
    <span className="flex flex-col gap-1">
      <input
        aria-label={etiqueta}
        aria-invalid={!valido}
        aria-describedby={valido ? undefined : id}
        inputMode="numeric"
        disabled={disabled}
        value={texto}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setTexto(e.target.value)
          const n = leerPesos(e.target.value)
          alValidar(n !== null)
          if (n !== null) alCambiar(n)
        }}
        onBlur={() => {
          const n = leerPesos(texto)
          if (n !== null) setTexto(formato(n))
        }}
        className={`${campo} cifras text-right ${valido ? '' : 'border-alerta-fuerte'}`}
      />
      {!valido && (
        <span id={id} className="text-sm text-alerta-texto">
          Escribe el valor en pesos, sin centavos
        </span>
      )}
    </span>
  )
}

/** Pie de los paneles: guardar (dice lo que falta o el error del hub) o, al querer cerrar con
 * cambios, confirmar que se descartan. */
function PieGuardar({
  problemas,
  sinCambios,
  error,
  alGuardar,
  confirmandoCierre,
  alSeguir,
  alDescartar,
}: {
  problemas: string[]
  sinCambios: boolean
  error: string | null
  alGuardar: () => Promise<void>
  confirmandoCierre: boolean
  alSeguir: () => void
  alDescartar: () => void
}) {
  const [guardando, setGuardando] = useState(false)
  if (confirmandoCierre)
    return (
      <div className="flex flex-col gap-2">
        <p className="font-semibold" role="alert">
          Tienes cambios sin guardar.
        </p>
        <div className="flex gap-2">
          <Boton variante="secundario" grande className="flex-1" onClick={alDescartar}>
            Descartar
          </Boton>
          {/* El foco va a la opción segura. */}
          <Boton variante="principal" grande className="flex-1" autoFocus onClick={alSeguir}>
            Seguir editando
          </Boton>
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p className="min-h-6 text-alerta-texto" role="alert">
          {error}
        </p>
      ) : (
        <p className="min-h-6 text-alerta-texto" aria-live="polite">
          {problemas[0] ?? ''}
        </p>
      )}
      <Boton
        variante="principal"
        grande
        className="w-full"
        disabled={guardando || problemas.length > 0 || sinCambios}
        onClick={async () => {
          setGuardando(true)
          await alGuardar()
          setGuardando(false)
        }}
      >
        {guardando ? 'Guardando…' : sinCambios ? 'Sin cambios' : 'Guardar'}
      </Boton>
    </div>
  )
}

/** Lo común de los paneles: precios mal escritos y la confirmación al cerrar con cambios. */
function usePanel(sinCambios: boolean, alCerrar: () => void) {
  const [malos, setMalos] = useState<ReadonlySet<string>>(new Set())
  const [confirmando, setConfirmando] = useState(false)
  const validar = (clave: string) => (valido: boolean) =>
    setMalos((m) => {
      const nuevo = new Set(m)
      if (valido) nuevo.delete(clave)
      else nuevo.add(clave)
      return nuevo
    })
  return {
    precioMalo: malos.size > 0 ? ['Hay un precio mal escrito'] : [],
    validar,
    confirmando,
    cerrar: () => (sinCambios ? alCerrar() : setConfirmando(true)),
    seguir: () => setConfirmando(false),
  }
}

// ── Producto ───────────────────────────────────────────────────────────

function PanelProducto({
  c,
  inicial,
  puedeTodo,
  alCerrar,
  alGuardar,
}: {
  c: CatalogoEdicion
  inicial: BorradorProducto
  puedeTodo: boolean
  alCerrar: () => void
  alGuardar: (b: BorradorProducto) => Promise<string | null>
}) {
  const [b, setB] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  const cambiar = (parcial: Partial<BorradorProducto>) => setB((x) => ({ ...x, ...parcial }))
  const variantes = b.variantes.filter((v) => v.activo)
  const cambiarVariante = (id: string, parcial: Partial<BorradorProducto['variantes'][number]>) =>
    cambiar({ variantes: b.variantes.map((v) => (v.id === id ? { ...v, ...parcial } : v)) })
  const grupos = c.grupos.filter((g) => g.activo || b.grupos.includes(g.id))
  const sinCambios = cambiosDeProducto(c, b).length === 0
  const panel = usePanel(sinCambios, alCerrar)

  return (
    <PanelLateral
      abierto
      titulo={inicial.nuevo ? 'Nuevo producto' : inicial.nombre}
      alCerrar={panel.cerrar}
      pie={
        <PieGuardar
          problemas={[...panel.precioMalo, ...problemasDeProducto(b)]}
          sinCambios={sinCambios}
          error={error}
          alGuardar={async () => setError(await alGuardar(b))}
          confirmandoCierre={panel.confirmando}
          alSeguir={panel.seguir}
          alDescartar={alCerrar}
        />
      }
    >
      {!puedeTodo && (
        <p className="mb-4 rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Tu rol solo puede cambiar precios.
        </p>
      )}
      {!b.activo && (
        <p className="mb-4 rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Archivado: no aparece en la carta de los equipos.
        </p>
      )}
      <Campo etiqueta="Nombre">
        <input
          className={campo}
          value={b.nombre}
          maxLength={80}
          disabled={!puedeTodo}
          onChange={(e) => cambiar({ nombre: e.target.value })}
        />
      </Campo>
      <Campo etiqueta="Descripción (opcional)">
        <textarea
          className={`${campo} py-2`}
          rows={2}
          maxLength={300}
          value={b.descripcion}
          disabled={!puedeTodo}
          onChange={(e) => cambiar({ descripcion: e.target.value })}
        />
      </Campo>
      <Campo etiqueta="Categoría">
        <select
          className={campo}
          value={b.categoriaId}
          disabled={!puedeTodo}
          onChange={(e) => cambiar({ categoriaId: e.target.value })}
        >
          {c.categorias
            .filter((x) => x.activo || x.id === b.categoriaId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.nombre}
              </option>
            ))}
        </select>
      </Campo>
      <Campo etiqueta="Impuesto">
        <select
          className={campo}
          value={b.impuestoId}
          disabled={!puedeTodo}
          onChange={(e) => cambiar({ impuestoId: e.target.value })}
        >
          {c.impuestos
            .filter((x) => x.activo || x.id === b.impuestoId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.nombre}
              </option>
            ))}
        </select>
      </Campo>
      {variantes.length === 0 && (
        <Campo etiqueta="Precio (con impuesto incluido)">
          <CampoPesos
            etiqueta={`Precio de ${b.nombre || 'el producto'}`}
            valor={b.precio}
            alCambiar={(precio) => cambiar({ precio })}
            alValidar={panel.validar('producto')}
          />
        </Campo>
      )}

      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">Tamaños (copa, botella…)</legend>
        <p className="mb-2 text-sm text-texto-suave">
          Si el producto tiene tamaños, el mesero debe elegir uno y cada uno tiene su precio.
        </p>
        {variantes.map((v) => (
          <div key={v.id} className="mb-2 flex items-start gap-2">
            <input
              aria-label="Nombre del tamaño"
              className={`${campo} flex-1`}
              value={v.nombre}
              placeholder="Copa"
              maxLength={80}
              disabled={!puedeTodo}
              onChange={(e) => cambiarVariante(v.id, { nombre: e.target.value })}
            />
            <span className="w-36">
              <CampoPesos
                etiqueta={`Precio de ${v.nombre || 'este tamaño'}`}
                valor={v.precio}
                alCambiar={(precio) => cambiarVariante(v.id, { precio })}
                alValidar={panel.validar(v.id)}
              />
            </span>
            {puedeTodo && (
              <Boton
                variante="fantasma"
                icono="cerrar"
                aria-label={`Quitar ${v.nombre || 'este tamaño'}`}
                onClick={() => {
                  panel.validar(v.id)(true)
                  cambiarVariante(v.id, { activo: false })
                }}
              />
            )}
          </div>
        ))}
        {puedeTodo && (
          <Boton
            icono="mas"
            onClick={() =>
              cambiar({
                variantes: [
                  ...b.variantes,
                  { id: nuevoId(), nuevo: true, nombre: '', precio: b.precio, activo: true },
                ],
              })
            }
          >
            Agregar tamaño
          </Boton>
        )}
      </fieldset>

      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">Grupos de opciones que se piden</legend>
        {grupos.length === 0 ? (
          <p className="text-sm text-texto-suave">
            Crea grupos (término, sabor, adicionales) en la pestaña Grupos de opciones.
          </p>
        ) : !puedeTodo ? (
          <p>
            {b.grupos.map((id) => c.grupos.find((g) => g.id === id)?.nombre).join(', ') ||
              'Ninguno'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {grupos.map((g) => {
              const elegido = b.grupos.includes(g.id)
              return (
                <Opcion
                  key={g.id}
                  elegida={elegido}
                  alElegir={() =>
                    cambiar({
                      grupos: elegido ? b.grupos.filter((x) => x !== g.id) : [...b.grupos, g.id],
                    })
                  }
                >
                  {g.nombre}
                </Opcion>
              )
            })}
          </div>
        )}
      </fieldset>

      {puedeTodo && !inicial.nuevo && (
        <Boton variante="secundario" onClick={() => cambiar({ activo: !b.activo })}>
          {b.activo ? 'Archivar (sacar de la carta)' : 'Volver a ponerlo en la carta'}
        </Boton>
      )}
    </PanelLateral>
  )
}

// ── Grupo de opciones ──────────────────────────────────────────────────

function Contador({
  etiqueta,
  valor,
  minimo,
  maximo,
  alCambiar,
  disabled,
}: {
  etiqueta: string
  valor: number
  minimo: number
  maximo: number
  alCambiar: (n: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 font-semibold">{etiqueta}</span>
      <Boton
        icono="menos"
        aria-label={`${etiqueta}: uno menos`}
        disabled={disabled || valor <= minimo}
        onClick={() => alCambiar(valor - 1)}
      />
      <output className="cifras w-8 text-center text-xl font-semibold">{valor}</output>
      <Boton
        icono="mas"
        aria-label={`${etiqueta}: uno más`}
        disabled={disabled || valor >= maximo}
        onClick={() => alCambiar(valor + 1)}
      />
    </div>
  )
}

function PanelGrupo({
  c,
  inicial,
  puedeTodo,
  alCerrar,
  alGuardar,
}: {
  c: CatalogoEdicion
  inicial: BorradorGrupo
  puedeTodo: boolean
  alCerrar: () => void
  alGuardar: (g: BorradorGrupo) => Promise<string | null>
}) {
  const [g, setG] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  const cambiar = (parcial: Partial<BorradorGrupo>) => setG((x) => ({ ...x, ...parcial }))
  const opciones = g.opciones.filter((o) => o.activo)
  const cambiarOpcion = (id: string, parcial: Partial<BorradorGrupo['opciones'][number]>) =>
    cambiar({ opciones: g.opciones.map((o) => (o.id === id ? { ...o, ...parcial } : o)) })
  const usan = productosConGrupo(c, g.id)
  const sinCambios = cambiosDeGrupo(c, g).length === 0
  const panel = usePanel(sinCambios, alCerrar)

  return (
    <PanelLateral
      abierto
      titulo={inicial.nuevo ? 'Nuevo grupo de opciones' : inicial.nombre}
      alCerrar={panel.cerrar}
      pie={
        <PieGuardar
          problemas={[...panel.precioMalo, ...problemasDeGrupo(g)]}
          sinCambios={sinCambios}
          error={error}
          alGuardar={async () => setError(await alGuardar(g))}
          confirmandoCierre={panel.confirmando}
          alSeguir={panel.seguir}
          alDescartar={alCerrar}
        />
      }
    >
      {usan > 0 && (
        <p className="mb-4 rounded-xl bg-proceso-suave p-3 text-proceso-texto">
          {`Lo usan ${usan === 1 ? '1 producto' : `${usan} productos`}: un cambio aquí cambia en todos.`}
        </p>
      )}
      <Campo etiqueta="Nombre">
        <input
          className={campo}
          value={g.nombre}
          placeholder="Término de la carne"
          maxLength={80}
          disabled={!puedeTodo}
          onChange={(e) => cambiar({ nombre: e.target.value })}
        />
      </Campo>
      <div className="mb-4 flex flex-col gap-2">
        <Contador
          etiqueta="Mínimo a elegir"
          valor={g.minimo}
          minimo={0}
          maximo={g.maximo}
          disabled={!puedeTodo}
          alCambiar={(minimo) => cambiar({ minimo })}
        />
        <Contador
          etiqueta="Máximo a elegir"
          valor={g.maximo}
          minimo={Math.max(1, g.minimo)}
          maximo={20}
          disabled={!puedeTodo}
          alCambiar={(maximo) => cambiar({ maximo })}
        />
        <p className="text-sm text-texto-suave">
          {g.minimo === 0
            ? 'Opcional: el mesero puede no elegir nada.'
            : 'Obligatorio: el mesero no puede agregar el producto sin elegir.'}
        </p>
      </div>
      <fieldset className="mb-4">
        <legend className="mb-2 font-semibold">Opciones y su precio extra</legend>
        {opciones.map((o) => (
          <div key={o.id} className="mb-2 flex items-start gap-2">
            <input
              aria-label="Nombre de la opción"
              className={`${campo} flex-1`}
              value={o.nombre}
              placeholder="Tocineta"
              maxLength={80}
              disabled={!puedeTodo}
              onChange={(e) => cambiarOpcion(o.id, { nombre: e.target.value })}
            />
            <span className="w-32">
              <CampoPesos
                etiqueta={`Precio extra de ${o.nombre || 'esta opción'}`}
                valor={o.precioExtra}
                alCambiar={(precioExtra) => cambiarOpcion(o.id, { precioExtra })}
                alValidar={panel.validar(o.id)}
              />
            </span>
            {puedeTodo && (
              <Boton
                variante="fantasma"
                icono="cerrar"
                aria-label={`Quitar ${o.nombre || 'esta opción'}`}
                onClick={() => {
                  panel.validar(o.id)(true)
                  cambiarOpcion(o.id, { activo: false })
                }}
              />
            )}
          </div>
        ))}
        {puedeTodo && (
          <Boton
            icono="mas"
            onClick={() =>
              cambiar({
                opciones: [
                  ...g.opciones,
                  { id: nuevoId(), nuevo: true, nombre: '', precioExtra: 0, activo: true },
                ],
              })
            }
          >
            Agregar opción
          </Boton>
        )}
      </fieldset>
      {puedeTodo && !inicial.nuevo && (
        <Boton variante="secundario" onClick={() => cambiar({ activo: !g.activo })}>
          {g.activo ? 'Archivar el grupo' : 'Volver a usarlo'}
        </Boton>
      )}
    </PanelLateral>
  )
}

// ── Categorías y estaciones ────────────────────────────────────────────

/** Una fila editable con nombre y, si es categoría, su estación. Guarda sola al tocar Guardar. */
function FilaEditable({
  nombre,
  estacionId,
  estaciones,
  activo,
  nuevo,
  puedeTodo,
  alGuardar,
}: {
  nombre: string
  estacionId?: string | null
  estaciones?: CatalogoEdicion['estaciones']
  activo: boolean
  nuevo?: boolean
  puedeTodo: boolean
  alGuardar: (d: {
    nombre: string
    estacionId: string | null
    activo: boolean
  }) => Promise<string | null>
}) {
  const [n, setN] = useState(nombre)
  const [e, setE] = useState(estacionId ?? null)
  const [error, setError] = useState<string | null>(null)
  const cambio = n.trim() !== nombre || e !== (estacionId ?? null)
  const guardar = async (a: boolean) => {
    const r = await alGuardar({ nombre: n.trim(), estacionId: e, activo: a })
    setError(r)
    if (!r && nuevo) setN('')
  }
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-borde p-2">
      <input
        aria-label={nuevo ? 'Nombre' : `Nombre de ${nombre}`}
        className={`${campo} min-w-40 flex-1`}
        value={n}
        placeholder={nuevo ? (estaciones ? 'Nueva categoría' : 'Nueva estación') : undefined}
        maxLength={80}
        disabled={!puedeTodo}
        onChange={(x) => setN(x.target.value)}
      />
      {estaciones && (
        <select
          aria-label="Estación a la que va"
          className={`${campo} w-auto`}
          value={e ?? ''}
          disabled={!puedeTodo}
          onChange={(x) => setE(x.target.value || null)}
        >
          <option value="">Sin estación</option>
          {estaciones
            .filter((x) => x.activo || x.id === e)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.nombre}
              </option>
            ))}
        </select>
      )}
      {puedeTodo && (
        <>
          <Boton
            variante="principal"
            disabled={!n.trim() || (!cambio && !nuevo)}
            onClick={() => void guardar(activo)}
          >
            {nuevo ? 'Agregar' : 'Guardar'}
          </Boton>
          {!nuevo && (
            <Boton
              variante={activo ? 'fantasma' : 'secundario'}
              onClick={() => void guardar(!activo)}
            >
              {activo ? 'Archivar' : 'Volver a usar'}
            </Boton>
          )}
        </>
      )}
      {error && (
        <p className="w-full text-alerta-texto" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

function Categorias({
  c,
  puedeTodo,
  guardar,
}: {
  c: CatalogoEdicion
  puedeTodo: boolean
  guardar: (cambios: CambioCatalogo[], hecho: string) => Promise<string | null>
}) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="titulo-categorias">
        <h2 id="titulo-categorias" className="mb-1 text-lg font-semibold">
          Categorías
        </h2>
        <p className="mb-2 text-texto-suave">
          La estación dice a dónde va la comanda de sus productos (cocina o barra).
        </p>
        <ul className="rounded-2xl border border-borde bg-superficie">
          {c.categorias.map((x) => (
            <FilaEditable
              key={`${x.id}-${x.version}`}
              nombre={x.nombre}
              estacionId={x.estacion_id}
              estaciones={c.estaciones}
              activo={x.activo}
              puedeTodo={puedeTodo}
              alGuardar={(d) =>
                guardar(
                  [
                    {
                      entidad: 'categoria',
                      id: x.id,
                      datos: { nombre: d.nombre, estacion_id: d.estacionId, activo: d.activo },
                    },
                  ],
                  `Guardaste ${d.nombre}`,
                )
              }
            />
          ))}
          {puedeTodo && (
            <FilaEditable
              key={`nueva-${c.version}`}
              nombre=""
              estacionId={c.estaciones.find((x) => x.activo)?.id ?? null}
              estaciones={c.estaciones}
              activo
              nuevo
              puedeTodo
              alGuardar={(d) =>
                guardar(
                  [
                    {
                      entidad: 'categoria',
                      id: nuevoId(),
                      datos: {
                        nombre: d.nombre,
                        orden: c.categorias.length,
                        estacion_id: d.estacionId,
                        activo: true,
                      },
                    },
                  ],
                  `Agregaste ${d.nombre}`,
                )
              }
            />
          )}
        </ul>
      </section>
      <section aria-labelledby="titulo-estaciones">
        <h2 id="titulo-estaciones" className="mb-2 text-lg font-semibold">
          Estaciones
        </h2>
        <ul className="rounded-2xl border border-borde bg-superficie">
          {c.estaciones.map((x) => (
            <FilaEditable
              key={`${x.id}-${x.version}`}
              nombre={x.nombre}
              activo={x.activo}
              puedeTodo={puedeTodo}
              alGuardar={(d) =>
                guardar(
                  [
                    {
                      entidad: 'estacion',
                      id: x.id,
                      datos: { nombre: d.nombre, activo: d.activo },
                    },
                  ],
                  `Guardaste ${d.nombre}`,
                )
              }
            />
          ))}
          {puedeTodo && (
            <FilaEditable
              key={`nueva-estacion-${c.version}`}
              nombre=""
              activo
              nuevo
              puedeTodo
              alGuardar={(d) =>
                guardar(
                  [
                    {
                      entidad: 'estacion',
                      id: nuevoId(),
                      datos: { nombre: d.nombre, orden: c.estaciones.length, activo: true },
                    },
                  ],
                  `Agregaste ${d.nombre}`,
                )
              }
            />
          )}
        </ul>
      </section>
    </div>
  )
}
