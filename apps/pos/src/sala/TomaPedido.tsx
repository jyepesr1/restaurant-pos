import { type EstadoPedido, type ItemPedido, nuevoId, totalesItem } from '@pos/core'
import { useRef, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { pesos } from '../ui/formato'
import { Icono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar, useRuta } from '../ui/ruta'
import { sala, usePedidos, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'
import {
  comandasPorEstacion,
  copiaDe,
  datosItem,
  faltaElegir,
  type ProductoCatalogo,
  pideOpciones,
  porEnviar,
  precioElegido,
} from './pedido'
import { itemsVigentes, type PedidoVisible } from './proyeccion'

// Toma de pedido de la demo: tocar productos y "Enviar" (brief §5, regla 2). Cada toque es un
// evento guardado aquí antes de mostrarse; se envía al hub cuando haya conexión. La mesa queda
// ocupada al agregar el primer producto, no al abrirla.

const TEXTO_ESTADO: Record<string, string> = {
  pendiente: 'sin enviar',
  retenido: 'retenido',
  enviado: 'enviado',
  en_preparacion: 'en preparación',
  listo: 'listo',
  entregado: 'entregado',
}

export function TomaPedido() {
  const { parametros } = useRuta()
  const { catalogo } = useSala()
  const pedidos = usePedidos()
  const avisar = useAvisar()
  const mesaId = parametros.get('mesa') ?? ''
  const mesa = catalogo?.mesas.find((m) => m.id === mesaId)
  const [categoria, setCategoria] = useState(catalogo?.categorias[0]?.id ?? '')
  const [elegido, setElegido] = useState<ProductoCatalogo | null>(null)
  const [verPedido, setVerPedido] = useState(false)
  // El pedido que se abrió aquí: los toques seguidos van al mismo aunque aún no se haya releído.
  const abierto = useRef<string | null>(null)
  // Los toques se guardan uno tras otro, en el orden en que se hicieron.
  const cola = useRef<Promise<void>>(Promise.resolve())

  if (!catalogo || !mesa) {
    return (
      <MarcoSala titulo="Mesa" volver="/">
        <p className="p-6 text-texto-suave">Esta mesa no existe.</p>
      </MarcoSala>
    )
  }

  const deMesa = (pedidos ?? []).filter((p) => p.estado.mesaId === mesaId)
  const elegidoId = parametros.get('pedido') ?? abierto.current ?? deMesa[0]?.estado.id ?? null
  const pedido = deMesa.find((p) => p.estado.id === elegidoId) ?? null

  const enOrden = (trabajo: () => Promise<void>) => {
    cola.current = cola.current.then(trabajo).catch((e) => {
      console.error(e)
      avisar(e instanceof Error ? e.message : 'No se pudo guardar')
    })
  }

  const agregar = (
    p: ProductoCatalogo,
    varianteId: string | null,
    elegidas: Record<string, string[]>,
  ) =>
    enOrden(async () => {
      // Un toque anterior pudo abrir el pedido después de que se hizo este.
      let id = elegidoId ?? abierto.current
      // Antes de abrir el pedido: si falta elegir algo, no queda un pedido vacío en la mesa.
      const datos = datosItem(catalogo, p, varianteId, elegidas)
      if (!id) {
        id = nuevoId()
        abierto.current = id
        await sala.registrar('PedidoAbierto', id, {
          canal: 'salon',
          mesa_id: mesaId,
          comensales: 0,
        })
      }
      await sala.registrar('ItemAgregado', id, datos)
      const pedidoId = id
      avisar(`Agregaste ${datos.nombre}`, () =>
        enOrden(async () => {
          const estado = await sala.sync?.pedido(pedidoId)
          if (estado?.items[datos.item_id]?.estado !== 'pendiente') {
            avisar(`${datos.nombre} ya se envió: ya no se puede deshacer`)
            return
          }
          await sala.registrar('ItemQuitado', pedidoId, { item_id: datos.item_id })
        }),
      )
    })

  const quitar = (estado: EstadoPedido, item: ItemPedido) =>
    enOrden(async () => {
      // Deshacer lo vuelve a agregar igual (con otro id: el quitado no se reutiliza), con la
      // versión de catálogo con que se agregó: el precio era el de esa carta.
      const original = (await sala.sync?.locales())?.find(
        (l) => l.evento.tipo === 'ItemAgregado' && l.evento.datos.item_id === item.id,
      )?.evento
      const copia =
        original?.tipo === 'ItemAgregado'
          ? { ...original.datos, item_id: nuevoId() }
          : copiaDe(item, catalogo.version)
      await sala.registrar('ItemQuitado', estado.id, { item_id: item.id })
      avisar(`Quitaste ${item.nombre}`, () =>
        enOrden(() => sala.registrar('ItemAgregado', estado.id, copia).then(() => {})),
      )
    })

  const enviar = () =>
    enOrden(async () => {
      // Lo guardado, no lo de la última pantalla: un producto tocado justo antes ya está.
      const id = elegidoId ?? abierto.current
      const estado = id ? await sala.sync?.pedido(id) : null
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
      // Sin conexión queda guardado aquí, pero cocina todavía no lo tiene: no decir "Enviado".
      avisar(
        sala.instantanea().conexion === 'conectado'
          ? `Enviado a cocina y barra (${cuantos})`
          : `Guardado (${cuantos}): llega a cocina cuando vuelva la conexión`,
      )
      setVerPedido(false)
      navegar('/')
    })

  const tocarProducto = (p: ProductoCatalogo) =>
    pideOpciones(p) ? setElegido(p) : agregar(p, null, {})

  const cantidadEnPedido = (productoId: string) =>
    pedido ? porEnviar(pedido.estado).filter((i) => i.productoId === productoId).length : 0
  const faltan = pedido ? porEnviar(pedido.estado).length : 0
  const productos = catalogo.categorias.find((c) => c.id === categoria)?.productos ?? []

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
    <Ticket pedido={pedido} alQuitar={(item) => pedido && quitar(pedido.estado, item)} />
  )

  return (
    <MarcoSala titulo={`Mesa ${mesa.nombre}`} volver="/">
      <div className="mx-auto flex max-w-6xl gap-4 p-3 pb-28 md:pb-3">
        <section className="min-w-0 flex-1" aria-label="Carta">
          {deMesa.length > 1 && (
            <Grupo etiqueta="Pedidos de la mesa" className="mb-3 flex flex-wrap gap-2">
              {deMesa.map((p, i) => (
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
          <Grupo etiqueta="Categorías" className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1">
            {catalogo.categorias.map((c) => (
              <Opcion key={c.id} elegida={c.id === categoria} alElegir={() => setCategoria(c.id)}>
                {c.nombre}
              </Opcion>
            ))}
          </Grupo>
          <ul className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
            {productos.map((p) => {
              const cantidad = cantidadEnPedido(p.id)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    // Hasta leer los pedidos no se sabe si la mesa ya tiene uno.
                    disabled={pedidos === null}
                    onClick={() => tocarProducto(p)}
                    className="relative flex min-h-20 w-full flex-col justify-between rounded-xl border border-borde bg-superficie p-3 text-left hover:bg-superficie-2 active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-foco"
                  >
                    {cantidad > 0 && (
                      <span className="cifras absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-accion-fuerte text-sm font-bold text-white">
                        {cantidad}
                        <span className="sr-only"> en el pedido</span>
                      </span>
                    )}
                    <span className="font-semibold leading-snug">{p.nombre}</span>
                    <span className="cifras mt-1 flex items-center justify-between text-texto-suave">
                      <span className="font-titulo text-lg">
                        {p.variantes.length > 0
                          ? `desde ${pesos(Math.min(...p.variantes.map((v) => v.precio)))}`
                          : pesos(p.precio)}
                      </span>
                      {pideOpciones(p) && (
                        <span className="text-sm whitespace-nowrap">opciones ›</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
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
        titulo={`Pedido · Mesa ${mesa.nombre}`}
        alCerrar={() => setVerPedido(false)}
        pie={botonEnviar}
      >
        {ticket}
      </PanelLateral>

      <PanelProducto
        producto={elegido}
        alCerrar={() => setElegido(null)}
        alAgregar={(varianteId, elegidas) => {
          if (elegido) agregar(elegido, varianteId, elegidas)
          setElegido(null)
        }}
      />
    </MarcoSala>
  )
}

function Ticket({
  pedido,
  alQuitar,
}: {
  pedido: PedidoVisible | null
  alQuitar: (item: ItemPedido) => void
}) {
  const items = pedido ? itemsVigentes(pedido.estado) : []
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <li className="p-6 text-center text-texto-suave">Toca un producto para agregarlo.</li>
        )}
        {pedido &&
          items.map((i) => {
            const porConfirmar = pedido.itemsPorConfirmar.has(i.id)
            return (
              <li
                key={i.id}
                className="flex min-h-14 items-start gap-3 border-b border-borde px-3 py-2"
              >
                <span className="cifras w-6 font-semibold">{i.cantidad - i.cantidadAnulada}</span>
                <span className="flex-1">
                  <span className="font-semibold">{i.nombre}</span>
                  {i.modificadores.length > 0 && (
                    <span className="block text-sm font-semibold text-proceso-texto">
                      {i.modificadores.map((m) => m.nombre).join(' · ')}
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-sm text-texto-suave">
                    {TEXTO_ESTADO[i.estado] ?? i.estado}
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
                {i.estado === 'pendiente' && (
                  <Boton
                    variante="fantasma"
                    icono="cerrar"
                    aria-label={`Quitar ${i.nombre}`}
                    onClick={() => alQuitar(i)}
                  />
                )}
              </li>
            )
          })}
      </ul>
      <div className="cifras flex justify-between p-3 text-lg font-semibold">
        <span>Total</span>
        <span>{pesos(pedido?.total ?? 0)}</span>
      </div>
    </div>
  )
}

/** Tamaño y opciones de un producto. Si solo hay una cosa que elegir, tocarla ya lo agrega. */
function PanelProducto({
  producto,
  alCerrar,
  alAgregar,
}: {
  producto: ProductoCatalogo | null
  alCerrar: () => void
  alAgregar: (varianteId: string | null, elegidas: Record<string, string[]>) => void
}) {
  const [varianteId, setVarianteId] = useState<string | null>(null)
  const [elegidas, setElegidas] = useState<Record<string, string[]>>({})
  const [abiertoPara, setAbiertoPara] = useState<string | null>(null)

  // Al abrir con otro producto, todo empieza de cero.
  if (producto && abiertoPara !== producto.id) {
    setAbiertoPara(producto.id)
    setVarianteId(null)
    setElegidas({})
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

  const cerrar = () => {
    setAbiertoPara(null)
    alCerrar()
  }
  const agregarCon = (v: string | null, e: Record<string, string[]>) => {
    setAbiertoPara(null)
    alAgregar(v, e)
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
          {faltan.length > 0 ? `Elige ${faltan[0]}` : `Agregar · ${pesos(precio)}`}
        </Boton>
      }
    >
      {producto.descripcion && <p className="mb-4 text-texto-suave">{producto.descripcion}</p>}
      {unaSola && (
        <p className="mb-3 text-sm text-texto-suave">Toca una opción y queda agregada.</p>
      )}
      {producto.variantes.length > 0 && (
        <Grupo etiqueta="Tamaño" className="mb-4 flex flex-col gap-2">
          <p className="font-semibold">Tamaño</p>
          {producto.variantes.map((v) => (
            <Opcion
              key={v.id}
              forma="tarjeta"
              elegida={v.id === varianteId}
              detalle={pesos(v.precio)}
              alElegir={() => (unaSola ? agregarCon(v.id, elegidas) : setVarianteId(v.id))}
            >
              {v.nombre}
            </Opcion>
          ))}
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
    </PanelLateral>
  )
}
