import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '../ui/Button'
import { ConnectionIndicator } from '../ui/ConnectionIndicator'
import { navigate } from '../ui/route'
import { useTheme } from '../ui/theme'
import { useSimulation } from './state'

// Frame of each mockup: top bar with back, title, who is signed in, connection and printers, and
// dark mode. When the screen changes, the tab title and the focus move to the new one (so the
// screen reader announces it).

export function Frame({
  title,
  back = '/mockups',
  user = 'Mesero 1',
  actions,
  children,
}: {
  title: string
  back?: string
  user?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const { dark, select } = useTheme()
  const { connection, pendingList, failingPrinters } = useSimulation()
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    document.title = `${title} · POS`
    heading.current?.focus({ preventScroll: true })
  }, [title])

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-borde bg-superficie/95 px-2 py-2 backdrop-blur">
        <Button variant="ghost" icon="back" aria-label="Volver" onClick={() => navigate(back)} />
        {/* The restaurant badge: the logo in its cream circle, as on the menu. */}
        <img
          src="/marca/la-spritzzeria.svg"
          alt=""
          className="logo-marca size-10 rounded-full border-2 border-marca bg-[#fff8ec] p-0.5"
        />
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-titulo mr-auto text-2xl font-semibold leading-none outline-none"
        >
          {title}
        </h1>
        <ConnectionIndicator
          status={connection}
          pendingList={pendingList}
          failingPrinters={failingPrinters}
        />
        <span className="hidden text-texto-suave sm:inline">{user}</span>
        {actions}
        <Button
          variant="ghost"
          icon={dark ? 'sun' : 'moon'}
          aria-label="Modo oscuro"
          aria-pressed={dark}
          onClick={() => select(dark ? 'light' : 'dark')}
        />
      </header>
      <div className="firma-marca" aria-hidden="true" />
      <main className="flex-1">{children}</main>
    </div>
  )
}
