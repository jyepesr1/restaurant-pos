import { type EstadoPedido, type ItemPedido, nuevoId, totalesItem } from '@pos/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { buscar } from '../ui/busqueda'
import { pesos } from '../ui/formato'
import { Icono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar, useRuta } from '../ui/ruta'
import { sala, useSala, useVistaLocal } from './contexto'
import { MarcoSala } from './MarcoSala'
import {
  CANALES,
  CURSOS,
  type Curso,
  comandasDeCurso,
  comandasPorEstacion,
  copiaDe,
  datosItem,
  elCurso,
  faltaElegir,
  lineaIgual,
  type ProductoCatalogo,
  pideOpciones,
  porEnviar,
  precioElegido,
} from './pedido'
import { claveAgotado, itemsVigentes, type PedidoVisible } from './proyeccion'

// Toma de pedido (brief §4.2 y §5, regla 2): tocar productos y "Enviar". Cada toque es un evento
// guardado aquí antes de mostrarse; se envía al hub cuando haya conexión.
// - Para quién (la mesa o la persona 1, 2…) y en qué curso va lo que se agregue: se elige arriba y
//   vale para lo siguiente. El mismo producto otra vez suma a su línea.
// - Un curso se puede retener y marchar después (la entrada sale ya; el fuerte, cuando se pida).
// - Lo agotado (86) se ve en todos los equipos al instante; quien tiene permiso lo marca aquí.
// La mesa queda ocupada al agregar el primer producto, no al abrirla.

const TEXTO_ESTADO: Record<string, string> = {
  pendiente: 'sin enviar',
  retenido: 'retenido',
  enviado: 'enviado',
  en_preparacion: 'en preparación',
  listo: 'listo',
  entregado: 'entregado',
}

type Canal = 'salon' | keyof typeof CANALES
/** Lo más que lleva una línea desde la pantalla (el esquema admite hasta 999). */
const MAXIMO_LINEA = 99

const FAVORITOS = '__favoritos'
const MAS_PEDIDOS = '__mas'
const RESULTADOS = 40

export function TomaPedido() {
  const { parametros } = useRuta()
  const { catalogo, sesion } = useSala()
  const vista = useVistaLocal()
  const pedidos = vista?.pedidos ?? null
  const agotados = vista?.agotados ?? new Set<string>()
  const avisar = useAvisar()
  const mesaId = parametros.get('mesa')
  const canalNuevo = (parametros.get('canal') as Canal | null) ?? (mesaId ? 'salon' : null)
  const mesa = mesaId ? catalogo?.mesas.find((m) => m.id === mesaId) : undefined
  const [busqueda, setBusqueda] = useState('')
  const [categoria, setCategoria] = useState<string | null>(null)
  const [elegido, setElegido] = useState<ProductoCatalogo | null>(null)
  const [editando, setEditando] = useState<string | null>(null)
  const [verPedido, setVerPedido] = useState(false)
  const [comensal, setComensal] = useState<number | null>(null)
  const [curso, setCurso] = useState<Curso | null>(null)
  const [comensalesIniciales, setComensalesIniciales] = useState(0)
  const [marcandoAgotados, setMarcandoAgotados] = useState(false)
  const [agotando, setAgotando] = useState<ProductoCatalogo | null>(null)
  const campoBusqueda = useRef<HTMLInputElement>(null)
  // El pedido que se abrió aquí: los toques seguidos van al mismo aunque aún no se haya releído.
  const abierto = useRef<string | null>(null)
  // Los toques se guardan uno tras otro, en el orden en que se hicieron.
  const cola = useRef<Promise<void>>(Promise.resolve())
  const puedeAgotar = sesion?.permisos.includes('agotar_producto') ?? false

  // "/" lleva a la búsqueda (atajo de caja, brief §5, regla 8).
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement).closest('input, textarea')) return
      e.preventDefault()
      campoBusqueda.current?.focus()
    }
    window.addEventListener('keydown', alTeclear)
    return () => window.removeEventListener('keydown', alTeclear)
  }, [])

  if (!catalogo || (mesaId && !mesa) || (!mesaId && !canalNuevo && !parametros.get('pedido'))) {
    return (
      <MarcoSala titulo="Pedido" volver="/">
        <p className="p-6 text-texto-suave">Esta mesa o este pedido no existe.</p>
      </MarcoSala>
    )
  }

  // El pedido: el elegido, el que se abrió aquí o el primero de la mesa.
  const candidatos = (pedidos ?? []).filter((p) =>
    mesaId ? p.estado.mesaId === mesaId : p.estado.id === parametros.get('pedido'),
  )
  const elegidoId =
    parametros.get('pedido') ??
    abierto.current ??
    (mesaId ? candidatos[0]?.estado.id : null) ??
    null
  const pedido = (pedidos ?? []).find((p) => p.estado.id === elegidoId) ?? null
  const canal: Canal = pedido?.estado.canal ?? canalNuevo ?? 'salon'
  const comensales = pedido?.estado.comensales ?? comensalesIniciales
  const titulo = mesa
    ? `Mesa ${mesa.nombre}`
    : `${canal === 'salon' ? 'Pedido' : CANALES[canal]}${pedido?.estado.numeroDia ? ` #${pedido.estado.numeroDia}` : ''}`
  const productos = catalogo.categorias.flatMap((c) => c.productos)
  const agotado = (p: ProductoCatalogo) => agotados.has(claveAgotado(p.id))

  const enOrden = (trabajo: () => Promise<void>) => {
    cola.current = cola.current.then(trabajo).catch((e) => {
      console.error(e)
      avisar(e instanceof Error ? e.message : 'No se pudo guardar')
    })
  }
  /** El pedido guardado (no el de la última pantalla): un toque anterior pudo cambiarlo. */
  const pedidoGuardado = async () => {
    const id = elegidoId ?? abierto.current
    return id ? ((await sala.sync?.pedido(id)) ?? null) : null
  }
  /** El pedido al que va lo que se agregue; si aún no existe, se abre. */
  const asegurarPedido = async () => {
    const id = elegidoId ?? abierto.current
    if (id) return id
    const nuevo = nuevoId()
    await sala.registrar('PedidoAbierto', nuevo, {
      canal,
      mesa_id: mesaId ?? null,
      comensales: comensalesIniciales,
    })
    // Solo después de guardarlo: si falló, el próximo toque lo vuelve a intentar.
    abierto.current = nuevo
    // Un pedido sin mesa se sigue por su id (la mesa no lo identifica).
    if (!mesaId) navegar(`/pedido?pedido=${nuevo}`)
    return nuevo
  }
  /** La línea tal como está guardada, si aún no se envió. */
  const lineaGuardada = async (itemId: string) => {
    const estado = await pedidoGuardado()
    const item = estado?.items[itemId]
    return estado && item && (item.estado === 'pendiente' || item.estado === 'retenido')
      ? { estado, item }
      : null
  }
  /**
   * Los datos para volver a agregar un ítem como está ahora (otra `item_id`), con la versión de
   * catálogo con que se agregó: el precio era el de esa carta.
   */
  const copiaActual = async (item: ItemPedido) => {
    const original = (await sala.sync?.locales())?.find(
      (l) => l.evento.tipo === 'ItemAgregado' && l.evento.datos.item_id === item.id,
    )?.evento
    return original?.tipo === 'ItemAgregado'
      ? {
          ...original.datos,
          item_id: nuevoId(),
          cantidad: item.cantidad - item.cantidadAnulada,
          comensal: item.comensal,
          curso: item.curso,
          notas: item.notas,
        }
      : copiaDe(item, catalogo.version)
  }

  /**
   * Suma o resta unidades a una línea sin enviar, a partir de lo guardado (dos toques seguidos
   * cuentan dos). Si queda en 0, la quita con Deshacer.
   */
  const sumar = (itemId: string, delta: number, deshacible = true) =>
    enOrden(async () => {
      const linea = await lineaGuardada(itemId)
      if (!linea) {
        avisar('Esa línea ya se envió o ya no está')
        return
      }
      const cantidad = linea.item.cantidad + delta
      if (cantidad <= 0) {
        await quitarYa(linea.estado, linea.item)
        return
      }
      if (cantidad > MAXIMO_LINEA) {
        avisar(`Una línea lleva hasta ${MAXIMO_LINEA}`)
        return
      }
      await sala.registrar('ItemCambiado', linea.estado.id, { item_id: itemId, cantidad })
      if (deshacible && delta > 0)
        avisar(`${linea.item.nombre}: ${cantidad}`, () => sumar(itemId, -delta, false))
    })

  const agregar = (
    p: ProductoCatalogo,
    varianteId: string | null,
    elegidas: Record<string, string[]>,
    extras: { cantidad?: number; notas?: string } = {},
  ) =>
    enOrden(async () => {
      // Antes de abrir el pedido: si falta elegir algo, no queda un pedido vacío en la mesa.
      const datos = datosItem(catalogo, p, varianteId, elegidas, { ...extras, comensal, curso })
      const id = await asegurarPedido()
      const igual = lineaIgual(await pedidoGuardado(), datos)
      if (igual) {
        const cantidad = Math.min(MAXIMO_LINEA, igual.cantidad + datos.cantidad)
        const sumado = cantidad - igual.cantidad
        if (sumado === 0) {
          avisar(`Una línea lleva hasta ${MAXIMO_LINEA}`)
          return
        }
        await sala.registrar('ItemCambiado', id, { item_id: igual.id, cantidad })
        // Deshacer resta lo que se sumó, sobre lo que haya entonces.
        avisar(`${igual.nombre}: ${cantidad}`, () => sumar(igual.id, -sumado, false))
        return
      }
      await sala.registrar('ItemAgregado', id, datos)
      avisar(`Agregaste ${datos.nombre}`, () => sumar(datos.item_id, -datos.cantidad, false))
    })

  /** Quita la línea (ya dentro de la cola) y deja Deshacer, que la vuelve a agregar como estaba. */
  const quitarYa = async (estado: EstadoPedido, item: ItemPedido) => {
    const copia = await copiaActual(item)
    await sala.registrar('ItemQuitado', estado.id, { item_id: item.id })
    avisar(`Quitaste ${item.nombre}`, () =>
      enOrden(() => sala.registrar('ItemAgregado', estado.id, copia).then(() => {})),
    )
  }
  const quitar = (itemId: string) =>
    enOrden(async () => {
      const linea = await lineaGuardada(itemId)
      if (linea) await quitarYa(linea.estado, linea.item)
    })

  /** Cambia para quién, el curso o la nota de una línea sin enviar. */
  const cambiarItem = (
    itemId: string,
    cambio: { comensal?: number | null; curso?: Curso | null; notas?: string | null },
  ) =>
    enOrden(async () => {
      const linea = await lineaGuardada(itemId)
      if (!linea) {
        avisar('Esa línea ya se envió o ya no está')
        return
      }
      await sala.registrar('ItemCambiado', linea.estado.id, { item_id: itemId, ...cambio })
    })

  const duplicar = (itemId: string) =>
    enOrden(async () => {
      const estado = await pedidoGuardado()
      const item = estado?.items[itemId]
      if (!estado || !item) return
      await sala.registrar('ItemAgregado', estado.id, await copiaActual(item))
      avisar(`Duplicaste ${item.nombre}`)
    })

  /** Una persona más o menos, sobre lo guardado; no baja de la mayor persona que tiene algo. */
  const cambiarComensales = (delta: number) => {
    if (!pedido) {
      setComensalesIniciales((n) => Math.max(0, Math.min(200, n + delta)))
      return
    }
    enOrden(async () => {
      const estado = await pedidoGuardado()
      if (!estado) return
      const enUso = Math.max(0, ...itemsVigentes(estado).map((i) => i.comensal ?? 0))
      const n = estado.comensales + delta
      if (n < enUso) {
        avisar(`La persona ${enUso} tiene cosas: pásalas a otra antes de quitarla`)
        return
      }
      if (n < 0 || n > 200) return
      if (comensal !== null && comensal > n) setComensal(null)
      await sala.registrar('ComensalesCambiados', estado.id, { comensales: n })
    })
  }

  // Sin conexión queda guardado aquí, pero cocina todavía no lo tiene: no decir "Enviado".
  const avisarEnvio = (cuantos: number, que = 'a cocina y barra') =>
    avisar(
      sala.instantanea().conexion === 'conectado'
        ? `Enviado ${que} (${cuantos})`
        : `Guardado (${cuantos}): llega a cocina cuando vuelva la conexión`,
    )

  /** Enviar lo pendiente (lo retenido espera a que se marche su curso). */
  const enviar = () =>
    enOrden(async () => {
      const estado = await pedidoGuardado()
      if (!estado) return
      const cuantos = porEnviar(estado).length
      if (cuantos === 0) return
      const datos = comandasPorEstacion(catalogo, estado)
      if (!datos) {
        avisar('No hay a dónde enviar: la carta no tiene cocina ni barra')
        return
      }
      await sala.registrar('ItemsEnviados', estado.id, datos)
      navigator.vibrate?.(60)
      avisarEnvio(cuantos)
      setVerPedido(false)
      navegar('/')
    })

  const retener = (c: Curso) =>
    enOrden(async () => {
      const estado = await pedidoGuardado()
      if (!estado) return
      await sala.registrar('CursoRetenido', estado.id, { curso: c })
      const texto = elCurso(c)
      avisar(`${texto[0]?.toUpperCase()}${texto.slice(1)} espera: márchalo cuando lo pidan`)
    })
  /** Marchar: el curso deja de esperar y sale a cocina de una vez. */
  const marchar = (c: Curso) =>
    enOrden(async () => {
      const estado = await pedidoGuardado()
      if (!estado) return
      await sala.registrar('CursoMarchado', estado.id, { curso: c })
      const ahora = await pedidoGuardado()
      const datos = ahora ? comandasDeCurso(catalogo, ahora, c) : null
      if (ahora && datos) {
        await sala.registrar('ItemsEnviados', ahora.id, datos)
        avisarEnvio(
          datos.comandas.reduce((s, x) => s + x.item_ids.length, 0),
          elCurso(c),
        )
      }
    })

  /** Marca agotado o disponible el producto entero o una variante (la botella, no la copa). */
  const alternarAgotado = (
    p: ProductoCatalogo,
    varianteId: string | null,
    agotar: boolean,
    deshacible = true,
  ): void =>
    enOrden(async () => {
      await sala.registrar(agotar ? 'ProductoAgotado' : 'ProductoDisponible', p.id, {
        producto_id: p.id,
        variante_id: varianteId,
      })
      const variante = p.variantes.find((v) => v.id === varianteId)
      const nombre = variante ? `${p.nombre} (${variante.nombre})` : p.nombre
      const texto = agotar ? `${nombre}: agotado` : `${nombre} vuelve a estar disponible`
      if (deshacible) avisar(texto, () => alternarAgotado(p, varianteId, !agotar, false))
      else avisar(texto)
    })

  const tocarProducto = (p: ProductoCatalogo) => {
    if (marcandoAgotados) {
      if (p.variantes.length > 0) setAgotando(p)
      else alternarAgotado(p, null, !agotado(p))
    } else if (agotado(p)) avisar(`${p.nombre} está agotado`)
    else if (pideOpciones(p)) setElegido(p)
    else agregar(p, null, {})
  }

  const favoritos = productos.filter((p) => p.favorito)
  const masPedidos = (vista?.masPedidos ?? [])
    .map((id) => productos.find((p) => p.id === id))
    .filter((p): p is ProductoCatalogo => p !== undefined)
  const categoriaActual =
    categoria ??
    (favoritos.length > 0
      ? FAVORITOS
      : masPedidos.length > 0
        ? MAS_PEDIDOS
        : catalogo.categorias[0]?.id)
  const lista = busqueda.trim()
    ? buscar(productos, busqueda, (p) => `${p.nombre} ${p.descripcion ?? ''}`)
    : categoriaActual === FAVORITOS
      ? favoritos
      : categoriaActual === MAS_PEDIDOS
        ? masPedidos
        : (catalogo.categorias.find((c) => c.id === categoriaActual)?.productos ?? [])
  // Cuántos van sin enviar (también lo retenido, que espera su curso).
  const enPedido = (productoId: string) =>
    pedido
      ? itemsVigentes(pedido.estado)
          .filter(
            (i) =>
              i.productoId === productoId && (i.estado === 'pendiente' || i.estado === 'retenido'),
          )
          .reduce((s, i) => s + i.cantidad, 0)
      : 0
  const faltan = pedido ? porEnviar(pedido.estado).length : 0
  const itemEditado = pedido && editando ? (pedido.estado.items[editando] ?? null) : null

  const botonEnviar = (
    <Boton
      variante="principal"
      grande
      icono="enviar"
      className="w-full"
      disabled={faltan === 0}
      onClick={enviar}
    >
      {faltan === 0 ? 'Enviar' : `Enviar ${faltan}`}
    </Boton>
  )
  const ticket = (
    <Ticket
      pedido={pedido}
      comensales={comensales}
      enSalon={canal === 'salon'}
      alCambiarComensales={cambiarComensales}
      alTocarItem={(i) => setEditando(i.id)}
      alSumar={(i, delta) => sumar(i.id, delta)}
      alRetener={retener}
      alMarchar={marchar}
    />
  )

  return (
    <MarcoSala titulo={titulo} volver="/">
      <div className="mx-auto flex max-w-6xl gap-4 p-3 pb-28 md:pb-3">
        <section className="min-w-0 flex-1" aria-label="Carta">
          {mesaId && candidatos.length > 1 && (
            <Grupo etiqueta="Pedidos de la mesa" className="mb-3 flex flex-wrap gap-2">
              {candidatos.map((p, i) => (
                <Opcion
                  key={p.estado.id}
                  elegida={p.estado.id === elegidoId}
                  alElegir={() => navegar(`/pedido?mesa=${mesaId}&pedido=${p.estado.id}`)}
                >
                  {`Pedido ${i + 1}`}
                </Opcion>
              ))}
            </Grupo>
          )}

          <div className="flex gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Buscar en la carta</span>
              <Icono
                nombre="buscar"
                className="absolute top-1/2 left-3 -translate-y-1/2 text-texto-suave"
              />
              <input
                ref={campoBusqueda}
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setBusqueda('')
                  // Con una sola coincidencia, Enter la agrega (atajo de caja).
                  if (e.key === 'Enter' && lista.length === 1 && lista[0]) {
                    tocarProducto(lista[0])
                    setBusqueda('')
                  }
                }}
                placeholder="Buscar: «hamburgesa», «aperol»…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="min-h-12 w-full rounded-xl border border-borde bg-superficie pr-3 pl-11 text-lg placeholder:text-texto-suave focus-visible:outline-3 focus-visible:outline-foco"
              />
            </label>
            {puedeAgotar && (
              <Boton
                variante={marcandoAgotados ? 'principal' : 'secundario'}
                aria-pressed={marcandoAgotados}
                onClick={() => setMarcandoAgotados(!marcandoAgotados)}
              >
                {marcandoAgotados ? 'Listo' : 'Agotados'}
              </Boton>
            )}
          </div>
          {marcandoAgotados && (
            <p className="mt-2 rounded-xl bg-alerta-suave p-3 text-alerta-texto" role="status">
              Toca un producto para marcarlo agotado o disponible. Se ve al instante en todos los
              equipos. Toca «Listo» al terminar.
            </p>
          )}

          {!busqueda.trim() && (
            <Grupo
              etiqueta="Categorías"
              className="-mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1"
            >
              {favoritos.length > 0 && (
                <Opcion
                  elegida={categoriaActual === FAVORITOS}
                  alElegir={() => setCategoria(FAVORITOS)}
                >
                  Favoritos
                </Opcion>
              )}
              {masPedidos.length > 0 && (
                <Opcion
                  elegida={categoriaActual === MAS_PEDIDOS}
                  alElegir={() => setCategoria(MAS_PEDIDOS)}
                >
                  Lo más pedido
                </Opcion>
              )}
              {catalogo.categorias.map((c) => (
                <Opcion
                  key={c.id}
                  elegida={c.id === categoriaActual}
                  alElegir={() => setCategoria(c.id)}
                >
                  {c.nombre}
                </Opcion>
              ))}
            </Grupo>
          )}

          <ElegirPara
            comensales={canal === 'salon' ? comensales : 0}
            preguntarPersonas={canal === 'salon' && comensales === 0}
            comensal={comensal}
            curso={curso}
            alElegirComensal={setComensal}
            alElegirCurso={setCurso}
            alContarPersonas={(n) => cambiarComensales(n - comensales)}
          />

          <ul className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
            {lista.slice(0, RESULTADOS).map((p) => {
              const cantidad = enPedido(p.id)
              const sinStock = agotado(p)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    // Hasta leer los pedidos no se sabe si la mesa ya tiene uno.
                    disabled={pedidos === null}
                    aria-label={[
                      p.nombre,
                      sinStock
                        ? 'agotado'
                        : p.variantes.length > 0
                          ? `desde ${pesos(Math.min(...p.variantes.map((v) => v.precio)))}`
                          : pesos(p.precio),
                      ...(cantidad > 0 ? [`${cantidad} en el pedido`] : []),
                    ].join(', ')}
                    onClick={() => tocarProducto(p)}
                    className={`relative flex min-h-20 w-full flex-col justify-between rounded-xl border p-3 text-left active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco ${
                      sinStock
                        ? 'border-dashed border-alerta-fuerte bg-alerta-suave text-alerta-texto'
                        : 'border-borde bg-superficie hover:bg-superficie-2'
                    }`}
                  >
                    {cantidad > 0 && (
                      <span className="cifras absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-accion-fuerte text-sm font-bold text-white">
                        {cantidad}
                      </span>
                    )}
                    <span
                      className={`font-semibold leading-snug ${sinStock ? 'line-through' : ''}`}
                    >
                      {p.nombre}
                    </span>
                    <span className="cifras mt-1 flex items-center justify-between">
                      {sinStock ? (
                        <span className="font-semibold">Agotado</span>
                      ) : (
                        <span className="font-titulo text-lg text-texto-suave">
                          {p.variantes.length > 0
                            ? `desde ${pesos(Math.min(...p.variantes.map((v) => v.precio)))}`
                            : pesos(p.precio)}
                        </span>
                      )}
                      {!sinStock && pideOpciones(p) && (
                        <span className="text-sm whitespace-nowrap text-texto-suave">
                          opciones ›
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
            {lista.length === 0 && (
              <li className="col-span-full p-6 text-center text-texto-suave">
                {busqueda.trim() ? `No hay nada con «${busqueda}».` : 'No hay productos aquí.'}
              </li>
            )}
            {lista.length > RESULTADOS && (
              <li className="col-span-full p-3 text-center text-texto-suave">
                {`Hay ${lista.length - RESULTADOS} más: escribe un poco más.`}
              </li>
            )}
          </ul>
        </section>

        {/* Tablet y caja: el pedido siempre a la vista. */}
        <aside className="sticky top-20 hidden h-[calc(100dvh-6rem)] w-96 shrink-0 flex-col rounded-2xl border border-borde bg-superficie md:flex">
          {ticket}
          <div className="border-t border-borde p-3">{botonEnviar}</div>
        </aside>
      </div>

      {/* Celular: barra fija abajo, al alcance del pulgar. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-borde bg-superficie p-3 md:hidden">
        <Boton
          variante="secundario"
          grande
          onClick={() => setVerPedido(true)}
          className="flex-1 flex-col gap-0! text-base! leading-tight"
        >
          <span>{`Pedido (${pedido ? itemsVigentes(pedido.estado).length : 0})`}</span>
          <span className="cifras font-titulo text-lg">{pesos(pedido?.total ?? 0)}</span>
        </Boton>
        <div className="flex-1">{botonEnviar}</div>
      </div>

      <PanelLateral
        abierto={verPedido}
        titulo={`Pedido · ${titulo}`}
        alCerrar={() => setVerPedido(false)}
        pie={botonEnviar}
      >
        {ticket}
      </PanelLateral>

      <PanelProducto
        producto={elegido}
        agotados={agotados}
        alCerrar={() => setElegido(null)}
        alAgregar={(varianteId, elegidas, extras) => {
          if (elegido) agregar(elegido, varianteId, elegidas, extras)
          setElegido(null)
        }}
      />

      <PanelAgotar
        producto={agotando}
        agotados={agotados}
        alCerrar={() => setAgotando(null)}
        alCambiar={(varianteId, agotar) =>
          agotando && alternarAgotado(agotando, varianteId, agotar)
        }
      />

      {pedido && itemEditado && (
        <PanelItem
          item={itemEditado}
          comensales={comensales}
          alCerrar={() => setEditando(null)}
          enSalon={canal === 'salon'}
          alCambiar={(cambio) => cambiarItem(itemEditado.id, cambio)}
          alSumar={(delta) => sumar(itemEditado.id, delta)}
          alDuplicar={() => {
            duplicar(itemEditado.id)
            setEditando(null)
          }}
          alQuitar={() => {
            quitar(itemEditado.id)
            setEditando(null)
          }}
        />
      )}
    </MarcoSala>
  )
}

const nombreComensal = (c: number | null) => (c === null ? 'Mesa' : `P${c}`)
const etiquetaComensal = (c: number | null) =>
  c === null ? 'Mesa, para todos' : `P${c}, persona ${c}`
const personasDe = (comensales: number) => [
  null,
  ...Array.from({ length: comensales }, (_, i) => i + 1),
]
/** Lo que se toca más al sentar una mesa; más de 6 se sube con + en el pedido. */
const PERSONAS_RAPIDAS = [1, 2, 3, 4, 5, 6]

/** Para quién y en qué curso va lo que se agregue: vale para lo siguiente. */
function ElegirPara({
  comensales,
  preguntarPersonas,
  comensal,
  curso,
  alElegirComensal,
  alElegirCurso,
  alContarPersonas,
}: {
  comensales: number
  preguntarPersonas: boolean
  comensal: number | null
  curso: Curso | null
  alElegirComensal: (c: number | null) => void
  alElegirCurso: (c: Curso | null) => void
  alContarPersonas: (n: number) => void
}) {
  // En el celular cada fila es una sola línea que se desliza; en pantallas anchas cabe todo.
  const fila = '-mx-3 flex items-center gap-2 overflow-x-auto px-3 pb-1 md:flex-wrap'
  return (
    <div className="mt-3 flex flex-col gap-2">
      {preguntarPersonas && (
        <Grupo etiqueta="Cuántas personas hay en la mesa" className={fila}>
          <span className="shrink-0 font-semibold text-texto-suave">¿Cuántas personas?</span>
          {PERSONAS_RAPIDAS.map((n) => (
            <Opcion key={n} elegida={false} alElegir={() => alContarPersonas(n)}>
              {String(n)}
            </Opcion>
          ))}
        </Grupo>
      )}
      {comensales > 0 && (
        <Grupo etiqueta="Para quién es lo que agregues" className={fila}>
          <span className="shrink-0 font-semibold text-texto-suave">Para</span>
          {personasDe(comensales).map((c) => (
            <Opcion
              key={c ?? 'mesa'}
              elegida={comensal === c}
              alElegir={() => alElegirComensal(c)}
              etiqueta={etiquetaComensal(c)}
            >
              {nombreComensal(c)}
            </Opcion>
          ))}
        </Grupo>
      )}
      <Grupo etiqueta="En qué curso va lo que agregues" className={fila}>
        <span className="shrink-0 font-semibold text-texto-suave">Curso</span>
        {CURSOS.map((c) => (
          <Opcion
            key={c.curso ?? 'ninguno'}
            elegida={curso === c.curso}
            alElegir={() => alElegirCurso(c.curso)}
          >
            {c.nombre}
          </Opcion>
        ))}
      </Grupo>
    </div>
  )
}

function Ticket({
  pedido,
  comensales,
  enSalon,
  alCambiarComensales,
  alTocarItem,
  alSumar,
  alRetener,
  alMarchar,
}: {
  pedido: PedidoVisible | null
  comensales: number
  enSalon: boolean
  /** Una persona más (1) o menos (-1). */
  alCambiarComensales: (delta: number) => void
  alTocarItem: (item: ItemPedido) => void
  alSumar: (item: ItemPedido, delta: number) => void
  alRetener: (curso: Curso) => void
  alMarchar: (curso: Curso) => void
}) {
  const items = pedido ? itemsVigentes(pedido.estado) : []
  const porCurso = CURSOS.map((c) => ({
    ...c,
    items: items.filter((i) => i.curso === c.curso),
  })).filter((c) => c.items.length > 0)
  const esperan = items.filter((i) => i.estado === 'retenido').length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Fuera del salón no se cuentan personas. */}
      {enSalon && (
        <div className="flex items-center gap-2 border-b border-borde p-3">
          <Icono nombre="personas" />
          <span className="font-semibold">
            {comensales === 0
              ? 'Sin contar personas'
              : `${comensales} ${comensales === 1 ? 'persona' : 'personas'}`}
          </span>
          <Boton
            variante="fantasma"
            icono="menos"
            aria-label="Una persona menos"
            disabled={comensales <= 0}
            onClick={() => alCambiarComensales(-1)}
          />
          <Boton
            variante="fantasma"
            icono="mas"
            aria-label="Una persona más"
            disabled={comensales >= 200}
            onClick={() => alCambiarComensales(1)}
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="p-6 text-center text-texto-suave">Toca un producto para agregarlo.</p>
        )}
        {pedido &&
          porCurso.map((c) => {
            const retenidos = c.items.filter((i) => i.estado === 'retenido').length
            const pendientes = c.items.filter((i) => i.estado === 'pendiente').length
            return (
              <section key={c.curso ?? 'ninguno'} aria-label={c.nombre}>
                {(porCurso.length > 1 || c.curso !== null) && (
                  <div className="flex min-h-12 items-center justify-between gap-2 bg-superficie-2 px-3">
                    <span className="font-semibold">
                      {c.nombre}
                      {retenidos > 0 && (
                        <span className="font-normal text-proceso-texto"> · espera</span>
                      )}
                    </span>
                    {c.curso !== null && retenidos > 0 && (
                      <Boton variante="principal" onClick={() => alMarchar(c.curso as Curso)}>
                        {`Marchar ${retenidos}`}
                      </Boton>
                    )}
                    {c.curso !== null && retenidos === 0 && pendientes > 0 && (
                      <Boton onClick={() => alRetener(c.curso as Curso)}>Retener</Boton>
                    )}
                  </div>
                )}
                <ul>
                  {c.items.map((i) => (
                    <LineaTicket
                      key={i.id}
                      pedido={pedido}
                      item={i}
                      alTocar={() => alTocarItem(i)}
                      alSumar={(delta) => alSumar(i, delta)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
      </div>
      {esperan > 0 && (
        <p className="border-t border-borde px-3 pt-2 text-sm text-proceso-texto">
          {`${esperan} ${esperan === 1 ? 'espera' : 'esperan'} su curso: «Enviar» no ${esperan === 1 ? 'lo manda' : 'los manda'}; sale${esperan === 1 ? '' : 'n'} al tocar «Marchar».`}
        </p>
      )}
      <div className="cifras flex justify-between p-3 text-lg font-semibold">
        <span>Total</span>
        <span>{pesos(pedido?.total ?? 0)}</span>
      </div>
    </div>
  )
}

function LineaTicket({
  pedido,
  item: i,
  alTocar,
  alSumar,
}: {
  pedido: PedidoVisible
  item: ItemPedido
  alTocar: () => void
  alSumar: (delta: number) => void
}) {
  const sinEnviar = i.estado === 'pendiente' || i.estado === 'retenido'
  const porConfirmar = pedido.itemsPorConfirmar.has(i.id)
  return (
    <li className="flex min-h-14 items-center gap-1 border-b border-borde pr-2">
      <button
        type="button"
        onClick={alTocar}
        className="flex min-h-14 flex-1 items-start gap-3 px-3 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
      >
        <span className="cifras w-6 font-semibold">{i.cantidad - i.cantidadAnulada}</span>
        <span className="flex-1">
          <span className="font-semibold">{i.nombre}</span>
          {i.modificadores.length > 0 && (
            <span className="block text-sm font-semibold text-proceso-texto">
              {i.modificadores.map((m) => m.nombre).join(' · ')}
            </span>
          )}
          {i.notas && <span className="block text-sm text-texto-suave">«{i.notas}»</span>}
          <span className="flex flex-wrap items-center gap-1 text-sm text-texto-suave">
            {[
              ...(i.comensal === null ? [] : [nombreComensal(i.comensal)]),
              TEXTO_ESTADO[i.estado] ?? i.estado,
            ].join(' · ')}
            {porConfirmar && (
              <>
                {' · '}
                <Icono nombre="reloj" className="size-4" />
                sin confirmar
              </>
            )}
          </span>
        </span>
        <span className="cifras">{pesos(totalesItem(pedido.estado, i).neto)}</span>
      </button>
      {sinEnviar && (
        <>
          <Boton
            variante="fantasma"
            icono="menos"
            aria-label={i.cantidad === 1 ? `Quitar ${i.nombre}` : `Uno menos de ${i.nombre}`}
            onClick={() => alSumar(-1)}
          />
          <Boton
            variante="fantasma"
            icono="mas"
            aria-label={`Uno más de ${i.nombre}`}
            disabled={i.cantidad >= MAXIMO_LINEA}
            onClick={() => alSumar(1)}
          />
        </>
      )}
    </li>
  )
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="font-semibold">{titulo}</p>
      {children}
    </div>
  )
}

function Cantidad({
  valor,
  alCambiar,
  minimo = 1,
}: {
  valor: number
  alCambiar: (n: number) => void
  minimo?: number
}) {
  return (
    <div className="flex items-center gap-2">
      <Boton
        icono="menos"
        aria-label="Uno menos"
        disabled={valor <= minimo}
        onClick={() => alCambiar(valor - 1)}
      />
      <output className="cifras w-10 text-center text-xl font-semibold">{valor}</output>
      <Boton
        icono="mas"
        aria-label="Uno más"
        disabled={valor >= MAXIMO_LINEA}
        onClick={() => alCambiar(valor + 1)}
      />
    </div>
  )
}

const claseNota =
  'rounded-xl border border-borde bg-superficie px-3 py-2 text-lg focus-visible:outline-3 focus-visible:outline-foco'

/**
 * Tamaño, opciones, cantidad y nota de un producto. Si solo hay una cosa que elegir, tocarla ya
 * lo agrega.
 */
function PanelProducto({
  producto,
  agotados,
  alCerrar,
  alAgregar,
}: {
  producto: ProductoCatalogo | null
  agotados: Set<string>
  alCerrar: () => void
  alAgregar: (
    varianteId: string | null,
    elegidas: Record<string, string[]>,
    extras: { cantidad: number; notas: string },
  ) => void
}) {
  const [varianteId, setVarianteId] = useState<string | null>(null)
  const [elegidas, setElegidas] = useState<Record<string, string[]>>({})
  const [cantidad, setCantidad] = useState(1)
  const [notas, setNotas] = useState('')
  const [abiertoPara, setAbiertoPara] = useState<string | null>(null)

  // Al abrir con otro producto, todo empieza de cero.
  if (producto && abiertoPara !== producto.id) {
    setAbiertoPara(producto.id)
    setVarianteId(null)
    setElegidas({})
    setCantidad(1)
    setNotas('')
  }
  if (!producto) return null

  const [unico, ...otros] = producto.grupos
  const unaSola =
    (producto.variantes.length > 0 && !unico) ||
    (producto.variantes.length === 0 &&
      otros.length === 0 &&
      unico?.minimo === 1 &&
      unico.maximo === 1)
  const faltan = faltaElegir(producto, varianteId, elegidas)
  const precio = precioElegido(producto, varianteId, elegidas)
  const varianteAgotada = (id: string) => agotados.has(claveAgotado(producto.id, id))

  const cerrar = () => {
    setAbiertoPara(null)
    alCerrar()
  }
  const agregarCon = (v: string | null, e: Record<string, string[]>) => {
    setAbiertoPara(null)
    alAgregar(v, e, { cantidad, notas })
  }
  const tocarOpcion = (grupoId: string, maximo: number, opcionId: string) => {
    const actuales = elegidas[grupoId] ?? []
    const nuevas = actuales.includes(opcionId)
      ? actuales.filter((o) => o !== opcionId)
      : maximo === 1
        ? [opcionId]
        : actuales.length < maximo
          ? [...actuales, opcionId]
          : actuales
    const todas = { ...elegidas, [grupoId]: nuevas }
    if (unaSola) agregarCon(null, todas)
    else setElegidas(todas)
  }

  return (
    <PanelLateral
      abierto
      titulo={producto.nombre}
      alCerrar={cerrar}
      pie={
        <Boton
          variante="principal"
          grande
          className="w-full"
          disabled={faltan.length > 0}
          onClick={() => agregarCon(varianteId, elegidas)}
        >
          {faltan.length > 0
            ? `Elige ${faltan[0]}`
            : `Agregar ${cantidad > 1 ? `${cantidad} · ` : '· '}${pesos(precio * cantidad)}`}
        </Boton>
      }
    >
      {producto.descripcion && <p className="mb-4 text-texto-suave">{producto.descripcion}</p>}
      {unaSola && (
        <p className="mb-3 text-texto-suave">
          Toca una opción y queda agregada. Si quieres cantidad o nota, cámbialas antes.
        </p>
      )}
      {producto.variantes.length > 0 && (
        <Grupo etiqueta="Tamaño" className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">Tamaño</p>
          {producto.variantes.map((v) =>
            varianteAgotada(v.id) ? (
              <p
                key={v.id}
                className="flex min-h-14 items-center rounded-xl border-2 border-dashed border-alerta-fuerte px-3 text-alerta-texto"
              >
                {`${v.nombre} · agotado`}
              </p>
            ) : (
              <Opcion
                key={v.id}
                forma="tarjeta"
                elegida={v.id === varianteId}
                detalle={pesos(v.precio)}
                alElegir={() => (unaSola ? agregarCon(v.id, elegidas) : setVarianteId(v.id))}
              >
                {v.nombre}
              </Opcion>
            ),
          )}
        </Grupo>
      )}
      {producto.grupos.map((g) => (
        <Grupo key={g.id} etiqueta={g.nombre} className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">
            {g.nombre}
            {g.minimo > 0 && <span className="font-normal text-texto-suave"> (obligatorio)</span>}
            {g.maximo > 1 && (
              <span className="font-normal text-texto-suave">{` · hasta ${g.maximo}`}</span>
            )}
          </p>
          {g.opciones.map((o) => (
            <Opcion
              key={o.id}
              forma="tarjeta"
              elegida={elegidas[g.id]?.includes(o.id) ?? false}
              detalle={o.precioExtra > 0 ? `+ ${pesos(o.precioExtra)}` : undefined}
              alElegir={() => tocarOpcion(g.id, g.maximo, o.id)}
            >
              {o.nombre}
            </Opcion>
          ))}
        </Grupo>
      ))}
      <Seccion titulo="Cantidad">
        <Cantidad valor={cantidad} alCambiar={setCantidad} />
      </Seccion>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Nota para cocina (opcional)</span>
        <textarea
          rows={2}
          maxLength={200}
          value={notas}
          placeholder="Sin cebolla, salsa aparte…"
          onChange={(e) => setNotas(e.target.value)}
          className={claseNota}
        />
      </label>
    </PanelLateral>
  )
}

/** Una línea del pedido: cantidad, para quién, curso y nota si aún no se envió; duplicar o quitar. */
function PanelItem({
  item,
  comensales,
  enSalon,
  alCerrar,
  alCambiar,
  alSumar,
  alDuplicar,
  alQuitar,
}: {
  item: ItemPedido
  comensales: number
  enSalon: boolean
  alCerrar: () => void
  alCambiar: (cambio: {
    comensal?: number | null
    curso?: Curso | null
    notas?: string | null
  }) => void
  alSumar: (delta: number) => void
  alDuplicar: () => void
  alQuitar: () => void
}) {
  const sinEnviar = item.estado === 'pendiente' || item.estado === 'retenido'
  const [notas, setNotas] = useState(item.notas ?? '')
  /** La nota se guarda al salir del campo o al cerrar el panel, lo que pase primero. */
  const guardarNota = () => {
    const nueva = notas.trim() || null
    if (sinEnviar && nueva !== item.notas) alCambiar({ notas: nueva })
  }
  const cerrar = () => {
    guardarNota()
    alCerrar()
  }
  // Para quién y curso son una sola elección: al tocarla, el panel se cierra.
  const elegir = (cambio: { comensal?: number | null; curso?: Curso | null }) => {
    guardarNota()
    alCambiar(cambio)
    alCerrar()
  }
  return (
    <PanelLateral
      abierto
      titulo={item.nombre}
      alCerrar={cerrar}
      pie={
        <div className="flex gap-2">
          <Boton grande className="flex-1" onClick={alDuplicar}>
            Duplicar
          </Boton>
          {sinEnviar && (
            <Boton grande className="flex-1" onClick={alQuitar}>
              Quitar
            </Boton>
          )}
        </div>
      }
    >
      {!sinEnviar && (
        <p className="mb-4 rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Ya se envió a cocina: aquí no se cambia. Anularlo llega con la tarea de anulaciones.
        </p>
      )}
      {sinEnviar && (
        <>
          <Seccion titulo="Cantidad">
            <Cantidad valor={item.cantidad} alCambiar={(n) => alSumar(n - item.cantidad)} />
          </Seccion>
          {enSalon && comensales > 0 && (
            <Grupo etiqueta="Para quién" className="mb-4 flex flex-wrap items-center gap-2">
              <p className="w-full font-semibold">Para quién</p>
              {personasDe(comensales).map((c) => (
                <Opcion
                  key={c ?? 'mesa'}
                  elegida={item.comensal === c}
                  alElegir={() => elegir({ comensal: c })}
                  etiqueta={etiquetaComensal(c)}
                >
                  {nombreComensal(c)}
                </Opcion>
              ))}
            </Grupo>
          )}
          <Grupo etiqueta="Curso" className="mb-4 flex flex-wrap items-center gap-2">
            <p className="w-full font-semibold">Curso</p>
            {CURSOS.map((c) => (
              <Opcion
                key={c.curso ?? 'ninguno'}
                elegida={item.curso === c.curso}
                alElegir={() => elegir({ curso: c.curso })}
              >
                {c.nombre}
              </Opcion>
            ))}
          </Grupo>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nota para cocina</span>
            <textarea
              rows={2}
              maxLength={200}
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              onBlur={guardarNota}
              className={claseNota}
            />
          </label>
        </>
      )}
    </PanelLateral>
  )
}

/** Agotar un producto con tamaños: el producto entero o solo uno (se acabó la botella, no la copa). */
function PanelAgotar({
  producto,
  agotados,
  alCerrar,
  alCambiar,
}: {
  producto: ProductoCatalogo | null
  agotados: Set<string>
  alCerrar: () => void
  alCambiar: (varianteId: string | null, agotar: boolean) => void
}) {
  if (!producto) return null
  const todo = agotados.has(claveAgotado(producto.id))
  // Con todo el producto agotado, los tamaños no se tocan por separado.
  const opciones = [
    { id: null, nombre: 'Todo el producto' },
    ...(todo ? [] : producto.variantes.map((v) => ({ id: v.id, nombre: v.nombre }))),
  ]
  return (
    <PanelLateral abierto titulo={`Agotar ${producto.nombre}`} alCerrar={alCerrar}>
      <p className="mb-4 text-texto-suave">
        Toca lo que se acabó; tócalo otra vez cuando vuelva a haber.
      </p>
      <Grupo etiqueta="Qué se acabó" className="flex flex-col gap-2">
        {opciones.map((o) => {
          const yaAgotado = agotados.has(claveAgotado(producto.id, o.id))
          return (
            <Opcion
              key={o.id ?? 'todo'}
              forma="tarjeta"
              elegida={yaAgotado}
              detalle={yaAgotado ? 'agotado' : 'disponible'}
              alElegir={() => alCambiar(o.id, !yaAgotado)}
            >
              {o.nombre}
            </Opcion>
          )
        })}
      </Grupo>
    </PanelLateral>
  )
}
