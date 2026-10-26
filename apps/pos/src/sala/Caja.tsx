import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { conPuntos, pesos, soloDigitos } from '../ui/formato'
import { navegar } from '../ui/ruta'
import { sala, useSala, useVistaLocal } from './contexto'
import { nombreDeMedio, reglasDe } from './cuentas'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'

// La caja de este equipo (tarea 1.6): abrirla con la base en efectivo para poder cobrar, y ver lo
// cobrado en el turno por medio de pago. El cierre con arqueo llega después.

const hora = (iso: string) =>
  new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

export function Caja() {
  const { equipo, conexion, sesion, catalogo } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const [base, setBase] = useState(0)
  const [ocupado, setOcupado] = useState(false)

  if (!vista) return null
  const esCaja = equipo?.tipo === 'caja'
  const puedeAbrir = (sesion?.permisos ?? []).includes('abrir_turno_caja')
  const turno = vista.turno
  const resumen = vista.resumenTurno

  const abrir = async () => {
    if (ocupado) return
    setOcupado(true)
    try {
      await sala.abrirTurno(base)
      avisar(`Caja abierta con ${pesos(base)} de base`)
      // Si venía de cobrar una cuenta, vuelve a ella.
      const volver = new URLSearchParams(location.search).get('volver')
      if (volver?.startsWith('/cuenta?')) navegar(volver)
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo abrir la caja')
    } finally {
      setOcupado(false)
    }
  }

  return (
    <MarcoSala titulo="Caja">
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-3 md:p-5">
        {!esCaja ? (
          <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
            Este equipo no es de caja. Para cobrar, entra con el usuario y la contraseña de caja en
            el computador de la caja.
          </p>
        ) : turno ? (
          <>
            <section className="rounded-2xl border border-linea bg-superficie p-4 shadow-flota">
              <p className="text-lg font-semibold">
                {`Caja abierta desde las ${hora(turno.abiertoEn)}`}
                {turno.porConfirmar && (
                  <span className="ml-2 text-sm font-normal text-texto-suave">(sin confirmar)</span>
                )}
              </p>
              <p className="cifras text-texto-suave">{`Base: ${pesos(turno.base)}`}</p>
            </section>
            <section
              className="rounded-2xl border border-linea bg-superficie p-4"
              aria-label="Cobrado en este turno"
            >
              <h2 className="mb-2 font-semibold">Cobrado en este turno</h2>
              {resumen && resumen.pagos > 0 ? (
                <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                  <dt className="font-semibold">Total</dt>
                  <dd className="text-right font-semibold">
                    {pesos(resumen.porMedio.reduce((a, m) => a + m.venta, 0))}
                    <span className="block text-sm font-normal text-texto-suave">{`+ propinas ${pesos(resumen.porMedio.reduce((a, m) => a + m.propina, 0))}`}</span>
                  </dd>
                  {resumen.porMedio.map((m) => (
                    <div key={`${m.medio}${m.medioPropioId ?? ''}`} className="contents">
                      <dt>{`${nombreDeMedio(m.medio, m.medioPropioId, reglasDe(catalogo))} (${m.pagos})`}</dt>
                      <dd className="text-right">
                        {pesos(m.venta)}
                        {m.propina > 0 && (
                          <span className="block text-sm text-texto-suave">{`+ propina ${pesos(m.propina)}`}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-texto-suave">Todavía no hay pagos.</p>
              )}
            </section>
          </>
        ) : !puedeAbrir ? (
          <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
            La caja está cerrada. Pídele a quien tenga el permiso que la abra.
          </p>
        ) : (
          <section className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie p-4 shadow-flota">
            <h2 className="text-lg font-semibold">Abrir la caja</h2>
            <label>
              <span className="font-semibold">Base en efectivo</span>
              <span className="block text-sm text-texto-suave">
                El efectivo con que empieza la caja, para dar cambio.
              </span>
              <input
                inputMode="numeric"
                className={`${claseCampo} cifras mt-2 min-h-14 text-2xl`}
                value={conPuntos(base)}
                placeholder="0"
                onChange={(e) => setBase(soloDigitos(e.target.value))}
              />
            </label>
            {conexion !== 'conectado' && (
              <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
                Sin conexión con el hub: la caja se abre con la red. Revisa el cable o el Wi-Fi.
              </p>
            )}
            <Boton
              variante="principal"
              grande
              icono="billete"
              disabled={ocupado || conexion !== 'conectado'}
              onClick={abrir}
            >
              {base === 0 ? 'Abrir sin base' : `Abrir con ${pesos(base)}`}
            </Boton>
          </section>
        )}
      </div>
    </MarcoSala>
  )
}
