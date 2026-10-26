import { itemTotals, newId, type OrderItem, type OrderState } from '@pos/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { search } from '../ui/busqueda'
import { pesos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar, useRuta } from '../ui/ruta'
import {
  PanelAccionesPedido,
  PanelAnular,
  PanelCambiarMesa,
  PanelCancelar,
  PanelMover,
  PanelUnirMesas,
} from './AccionesPedido'
import { sala, useSala, useVistaLocal } from './contexto'
import { MarcoSala } from './MarcoSala'
import {
  CANALES,
  COURSES,
  type Course,
  comandasDeCurso,
  comandasPorEstacion,
  copiaDe,
  datosItem,
  elCurso,
  faltaElegir,
  lineaIgual,
  movidoDe,
  type ProductoCatalogo,
  pideOpciones,
  precioElegido,
  unidadesPorEnviar,
} from './pedido'
import { claveAgotado, itemsVigentes, ocupaMesa, type PedidoVisible } from './proyeccion'

// Toma de pedido (brief §4.2 y §5, regla 2): tocar productos y "Enviar". Cada toque es un evento
// guardado aquí antes de mostrarse; se envía al hub cuando haya conexión.
// - Para quién (la mesa o la persona 1, 2…) y en qué curso va lo que se agregue: se elige arriba y
//   vale para lo siguiente. El mismo producto otra vez suma a su línea.
// - Un curso se puede retener y marchar después (la entrada sale ya; el fuerte, cuando se pida).
// - Lo agotado (86) se ve en todos los equipos al instante; quien tiene permiso lo marca aquí.
// La mesa queda ocupada al agregar el primer producto, no al abrirla.

/** Unidades (no líneas) de unos ítems: 2 Aperol en una línea son 2. */
const unidadesDe = (items: readonly OrderItem[]) =>
  items.reduce((n, i) => n + i.quantity - i.voidedQuantity, 0)

/** Lo que está en cocina y el mesero puede marcar entregado (ADR-015). */
const EN_COCINA = new Set(['sent', 'in_preparation', 'ready'])

const TEXTO_ESTADO: Record<string, string> = {
  pending: 'sin enviar',
  held: 'held',
  sent: 'en cocina',
  in_preparation: 'en preparación',
  ready: 'listo para llevar',
  served: 'entregado',
}

type Channel = 'dine_in' | keyof typeof CANALES
/** Lo más que lleva una línea desde la pantalla (el esquema admite hasta 999). */
const MAXIMO_LINEA = 99

const FAVORITOS = '__favorites'
const MAS_PEDIDOS = '__more'
const RESULTADOS = 40

export function TomaPedido() {
  const { parametros } = useRuta()
  const { catalog, session, connection } = useSala()
  const enLinea = connection === 'connected'
  const vista = useVistaLocal()
  const orders = vista?.orders ?? null
  const agotados = vista?.agotados ?? new Set<string>()
  const avisar = useAvisar()
  const tableId = parametros.get('table')
  const canalNuevo = (parametros.get('channel') as Channel | null) ?? (tableId ? 'dine_in' : null)
  const table = tableId ? catalog?.tables.find((m) => m.id === tableId) : undefined
  const [busqueda, setBusqueda] = useState('')
  const [category, setCategoria] = useState<string | null>(null)
  const [elegido, setElegido] = useState<ProductoCatalogo | null>(null)
  const [editando, setEditando] = useState<string | null>(null)
  const [verPedido, setVerPedido] = useState(false)
  const [guest, setComensal] = useState<number | null>(null)
  const [course, setCurso] = useState<Course | null>(null)
  const [comensalesIniciales, setComensalesIniciales] = useState(0)
  const [marcandoAgotados, setMarcandoAgotados] = useState(false)
  const [agotando, setAgotando] = useState<ProductoCatalogo | null>(null)
  const campoBusqueda = useRef<HTMLInputElement>(null)
  // El pedido que se abrió aquí: los toques seguidos van al mismo aunque aún no se haya releído.
  const opened = useRef<string | null>(null)
  // Los toques se guardan uno tras otro, en el orden en que se hicieron.
  const cola = useRef<Promise<void>>(Promise.resolve())
  const puedeAgotar = session?.permissions.includes('mark_product_sold_out') ?? false
  const puedeEntregar = session?.permissions.includes('mark_preparation') ?? false
  // Los cursos se usan poco en Colombia: solo se ven si el restaurante los prende.
  const usarCursos = catalog?.restaurant.usarCursos ?? false
  const [editandoNota, setEditandoNota] = useState(false)
  // Mesa y pedido (tarea 1.5): qué panel está abierto, y qué ítem se anula.
  const [action, setAccion] = useState<'menu' | 'move' | 'table' | 'merge' | 'cancel' | null>(null)
  const [anulando, setAnulando] = useState<string | null>(null)
  const permissions = session?.permissions ?? []

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

  if (!catalog || (tableId && !table) || (!tableId && !canalNuevo && !parametros.get('order'))) {
    return (
      <MarcoSala title="Pedido" back="/">
        <p className="p-6 text-texto-suave">Esta mesa o este pedido no existe.</p>
      </MarcoSala>
    )
  }

  // El pedido: el elegido, el que se abrió aquí o el primero de la mesa.
  const candidatos = (orders ?? []).filter((p) =>
    tableId
      ? p.status.tableId === tableId || p.status.mergedTables.includes(tableId)
      : p.status.id === parametros.get('order'),
  )
  const elegidoId =
    parametros.get('order') ?? opened.current ?? (tableId ? candidatos[0]?.status.id : null) ?? null
  const order = (orders ?? []).find((p) => p.status.id === elegidoId) ?? null
  const channel: Channel = order?.status.channel ?? canalNuevo ?? 'dine_in'
  const guests = order?.status.guests ?? comensalesIniciales
  const merged = (order?.status.mergedTables ?? [])
    .map((id) => catalog?.tables.find((m) => m.id === id)?.name)
    .filter(Boolean)
  const title = table
    ? `Mesa ${[table.name, ...merged].join(' + ')}`
    : `${channel === 'dine_in' ? 'Pedido' : CANALES[channel]}${order?.status.dayNumber ? ` #${order.status.dayNumber}` : ''}`
  const products = catalog.categories.flatMap((c) => c.products)
  // Por dónde sale cada producto (cocina o barra): da su ícono cuando no tiene foto.
  const estacionDe = new Map(
    catalog.categories.flatMap((c) =>
      c.products.map((p) => [
        p.id,
        catalog.stations.find((e) => e.id === c.estacionId)?.name ?? '',
      ]),
    ),
  )
  const soldOut = (p: ProductoCatalogo) => agotados.has(claveAgotado(p.id))

  const inOrder = (trabajo: () => Promise<void>) => {
    cola.current = cola.current.then(trabajo).catch((e) => {
      console.error(e)
      avisar(e instanceof Error ? e.message : 'No se pudo guardar')
    })
  }
  /**
   * Como `inOrder`, pero el fallo vuelve a quien lo pidió (un panel que lo muestra junto al
   * botón: un PIN errado, sin conexión) en vez de un aviso.
   */
  const enOrdenConError = (trabajo: () => Promise<void>): Promise<void> => {
    const hecho = cola.current.then(trabajo)
    cola.current = hecho.catch(() => {})
    return hecho
  }
  /**
   * Para lo que espera al hub (el PIN del supervisor, hasta 8 s): va después de lo que ya está en
   * la cola, pero sin frenar los productos que se agreguen mientras tanto.
   */
  const sinFrenarLaCola = async (trabajo: () => Promise<void>): Promise<void> => {
    await cola.current
    await trabajo()
  }
  /** El pedido guardado (no el de la última pantalla): un toque anterior pudo cambiarlo. */
  const pedidoGuardado = async () => {
    const id = elegidoId ?? opened.current
    return id ? ((await sala.sync?.order(id)) ?? null) : null
  }
  /** El pedido al que va lo que se agregue; si aún no existe, se abre. */
  const asegurarPedido = async () => {
    const id = elegidoId ?? opened.current
    if (id) return id
    const fresh = newId()
    await sala.record('OrderOpened', fresh, {
      channel,
      table_id: tableId ?? null,
      guests: comensalesIniciales,
    })
    // Solo después de guardarlo: si falló, el próximo toque lo vuelve a intentar.
    opened.current = fresh
    // Un pedido sin mesa se sigue por su id (la mesa no lo identifica).
    if (!tableId) navegar(`/order?order=${fresh}`)
    return fresh
  }
  /** La línea tal como está guardada, si aún no se envió. */
  const lineaGuardada = async (itemId: string) => {
    const status = await pedidoGuardado()
    const item = status?.items[itemId]
    return status && item && (item.status === 'pending' || item.status === 'held')
      ? { status, item }
      : null
  }
  /**
   * Los datos para volver a agregar un ítem como está ahora (otra `item_id`), con la versión de
   * catálogo con que se agregó: el precio era el de esa carta.
   */
  const copiaActual = async (item: OrderItem) => {
    const original = (await sala.sync?.locales())?.find(
      (l) => l.event.type === 'ItemAdded' && l.event.data.item_id === item.id,
    )?.event
    return original?.type === 'ItemAdded'
      ? {
          ...original.data,
          item_id: newId(),
          quantity: item.quantity - item.voidedQuantity,
          guest: item.guest,
          course: item.course,
          notes: item.notes,
        }
      : copiaDe(item, catalog.version)
  }

  /**
   * Suma o resta unidades a una línea sin enviar, a partir de lo guardado (dos toques seguidos
   * cuentan dos). Sin aviso: el número cambia a la vista y con «−» se corrige (decisión del
   * dueño: el aviso estorbaba al tomar pedidos). Si queda en 0, la quita con Deshacer.
   */
  const increment = (itemId: string, delta: number) =>
    inOrder(async () => {
      const line = await lineaGuardada(itemId)
      if (!line) {
        avisar('Esa línea ya se envió o ya no está')
        return
      }
      const quantity = line.item.quantity + delta
      if (quantity <= 0) {
        await quitarYa(line.status, line.item)
        return
      }
      if (quantity > MAXIMO_LINEA) {
        avisar(`Una línea lleva hasta ${MAXIMO_LINEA}`)
        return
      }
      await sala.record('ItemChanged', line.status.id, { item_id: itemId, quantity })
    })

  const add = (
    p: ProductoCatalogo,
    variantId: string | null,
    elegidas: Record<string, string[]>,
    extras: { quantity?: number; notes?: string } = {},
  ) =>
    inOrder(async () => {
      // Antes de abrir el pedido: si falta elegir algo, no queda un pedido vacío en la mesa.
      const data = datosItem(catalog, p, variantId, elegidas, {
        ...extras,
        guest,
        course: usarCursos ? course : null,
      })
      const id = await asegurarPedido()
      const equal = lineaIgual(await pedidoGuardado(), data)
      if (equal) {
        const quantity = Math.min(MAXIMO_LINEA, equal.quantity + data.quantity)
        const sumado = quantity - equal.quantity
        if (sumado === 0) {
          avisar(`Una línea lleva hasta ${MAXIMO_LINEA}`)
          return
        }
        await sala.record('ItemChanged', id, { item_id: equal.id, quantity })
        return
      }
      await sala.record('ItemAdded', id, data)
    })

  /** Quita la línea (ya dentro de la cola) y deja Deshacer, que la vuelve a agregar como estaba. */
  const quitarYa = async (status: OrderState, item: OrderItem) => {
    const copy = await copiaActual(item)
    await sala.record('ItemRemoved', status.id, { item_id: item.id })
    avisar(`Quitaste ${item.name}`, () =>
      inOrder(() => sala.record('ItemAdded', status.id, copy).then(() => {})),
    )
  }
  const remove = (itemId: string) =>
    inOrder(async () => {
      const line = await lineaGuardada(itemId)
      if (line) await quitarYa(line.status, line.item)
    })

  /** Cambia para quién, el curso o la nota de una línea sin enviar. */
  const cambiarItem = (
    itemId: string,
    change: { guest?: number | null; course?: Course | null; notes?: string | null },
  ) =>
    inOrder(async () => {
      const line = await lineaGuardada(itemId)
      if (!line) {
        avisar('Esa línea ya se envió o ya no está')
        return
      }
      await sala.record('ItemChanged', line.status.id, { item_id: itemId, ...change })
    })

  /** La nota de todo el pedido («alérgico al maní»): va en cada comanda y en la cocina. */
  const cambiarNotaPedido = (notes: string | null) =>
    inOrder(async () => {
      const before = await pedidoGuardado()
      // Sin cambio no se escribe nada, ni se abre un pedido vacío en una mesa libre.
      if ((before?.notes ?? null) === notes) return
      if (before && before.status !== 'open') {
        avisar('Este pedido ya se cerró: la nota no se guardó')
        return
      }
      const id = await asegurarPedido()
      await sala.record('OrderNoteChanged', id, { notes })
    })

  // ── Mesa y pedido (tarea 1.5) ────────────────────────────────────────

  /**
   * Mesas que ocupan los otros pedidos abiertos (su mesa y las unidas), para elegir a dónde pasar.
   * Uno que quedó vacío al pasar todo a otra mesa ya no ocupa la suya (igual que en el hub).
   */
  const occupiedIds = new Map<string, string>()
  for (const p of orders ?? []) {
    if (!p.status.tableId || p.status.id === order?.status.id || !ocupaMesa(p.status)) continue
    const waiter = catalog?.staff.find((u) => u.id === p.status.assignedWaiterId)?.name
    for (const m of [p.status.tableId, ...p.status.mergedTables])
      occupiedIds.set(m, waiter ?? 'ocupada')
  }

  /** Anular lo enviado, con motivo; sin el permiso lo autoriza el cajero con su PIN. */
  const voidItem = (
    itemId: string,
    d: { quantity: number; reason: string; alreadyPrepared: boolean; pin: string | null },
  ) =>
    sinFrenarLaCola(async () => {
      const status = await pedidoGuardado()
      const item = status?.items[itemId]
      if (!status || !item) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      await sala.record(
        'ItemVoided',
        status.id,
        {
          item_id: item.id,
          quantity: d.quantity,
          already_prepared: d.alreadyPrepared,
          ticket_id: newId(),
        },
        {
          reason: d.reason,
          ...(d.pin ? { authorizes: { pin: d.pin, permission: 'void_sent_item' } } : {}),
        },
      )
      setAnulando(null)
      setEditando(null)
      avisar(
        enLinea
          ? `Anulaste ${d.quantity} ${item.name}`
          : `Anulado aquí: llega a cocina cuando vuelva la conexión`,
      )
    })

  /** Cancelar el pedido entero; la mesa queda libre y la cocina recibe la anulación. */
  const cancelarPedido = (d: { reason: string; pin: string | null }) =>
    sinFrenarLaCola(async () => {
      const status = await pedidoGuardado()
      if (!status) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      if (Object.values(status.payments).some((p) => !p.voided))
        throw new Error('Este pedido ya tiene pagos: primero hay que anularlos en caja')
      await sala.record(
        'OrderCanceled',
        status.id,
        {},
        {
          reason: d.reason,
          ...(d.pin ? { authorizes: { pin: d.pin, permission: 'cancel_order' } } : {}),
        },
      )
      setAccion(null)
      avisar('Cancelaste el pedido')
      navegar('/')
    })

  /** La nota de un plato que ya salió: la cocina recibe una comanda «CAMBIO». */
  const cambiarNotaEnviada = (itemId: string, notes: string | null) =>
    inOrder(async () => {
      const status = await pedidoGuardado()
      const item = status?.items[itemId]
      if (!status || !item || item.notes === notes) return
      await sala.record('ItemModifiedAfterSend', status.id, {
        item_id: item.id,
        ticket_id: newId(),
        notes,
      })
      avisar(
        enLinea
          ? `La cocina recibe el cambio de ${item.name}`
          : 'Guardado: el cambio llega a cocina cuando vuelva la conexión',
      )
    })

  /** Pasar productos a otra mesa: al pedido que tenga, o a uno nuevo si está libre. */
  const moverA = (itemIds: string[], mesaDestino: string) =>
    enOrdenConError(async () => {
      const status = await pedidoGuardado()
      if (!status) return
      const items = itemIds.map((id) => status.items[id]).filter((i): i is OrderItem => !!i)
      if (items.length === 0) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      // Lo que el hub rechazaría se avisa antes de abrir nada en la otra mesa.
      if (status.checks) throw new Error('La cuenta está dividida: primero deshaz la división')
      if (
        items.some((i) =>
          Object.values(status.discounts).some((d) => d.amounts[i.id] !== undefined),
        )
      )
        throw new Error('Algo tiene descuento: primero quítalo en caja')
      let target = (orders ?? []).find(
        (p) =>
          p.status.id !== status.id &&
          (p.status.tableId === mesaDestino || p.status.mergedTables.includes(mesaDestino)),
      )?.status.id
      if (!target) {
        target = newId()
        await sala.record('OrderOpened', target, {
          channel: 'dine_in',
          table_id: mesaDestino,
          guests: 0,
        })
      }
      await sala.record(
        'ItemsMoved',
        status.id,
        { target_order_id: target, items: items.map(movidoDe) },
        { related: [target] },
      )
      setAccion(null)
      const name = catalog?.tables.find((m) => m.id === mesaDestino)?.name
      avisar(`Pasaste ${unidadesDe(items)} a la mesa ${name ?? ''}`)
    })

  /** El pedido entero se cambia a otra mesa libre. */
  const cambiarDeMesa = (mesaDestino: string) =>
    enOrdenConError(async () => {
      const status = await pedidoGuardado()
      if (!status) throw new Error('El pedido cambió: ciérralo y ábrelo de nuevo')
      await sala.record('OrderMovedTable', status.id, { target_table_id: mesaDestino })
      setAccion(null)
      navegar(`/order?table=${mesaDestino}&order=${status.id}`)
    })

  /** Unir mesas libres a la de este pedido, o soltarlas. */
  const unirMesas = (add: string[], remove: string[]) =>
    enOrdenConError(async () => {
      const id = await asegurarPedido()
      if (add.length > 0) await sala.record('TablesMerged', id, { table_ids: add })
      if (remove.length > 0) await sala.record('TablesSeparated', id, { table_ids: remove })
      setAccion(null)
    })

  const duplicateSelected = (itemId: string) =>
    inOrder(async () => {
      const status = await pedidoGuardado()
      const item = status?.items[itemId]
      if (!status || !item) return
      await sala.record('ItemAdded', status.id, await copiaActual(item))
    })

  /** Una persona más o menos, sobre lo guardado; no baja de la mayor persona que tiene algo. */
  const cambiarComensales = (delta: number) => {
    if (!order) {
      setComensalesIniciales((n) => Math.max(0, Math.min(200, n + delta)))
      return
    }
    inOrder(async () => {
      const status = await pedidoGuardado()
      if (!status) return
      const enUso = Math.max(0, ...itemsVigentes(status).map((i) => i.guest ?? 0))
      const n = status.guests + delta
      if (n < enUso) {
        avisar(`La persona ${enUso} tiene cosas: pásalas a otra antes de quitarla`)
        return
      }
      if (n < 0 || n > 200) return
      if (guest !== null && guest > n) setComensal(null)
      await sala.record('GuestsChanged', status.id, { guests: n })
    })
  }

  // Sin conexión queda guardado aquí, pero cocina todavía no lo tiene: no decir "Enviado".
  const avisarEnvio = (cuantos: number, que = 'a cocina y barra') =>
    avisar(
      sala.instantanea().connection === 'connected'
        ? `Enviado ${que} (${cuantos})`
        : `Guardado (${cuantos}): llega a cocina cuando vuelva la conexión`,
    )

  /** Enviar lo pendiente (lo retenido espera a que se marche su curso). */
  const send = () =>
    inOrder(async () => {
      const status = await pedidoGuardado()
      if (!status) return
      const cuantos = unidadesPorEnviar(status)
      if (cuantos === 0) return
      const data = comandasPorEstacion(catalog, status)
      if (!data) {
        avisar('No hay a dónde enviar: la carta no tiene cocina ni barra')
        return
      }
      await sala.record('ItemsSent', status.id, data)
      navigator.vibrate?.(60)
      avisarEnvio(cuantos)
      setVerPedido(false)
      navegar('/')
    })

  const hold = (c: Course) =>
    inOrder(async () => {
      const status = await pedidoGuardado()
      if (!status) return
      await sala.record('CourseHeld', status.id, { course: c })
      const text = elCurso(c)
      avisar(`${text[0]?.toUpperCase()}${text.slice(1)} espera: márchalo cuando lo pidan`)
    })
  /** Marchar: el curso deja de esperar y sale a cocina de una vez. */
  const marchar = (c: Course) =>
    inOrder(async () => {
      const status = await pedidoGuardado()
      if (!status) return
      await sala.record('CourseFired', status.id, { course: c })
      const ahora = await pedidoGuardado()
      const data = ahora ? comandasDeCurso(catalog, ahora, c) : null
      if (ahora && data) {
        await sala.record('ItemsSent', ahora.id, data)
        avisarEnvio(
          data.tickets.reduce((s, x) => s + x.item_ids.length, 0),
          elCurso(c),
        )
      }
    })

  /**
   * El mesero lleva el plato a la mesa (ADR-015): sale de «Pedidos en cocina». Se puede deshacer
   * unos segundos, por si tocó el que no era.
   */
  const serve = (ids: string[], que: string) =>
    inOrder(async () => {
      const status = await pedidoGuardado()
      if (!status || ids.length === 0) return
      await sala.record('ItemServed', status.id, { item_ids: ids })
      avisar(`Entregado: ${que}`, () =>
        inOrder(async () => {
          await sala.record('ItemReturnedToQueue', status.id, { item_ids: ids })
        }),
      )
    })

  /** Marca agotado o disponible el producto entero o una variante (la botella, no la copa). */
  const alternarAgotado = (
    p: ProductoCatalogo,
    variantId: string | null,
    markSoldOut: boolean,
    deshacible = true,
  ): void =>
    inOrder(async () => {
      await sala.record(markSoldOut ? 'ProductSoldOut' : 'ProductAvailable', p.id, {
        product_id: p.id,
        variant_id: variantId,
      })
      const variant = p.variants.find((v) => v.id === variantId)
      const name = variant ? `${p.name} (${variant.name})` : p.name
      const text = markSoldOut ? `${name}: agotado` : `${name} vuelve a estar disponible`
      if (deshacible) avisar(text, () => alternarAgotado(p, variantId, !markSoldOut, false))
      else avisar(text)
    })

  const tocarProducto = (p: ProductoCatalogo) => {
    if (marcandoAgotados) {
      if (p.variants.length > 0) setAgotando(p)
      else alternarAgotado(p, null, !soldOut(p))
    } else if (soldOut(p)) avisar(`${p.name} está agotado`)
    else if (pideOpciones(p)) setElegido(p)
    else add(p, null, {})
  }

  const favoritos = products.filter((p) => p.favorite)
  const masPedidos = (vista?.masPedidos ?? [])
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is ProductoCatalogo => p !== undefined)
  const categoriaActual =
    category ??
    (favoritos.length > 0
      ? FAVORITOS
      : masPedidos.length > 0
        ? MAS_PEDIDOS
        : catalog.categories[0]?.id)
  const list = busqueda.trim()
    ? search(products, busqueda, (p) => `${p.name} ${p.description ?? ''}`)
    : categoriaActual === FAVORITOS
      ? favoritos
      : categoriaActual === MAS_PEDIDOS
        ? masPedidos
        : (catalog.categories.find((c) => c.id === categoriaActual)?.products ?? [])
  // Unidades por enviar ahora (lo retenido espera a que se marche su curso).
  const enPedido = (productId: string) =>
    order
      ? itemsVigentes(order.status)
          .filter(
            (i) => i.productId === productId && (i.status === 'pending' || i.status === 'held'),
          )
          .reduce((s, i) => s + i.quantity, 0)
      : 0
  const missingOnes = order ? unidadesPorEnviar(order.status) : 0
  const itemEditado = order && editando ? (order.status.items[editando] ?? null) : null

  const enCocina = order ? itemsVigentes(order.status).filter((i) => EN_COCINA.has(i.status)) : []
  const botonEnviar = (
    <Boton
      variant="main"
      large
      icono="send"
      className="w-full"
      disabled={missingOnes === 0}
      onClick={send}
    >
      {missingOnes === 0 ? 'Enviar' : `Enviar ${missingOnes}`}
    </Boton>
  )
  // La precuenta, dividir y cobrar (tarea 1.6), en su pantalla.
  const conProductos = order !== null && itemsVigentes(order.status).length > 0
  const irACuenta = () => order && navegar(`/check?order=${order.status.id}`)
  const botonCuenta = (
    <Boton variant="secondary" large icono="receipt" className="w-full" onClick={irACuenta}>
      Cuenta
    </Boton>
  )
  const pieTicket = conProductos ? (
    <div className="grid grid-cols-[2fr_3fr] gap-2">
      {botonCuenta}
      {botonEnviar}
    </div>
  ) : (
    botonEnviar
  )
  const ticket = (
    <Ticket
      order={order}
      guests={guests}
      enSalon={channel === 'dine_in'}
      alCambiarComensales={cambiarComensales}
      alTocarItem={(i) => setEditando(i.id)}
      alSumar={(i, delta) => increment(i.id, delta)}
      alRetener={hold}
      alMarchar={marchar}
      alEntregar={puedeEntregar ? serve : null}
      alEditarNota={() => setEditandoNota(true)}
      alAcciones={order || tableId ? () => setAccion('menu') : null}
    />
  )

  return (
    <MarcoSala title={title} back="/">
      <div className="mx-auto flex max-w-[96rem] gap-5 p-3 pb-28 md:p-5 md:pb-5">
        <section className="min-w-0 flex-1" aria-label="Carta">
          {tableId && candidatos.length > 1 && (
            <Grupo etiqueta="Pedidos de la mesa" className="mb-3 flex flex-wrap gap-2">
              {candidatos.map((p, i) => (
                <Opcion
                  key={p.status.id}
                  elegida={p.status.id === elegidoId}
                  alElegir={() => navegar(`/order?table=${tableId}&order=${p.status.id}`)}
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
                name="search"
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
                  if (e.key === 'Enter' && list.length === 1 && list[0]) {
                    tocarProducto(list[0])
                    setBusqueda('')
                  }
                }}
                placeholder="Buscar: «hamburgesa», «aperol»…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="min-h-12 w-full rounded-xl border border-linea bg-superficie pr-3 pl-11 text-lg shadow-flota placeholder:text-texto-suave focus-visible:outline-3 focus-visible:outline-foco"
              />
            </label>
            {puedeAgotar && (
              <Boton
                variant={marcandoAgotados ? 'main' : 'secondary'}
                aria-pressed={marcandoAgotados}
                onClick={() => setMarcandoAgotados(!marcandoAgotados)}
              >
                {marcandoAgotados ? 'Listo' : 'Marcar agotados'}
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
              {catalog.categories.map((c) => (
                <Opcion
                  key={c.id}
                  elegida={c.id === categoriaActual}
                  alElegir={() => setCategoria(c.id)}
                >
                  {c.name}
                </Opcion>
              ))}
            </Grupo>
          )}

          <ElegirPara
            guests={channel === 'dine_in' ? guests : 0}
            preguntarPersonas={channel === 'dine_in' && guests === 0}
            guest={guest}
            course={course}
            usarCursos={usarCursos}
            alElegirComensal={setComensal}
            alElegirCurso={setCurso}
            alContarPersonas={(n) => cambiarComensales(n - guests)}
          />

          {orders === null && (
            <p className="mt-3 text-texto-suave" role="status">
              Leyendo los pedidos de este equipo…
            </p>
          )}
          {/* Las columnas salen del ancho de la carta, no de la pantalla: en tablet el panel del
              pedido le quita espacio. */}
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
            {list.slice(0, RESULTADOS).map((p) => {
              const quantity = enPedido(p.id)
              const sinStock = soldOut(p)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    // Hasta leer los pedidos no se sabe si la mesa ya tiene uno.
                    disabled={orders === null}
                    aria-label={[
                      p.name,
                      sinStock
                        ? 'agotado'
                        : p.variants.length > 0
                          ? `desde ${pesos(Math.min(...p.variants.map((v) => v.price)))}`
                          : pesos(p.price),
                      ...(quantity > 0 ? [`${quantity} en el pedido`] : []),
                    ].join(', ')}
                    onClick={() => tocarProducto(p)}
                    className={`group flex h-full w-full flex-col overflow-hidden rounded-2xl border text-left transition active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco ${
                      sinStock
                        ? 'border-dashed border-alerta-fuerte bg-alerta-suave text-alerta-texto'
                        : quantity > 0
                          ? 'border-accion-fuerte bg-superficie shadow-flota'
                          : 'border-linea bg-superficie hover:border-borde hover:shadow-flota'
                    }`}
                  >
                    <span
                      className={`relative flex w-full items-center justify-center ${
                        p.photo
                          ? 'aspect-video bg-superficie-2 sm:aspect-[4/3]'
                          : 'h-14 bg-superficie-2/70 sm:h-20'
                      }`}
                    >
                      <FotoOIcono
                        photo={p.photo ?? null}
                        icono={iconoDe(estacionDe.get(p.id) ?? '')}
                        apagada={sinStock}
                      />
                      {quantity > 0 && (
                        <span className="cifras absolute top-2 right-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-accion-fuerte px-2 text-sm font-bold text-white shadow-flota">
                          {`×${quantity}`}
                        </span>
                      )}
                      {sinStock && (
                        <span className="absolute top-2 left-2 rounded-full bg-alerta-fuerte px-2.5 py-0.5 text-sm font-semibold text-white">
                          Agotado
                        </span>
                      )}
                    </span>
                    <span className="flex flex-1 flex-col gap-2 p-3">
                      <span
                        className={`line-clamp-2 font-semibold leading-snug ${sinStock ? 'line-through' : ''}`}
                      >
                        {p.name}
                      </span>
                      <span className="mt-auto flex items-center justify-between gap-2">
                        <span className="cifras text-lg font-bold">
                          {p.variants.length > 0
                            ? `desde ${pesos(Math.min(...p.variants.map((v) => v.price)))}`
                            : pesos(p.price)}
                        </span>
                        {!sinStock &&
                          (pideOpciones(p) ? (
                            <span className="text-sm whitespace-nowrap text-texto-suave">
                              opciones ›
                            </span>
                          ) : (
                            <span
                              aria-hidden="true"
                              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accion-fuerte text-white transition group-hover:brightness-110"
                            >
                              <Icono name="more" className="size-5" />
                            </span>
                          ))}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
            {list.length === 0 && (
              <li className="col-span-full p-6 text-center text-texto-suave">
                {busqueda.trim() ? `No hay nada con «${busqueda}».` : 'No hay productos aquí.'}
              </li>
            )}
            {list.length > RESULTADOS && (
              <li className="col-span-full p-3 text-center text-texto-suave">
                {`Hay ${list.length - RESULTADOS} más: escribe un poco más.`}
              </li>
            )}
          </ul>
        </section>

        {/* Tablet y caja: el pedido siempre a la vista. */}
        <aside className="sticky top-21 hidden h-[calc(100dvh-6.5rem)] w-80 shrink-0 lg:w-96 flex-col overflow-hidden rounded-2xl border border-linea bg-superficie shadow-flota md:flex">
          <div className="flex items-center justify-between gap-2 border-b border-linea px-4 py-3">
            <h2 className="text-lg font-bold">{title}</h2>
            {order?.status.dayNumber && (
              <span className="cifras text-sm text-texto-suave">{`Pedido #${order.status.dayNumber}`}</span>
            )}
          </div>
          {ticket}
          <div className="border-t border-linea p-4">{pieTicket}</div>
        </aside>
      </div>

      {/* Celular: barra fija abajo, al alcance del pulgar. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-linea bg-lateral p-3 shadow-flota md:hidden">
        <Boton
          variant="secondary"
          large
          onClick={() => setVerPedido(true)}
          className="flex-1 flex-col gap-0! text-base! leading-tight"
        >
          <span>{`Pedido (${order ? itemsVigentes(order.status).reduce((n, i) => n + i.quantity - i.voidedQuantity, 0) : 0})`}</span>
          <span className="cifras font-titulo text-lg">{pesos(order?.total ?? 0)}</span>
        </Boton>
        {/* Con todo enviado, el pulgar entrega lo que está en cocina de una vez (ADR-015). */}
        <div className="flex-1">
          {missingOnes === 0 && puedeEntregar && enCocina.length > 0 ? (
            <Boton
              variant="success"
              large
              icono="serve"
              className="w-full"
              onClick={() =>
                serve(
                  enCocina.map((i) => i.id),
                  `${unidadesDe(enCocina)} ${unidadesDe(enCocina) === 1 ? 'producto' : 'productos'}`,
                )
              }
            >
              {`Entregar ${unidadesDe(enCocina)}`}
            </Boton>
          ) : missingOnes === 0 && conProductos ? (
            botonCuenta
          ) : (
            botonEnviar
          )}
        </div>
      </div>

      <PanelLateral
        opened={verPedido}
        title={`Pedido · ${title}`}
        alCerrar={() => setVerPedido(false)}
        pie={pieTicket}
      >
        {ticket}
      </PanelLateral>

      <PanelProducto
        product={elegido}
        agotados={agotados}
        alCerrar={() => setElegido(null)}
        alAgregar={(variantId, elegidas, extras) => {
          if (elegido) add(elegido, variantId, elegidas, extras)
          setElegido(null)
        }}
      />

      <PanelAgotar
        product={agotando}
        agotados={agotados}
        alCerrar={() => setAgotando(null)}
        onChange={(variantId, markSoldOut) =>
          agotando && alternarAgotado(agotando, variantId, markSoldOut)
        }
      />

      {editandoNota && (
        <PanelNotaPedido
          note={order?.status.notes ?? null}
          alCerrar={() => setEditandoNota(false)}
          onSave={(note) => {
            cambiarNotaPedido(note)
            setEditandoNota(false)
          }}
        />
      )}

      {action === 'menu' && (
        <PanelAccionesPedido
          withTable={order ? order.status.tableId !== null : !!tableId}
          withOrder={!!order}
          alCerrar={() => setAccion(null)}
          alElegir={setAccion}
        />
      )}
      {order && action === 'move' && (
        <PanelMover
          order={order}
          catalog={catalog}
          occupiedIds={occupiedIds}
          enLinea={enLinea}
          alCerrar={() => setAccion(null)}
          alMover={moverA}
        />
      )}
      {order?.status.tableId && action === 'table' && (
        <PanelCambiarMesa
          enLinea={enLinea}
          catalog={catalog}
          occupiedIds={occupiedIds}
          current={[order.status.tableId, ...order.status.mergedTables]}
          alCerrar={() => setAccion(null)}
          onChange={cambiarDeMesa}
        />
      )}
      {(order?.status.tableId ?? tableId) && action === 'merge' && (
        <PanelUnirMesas
          enLinea={enLinea}
          catalog={catalog}
          occupiedIds={occupiedIds}
          tableId={(order?.status.tableId ?? tableId) as string}
          merged={order?.status.mergedTables ?? []}
          alCerrar={() => setAccion(null)}
          onSave={unirMesas}
        />
      )}
      {order && action === 'cancel' && (
        <PanelCancelar
          table={title}
          withPayments={Object.values(order.status.payments).some((p) => !p.voided)}
          conPermiso={permissions.includes('cancel_order')}
          enLinea={enLinea}
          enCocina={itemsVigentes(order.status).filter((i) => EN_COCINA.has(i.status)).length}
          alCerrar={() => setAccion(null)}
          alCancelar={cancelarPedido}
        />
      )}
      {order && anulando && order.status.items[anulando] && (
        <PanelAnular
          item={order.status.items[anulando] as OrderItem}
          conPermiso={permissions.includes('void_sent_item')}
          enLinea={enLinea}
          alCerrar={() => setAnulando(null)}
          onVoid={(d) => voidItem(anulando, d)}
        />
      )}

      {order && itemEditado && !anulando && (
        <PanelItem
          key={itemEditado.id}
          item={itemEditado}
          guests={guests}
          alCerrar={() => setEditando(null)}
          enSalon={channel === 'dine_in'}
          onChange={(change) => cambiarItem(itemEditado.id, change)}
          alSumar={(delta) => increment(itemEditado.id, delta)}
          usarCursos={usarCursos}
          onVoid={() => setAnulando(itemEditado.id)}
          alCambiarNotaEnviada={(notes) => cambiarNotaEnviada(itemEditado.id, notes)}
          alDuplicar={() => {
            duplicateSelected(itemEditado.id)
            setEditando(null)
          }}
          alQuitar={() => {
            remove(itemEditado.id)
            setEditando(null)
          }}
        />
      )}
    </MarcoSala>
  )
}

/** La foto del producto; si no tiene, o no carga (el hub no responde), su ícono. */
function FotoOIcono({
  photo,
  icono,
  apagada,
}: {
  photo: string | null
  icono: NombreIcono
  apagada: boolean
}) {
  const [broken, setRota] = useState(false)
  if (photo && !broken)
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        onError={() => setRota(true)}
        className={`size-full object-cover ${apagada ? 'opacity-40 grayscale' : ''}`}
      />
    )
  return (
    <Icono
      name={icono}
      className={`size-9 ${apagada ? 'text-alerta-texto' : 'text-texto-suave'}`}
    />
  )
}

/** Sin foto, el producto muestra un ícono: copa si sale por la barra, plato si sale por cocina. */
const iconoDe = (station: string): NombreIcono =>
  /barra|bar|bebida/i.test(station) ? 'glass' : 'dish'

const nombreComensal = (c: number | null) => (c === null ? 'Mesa' : `P${c}`)
const etiquetaComensal = (c: number | null) =>
  c === null ? 'Mesa, para todos' : `P${c}, persona ${c}`
const personasDe = (guests: number) => [null, ...Array.from({ length: guests }, (_, i) => i + 1)]
/** Lo que se toca más al sentar una mesa; más de 6 se sube con + en el pedido. */
const PERSONAS_RAPIDAS = [1, 2, 3, 4, 5, 6]

/** Para quién y en qué curso va lo que se agregue: vale para lo siguiente. */
function ElegirPara({
  guests,
  preguntarPersonas,
  guest,
  course,
  usarCursos,
  alElegirComensal,
  alElegirCurso,
  alContarPersonas,
}: {
  guests: number
  preguntarPersonas: boolean
  guest: number | null
  course: Course | null
  usarCursos: boolean
  alElegirComensal: (c: number | null) => void
  alElegirCurso: (c: Course | null) => void
  alContarPersonas: (n: number) => void
}) {
  // En el celular cada fila es una sola línea que se desliza; en pantallas anchas cabe todo.
  const row = '-mx-3 flex items-center gap-2 overflow-x-auto px-3 pb-1 md:flex-wrap'
  return (
    <div className="mt-3 flex flex-col gap-2">
      {preguntarPersonas && (
        <Grupo etiqueta="Cuántas personas hay en la mesa" className={row}>
          <span className="shrink-0 font-semibold text-texto-suave">¿Cuántas personas?</span>
          {PERSONAS_RAPIDAS.map((n) => (
            <Opcion key={n} elegida={false} alElegir={() => alContarPersonas(n)}>
              {String(n)}
            </Opcion>
          ))}
        </Grupo>
      )}
      {guests > 0 && (
        <Grupo etiqueta="Para quién es lo que agregues" className={row}>
          <span className="shrink-0 font-semibold text-texto-suave">Para</span>
          {personasDe(guests).map((c) => (
            <Opcion
              key={c ?? 'table'}
              elegida={guest === c}
              alElegir={() => alElegirComensal(c)}
              etiqueta={etiquetaComensal(c)}
            >
              {nombreComensal(c)}
            </Opcion>
          ))}
        </Grupo>
      )}
      {usarCursos && (
        <Grupo etiqueta="En qué curso va lo que agregues" className={row}>
          <span className="shrink-0 font-semibold text-texto-suave">Curso</span>
          {COURSES.map((c) => (
            <Opcion
              key={c.course ?? 'ninguno'}
              elegida={course === c.course}
              alElegir={() => alElegirCurso(c.course)}
            >
              {c.name}
            </Opcion>
          ))}
        </Grupo>
      )}
    </div>
  )
}

function Ticket({
  order,
  guests,
  enSalon,
  alCambiarComensales,
  alTocarItem,
  alSumar,
  alRetener,
  alMarchar,
  alEntregar,
  alEditarNota,
  alAcciones,
}: {
  order: PedidoVisible | null
  guests: number
  enSalon: boolean
  /** Una persona más (1) o menos (-1). */
  alCambiarComensales: (delta: number) => void
  alTocarItem: (item: OrderItem) => void
  alSumar: (item: OrderItem, delta: number) => void
  alRetener: (course: Course) => void
  alMarchar: (course: Course) => void
  /** Sin el permiso de marcar, no se ven los botones de entregar. */
  alEntregar: ((ids: string[], que: string) => void) | null
  alEditarNota: () => void
  /** Cambiar de mesa, unir, mover y cancelar; sin pedido todavía, nada. */
  alAcciones: (() => void) | null
}) {
  const items = order ? itemsVigentes(order.status) : []
  const porEntregar = items.filter((i) => EN_COCINA.has(i.status))
  const porCurso = COURSES.map((c) => ({
    ...c,
    items: items.filter((i) => i.course === c.course),
  })).filter((c) => c.items.length > 0)
  const esperan = items.filter((i) => i.status === 'held').length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Fuera del salón no se cuentan personas. */}
      {enSalon && (
        <div className="flex items-center gap-2 border-b border-linea p-3">
          <Icono name="people" />
          <span className="font-semibold">
            {guests === 0
              ? 'Sin contar personas'
              : `${guests} ${guests === 1 ? 'persona' : 'personas'}`}
          </span>
          <Boton
            variant="ghost"
            icono="minus"
            aria-label="Una persona menos"
            disabled={guests <= 0}
            onClick={() => alCambiarComensales(-1)}
          />
          <Boton
            variant="ghost"
            icono="more"
            aria-label="Una persona más"
            disabled={guests >= 200}
            onClick={() => alCambiarComensales(1)}
          />
        </div>
      )}
      {alAcciones && (
        <button
          type="button"
          onClick={alAcciones}
          className="flex min-h-12 w-full items-center gap-2 border-b border-linea px-4 py-2 text-left font-semibold hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
        >
          <Icono name="table" className="size-5 shrink-0" />
          Mesa y pedido
          <span className="ml-auto text-sm font-normal text-texto-suave">
            Cambiar, unir, mover, cancelar
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={alEditarNota}
        className="flex min-h-12 w-full items-start gap-2 border-b border-linea px-4 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
      >
        <Icono name="pencil" className="mt-0.5 size-5 shrink-0" />
        {order?.status.notes ? (
          <span>
            <span className="block text-sm text-texto-suave">Nota del pedido</span>
            <span className="font-semibold">{order.status.notes}</span>
          </span>
        ) : (
          <span className="font-semibold text-accion-texto">Nota del pedido</span>
        )}
      </button>
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="p-6 text-center text-texto-suave">Toca un producto para agregarlo.</p>
        )}
        {order &&
          porCurso.map((c) => {
            const heldCourses = c.items.filter((i) => i.status === 'held').length
            const pendingList = c.items.filter((i) => i.status === 'pending').length
            return (
              <section key={c.course ?? 'ninguno'} aria-label={c.name}>
                {(porCurso.length > 1 || c.course !== null) && (
                  <div className="flex min-h-12 items-center justify-between gap-2 bg-superficie-2/60 px-4">
                    <span className="font-semibold">
                      {c.name}
                      {heldCourses > 0 && (
                        <span className="font-normal text-proceso-texto"> · espera</span>
                      )}
                    </span>
                    {c.course !== null && heldCourses > 0 && (
                      <Boton variant="main" onClick={() => alMarchar(c.course as Course)}>
                        {`Marchar ${heldCourses}`}
                      </Boton>
                    )}
                    {c.course !== null && heldCourses === 0 && pendingList > 0 && (
                      <Boton onClick={() => alRetener(c.course as Course)}>Retener</Boton>
                    )}
                  </div>
                )}
                <ul>
                  {c.items.map((i) => (
                    <LineaTicket
                      key={i.id}
                      order={order}
                      item={i}
                      alTocar={() => alTocarItem(i)}
                      alSumar={(delta) => alSumar(i, delta)}
                      alEntregar={
                        alEntregar && EN_COCINA.has(i.status)
                          ? () => alEntregar([i.id], i.name)
                          : null
                      }
                    />
                  ))}
                </ul>
              </section>
            )
          })}
      </div>
      {alEntregar && porEntregar.length > 1 && (
        <div className="border-t border-linea px-3 pt-3">
          <Boton
            icono="serve"
            className="w-full"
            onClick={() =>
              alEntregar(
                porEntregar.map((i) => i.id),
                `${unidadesDe(porEntregar)} productos`,
              )
            }
          >
            {`Todo entregado (${unidadesDe(porEntregar)})`}
          </Boton>
        </div>
      )}
      {esperan > 0 && (
        <p className="border-t border-linea px-3 pt-2 text-sm text-proceso-texto">
          {`${esperan} ${esperan === 1 ? 'espera' : 'esperan'} su curso: «Enviar» no ${esperan === 1 ? 'lo manda' : 'los manda'}; sale${esperan === 1 ? '' : 'n'} al tocar «Marchar».`}
        </p>
      )}
      <div className="flex flex-col gap-1 border-t border-linea px-4 py-3">
        <div className="flex justify-between text-sm text-texto-suave">
          <span>Productos</span>
          <span className="cifras">
            {items.reduce((total, i) => total + i.quantity - i.voidedQuantity, 0)}
          </span>
        </div>
        <div className="cifras flex items-baseline justify-between">
          <span className="text-lg font-semibold">Total</span>
          <span className="text-2xl font-bold">{pesos(order?.total ?? 0)}</span>
        </div>
      </div>
    </div>
  )
}

function LineaTicket({
  order,
  item: i,
  alTocar,
  alSumar,
  alEntregar,
}: {
  order: PedidoVisible
  item: OrderItem
  alTocar: () => void
  alSumar: (delta: number) => void
  alEntregar: (() => void) | null
}) {
  const sinEnviar = i.status === 'pending' || i.status === 'held'
  const porConfirmar = order.itemsPorConfirmar.has(i.id)
  return (
    <li className="flex min-h-14 items-center gap-1 border-b border-linea pr-2">
      <button
        type="button"
        onClick={alTocar}
        className="flex min-h-14 flex-1 items-start gap-3 px-3 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco"
      >
        <span className="cifras w-6 font-semibold">{i.quantity - i.voidedQuantity}</span>
        <span className="flex-1">
          <span className="font-semibold">{i.name}</span>
          {i.modifiers.length > 0 && (
            <span className="block text-sm font-semibold text-proceso-texto">
              {i.modifiers.map((m) => m.name).join(' · ')}
            </span>
          )}
          {i.notes && <span className="block text-sm font-semibold">«{i.notes}»</span>}
          {sinEnviar && !i.notes && (
            <span className="flex items-center gap-1 whitespace-nowrap text-sm text-accion-texto">
              <Icono name="pencil" className="size-4" />
              Toca para nota
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1 text-sm text-texto-suave">
            {[
              ...(i.guest === null ? [] : [nombreComensal(i.guest)]),
              TEXTO_ESTADO[i.status] ?? i.status,
            ].join(' · ')}
            {porConfirmar && (
              <>
                {' · '}
                <Icono name="clock" className="size-4" />
                sin confirmar
              </>
            )}
          </span>
        </span>
        <span className="cifras">{pesos(itemTotals(order.status, i).net)}</span>
      </button>
      {sinEnviar && (
        <>
          <Boton
            variant="ghost"
            icono="minus"
            aria-label={i.quantity === 1 ? `Quitar ${i.name}` : `Uno menos de ${i.name}`}
            onClick={() => alSumar(-1)}
          />
          <Boton
            variant="ghost"
            icono="more"
            aria-label={`Uno más de ${i.name}`}
            disabled={i.quantity >= MAXIMO_LINEA}
            onClick={() => alSumar(1)}
          />
        </>
      )}
      {alEntregar && (
        <Boton
          variant={i.status === 'ready' ? 'success' : 'secondary'}
          icono="serve"
          aria-label={`Entregar: ${i.name}`}
          className="px-3"
          onClick={alEntregar}
        >
          Entregar
        </Boton>
      )}
    </li>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="font-semibold">{title}</p>
      {children}
    </div>
  )
}

function Quantity({
  value,
  onChange,
  minimum = 1,
}: {
  value: number
  onChange: (n: number) => void
  minimum?: number
}) {
  return (
    <div className="flex items-center gap-2">
      <Boton
        icono="minus"
        aria-label="Uno menos"
        disabled={value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <output className="cifras w-10 text-center text-xl font-semibold">{value}</output>
      <Boton
        icono="more"
        aria-label="Uno más"
        disabled={value >= MAXIMO_LINEA}
        onClick={() => onChange(value + 1)}
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
  product,
  agotados,
  alCerrar,
  alAgregar,
}: {
  product: ProductoCatalogo | null
  agotados: Set<string>
  alCerrar: () => void
  alAgregar: (
    variantId: string | null,
    elegidas: Record<string, string[]>,
    extras: { quantity: number; notes: string },
  ) => void
}) {
  const [variantId, setVarianteId] = useState<string | null>(null)
  const [elegidas, setElegidas] = useState<Record<string, string[]>>({})
  const [quantity, setCantidad] = useState(1)
  const [notes, setNotas] = useState('')
  const [abiertoPara, setAbiertoPara] = useState<string | null>(null)

  // Al abrir con otro producto, todo empieza de cero.
  if (product && abiertoPara !== product.id) {
    setAbiertoPara(product.id)
    setVarianteId(null)
    setElegidas({})
    setCantidad(1)
    setNotas('')
  }
  if (!product) return null

  const [unico, ...others] = product.groups
  const unaSola =
    (product.variants.length > 0 && !unico) ||
    (product.variants.length === 0 &&
      others.length === 0 &&
      unico?.minimum === 1 &&
      unico.maximum === 1)
  const missingOnes = faltaElegir(product, variantId, elegidas)
  const price = precioElegido(product, variantId, elegidas)
  const varianteAgotada = (id: string) => agotados.has(claveAgotado(product.id, id))

  const close = () => {
    setAbiertoPara(null)
    alCerrar()
  }
  const agregarCon = (v: string | null, e: Record<string, string[]>) => {
    setAbiertoPara(null)
    alAgregar(v, e, { quantity, notes })
  }
  const tocarOpcion = (grupoId: string, maximum: number, opcionId: string) => {
    const actuales = elegidas[grupoId] ?? []
    const newOnes = actuales.includes(opcionId)
      ? actuales.filter((o) => o !== opcionId)
      : maximum === 1
        ? [opcionId]
        : actuales.length < maximum
          ? [...actuales, opcionId]
          : actuales
    const allRows = { ...elegidas, [grupoId]: newOnes }
    if (unaSola) agregarCon(null, allRows)
    else setElegidas(allRows)
  }

  return (
    <PanelLateral
      opened
      title={product.name}
      alCerrar={close}
      pie={
        <Boton
          variant="main"
          large
          className="w-full"
          disabled={missingOnes.length > 0}
          onClick={() => agregarCon(variantId, elegidas)}
        >
          {missingOnes.length > 0
            ? `Elige ${missingOnes[0]}`
            : `Agregar ${quantity > 1 ? `${quantity} · ` : '· '}${pesos(price * quantity)}`}
        </Boton>
      }
    >
      {product.description && <p className="mb-4 text-texto-suave">{product.description}</p>}
      {unaSola && (
        <p className="mb-3 text-texto-suave">
          Toca una opción y queda agregada. Si quieres cantidad o nota, cámbialas antes.
        </p>
      )}
      {product.variants.length > 0 && (
        <Grupo etiqueta="Tamaño" className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">Tamaño</p>
          {product.variants.map((v) =>
            varianteAgotada(v.id) ? (
              <p
                key={v.id}
                className="flex min-h-14 items-center rounded-xl border-2 border-dashed border-alerta-fuerte px-3 text-alerta-texto"
              >
                {`${v.name} · agotado`}
              </p>
            ) : (
              <Opcion
                key={v.id}
                shape="card"
                elegida={v.id === variantId}
                detalle={pesos(v.price)}
                alElegir={() => (unaSola ? agregarCon(v.id, elegidas) : setVarianteId(v.id))}
              >
                {v.name}
              </Opcion>
            ),
          )}
        </Grupo>
      )}
      {product.groups.map((g) => (
        <Grupo key={g.id} etiqueta={g.name} className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">
            {g.name}
            {g.minimum > 0 && <span className="font-normal text-texto-suave"> (obligatorio)</span>}
            {g.maximum > 1 && (
              <span className="font-normal text-texto-suave">{` · hasta ${g.maximum}`}</span>
            )}
          </p>
          {g.options.map((o) => (
            <Opcion
              key={o.id}
              shape="card"
              elegida={elegidas[g.id]?.includes(o.id) ?? false}
              detalle={o.extraPrice > 0 ? `+ ${pesos(o.extraPrice)}` : undefined}
              alElegir={() => tocarOpcion(g.id, g.maximum, o.id)}
            >
              {o.name}
            </Opcion>
          ))}
        </Grupo>
      ))}
      <Section title="Cantidad">
        <Quantity value={quantity} onChange={setCantidad} />
      </Section>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Nota para cocina (opcional)</span>
        <textarea
          rows={2}
          maxLength={200}
          value={notes}
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
  guests,
  enSalon,
  alCerrar,
  onChange,
  alSumar,
  usarCursos,
  onVoid,
  alCambiarNotaEnviada,
  alDuplicar,
  alQuitar,
}: {
  item: OrderItem
  guests: number
  enSalon: boolean
  usarCursos: boolean
  alCerrar: () => void
  onChange: (change: {
    guest?: number | null
    course?: Course | null
    notes?: string | null
  }) => void
  alSumar: (delta: number) => void
  /** Ya enviado: anular con motivo (y PIN si hace falta). */
  onVoid: () => void
  /** Ya enviado: cambiar su nota; la cocina recibe «CAMBIO». */
  alCambiarNotaEnviada: (notes: string | null) => void
  alDuplicar: () => void
  alQuitar: () => void
}) {
  const sinEnviar = item.status === 'pending' || item.status === 'held'
  const [notes, setNotas] = useState(item.notes ?? '')
  /**
   * La nota se aplica al cerrar el panel (o al elegir persona o curso). Si es para una sola
   * unidad, se escribe así en la nota («1 sin hielo»): el dueño lo prefiere a separar la línea.
   */
  const guardarNota = () => {
    const newOne = notes.trim() || null
    if (newOne === item.notes) return
    if (sinEnviar) onChange({ notes: newOne })
    // Ya enviado y sin entregar: lo escrito no se pierde al cerrar, va como «CAMBIO» a cocina.
    else if (item.status !== 'served' && item.status !== 'voided') alCambiarNotaEnviada(newOne)
  }
  const close = () => {
    guardarNota()
    alCerrar()
  }
  // Para quién y curso son una sola elección: al tocarla, el panel se cierra.
  const select = (change: { guest?: number | null; course?: Course | null }) => {
    guardarNota()
    onChange(change)
    alCerrar()
  }
  return (
    <PanelLateral
      opened
      title={item.name}
      alCerrar={close}
      pie={
        <div className="flex gap-2">
          <Boton
            large
            className="flex-1"
            onClick={() => {
              guardarNota()
              alDuplicar()
            }}
          >
            Duplicar
          </Boton>
          {sinEnviar && (
            <Boton large className="flex-1" onClick={alQuitar}>
              Quitar
            </Boton>
          )}
          {!sinEnviar && item.status !== 'voided' && (
            <Boton variant="danger" large className="flex-1" onClick={onVoid}>
              Anular
            </Boton>
          )}
        </div>
      }
    >
      {!sinEnviar && item.status === 'served' && (
        <p className="rounded-xl bg-neutro-suave p-3 text-neutro-texto">
          Ya se entregó en la mesa. Si hay que anularlo, toca «Anular».
        </p>
      )}
      {!sinEnviar && item.status !== 'served' && (
        <div className="flex flex-col gap-4">
          <p className="rounded-xl bg-neutro-suave p-3 text-neutro-texto">
            Ya salió a cocina. Si cambias la nota, la cocina recibe una comanda «CAMBIO».
          </p>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nota para cocina</span>
            <textarea
              rows={2}
              maxLength={200}
              value={notes}
              onChange={(e) => setNotas(e.target.value)}
              className={claseNota}
            />
          </label>
          <Boton disabled={(notes.trim() || null) === item.notes} onClick={close}>
            Enviar el cambio a cocina
          </Boton>
        </div>
      )}
      {sinEnviar && (
        <>
          <Section title="Cantidad">
            <Quantity value={item.quantity} onChange={(n) => alSumar(n - item.quantity)} />
          </Section>
          {enSalon && guests > 0 && (
            <Grupo etiqueta="Para quién" className="mb-4 flex flex-wrap items-center gap-2">
              <p className="w-full font-semibold">Para quién</p>
              {personasDe(guests).map((c) => (
                <Opcion
                  key={c ?? 'table'}
                  elegida={item.guest === c}
                  alElegir={() => select({ guest: c })}
                  etiqueta={etiquetaComensal(c)}
                >
                  {nombreComensal(c)}
                </Opcion>
              ))}
            </Grupo>
          )}
          {usarCursos && (
            <Grupo etiqueta="Curso" className="mb-4 flex flex-wrap items-center gap-2">
              <p className="w-full font-semibold">Curso</p>
              {COURSES.map((c) => (
                <Opcion
                  key={c.course ?? 'ninguno'}
                  elegida={item.course === c.course}
                  alElegir={() => select({ course: c.course })}
                >
                  {c.name}
                </Opcion>
              ))}
            </Grupo>
          )}
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nota para cocina</span>
            <textarea
              rows={2}
              maxLength={200}
              value={notes}
              placeholder={
                item.quantity - item.voidedQuantity > 1
                  ? '1 sin hielo, salsa aparte…'
                  : 'Sin hielo, salsa aparte…'
              }
              onChange={(e) => setNotas(e.target.value)}
              className={claseNota}
            />
          </label>
        </>
      )}
    </PanelLateral>
  )
}

/** La nota de todo el pedido: alergias, celebraciones, «todo junto». Va en cada comanda. */
function PanelNotaPedido({
  note,
  alCerrar,
  onSave,
}: {
  note: string | null
  alCerrar: () => void
  onSave: (note: string | null) => void
}) {
  const [text, setTexto] = useState(note ?? '')
  const newOne = text.trim() || null
  return (
    <PanelLateral
      opened
      title="Nota del pedido"
      alCerrar={alCerrar}
      pie={
        <Boton variant="main" large className="w-full" onClick={() => onSave(newOne)}>
          {newOne === null && note !== null ? 'Quitar la nota' : 'Guardar'}
        </Boton>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Para cocina y barra, en cada comanda</span>
        <textarea
          rows={3}
          maxLength={300}
          value={text}
          placeholder="Alérgico al maní, cumpleaños, todo junto…"
          // biome-ignore lint/a11y/noAutofocus: el panel se abre solo para escribir la nota
          autoFocus
          onChange={(e) => setTexto(e.target.value)}
          className={claseNota}
        />
      </label>
      <p className="mt-2 text-sm text-texto-suave">
        Sale en cada comanda que envíes. Si ya hay platos en cocina, la nota nueva sale además en
        papel a cada estación que tenga algo pendiente.
      </p>
    </PanelLateral>
  )
}

/** Agotar un producto con tamaños: el producto entero o solo uno (se acabó la botella, no la copa). */
function PanelAgotar({
  product,
  agotados,
  alCerrar,
  onChange,
}: {
  product: ProductoCatalogo | null
  agotados: Set<string>
  alCerrar: () => void
  onChange: (variantId: string | null, markSoldOut: boolean) => void
}) {
  if (!product) return null
  const everything = agotados.has(claveAgotado(product.id))
  // Con todo el producto agotado, los tamaños no se tocan por separado.
  const options = [
    { id: null, name: 'Todo el producto' },
    ...(everything ? [] : product.variants.map((v) => ({ id: v.id, name: v.name }))),
  ]
  return (
    <PanelLateral opened title={`Agotar ${product.name}`} alCerrar={alCerrar}>
      <p className="mb-4 text-texto-suave">
        Toca lo que se acabó; tócalo otra vez cuando vuelva a haber.
      </p>
      <Grupo etiqueta="Qué se acabó" className="flex flex-col gap-2">
        {options.map((o) => {
          const yaAgotado = agotados.has(claveAgotado(product.id, o.id))
          return (
            <Opcion
              key={o.id ?? 'everything'}
              shape="card"
              elegida={yaAgotado}
              detalle={yaAgotado ? 'agotado' : 'disponible'}
              alElegir={() => onChange(o.id, !yaAgotado)}
            >
              {o.name}
            </Opcion>
          )
        })}
      </Grupo>
    </PanelLateral>
  )
}
