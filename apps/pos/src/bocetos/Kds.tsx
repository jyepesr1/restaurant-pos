import { useMemo, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta, type Tono } from '../ui/Etiqueta'
import { minutos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { estacionDe, type Mesa } from './datos'
import { cambiarMesa, useAhora, useMesas } from './estado'
import { Marco } from './Marco'
import {
  enPreparacion,
  MINUTOS_ATENCION,
  MINUTOS_DEMORA,
  minutosDesde,
  nombreItem,
} from './totales'

// Pantalla de cocina y barra (brief §4.4): una tarjeta por mesa y estación. El tiempo sale de la
// hora de envío de la comanda (igual en todas las pantallas). Verde queda para "listo": el tiempo
// normal va en gris, la atención en ámbar y la demora en rojo, cada uno con su texto. Tocar un ítem
// lo marca listo; "Todo listo" despacha la comanda (con Deshacer) y avisa al mesero en el plano.

type Filtro = 'todas' | 'cocina' | 'barra'

export function tiempoDeComanda(m: number): { tono: Tono; icono: NombreIcono; texto: string } {
  if (m >= MINUTOS_DEMORA) return { tono: 'alerta', icono: 'alerta', texto: 'demora' }
  if (m >= MINUTOS_ATENCION) return { tono: 'proceso', icono: 'reloj', texto: 'atención' }
  return { tono: 'neutro', icono: 'reloj', texto: 'a tiempo' }
}

/** Despachar marca los ítems de esa estación; si ya no queda nada en preparación, la mesa está lista. */
function despachar(mesa: Mesa, ids: ReadonlySet<string>): Mesa {
  const items = mesa.items.map((i) => (ids.has(i.id) ? { ...i, despachado: true } : i))
  const queda = items.some((i) => !i.anulado && i.enviadoEn !== null && !i.despachado)
  return { ...mesa, items, estado: queda || mesa.estado !== 'en_cocina' ? mesa.estado : 'listo' }
}

export function Kds() {
  const mesas = useMesas()
  const ahora = useAhora(5000)
  const avisar = useAvisar()
  const [filtro, setFiltro] = useState<Filtro>('todas')
  const [listos, setListos] = useState<Set<string>>(new Set())

  const comandas = useMemo(
    () =>
      mesas
        // Una mesa ya cerrada (por limpiar o libre) no tiene nada que preparar.
        .filter((mesa) => mesa.estado !== 'sucia' && mesa.estado !== 'libre')
        .flatMap((mesa) =>
          (['cocina', 'barra'] as const).map((estacion) => {
            const items = enPreparacion(mesa).filter(
              (i) => estacionDe.get(i.producto.clave) === estacion,
            )
            const desde = Math.min(...items.map((i) => i.enviadoEn as number))
            return { clave: `${mesa.numero}-${estacion}`, mesa, estacion, items, desde }
          }),
        )
        .filter((c) => c.items.length > 0)
        .filter((c) => filtro === 'todas' || c.estacion === filtro)
        .sort((a, b) => a.desde - b.desde),
    [mesas, filtro],
  )

  const alternar = (id: string) =>
    setListos((a) => {
      const b = new Set(a)
      if (b.has(id)) b.delete(id)
      else b.add(id)
      return b
    })

  return (
    <Marco titulo="Cocina y barra" usuario="Cocina">
      <div className="p-3">
        <Grupo etiqueta="Estación" className="mb-3 flex flex-wrap gap-2">
          {(['todas', 'cocina', 'barra'] as const).map((f) => (
            <Opcion key={f} elegida={filtro === f} alElegir={() => setFiltro(f)}>
              <span className="text-lg capitalize">{f}</span>
            </Opcion>
          ))}
        </Grupo>
        {comandas.length === 0 && (
          <p className="p-10 text-center text-xl text-texto-suave">No hay comandas pendientes.</p>
        )}
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {comandas.map((c) => {
            const m = minutosDesde(c.desde, ahora)
            const t = tiempoDeComanda(m)
            const todos = c.items.every((i) => listos.has(i.id))
            return (
              <li
                key={c.clave}
                className="flex flex-col rounded-2xl border border-borde bg-superficie"
              >
                <div className="flex items-center justify-between gap-2 border-b border-borde p-3">
                  <div>
                    <p className="text-2xl font-bold">Mesa {c.mesa.numero}</p>
                    <p className="text-texto-suave">
                      {c.mesa.mesero} · <span className="capitalize">{c.estacion}</span>
                    </p>
                  </div>
                  <Etiqueta tono={t.tono} icono={t.icono} fuerte>
                    <span className="cifras text-lg">{minutos(m)}</span>
                    <span className="text-sm">{t.texto}</span>
                  </Etiqueta>
                </div>
                <ul className="flex-1">
                  {c.items.map((i) => {
                    const listo = listos.has(i.id)
                    return (
                      <li key={i.id}>
                        <button
                          type="button"
                          aria-pressed={listo}
                          onClick={() => alternar(i.id)}
                          className={`flex min-h-14 w-full items-start gap-3 border-b border-borde px-3 py-2 text-left text-lg ${listo ? 'bg-libre-suave text-libre-texto' : ''}`}
                        >
                          <span className="cifras w-8 font-bold">{i.cantidad}×</span>
                          <span className="flex-1">
                            <span className={`font-semibold ${listo ? 'line-through' : ''}`}>
                              {nombreItem(i)}
                            </span>
                            {i.opciones.length > 0 && (
                              <span className="block rounded bg-proceso-suave px-1 font-bold text-proceso-texto">
                                {i.opciones.map((o) => o.nombre).join(' · ')}
                              </span>
                            )}
                            {i.notas && (
                              <span className="block font-bold text-alerta-texto">¡{i.notas}!</span>
                            )}
                            {i.comensal && (
                              <span className="block text-base text-texto-suave">
                                P{i.comensal}
                              </span>
                            )}
                          </span>
                          {listo && <Icono nombre="check" />}
                          <span className="sr-only">{listo ? 'listo' : 'pendiente'}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <div className="p-3">
                  <Boton
                    variante={todos ? 'exito' : 'secundario'}
                    grande
                    icono="check"
                    className="w-full"
                    onClick={() => {
                      const ids = new Set(c.items.map((i) => i.id))
                      cambiarMesa(c.mesa.numero, (mesa) => despachar(mesa, ids))
                      avisar(`Mesa ${c.mesa.numero} despachada (${c.estacion})`, () =>
                        cambiarMesa(c.mesa.numero, (mesa) => ({
                          ...mesa,
                          estado: mesa.estado === 'listo' ? 'en_cocina' : mesa.estado,
                          items: mesa.items.map((i) =>
                            ids.has(i.id) ? { ...i, despachado: false } : i,
                          ),
                        })),
                      )
                    }}
                  >
                    Todo listo
                  </Boton>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </Marco>
  )
}
