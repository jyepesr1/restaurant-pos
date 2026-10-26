import { useEffect, useState } from 'react'
import { Boton } from '../ui/Boton'
import { aplicarMarca, esMarca } from '../ui/marca'
import { Caja } from './Caja'
import { CajaAjustes } from './CajaAjustes'
import { Menu } from './Carta'
import { AvisoListos, PantallaCocina, PedidosEnCocina } from './Cocina'
import { CocinaAjustes } from './CocinaAjustes'
import { Check } from './Cuenta'
import { sala, useSala } from './contexto'
import { Entrar } from './Entrar'
import { Marca } from './Marca'
import { MarcoSala } from './MarcoSala'
import { Mesas } from './Mesas'
import { Personal } from './Personal'
import { PlanoEditor } from './PlanoEditor'
import { Reportes } from './Reportes'
import { TomaPedido } from './TomaPedido'

// La app de operación: entrar (con PIN o con usuario y contraseña, ADR-013) y trabajar (mesas,
// pedido, carta, plano y personal). Abre la sala al arrancar y le avisa cuando la pantalla se
// oculta o vuelve (ADR-001).

const REVISAR_SESION_MS = 30_000

export function Operacion({ ruta, parametros }: { ruta: string; parametros: URLSearchParams }) {
  const status = useSala()
  // La marca del restaurante llega con la carta: cuando cambia, todo el equipo se ve con ella.
  // Sin carta todavía (se está leyendo, o el equipo recién entra) se deja la que pintó index.html.
  const conCarta = status.catalog !== null
  const brand = status.catalog?.restaurant.brand
  useEffect(() => {
    if (conCarta) aplicarMarca(esMarca(brand) ? brand : 'faro')
  }, [conCarta, brand])

  useEffect(() => {
    sala.cargar().catch((e) => console.error('No se pudo abrir la base del equipo:', e))
    const alCambiarVisibilidad = () => sala.cambiarVisibilidad(!document.hidden)
    const alTocar = () => sala.usar()
    const revisar = setInterval(() => sala.vencerSesionSiToca(), REVISAR_SESION_MS)
    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    window.addEventListener('pointerdown', alTocar, { passive: true })
    return () => {
      clearInterval(revisar)
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      window.removeEventListener('pointerdown', alTocar)
    }
  }, [])

  if (!status.cargado) return <p className="p-6 text-texto-suave">Cargando…</p>
  if (status.errorHub && status.errorHub.code !== 'invalid_message')
    return <EquipoRechazado message={status.errorHub.message} code={status.errorHub.code} />
  // Sin equipo todavía, entrar lo registra en el hub (ya no se empareja antes).
  if (!status.device || !status.session) return <Entrar />
  if (!status.catalog) return <SinCatalogo />
  // Una pantalla de cocina no ve nada más (ADR-015).
  if (status.device.type === 'kds') return <PantallaCocina />
  return (
    <>
      <AvisoListos />
      <Pantalla ruta={ruta} parametros={parametros} permissions={status.session.permissions} />
    </>
  )
}

function Pantalla({
  ruta,
  parametros,
  permissions,
}: {
  ruta: string
  parametros: URLSearchParams
  permissions: string[]
}) {
  if (ruta === '/kitchen/settings' && permissions.includes('manage_devices'))
    return <CocinaAjustes />
  if (ruta === '/register/settings' && permissions.includes('manage_devices'))
    return <CajaAjustes />
  if (ruta === '/register') return <Caja />
  if (ruta === '/reports' && permissions.includes('view_reports')) return <Reportes />
  if (ruta === '/check') return <Check key={parametros.get('order')} />
  if (ruta === '/kitchen') return <PedidosEnCocina />
  if (ruta === '/staff' && permissions.includes('manage_users')) return <Personal />
  if (ruta === '/brand' && permissions.includes('manage_users')) return <Marca />
  if (ruta === '/menu') return <Menu />
  if (ruta === '/floor-plan') return <PlanoEditor />
  if (ruta === '/order') return <TomaPedido key={parametros.get('table')} />
  return <Mesas />
}

function EquipoRechazado({ code, message }: { code: string; message: string }) {
  const { pendingList } = useSala()
  const [confirmando, setConfirmando] = useState(false)
  useEffect(() => {
    document.title = 'Equipo rechazado · Faro'
  }, [])
  const olvidar = () => void sala.olvidarEquipo()
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="font-titulo text-3xl font-semibold">
        Este equipo no puede entrar al POS del restaurante
      </h1>
      <p role="alert">{message}</p>
      {code === 'outdated_app' ? (
        <Boton variant="main" large onClick={() => location.reload()}>
          Recargar la app
        </Boton>
      ) : pendingList === 0 ? (
        <Boton variant="main" large onClick={olvidar}>
          Entrar de nuevo
        </Boton>
      ) : (
        <>
          {/* Lo pendiente lleva el equipo viejo: entrar de nuevo registra otro y el hub lo rechaza. */}
          <p>
            {`Hay ${pendingList === 1 ? 'un cambio' : `${pendingList} cambios`} de este equipo (pedidos, cobros) que la caja todavía no recibe. `}
            {code === 'revoked_token'
              ? 'Si hay Wi-Fi, se siguen enviando para que un administrador los revise: espera a que el número llegue a 0.'
              : 'Si entras de nuevo, no llegarán a la caja. Avisa a un administrador antes.'}
          </p>
          {confirmando ? (
            <Boton variant="danger" large onClick={olvidar}>
              {`Entrar de nuevo sin ${pendingList === 1 ? 'ese cambio' : `esos ${pendingList}`}`}
            </Boton>
          ) : (
            <Boton variant="secondary" large onClick={() => setConfirmando(true)}>
              Entrar de nuevo de todas formas
            </Boton>
          )}
        </>
      )}
    </main>
  )
}

/** Recién se entró pero no llegó la carta (se cortó justo): reintentar. */
function SinCatalogo() {
  const [error, setError] = useState<string | null>(null)
  return (
    <MarcoSala titulo="Salón">
      <div className="flex flex-col items-start gap-3 p-6">
        <p>Falta traer la carta y las mesas del restaurante.</p>
        <p className="text-alerta-texto" role="alert">
          {error ?? ''}
        </p>
        <Boton
          variant="main"
          onClick={() =>
            sala
              .actualizarCatalogo()
              .then(() => setError(null))
              .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo'))
          }
        >
          Traer la carta
        </Boton>
      </div>
    </MarcoSala>
  )
}
