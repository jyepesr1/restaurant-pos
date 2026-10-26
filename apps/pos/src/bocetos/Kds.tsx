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

export function tiempoDeComanda(m: number): { tono: Tono; icono: NombreIcono; text: string } {
  if (m >= MINUTOS_DEMORA) return { tono: 'warning', icono: 'warning', text: 'demora' }
  if (m >= MINUTOS_ATENCION) return { tono: 'progress', icono: 'clock', text: 'atención' }
  return { tono: 'neutral', icono: 'clock', text: 'a tiempo' }
}

/** Despachar marca los ítems de esa estación; si ya no queda nada en preparación, la mesa está lista. */
function despachar(table: Mesa, ids: ReadonlySet<string>): Mesa {
  const items = table.items.map((i) => (ids.has(i.id) ? { ...i, despachado: true } : i))
  const queda = items.some((i) => !i.voided && i.enviadoEn !== null && !i.despachado)
  return {
    ...table,
    items,
    status: queda || table.status !== 'in_kitchen' ? table.status : 'ready',
  }
}

export function Kds() {
  const tables = useMesas()
  const ahora = useAhora(5000)
  const avisar = useAvisar()
  const [filtro, setFiltro] = useState<Filtro>('todas')
  const [listos, setListos] = useState<Set<string>>(new Set())

  const tickets = useMemo(
    () =>
      tables
        // Una mesa ya cerrada (por limpiar o libre) no tiene nada que preparar.
        .filter((table) => table.status !== 'dirty' && table.status !== 'free')
        .flatMap((table) =>
          (['cocina', 'barra'] as const).map((station) => {
            const items = enPreparacion(table).filter(
              (i) => estacionDe.get(i.product.key) === station,
            )
            const from = Math.min(...items.map((i) => i.enviadoEn as number))
            return { key: `${table.number}-${station}`, table, station, items, from }
          }),
        )
        .filter((c) => c.items.length > 0)
        .filter((c) => filtro === 'todas' || c.station === filtro)
        .sort((a, b) => a.from - b.from),
    [tables, filtro],
  )

  const alternar = (id: string) =>
    setListos((a) => {
      const b = new Set(a)
      if (b.has(id)) b.delete(id)
      else b.add(id)
      return b
    })

  return (
    <Marco title="Cocina y barra" user="Cocina">
      <div className="p-3">
        <Grupo etiqueta="Estación" className="mb-3 flex flex-wrap gap-2">
          {(['todas', 'cocina', 'barra'] as const).map((f) => (
            <Opcion key={f} elegida={filtro === f} alElegir={() => setFiltro(f)}>
              <span className="text-lg capitalize">{f}</span>
            </Opcion>
          ))}
        </Grupo>
        {tickets.length === 0 && (
          <p className="p-10 text-center text-xl text-texto-suave">No hay comandas pendientes.</p>
        )}
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tickets.map((c) => {
            const m = minutosDesde(c.from, ahora)
            const t = tiempoDeComanda(m)
            const all = c.items.every((i) => listos.has(i.id))
            return (
              <li
                key={c.key}
                className="flex flex-col rounded-2xl border border-borde bg-superficie"
              >
                <div className="flex items-center justify-between gap-2 border-b border-borde p-3">
                  <div>
                    <p className="font-titulo text-3xl font-bold">Mesa {c.table.number}</p>
                    <p className="text-texto-suave">
                      {c.table.waiter} · <span className="capitalize">{c.station}</span>
                    </p>
                  </div>
                  <Etiqueta tono={t.tono} icono={t.icono} main>
                    <span className="cifras text-lg">{minutos(m)}</span>
                    <span className="text-sm">{t.text}</span>
                  </Etiqueta>
                </div>
                <ul className="flex-1">
                  {c.items.map((i) => {
                    const ready = listos.has(i.id)
                    return (
                      <li key={i.id}>
                        <button
                          type="button"
                          aria-pressed={ready}
                          onClick={() => alternar(i.id)}
                          className={`flex min-h-14 w-full items-start gap-3 border-b border-borde px-3 py-2 text-left text-lg ${ready ? 'bg-libre-suave text-libre-texto' : ''}`}
                        >
                          <span className="cifras w-8 font-bold">{i.quantity}×</span>
                          <span className="flex-1">
                            <span className={`font-semibold ${ready ? 'line-through' : ''}`}>
                              {nombreItem(i)}
                            </span>
                            {i.options.length > 0 && (
                              <span className="block rounded bg-proceso-suave px-1 font-bold text-proceso-texto">
                                {i.options.map((o) => o.name).join(' · ')}
                              </span>
                            )}
                            {i.notes && (
                              <span className="block font-bold text-alerta-texto">¡{i.notes}!</span>
                            )}
                            {i.guest && (
                              <span className="block text-base text-texto-suave">P{i.guest}</span>
                            )}
                          </span>
                          {ready && <Icono name="check" />}
                          <span className="sr-only">{ready ? 'listo' : 'pendiente'}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <div className="p-3">
                  <Boton
                    variant={all ? 'success' : 'secondary'}
                    large
                    icono="check"
                    className="w-full"
                    onClick={() => {
                      const ids = new Set(c.items.map((i) => i.id))
                      cambiarMesa(c.table.number, (table) => despachar(table, ids))
                      avisar(`Mesa ${c.table.number} despachada (${c.station})`, () =>
                        cambiarMesa(c.table.number, (table) => ({
                          ...table,
                          status: table.status === 'ready' ? 'in_kitchen' : table.status,
                          items: table.items.map((i) =>
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
