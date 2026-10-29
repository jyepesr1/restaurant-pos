import { useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { applyBrand, isBrand } from '../ui/brand'
import { navigate, useRoute } from '../ui/route'
import { type Me, type PanelApi, PanelError, panelApi, rulesOf, SESSION_CLOSED } from './api'
import { Dashboard } from './Dashboard'
import { PanelFrame } from './PanelFrame'
import { CsvButton, PanelReports, useCloudReports } from './PanelReports'
import { PanelSignIn } from './PanelSignIn'

// The owner's panel in the cloud (task 1.11c-1, ADR-017). It opens by asking who is signed in
// (the cookie may still be valid); without a session, «Entrar». A 401 later takes it back there
// with a notice.

type Session =
  | { state: 'checking' }
  | { state: 'offline'; message: string }
  | { state: 'signed-out'; notice: string | null }
  | { state: 'signed-in'; me: Me }

/** Whether the person can see the dashboard and the reports. */
export const canViewReports = (me: Me) => me.user.permissions.includes('view_reports')

export function PanelApp({ api: given }: { api?: PanelApi }) {
  const [session, setSession] = useState<Session>({ state: 'checking' })
  const api = useMemo(
    () => given ?? panelApi({ onUnauthorized: () => setSession(signedOut(SESSION_CLOSED)) }),
    [given],
  )

  // Bumped by «Reintentar»: asks again who is signed in.
  const [check, setCheck] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `check` is the retry
  useEffect(() => {
    let current = true
    setSession({ state: 'checking' })
    api
      .me()
      .then((me) => current && setSession({ state: 'signed-in', me }))
      .catch((e) => {
        if (!current) return
        // Without internet it is not known whether there is a session: it says so and retries.
        setSession(
          e instanceof PanelError && e.kind === 'offline'
            ? { state: 'offline', message: e.message }
            : signedOut(null),
        )
      })
    return () => {
      current = false
    }
  }, [api, check])

  if (session.state === 'checking') return <p className="p-6 text-muted">Abriendo el panel…</p>
  if (session.state === 'offline')
    return <Offline message={session.message} onRetry={() => setCheck((n) => n + 1)} />
  if (session.state === 'signed-out')
    return (
      <PanelSignIn
        api={api}
        notice={session.notice}
        onSignedIn={(me) => {
          setSession({ state: 'signed-in', me })
          navigate('/')
        }}
      />
    )
  return (
    <SignedIn
      api={api}
      me={session.me}
      onSignOut={() => {
        // The session is forgotten here even if the cloud does not answer: the cookie expires.
        void api.signOut().catch(() => {})
        setSession(signedOut(null))
      }}
    />
  )
}

const signedOut = (notice: string | null): Session => ({ state: 'signed-out', notice })

/** Opening without internet: nothing to show yet, only to try again. */
export function Offline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 py-10 sm:items-center">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-3xl border border-divider bg-surface p-5 shadow-float sm:p-8">
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          No se pudo abrir el panel
        </h1>
        <p role="status">{message}</p>
        <Button variant="main" large onClick={onRetry}>
          Reintentar
        </Button>
      </div>
    </main>
  )
}

function SignedIn({ api, me, onSignOut }: { api: PanelApi; me: Me; onSignOut: () => void }) {
  const { route } = useRoute()
  // The restaurant's brand, as the register shows it: an unknown one is Faro's. It is remembered
  // on the device (panel.html paints it before loading next time).
  const brand = me.restaurant.brand
  useEffect(() => {
    applyBrand(isBrand(brand) ? brand : 'faro')
  }, [brand])
  const section = route === '/reports' ? '/reports' : '/'
  const allowed = canViewReports(me)
  if (section === '/reports')
    return allowed ? (
      <ReportsSection api={api} me={me} onSignOut={onSignOut} />
    ) : (
      <PanelFrame me={me} route={section} title="Reportes" onSignOut={onSignOut}>
        <NoPermission />
      </PanelFrame>
    )
  return (
    <PanelFrame me={me} route={section} title="Hoy" onSignOut={onSignOut}>
      {allowed ? (
        <Dashboard api={api} place={{ timeZone: me.restaurant.time_zone, rules: rulesOf(me) }} />
      ) : (
        <NoPermission />
      )}
    </PanelFrame>
  )
}

function ReportsSection({ api, me, onSignOut }: { api: PanelApi; me: Me; onSignOut: () => void }) {
  const state = useCloudReports(api)
  const rules = rulesOf(me)
  return (
    <PanelFrame
      me={me}
      route="/reports"
      title="Reportes"
      onSignOut={onSignOut}
      actions={<CsvButton state={state} rules={rules} restaurant={me.restaurant.name} />}
    >
      <PanelReports state={state} rules={rules} />
    </PanelFrame>
  )
}

/** The dashboard and the reports ask for «Ver todos los reportes». */
export function NoPermission() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-divider bg-surface p-5">
      <h2 className="text-lg font-semibold">Tu rol no tiene permiso para ver los reportes</h2>
      <p className="text-muted">
        Para ver las ventas y los reportes, pide al administrador que le dé a tu rol el permiso «Ver
        todos los reportes».
      </p>
      <Button className="self-start" onClick={() => location.reload()}>
        Ya me lo dieron: volver a cargar
      </Button>
    </div>
  )
}
