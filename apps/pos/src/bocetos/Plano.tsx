import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta, TONOS_SUAVES, type Tono } from '../ui/Etiqueta'
import { minutos, pesos } from '../ui/formato'
import { Icono, type NombreIcono } from '../ui/iconos'
import { navegar } from '../ui/ruta'
import { type EstadoMesa, type Mesa, mesaLibre } from './datos'
import { cambiarMesa, useAhora, useMesas } from './estado'
import { Marco } from './Marco'
import { esperaMasLarga, MINUTOS_DEMORA, minutosDesde, saldoMesa } from './totales'

// Plano de mesas: la pantalla inicial del mesero (brief §5, regla 1). Un toque en una mesa libre
// lleva directo a la toma de pedido: tocar mesa → tocar productos → Enviar. La mesa queda
// ocupada al agregar el primer producto, no al abrirla: si se abrió por error, no queda tomada.

interface Visible {
  tono: Tono
  icono: NombreIcono
  text: string
}

export const ESTADOS: Record<EstadoMesa, Visible> = {
  free: { tono: 'free', icono: 'circle', text: 'Libre' },
  taking: { tono: 'progress', icono: 'pencil', text: 'Tomando pedido' },
  in_kitchen: { tono: 'progress', icono: 'fire', text: 'En preparación' },
  ready: { tono: 'free', icono: 'serve', text: 'Listo para servir' },
  preBill: { tono: 'neutral', icono: 'receipt', text: 'Por cobrar' },
  reserved: { tono: 'neutral', icono: 'calendar', text: 'Reservada' },
  dirty: { tono: 'neutral', icono: 'broom', text: 'Por limpiar' },
}

/** El estado que se muestra: una comanda que lleva 20 min o más en preparación es una demora. */
export function estadoVisible(table: Mesa, ahora: number): Visible {
  if (table.status === 'in_kitchen' && esperaMasLarga(table, ahora) >= MINUTOS_DEMORA)
    return { tono: 'warning', icono: 'warning', text: 'Demora' }
  return ESTADOS[table.status]
}

const ACTIVAS: readonly EstadoMesa[] = ['taking', 'in_kitchen', 'ready', 'preBill']
const activa = (m: Mesa) => ACTIVAS.includes(m.status)

/** Las libres van en blanco: así resaltan las que necesitan atención. */
const claseMesa = (table: Mesa, v: Visible) =>
  table.status === 'free'
    ? 'border-borde bg-superficie text-libre-texto'
    : v.tono === 'warning'
      ? `border-alerta-fuerte ${TONOS_SUAVES.warning}`
      : `border-transparent ${TONOS_SUAVES[v.tono]}`

export function Plano() {
  const tables = useMesas()
  const ahora = useAhora()
  const avisar = useAvisar()
  const [vista, setVista] = useState<'floorPlan' | 'list'>('floorPlan')

  const tocar = (table: Mesa) => {
    if (table.status === 'dirty') {
      cambiarMesa(table.numero, () => mesaLibre(table.numero))
      avisar(`Mesa ${table.numero} lista para usar`, () => cambiarMesa(table.numero, () => table))
      return
    }
    navegar(
      table.status === 'preBill'
        ? `/mockups/pre-bill?table=${table.numero}`
        : `/mockups/order?table=${table.numero}`,
    )
  }

  const abiertas = tables.filter(activa)
  const contar = (...statuses: EstadoMesa[]) =>
    tables.filter((m) => statuses.includes(m.status)).length

  return (
    <Marco
      titulo="Salón"
      actions={
        <Boton
          variant="secondary"
          icono={vista === 'floorPlan' ? 'list' : 'floorPlan'}
          onClick={() => setVista(vista === 'floorPlan' ? 'list' : 'floorPlan')}
        >
          {vista === 'floorPlan' ? 'Lista' : 'Plano'}
        </Boton>
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:flex-row">
        <section className="flex-1" aria-label="Mesas">
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Etiqueta tono="free" icono="circle">{`${contar('free')} libres`}</Etiqueta>
            <Etiqueta tono="progress" icono="fire">
              {`${contar('taking', 'in_kitchen')} atendiendo`}
            </Etiqueta>
            <Etiqueta tono="free" icono="serve">{`${contar('ready')} para servir`}</Etiqueta>
            <Etiqueta tono="neutral" icono="receipt">{`${contar('preBill')} por cobrar`}</Etiqueta>
          </div>
          {vista === 'floorPlan' ? (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {tables.map((table) => (
                <li key={table.numero}>
                  <MesaEnPlano table={table} ahora={ahora} alTocar={() => tocar(table)} />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-2">
              {tables.map((table) => (
                <li key={table.numero}>
                  <MesaEnLista table={table} ahora={ahora} alTocar={() => tocar(table)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Caja y tablet: plano + cuentas abiertas (brief §5, regla 1). */}
        <aside className="hidden w-72 shrink-0 md:block" aria-label="Cuentas abiertas">
          <h2 className="mb-2 text-lg font-semibold">Cuentas abiertas</h2>
          <ul className="flex flex-col gap-2">
            {abiertas.map((table) => (
              <li key={table.numero}>
                <button
                  type="button"
                  onClick={() => navegar(`/mockups/pre-bill?table=${table.numero}`)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-borde bg-superficie px-4 text-left hover:bg-superficie-2"
                >
                  <span>
                    <span className="font-semibold">Mesa {table.numero}</span>
                    <span className="block text-sm text-texto-suave">
                      {estadoVisible(table, ahora).text}
                    </span>
                  </span>
                  <span className="cifras font-semibold">{pesos(saldoMesa(table))}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </Marco>
  )
}

const detalle = (table: Mesa, ahora: number) =>
  [
    table.waiter,
    `${table.guests} ${table.guests === 1 ? 'persona' : 'personas'}`,
    minutos(minutosDesde(table.abiertaEn, ahora)),
  ]
    .filter(Boolean)
    .join(' · ')

function MesaEnPlano({
  table,
  ahora,
  alTocar,
}: {
  table: Mesa
  ahora: number
  alTocar: () => void
}) {
  const v = estadoVisible(table, ahora)
  const ocupada = activa(table)
  const tiempo = minutos(minutosDesde(table.abiertaEn, ahora))
  return (
    <button
      type="button"
      onClick={alTocar}
      aria-label={`Mesa ${table.numero}: ${v.text}${ocupada ? `, ${tiempo}, ${pesos(saldoMesa(table))}` : ''}`}
      className={`flex aspect-square w-full flex-col justify-between rounded-2xl border-2 p-2 text-left transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${claseMesa(table, v)}`}
    >
      <span className="flex items-start justify-between">
        <span className="font-titulo text-3xl font-bold leading-none">{table.numero}</span>
        <Icono name={v.icono} />
      </span>
      <span className="text-sm leading-tight font-semibold">{v.text}</span>
      {ocupada && (
        <span className="cifras text-sm leading-tight">
          {tiempo}
          <br />
          {pesos(saldoMesa(table))}
        </span>
      )}
    </button>
  )
}

function MesaEnLista({
  table,
  ahora,
  alTocar,
}: {
  table: Mesa
  ahora: number
  alTocar: () => void
}) {
  const v = estadoVisible(table, ahora)
  return (
    <button
      type="button"
      onClick={alTocar}
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-borde bg-superficie px-3 text-left hover:bg-superficie-2"
    >
      <span className="font-titulo w-10 text-center text-3xl font-bold">{table.numero}</span>
      <span className="flex-1">
        <Etiqueta tono={v.tono} icono={v.icono}>
          {v.text}
        </Etiqueta>
        {activa(table) && (
          <span className="mt-1 block text-sm text-texto-suave">{detalle(table, ahora)}</span>
        )}
      </span>
      {activa(table) && <span className="cifras font-semibold">{pesos(saldoMesa(table))}</span>}
    </button>
  )
}
