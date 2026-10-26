import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { applyBrand, isBrand } from '../ui/brand'
import { Brand } from './Brand'
import { Check } from './Check'
import { floor, useFloor } from './context'
import { FloorFrame } from './FloorFrame'
import { FloorPlanEditor } from './FloorPlanEditor'
import { KitchenScreen, OrdersInKitchen, ReadyAlert } from './Kitchen'
import { KitchenSettings } from './KitchenSettings'
import { Menu } from './Menu'
import { OrderEntry } from './OrderEntry'
import { Register } from './Register'
import { RegisterSettings } from './RegisterSettings'
import { Reports } from './Reports'
import { SignIn } from './SignIn'
import { Staff } from './Staff'
import { Tables } from './Tables'

// The operation app: sign in (with PIN or with user and password, ADR-013) and work (tables,
// order, menu, floor plan and staff). It opens the floor on startup and tells it when the screen
// is hidden or comes back (ADR-001).

const CHECK_SESSION_MS = 30_000

export function Operation({ route, params }: { route: string; params: URLSearchParams }) {
  const status = useFloor()
  // The restaurant's brand arrives with the menu: when it changes, the whole device shows it.
  // With no menu yet (it is being read, or the device just signed in) the one index.html painted
  // stays.
  const withMenu = status.catalog !== null
  const brand = status.catalog?.restaurant.brand
  useEffect(() => {
    if (withMenu) applyBrand(isBrand(brand) ? brand : 'faro')
  }, [withMenu, brand])

  useEffect(() => {
    floor.load().catch((e) => console.error('No se pudo abrir la base del equipo:', e))
    const onVisibilityChange = () => floor.changeVisibility(!document.hidden)
    const onTap = () => floor.enabled()
    const review = setInterval(() => floor.expireSessionIfDue(), CHECK_SESSION_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pointerdown', onTap, { passive: true })
    return () => {
      clearInterval(review)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pointerdown', onTap)
    }
  }, [])

  if (!status.loaded) return <p className="p-6 text-texto-suave">Cargando…</p>
  if (status.hubError && status.hubError.code !== 'invalid_message')
    return <RejectedDevice message={status.hubError.message} code={status.hubError.code} />
  // With no device yet, signing in registers it with the hub (it is no longer paired first).
  if (!status.device || !status.session) return <SignIn />
  if (!status.catalog) return <NoCatalog />
  // A kitchen screen sees nothing else (ADR-015).
  if (status.device.type === 'kds') return <KitchenScreen />
  return (
    <>
      <ReadyAlert />
      <Screen route={route} params={params} permissions={status.session.permissions} />
    </>
  )
}

function Screen({
  route,
  params,
  permissions,
}: {
  route: string
  params: URLSearchParams
  permissions: string[]
}) {
  if (route === '/kitchen/settings' && permissions.includes('manage_devices'))
    return <KitchenSettings />
  if (route === '/register/settings' && permissions.includes('manage_devices'))
    return <RegisterSettings />
  if (route === '/register') return <Register />
  if (route === '/reports' && permissions.includes('view_reports')) return <Reports />
  if (route === '/check') return <Check key={params.get('order')} />
  if (route === '/kitchen') return <OrdersInKitchen />
  if (route === '/staff' && permissions.includes('manage_users')) return <Staff />
  if (route === '/brand' && permissions.includes('manage_users')) return <Brand />
  if (route === '/menu') return <Menu />
  if (route === '/floor-plan') return <FloorPlanEditor />
  if (route === '/order') return <OrderEntry key={params.get('table')} />
  return <Tables />
}

function RejectedDevice({ code, message }: { code: string; message: string }) {
  const { pendingList } = useFloor()
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    document.title = 'Equipo rechazado · Faro'
  }, [])
  const forget = () => void floor.forgetDevice()
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="font-titulo text-3xl font-semibold">
        Este equipo no puede entrar al POS del restaurante
      </h1>
      <p role="alert">{message}</p>
      {code === 'outdated_app' ? (
        <Button variant="main" large onClick={() => location.reload()}>
          Recargar la app
        </Button>
      ) : pendingList === 0 ? (
        <Button variant="main" large onClick={forget}>
          Entrar de nuevo
        </Button>
      ) : (
        <>
          {/* The pending changes carry the old device: signing in again registers another one */}
          {/* and the hub rejects them. */}
          <p>
            {`Hay ${pendingList === 1 ? 'un cambio' : `${pendingList} cambios`} de este equipo (pedidos, cobros) que la caja todavía no recibe. `}
            {code === 'revoked_token'
              ? 'Si hay Wi-Fi, se siguen enviando para que un administrador los revise: espera a que el número llegue a 0.'
              : 'Si entras de nuevo, no llegarán a la caja. Avisa a un administrador antes.'}
          </p>
          {confirming ? (
            <Button variant="danger" large onClick={forget}>
              {`Entrar de nuevo sin ${pendingList === 1 ? 'ese cambio' : `esos ${pendingList}`}`}
            </Button>
          ) : (
            <Button variant="secondary" large onClick={() => setConfirming(true)}>
              Entrar de nuevo de todas formas
            </Button>
          )}
        </>
      )}
    </main>
  )
}

/** Just signed in but the menu did not arrive (the connection dropped right then): retry. */
function NoCatalog() {
  const [error, setError] = useState<string | null>(null)
  return (
    <FloorFrame title="Salón">
      <div className="flex flex-col items-start gap-3 p-6">
        <p>Falta traer la carta y las mesas del restaurante.</p>
        <p className="text-alerta-texto" role="alert">
          {error ?? ''}
        </p>
        <Button
          variant="main"
          onClick={() =>
            floor
              .updateCatalog()
              .then(() => setError(null))
              .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo'))
          }
        >
          Traer la carta
        </Button>
      </div>
    </FloorFrame>
  )
}
