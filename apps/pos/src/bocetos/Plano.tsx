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
  texto: string
}

export const ESTADOS: Record<EstadoMesa, Visible> = {
  libre: { tono: 'libre', icono: 'circulo', texto: 'Libre' },
  tomando: { tono: 'proceso', icono: 'lapiz', texto: 'Tomando pedido' },
  en_cocina: { tono: 'proceso', icono: 'fuego', texto: 'En preparación' },
  listo: { tono: 'libre', icono: 'servir', texto: 'Listo para servir' },
  precuenta: { tono: 'neutro', icono: 'recibo', texto: 'Por cobrar' },
  reservada: { tono: 'neutro', icono: 'calendario', texto: 'Reservada' },
  sucia: { tono: 'neutro', icono: 'escoba', texto: 'Por limpiar' },
}

/** El estado que se muestra: una comanda que lleva 20 min o más en preparación es una demora. */
export function estadoVisible(mesa: Mesa, ahora: number): Visible {
  if (mesa.estado === 'en_cocina' && esperaMasLarga(mesa, ahora) >= MINUTOS_DEMORA)
    return { tono: 'alerta', icono: 'alerta', texto: 'Demora' }
  return ESTADOS[mesa.estado]
}

const ACTIVAS: readonly EstadoMesa[] = ['tomando', 'en_cocina', 'listo', 'precuenta']
const activa = (m: Mesa) => ACTIVAS.includes(m.estado)

/** Las libres van en blanco: así resaltan las que necesitan atención. */
const claseMesa = (mesa: Mesa, v: Visible) =>
  mesa.estado === 'libre'
    ? 'border-borde bg-superficie text-libre-texto'
    : v.tono === 'alerta'
      ? `border-alerta-fuerte ${TONOS_SUAVES.alerta}`
      : `border-transparent ${TONOS_SUAVES[v.tono]}`

export function Plano() {
  const mesas = useMesas()
  const ahora = useAhora()
  const avisar = useAvisar()
  const [vista, setVista] = useState<'plano' | 'lista'>('plano')

  const tocar = (mesa: Mesa) => {
    if (mesa.estado === 'sucia') {
      cambiarMesa(mesa.numero, () => mesaLibre(mesa.numero))
      avisar(`Mesa ${mesa.numero} lista para usar`, () => cambiarMesa(mesa.numero, () => mesa))
      return
    }
    navegar(
      mesa.estado === 'precuenta'
        ? `/bocetos/precuenta?mesa=${mesa.numero}`
        : `/bocetos/pedido?mesa=${mesa.numero}`,
    )
  }

  const abiertas = mesas.filter(activa)
  const contar = (...estados: EstadoMesa[]) =>
    mesas.filter((m) => estados.includes(m.estado)).length

  return (
    <Marco
      titulo="Salón"
      acciones={
        <Boton
          variante="secundario"
          icono={vista === 'plano' ? 'lista' : 'plano'}
          onClick={() => setVista(vista === 'plano' ? 'lista' : 'plano')}
        >
          {vista === 'plano' ? 'Lista' : 'Plano'}
        </Boton>
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:flex-row">
        <section className="flex-1" aria-label="Mesas">
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Etiqueta tono="libre" icono="circulo">{`${contar('libre')} libres`}</Etiqueta>
            <Etiqueta tono="proceso" icono="fuego">
              {`${contar('tomando', 'en_cocina')} atendiendo`}
            </Etiqueta>
            <Etiqueta tono="libre" icono="servir">{`${contar('listo')} para servir`}</Etiqueta>
            <Etiqueta tono="neutro" icono="recibo">{`${contar('precuenta')} por cobrar`}</Etiqueta>
          </div>
          {vista === 'plano' ? (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {mesas.map((mesa) => (
                <li key={mesa.numero}>
                  <MesaEnPlano mesa={mesa} ahora={ahora} alTocar={() => tocar(mesa)} />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-2">
              {mesas.map((mesa) => (
                <li key={mesa.numero}>
                  <MesaEnLista mesa={mesa} ahora={ahora} alTocar={() => tocar(mesa)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Caja y tablet: plano + cuentas abiertas (brief §5, regla 1). */}
        <aside className="hidden w-72 shrink-0 md:block" aria-label="Cuentas abiertas">
          <h2 className="mb-2 text-lg font-semibold">Cuentas abiertas</h2>
          <ul className="flex flex-col gap-2">
            {abiertas.map((mesa) => (
              <li key={mesa.numero}>
                <button
                  type="button"
                  onClick={() => navegar(`/bocetos/precuenta?mesa=${mesa.numero}`)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-borde bg-superficie px-4 text-left hover:bg-superficie-2"
                >
                  <span>
                    <span className="font-semibold">Mesa {mesa.numero}</span>
                    <span className="block text-sm text-texto-suave">
                      {estadoVisible(mesa, ahora).texto}
                    </span>
                  </span>
                  <span className="cifras font-semibold">{pesos(saldoMesa(mesa))}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </Marco>
  )
}

const detalle = (mesa: Mesa, ahora: number) =>
  [
    mesa.mesero,
    `${mesa.comensales} ${mesa.comensales === 1 ? 'persona' : 'personas'}`,
    minutos(minutosDesde(mesa.abiertaEn, ahora)),
  ]
    .filter(Boolean)
    .join(' · ')

function MesaEnPlano({ mesa, ahora, alTocar }: { mesa: Mesa; ahora: number; alTocar: () => void }) {
  const v = estadoVisible(mesa, ahora)
  const ocupada = activa(mesa)
  const tiempo = minutos(minutosDesde(mesa.abiertaEn, ahora))
  return (
    <button
      type="button"
      onClick={alTocar}
      aria-label={`Mesa ${mesa.numero}: ${v.texto}${ocupada ? `, ${tiempo}, ${pesos(saldoMesa(mesa))}` : ''}`}
      className={`flex aspect-square w-full flex-col justify-between rounded-2xl border-2 p-2 text-left transition active:scale-95 focus-visible:outline-3 focus-visible:outline-foco ${claseMesa(mesa, v)}`}
    >
      <span className="flex items-start justify-between">
        <span className="text-2xl font-bold">{mesa.numero}</span>
        <Icono nombre={v.icono} />
      </span>
      <span className="text-sm leading-tight font-semibold">{v.texto}</span>
      {ocupada && (
        <span className="cifras text-sm leading-tight">
          {tiempo}
          <br />
          {pesos(saldoMesa(mesa))}
        </span>
      )}
    </button>
  )
}

function MesaEnLista({ mesa, ahora, alTocar }: { mesa: Mesa; ahora: number; alTocar: () => void }) {
  const v = estadoVisible(mesa, ahora)
  return (
    <button
      type="button"
      onClick={alTocar}
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-borde bg-superficie px-3 text-left hover:bg-superficie-2"
    >
      <span className="w-10 text-center text-2xl font-bold">{mesa.numero}</span>
      <span className="flex-1">
        <Etiqueta tono={v.tono} icono={v.icono}>
          {v.texto}
        </Etiqueta>
        {activa(mesa) && (
          <span className="mt-1 block text-sm text-texto-suave">{detalle(mesa, ahora)}</span>
        )}
      </span>
      {activa(mesa) && <span className="cifras font-semibold">{pesos(saldoMesa(mesa))}</span>}
    </button>
  )
}
