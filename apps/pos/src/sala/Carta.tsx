import { newId } from '@pos/core'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { search } from '../ui/busqueda'
import { Etiqueta } from '../ui/Etiqueta'
import { pesos } from '../ui/formato'
import { achicarFoto } from '../ui/foto'
import { Icono } from '../ui/iconos'
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
// Con solo el permiso `edit_prices` se ven todos los campos pero solo se cambian precios.

type Pestana = 'products' | 'options' | 'categories'
const ARCHIVADOS = 'archived'

const field =
  'min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-lg disabled:opacity-60 focus-visible:outline-3 focus-visible:outline-foco'

export function Menu() {
  const { session } = useSala()
  const avisar = useAvisar()
  const [c, setC] = useState<CatalogoEdicion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pestana, setPestana] = useState<Pestana>('products')
  const [product, setProducto] = useState<BorradorProducto | null>(null)
  const [group, setGrupo] = useState<BorradorGrupo | null>(null)
  const puedeTodo = session?.permissions.includes('edit_catalog') ?? false

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
  const guardar = async (changes: CambioCatalogo[], hecho: string) => {
    try {
      await sala.editarCatalogo(changes)
      await cargar()
      avisar(hecho)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'No se pudo guardar'
    }
  }

  return (
    <MarcoSala title="Carta" back="/">
      <div className="mx-auto max-w-4xl p-3">
        <Grupo etiqueta="Qué editar" className="mb-4 flex flex-wrap gap-2">
          <Opcion elegida={pestana === 'products'} alElegir={() => setPestana('products')}>
            Productos
          </Opcion>
          <Opcion elegida={pestana === 'options'} alElegir={() => setPestana('options')}>
            Grupos de opciones
          </Opcion>
          <Opcion elegida={pestana === 'categories'} alElegir={() => setPestana('categories')}>
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
        ) : pestana === 'products' ? (
          <ListaProductos
            c={c}
            puedeTodo={puedeTodo}
            alAbrir={(id) => setProducto(borradorDeProducto(c, id))}
            alCrear={(categoriaId) => setProducto(productoNuevo(c, categoriaId))}
          />
        ) : pestana === 'options' ? (
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
      {c && product && (
        <PanelProducto
          c={c}
          initial={product}
          puedeTodo={puedeTodo}
          alCambiarFoto={() => void cargar()}
          alCerrar={() => setProducto(null)}
          onSave={async (b) => {
            const r = await guardar(cambiosDeProducto(c, b), `Guardaste ${b.name.trim()}`)
            if (!r) setProducto(null)
            return r
          }}
        />
      )}
      {c && group && (
        <PanelGrupo
          c={c}
          initial={group}
          puedeTodo={puedeTodo}
          alCerrar={() => setGrupo(null)}
          onSave={async (g) => {
            const r = await guardar(cambiosDeGrupo(c, g), `Guardaste ${g.name.trim()}`)
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
  title,
  detalle,
  extremo,
  archived,
  alTocar,
}: {
  title: string
  detalle?: string
  extremo?: string
  archived: boolean
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
          <span className="font-semibold">{title}</span>
          {detalle && <span className="block text-sm text-texto-suave">{detalle}</span>}
        </span>
        {archived && <Etiqueta tono="neutral">Archivado</Etiqueta>}
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
  const categories = c.categories.filter((x) => x.active)
  const [category, setCategoria] = useState(categories[0]?.id ?? ARCHIVADOS)
  const [busqueda, setBusqueda] = useState('')
  const variantesDe = (id: string) => c.variants.filter((v) => v.product_id === id && v.active)
  const list = busqueda.trim()
    ? search(c.products, busqueda, (p) => p.name)
    : category === ARCHIVADOS
      ? // También los activos de una categoría archivada: no salen en la carta de los equipos.
        c.products.filter((p) => !p.active || !categories.some((x) => x.id === p.category_id))
      : c.products.filter((p) => p.category_id === category && p.active)

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
            className={field}
          />
        </label>
        {puedeTodo && (
          <Boton
            variant="main"
            icono="more"
            disabled={categories.length === 0}
            onClick={() => alCrear(category === ARCHIVADOS ? (categories[0]?.id ?? '') : category)}
          >
            Nuevo producto
          </Boton>
        )}
      </div>
      {!busqueda.trim() && (
        <Grupo etiqueta="Categorías" className="-mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {categories.map((x) => (
            <Opcion key={x.id} elegida={x.id === category} alElegir={() => setCategoria(x.id)}>
              {x.name}
            </Opcion>
          ))}
          <Opcion elegida={category === ARCHIVADOS} alElegir={() => setCategoria(ARCHIVADOS)}>
            Archivados
          </Opcion>
        </Grupo>
      )}
      <ul className="rounded-2xl border border-borde bg-superficie">
        {list.length === 0 && (
          <li className="p-6 text-center text-texto-suave">No hay productos aquí.</li>
        )}
        {list.map((p) => {
          const variants = variantesDe(p.id)
          return (
            <Fila
              key={p.id}
              title={p.name}
              detalle={
                [
                  variants.map((v) => v.name).join(' · '),
                  p.active && !categories.some((x) => x.id === p.category_id)
                    ? 'Su categoría está archivada'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' — ') || undefined
              }
              extremo={variants.length > 0 ? `desde ${pesos(p.price)}` : pesos(p.price)}
              archived={!p.active}
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
  const reglas = (minimum: number, maximum: number) =>
    minimum === 0
      ? `Opcional, hasta ${maximum}`
      : minimum === maximum
        ? `Obligatorio: elige ${minimum}`
        : `Elige de ${minimum} a ${maximum}`
  const groups = [...c.groups].sort((a, b) => Number(b.active) - Number(a.active))
  return (
    <section aria-label="Grupos de opciones">
      <p className="mb-3 text-texto-suave">
        Un grupo de opciones se pide al tomar el producto: el término de la carne, el sabor o
        adicionales con precio. Un mismo grupo sirve para varios productos.
      </p>
      {puedeTodo && (
        <Boton variant="main" icono="more" className="mb-3" onClick={alCrear}>
          Nuevo grupo de opciones
        </Boton>
      )}
      <ul className="rounded-2xl border border-borde bg-superficie">
        {groups.length === 0 && (
          <li className="p-6 text-center text-texto-suave">Todavía no hay grupos de opciones.</li>
        )}
        {groups.map((g) => {
          // Los nombres de los productos distinguen dos grupos que se llaman igual ("Sabor").
          const usan = productosDeGrupo(c, g.id).map((p) => p.name)
          const quienes =
            usan.length === 0
              ? 'ningún producto'
              : usan.length <= 2
                ? usan.join(' y ')
                : `${usan.slice(0, 2).join(', ')} y ${usan.length - 2} más`
          return (
            <Fila
              key={g.id}
              title={g.name}
              detalle={`${reglas(g.minimum, g.maximum)} · ${quienes}`}
              archived={!g.active}
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
  value,
  onChange,
  alValidar,
  etiqueta,
  disabled,
}: {
  value: number
  onChange: (pesos: number) => void
  /** Avisa si lo escrito es un monto válido: con uno mal escrito no se puede guardar. */
  alValidar: (valid: boolean) => void
  etiqueta: string
  disabled?: boolean
}) {
  const format = (n: number) => n.toLocaleString('es-CO')
  const [text, setTexto] = useState(format(value))
  const id = useId()
  const valid = leerPesos(text) !== null
  return (
    <span className="flex flex-col gap-1">
      <input
        aria-label={etiqueta}
        aria-invalid={!valid}
        aria-describedby={valid ? undefined : id}
        inputMode="numeric"
        disabled={disabled}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setTexto(e.target.value)
          const n = leerPesos(e.target.value)
          alValidar(n !== null)
          if (n !== null) onChange(n)
        }}
        onBlur={() => {
          const n = leerPesos(text)
          if (n !== null) setTexto(format(n))
        }}
        className={`${field} cifras text-right ${valid ? '' : 'border-alerta-fuerte'}`}
      />
      {!valid && (
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
  issues,
  sinCambios,
  error,
  onSave,
  confirmandoCierre,
  alSeguir,
  alDescartar,
}: {
  issues: string[]
  sinCambios: boolean
  error: string | null
  onSave: () => Promise<void>
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
          <Boton variant="secondary" large className="flex-1" onClick={alDescartar}>
            Descartar
          </Boton>
          {/* El foco va a la opción segura. */}
          <Boton variant="main" large className="flex-1" autoFocus onClick={alSeguir}>
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
          {issues[0] ?? ''}
        </p>
      )}
      <Boton
        variant="main"
        large
        className="w-full"
        disabled={guardando || issues.length > 0 || sinCambios}
        onClick={async () => {
          setGuardando(true)
          await onSave()
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
  const validar = (key: string) => (valid: boolean) =>
    setMalos((m) => {
      const fresh = new Set(m)
      if (valid) fresh.delete(key)
      else fresh.add(key)
      return fresh
    })
  return {
    precioMalo: malos.size > 0 ? ['Hay un precio mal escrito'] : [],
    validar,
    confirmando,
    close: () => (sinCambios ? alCerrar() : setConfirmando(true)),
    seguir: () => setConfirmando(false),
  }
}

// ── Producto ───────────────────────────────────────────────────────────

function PanelProducto({
  c,
  initial,
  puedeTodo,
  alCambiarFoto,
  alCerrar,
  onSave,
}: {
  c: CatalogoEdicion
  initial: BorradorProducto
  puedeTodo: boolean
  /** La foto se guarda aparte: la carta del editor se vuelve a leer para que no quede vieja. */
  alCambiarFoto: () => void
  alCerrar: () => void
  onSave: (b: BorradorProducto) => Promise<string | null>
}) {
  const [b, setB] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<BorradorProducto>) => setB((x) => ({ ...x, ...partial }))
  const variants = b.variants.filter((v) => v.active)
  const cambiarVariante = (id: string, partial: Partial<BorradorProducto['variants'][number]>) =>
    patch({ variants: b.variants.map((v) => (v.id === id ? { ...v, ...partial } : v)) })
  const groups = c.groups.filter((g) => g.active || b.groups.includes(g.id))
  const sinCambios = cambiosDeProducto(c, b).length === 0
  const panel = usePanel(sinCambios, alCerrar)

  return (
    <PanelLateral
      opened
      title={initial.fresh ? 'Nuevo producto' : initial.name}
      alCerrar={panel.close}
      pie={
        <PieGuardar
          issues={[...panel.precioMalo, ...problemasDeProducto(b)]}
          sinCambios={sinCambios}
          error={error}
          onSave={async () => setError(await onSave(b))}
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
      {!b.active && (
        <p className="mb-4 rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Archivado: no aparece en la carta de los equipos.
        </p>
      )}
      <Campo etiqueta="Nombre">
        <input
          className={field}
          value={b.name}
          maxLength={80}
          disabled={!puedeTodo}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Campo>
      <Campo etiqueta="Descripción (opcional)">
        <textarea
          className={`${field} py-2`}
          rows={2}
          maxLength={300}
          value={b.description}
          disabled={!puedeTodo}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Campo>
      <Campo etiqueta="Categoría">
        <select
          className={field}
          value={b.categoriaId}
          disabled={!puedeTodo}
          onChange={(e) => patch({ categoriaId: e.target.value })}
        >
          {c.categories
            .filter((x) => x.active || x.id === b.categoriaId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </Campo>
      <Campo etiqueta="Impuesto">
        <select
          className={field}
          value={b.impuestoId}
          disabled={!puedeTodo}
          onChange={(e) => patch({ impuestoId: e.target.value })}
        >
          {c.taxes
            .filter((x) => x.active || x.id === b.impuestoId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </Campo>
      {variants.length === 0 && (
        <Campo etiqueta="Precio (con impuesto incluido)">
          <CampoPesos
            etiqueta={`Precio de ${b.name || 'el producto'}`}
            value={b.price}
            onChange={(price) => patch({ price })}
            alValidar={panel.validar('product')}
          />
        </Campo>
      )}

      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">Tamaños (copa, botella…)</legend>
        <p className="mb-2 text-sm text-texto-suave">
          Si el producto tiene tamaños, el mesero debe elegir uno y cada uno tiene su precio.
        </p>
        {variants.map((v) => (
          <div key={v.id} className="mb-2 flex items-start gap-2">
            <input
              aria-label="Nombre del tamaño"
              className={`${field} flex-1`}
              value={v.name}
              placeholder="Copa"
              maxLength={80}
              disabled={!puedeTodo}
              onChange={(e) => cambiarVariante(v.id, { name: e.target.value })}
            />
            <span className="w-36">
              <CampoPesos
                etiqueta={`Precio de ${v.name || 'este tamaño'}`}
                value={v.price}
                onChange={(price) => cambiarVariante(v.id, { price })}
                alValidar={panel.validar(v.id)}
              />
            </span>
            {puedeTodo && (
              <Boton
                variant="ghost"
                icono="close"
                aria-label={`Quitar ${v.name || 'este tamaño'}`}
                onClick={() => {
                  panel.validar(v.id)(true)
                  cambiarVariante(v.id, { active: false })
                }}
              />
            )}
          </div>
        ))}
        {puedeTodo && (
          <Boton
            icono="more"
            onClick={() =>
              patch({
                variants: [
                  ...b.variants,
                  { id: newId(), fresh: true, name: '', price: b.price, active: true },
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
        {groups.length === 0 ? (
          <p className="text-sm text-texto-suave">
            Crea grupos (término, sabor, adicionales) en la pestaña Grupos de opciones.
          </p>
        ) : !puedeTodo ? (
          <p>
            {b.groups.map((id) => c.groups.find((g) => g.id === id)?.name).join(', ') || 'Ninguno'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => {
              const elegido = b.groups.includes(g.id)
              return (
                <Opcion
                  key={g.id}
                  elegida={elegido}
                  alElegir={() =>
                    patch({
                      groups: elegido ? b.groups.filter((x) => x !== g.id) : [...b.groups, g.id],
                    })
                  }
                >
                  {g.name}
                </Opcion>
              )
            })}
          </div>
        )}
      </fieldset>

      {puedeTodo && !initial.fresh && (
        <FotoProducto
          productId={initial.id}
          photo={c.products.find((p) => p.id === initial.id)?.photo ?? null}
          onChange={alCambiarFoto}
        />
      )}

      {puedeTodo && (
        <label className="mb-4 flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={b.favorite}
            onChange={(e) => patch({ favorite: e.target.checked })}
          />
          <span>
            <span className="font-semibold">Favorito</span>
            <span className="block text-texto-suave">
              Aparece en «Favoritos», lo primero que se ve al tomar el pedido.
            </span>
          </span>
        </label>
      )}

      {puedeTodo && !initial.fresh && (
        <Boton variant="secondary" onClick={() => patch({ active: !b.active })}>
          {b.active ? 'Archivar (sacar de la carta)' : 'Volver a ponerlo en la carta'}
        </Boton>
      )}
    </PanelLateral>
  )
}

// ── Grupo de opciones ──────────────────────────────────────────────────

function Accountant({
  etiqueta,
  value,
  minimum,
  maximum,
  onChange,
  disabled,
}: {
  etiqueta: string
  value: number
  minimum: number
  maximum: number
  onChange: (n: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 font-semibold">{etiqueta}</span>
      <Boton
        icono="minus"
        aria-label={`${etiqueta}: uno menos`}
        disabled={disabled || value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <output className="cifras w-8 text-center text-xl font-semibold">{value}</output>
      <Boton
        icono="more"
        aria-label={`${etiqueta}: uno más`}
        disabled={disabled || value >= maximum}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}

function PanelGrupo({
  c,
  initial,
  puedeTodo,
  alCerrar,
  onSave,
}: {
  c: CatalogoEdicion
  initial: BorradorGrupo
  puedeTodo: boolean
  alCerrar: () => void
  onSave: (g: BorradorGrupo) => Promise<string | null>
}) {
  const [g, setG] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<BorradorGrupo>) => setG((x) => ({ ...x, ...partial }))
  const options = g.options.filter((o) => o.active)
  const cambiarOpcion = (id: string, partial: Partial<BorradorGrupo['options'][number]>) =>
    patch({ options: g.options.map((o) => (o.id === id ? { ...o, ...partial } : o)) })
  const usan = productosConGrupo(c, g.id)
  const sinCambios = cambiosDeGrupo(c, g).length === 0
  const panel = usePanel(sinCambios, alCerrar)

  return (
    <PanelLateral
      opened
      title={initial.fresh ? 'Nuevo grupo de opciones' : initial.name}
      alCerrar={panel.close}
      pie={
        <PieGuardar
          issues={[...panel.precioMalo, ...problemasDeGrupo(g)]}
          sinCambios={sinCambios}
          error={error}
          onSave={async () => setError(await onSave(g))}
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
          className={field}
          value={g.name}
          placeholder="Término de la carne"
          maxLength={80}
          disabled={!puedeTodo}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Campo>
      <div className="mb-4 flex flex-col gap-2">
        <Accountant
          etiqueta="Mínimo a elegir"
          value={g.minimum}
          minimum={0}
          maximum={g.maximum}
          disabled={!puedeTodo}
          onChange={(minimum) => patch({ minimum })}
        />
        <Accountant
          etiqueta="Máximo a elegir"
          value={g.maximum}
          minimum={Math.max(1, g.minimum)}
          maximum={20}
          disabled={!puedeTodo}
          onChange={(maximum) => patch({ maximum })}
        />
        <p className="text-sm text-texto-suave">
          {g.minimum === 0
            ? 'Opcional: el mesero puede no elegir nada.'
            : 'Obligatorio: el mesero no puede agregar el producto sin elegir.'}
        </p>
      </div>
      <fieldset className="mb-4">
        <legend className="mb-2 font-semibold">Opciones y su precio extra</legend>
        {options.map((o) => (
          <div key={o.id} className="mb-2 flex items-start gap-2">
            <input
              aria-label="Nombre de la opción"
              className={`${field} flex-1`}
              value={o.name}
              placeholder="Tocineta"
              maxLength={80}
              disabled={!puedeTodo}
              onChange={(e) => cambiarOpcion(o.id, { name: e.target.value })}
            />
            <span className="w-32">
              <CampoPesos
                etiqueta={`Precio extra de ${o.name || 'esta opción'}`}
                value={o.extraPrice}
                onChange={(extraPrice) => cambiarOpcion(o.id, { extraPrice })}
                alValidar={panel.validar(o.id)}
              />
            </span>
            {puedeTodo && (
              <Boton
                variant="ghost"
                icono="close"
                aria-label={`Quitar ${o.name || 'esta opción'}`}
                onClick={() => {
                  panel.validar(o.id)(true)
                  cambiarOpcion(o.id, { active: false })
                }}
              />
            )}
          </div>
        ))}
        {puedeTodo && (
          <Boton
            icono="more"
            onClick={() =>
              patch({
                options: [
                  ...g.options,
                  { id: newId(), fresh: true, name: '', extraPrice: 0, active: true },
                ],
              })
            }
          >
            Agregar opción
          </Boton>
        )}
      </fieldset>
      {puedeTodo && !initial.fresh && (
        <Boton variant="secondary" onClick={() => patch({ active: !g.active })}>
          {g.active ? 'Archivar el grupo' : 'Volver a usarlo'}
        </Boton>
      )}
    </PanelLateral>
  )
}

// ── Categorías y estaciones ────────────────────────────────────────────

/** Una fila editable con nombre y, si es categoría, su estación. Guarda sola al tocar Guardar. */
function FilaEditable({
  name,
  estacionId,
  stations,
  active,
  fresh,
  puedeTodo,
  onSave,
}: {
  name: string
  estacionId?: string | null
  stations?: CatalogoEdicion['stations']
  active: boolean
  fresh?: boolean
  puedeTodo: boolean
  onSave: (d: {
    name: string
    estacionId: string | null
    active: boolean
  }) => Promise<string | null>
}) {
  const [n, setN] = useState(name)
  const [e, setE] = useState(estacionId ?? null)
  const [error, setError] = useState<string | null>(null)
  const change = n.trim() !== name || e !== (estacionId ?? null)
  const guardar = async (a: boolean) => {
    const r = await onSave({ name: n.trim(), estacionId: e, active: a })
    setError(r)
    if (!r && fresh) setN('')
  }
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-borde p-2">
      <input
        aria-label={fresh ? 'Nombre' : `Nombre de ${name}`}
        className={`${field} min-w-40 flex-1`}
        value={n}
        placeholder={fresh ? (stations ? 'Nueva categoría' : 'Nueva estación') : undefined}
        maxLength={80}
        disabled={!puedeTodo}
        onChange={(x) => setN(x.target.value)}
      />
      {stations && (
        <select
          aria-label="Estación a la que va"
          className={`${field} w-auto`}
          value={e ?? ''}
          disabled={!puedeTodo}
          onChange={(x) => setE(x.target.value || null)}
        >
          <option value="">Sin estación</option>
          {stations
            .filter((x) => x.active || x.id === e)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      )}
      {puedeTodo && (
        <>
          <Boton
            variant="main"
            disabled={!n.trim() || (!change && !fresh)}
            onClick={() => void guardar(active)}
          >
            {fresh ? 'Agregar' : 'Guardar'}
          </Boton>
          {!fresh && (
            <Boton variant={active ? 'ghost' : 'secondary'} onClick={() => void guardar(!active)}>
              {active ? 'Archivar' : 'Volver a usar'}
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
  guardar: (changes: CambioCatalogo[], hecho: string) => Promise<string | null>
}) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="title-categories">
        <h2 id="title-categories" className="mb-1 text-lg font-semibold">
          Categorías
        </h2>
        <p className="mb-2 text-texto-suave">
          La estación dice a dónde va la comanda de sus productos (cocina o barra).
        </p>
        <ul className="rounded-2xl border border-borde bg-superficie">
          {c.categories.map((x) => (
            <FilaEditable
              key={`${x.id}-${x.version}`}
              name={x.name}
              estacionId={x.station_id}
              stations={c.stations}
              active={x.active}
              puedeTodo={puedeTodo}
              onSave={(d) =>
                guardar(
                  [
                    {
                      entity: 'categories',
                      id: x.id,
                      data: { name: d.name, station_id: d.estacionId, active: d.active },
                    },
                  ],
                  `Guardaste ${d.name}`,
                )
              }
            />
          ))}
          {puedeTodo && (
            <FilaEditable
              key={`new-${c.version}`}
              name=""
              estacionId={c.stations.find((x) => x.active)?.id ?? null}
              stations={c.stations}
              active
              fresh
              puedeTodo
              onSave={(d) =>
                guardar(
                  [
                    {
                      entity: 'categories',
                      id: newId(),
                      data: {
                        name: d.name,
                        position: c.categories.length,
                        station_id: d.estacionId,
                        active: true,
                      },
                    },
                  ],
                  `Agregaste ${d.name}`,
                )
              }
            />
          )}
        </ul>
      </section>
      <section aria-labelledby="title-stations">
        <h2 id="title-stations" className="mb-2 text-lg font-semibold">
          Estaciones
        </h2>
        <ul className="rounded-2xl border border-borde bg-superficie">
          {c.stations.map((x) => (
            <FilaEditable
              key={`${x.id}-${x.version}`}
              name={x.name}
              active={x.active}
              puedeTodo={puedeTodo}
              onSave={(d) =>
                guardar(
                  [
                    {
                      entity: 'stations',
                      id: x.id,
                      data: { name: d.name, active: d.active },
                    },
                  ],
                  `Guardaste ${d.name}`,
                )
              }
            />
          ))}
          {puedeTodo && (
            <FilaEditable
              key={`new-station-${c.version}`}
              name=""
              active
              fresh
              puedeTodo
              onSave={(d) =>
                guardar(
                  [
                    {
                      entity: 'stations',
                      id: newId(),
                      data: { name: d.name, position: c.stations.length, active: true },
                    },
                  ],
                  `Agregaste ${d.name}`,
                )
              }
            />
          )}
        </ul>
      </section>
    </div>
  )
}

/**
 * La foto del producto (tarea 1.3c): opcional. Se guarda apenas se elige, aparte del resto del
 * producto, y se achica en el equipo antes de subirla. Sin foto, la carta muestra un ícono.
 */
function FotoProducto({
  productId,
  photo,
  onChange,
}: {
  productId: string
  photo: string | null
  onChange: () => void
}) {
  const [current, setActual] = useState(photo ? `/photos/${photo}` : null)
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entry = useRef<HTMLInputElement>(null)
  const subir = async (imagen: string | null) => {
    setOcupado(true)
    setError(null)
    try {
      setActual(await sala.subirFoto(productId, imagen))
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la foto')
    }
    setOcupado(false)
  }
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="font-semibold">Foto (opcional)</p>
      <div className="flex items-center gap-3">
        <span className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-linea bg-superficie-2">
          {current ? (
            <img src={current} alt="Foto del producto" className="size-full object-cover" />
          ) : (
            <Icono name="photo" className="size-8 text-texto-suave" />
          )}
        </span>
        <span className="flex flex-col gap-2">
          <Boton icono="photo" disabled={ocupado} onClick={() => entry.current?.click()}>
            {ocupado ? 'Guardando…' : current ? 'Cambiar foto' : 'Subir foto'}
          </Boton>
          {current && (
            <Boton variant="ghost" disabled={ocupado} onClick={() => void subir(null)}>
              Quitar foto
            </Boton>
          )}
        </span>
      </div>
      <input
        ref={entry}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const archivo = e.target.files?.[0]
          e.target.value = ''
          if (!archivo) return
          try {
            await subir(await achicarFoto(archivo))
          } catch (x) {
            setError(x instanceof Error ? x.message : 'No se pudo leer la foto')
          }
        }}
      />
      <p className="text-sm text-texto-suave">
        Se guarda apenas la eliges y la ven todos los equipos. Mejor de cerca y con buena luz.
      </p>
      {error && (
        <p className="text-sm text-alerta-texto" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
