import { Boton } from '../ui/Boton'
import { Etiqueta, TONOS_SUAVES, type Tono } from '../ui/Etiqueta'
import { pesos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { navegar } from '../ui/ruta'
import { usePedidos, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'
import { type EstadoMesaDemo, estadoMesa, type PedidoVisible } from './proyeccion'

// Plano de mesas de la demo: el salón real del piloto (del catálogo del hub) con el estado que
// sale de los pedidos guardados en este equipo. Un toque en la mesa lleva a su pedido.

const ESTADOS: Record<EstadoMesaDemo, { tono: Tono; icono: NombreIcono; texto: string }> = {
  libre: { tono: 'libre', icono: 'circulo', texto: 'Libre' },
  tomando: { tono: 'proceso', icono: 'lapiz', texto: 'Tomando pedido' },
  en_cocina: { tono: 'proceso', icono: 'fuego', texto: 'En preparación' },
}

export function Mesas() {
  const { catalogo, equipo, sesion } = useSala()
  const editaCarta = sesion?.permisos.some((p) => p === 'editar_catalogo' || p === 'editar_precios')
  const pedidos = usePedidos()
  if (!catalogo) return null

  const deMesa = (mesaId: string) => (pedidos ?? []).filter((p) => p.estado.mesaId === mesaId)
  const conteo = (estado: EstadoMesaDemo) =>
    catalogo.mesas.filter((m) => estadoMesa(deMesa(m.id)) === estado).length

  return (
    <MarcoSala titulo="Salón">
      <div className="mx-auto max-w-6xl p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Etiqueta tono="libre" icono="circulo">{`${conteo('libre')} libres`}</Etiqueta>
          <Etiqueta tono="proceso" icono="fuego">
            {`${conteo('tomando') + conteo('en_cocina')} atendiendo`}
          </Etiqueta>
          <span className="flex-1" />
          {editaCarta && (
            <Boton variante="secundario" onClick={() => navegar('/carta')}>
              Carta
            </Boton>
          )}
          {equipo?.tipo === 'caja' && (
            <Boton variante="secundario" onClick={() => navegar('/equipos')}>
              Aprobar un equipo
            </Boton>
          )}
        </div>
        {catalogo.zonas.map((zona) => (
          <section key={zona.id} className="mb-5" aria-label={zona.nombre}>
            {catalogo.zonas.length > 1 && (
              <h2 className="mb-2 text-lg font-semibold">{zona.nombre}</h2>
            )}
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {catalogo.mesas
                .filter((m) => m.zonaId === zona.id)
                .map((m) => (
                  <li key={m.id}>
                    <MesaEnPlano
                      nombre={m.nombre}
                      pedidos={deMesa(m.id)}
                      alTocar={() => navegar(`/pedido?mesa=${m.id}`)}
                    />
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </MarcoSala>
  )
}

function MesaEnPlano({
  nombre,
  pedidos,
  alTocar,
}: {
  nombre: string
  pedidos: PedidoVisible[]
  alTocar: () => void
}) {
  const estado = estadoMesa(pedidos)
  const v = ESTADOS[estado]
  const total = pedidos.reduce((s, p) => s + p.total, 0)
  const porConfirmar = pedidos.some((p) => p.porConfirmar)
  const varios = pedidos.length > 1
  const detalle = [
    v.texto,
    estado !== 'libre' ? pesos(total) : '',
    varios ? `${pedidos.length} pedidos` : '',
    porConfirmar ? 'sin confirmar' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <button
      type="button"
      onClick={alTocar}
      aria-label={`Mesa ${nombre}: ${detalle}`}
      className={`flex aspect-square w-full flex-col justify-between rounded-2xl border-2 p-2 text-left transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${
        estado === 'libre'
          ? 'border-borde bg-superficie text-libre-texto'
          : `border-transparent ${TONOS_SUAVES[v.tono]}`
      }`}
    >
      <span className="flex items-start justify-between">
        <span className="font-titulo text-3xl font-bold leading-none">{nombre}</span>
        <Icono nombre={porConfirmar ? 'reloj' : v.icono} />
      </span>
      <span className="text-sm leading-tight font-semibold">
        {v.texto}
        {varios && <span className="block">{`${pedidos.length} pedidos`}</span>}
        {porConfirmar && <span className="block font-normal">sin confirmar</span>}
      </span>
      {estado !== 'libre' && <span className="cifras text-sm leading-tight">{pesos(total)}</span>}
    </button>
  )
}
