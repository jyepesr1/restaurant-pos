import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/icons'
import { BrandMark } from '../ui/Logo'
import { navigate } from '../ui/route'
import { useTheme } from '../ui/theme'
import type { Me } from './api'

// The frame of the owner's panel: the restaurant and who entered at the top, with dark mode and
// «Salir». The sections go in a bar at the bottom on the phone (within reach of the thumb) and at
// the top on wider screens.

export const SECTIONS: readonly { route: string; name: string; icon: IconName }[] = [
  { route: '/', name: 'Hoy', icon: 'gauge' },
  { route: '/reports', name: 'Reportes', icon: 'chart' },
]

export function PanelFrame({
  me,
  route,
  title,
  actions,
  onSignOut,
  children,
}: {
  me: Me
  route: string
  title: string
  /** The screen's own buttons, next to the title. */
  actions?: ReactNode
  onSignOut: () => void
  children: ReactNode
}) {
  const { dark, select } = useTheme()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = `${title} · ${me.restaurant.name}`
  }, [title, me.restaurant.name])
  // Focus goes to the title on arriving at a section, as in the register.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the section changes
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [route])

  const tab = (s: (typeof SECTIONS)[number], phone: boolean) => {
    const current = s.route === route
    return (
      <button
        key={s.route}
        type="button"
        aria-current={current ? 'page' : undefined}
        onClick={() => navigate(s.route)}
        className={`flex items-center gap-2 rounded-xl font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-focus ${
          current ? 'bg-action-soft text-action-text' : 'text-foreground hover:bg-surface-2'
        } ${phone ? 'min-h-14 flex-1 flex-col justify-center gap-0.5 text-sm' : 'min-h-12 px-4'}`}
      >
        <Icon name={s.icon} className="size-5 shrink-0" />
        {s.name}
      </button>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-divider bg-sidebar">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-2 px-3 py-2 md:px-6">
          {/* The restaurant and who entered, where the logo with name says «con Faro». */}
          <span className="mr-auto flex min-w-0 items-center gap-2.5">
            <BrandMark brand={me.restaurant.brand} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="font-heading truncate text-lg font-bold tracking-tight">
                {me.restaurant.name}
              </span>
              <span className="truncate text-sm text-muted">{me.user.name}</span>
            </span>
          </span>
          <nav aria-label="Secciones" className="hidden gap-1 md:flex">
            {SECTIONS.map((s) => tab(s, false))}
          </nav>
          <Button
            variant="ghost"
            icon={dark ? 'sun' : 'moon'}
            aria-label="Modo oscuro"
            aria-pressed={dark}
            onClick={() => select(dark ? 'light' : 'dark')}
          />
          <Button variant="ghost" icon="exit" onClick={onSignOut} className="max-sm:px-2">
            Salir
          </Button>
        </div>
        <div className="brand-signature" aria-hidden="true" />
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 pb-28 md:p-6 md:pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1
            ref={heading}
            tabIndex={-1}
            className="font-heading text-2xl font-bold tracking-tight outline-none"
          >
            {title}
          </h1>
          {actions}
        </div>
        {children}
      </main>

      <nav
        aria-label="Secciones"
        className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-divider bg-sidebar px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
      >
        {SECTIONS.map((s) => tab(s, true))}
      </nav>
    </div>
  )
}
