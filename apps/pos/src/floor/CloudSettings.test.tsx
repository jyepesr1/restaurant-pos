import type { CloudState, CloudStatus } from '@pos/sync'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The «Copia en la nube» screen (task 1.11), rendered on the server (no browser): which states ask for the
// code, what each one explains and how the pending count reads.

const status: { cloud: CloudStatus | null } = { cloud: null }

vi.mock('./context', () => ({
  useFloor: () => ({ cloud: status.cloud }),
  floor: { cloudStatus: async () => status.cloud, connectCloud: async () => status.cloud },
}))
vi.mock('./FloorFrame', () => ({ FloorFrame: ({ children }: { children: unknown }) => children }))
vi.mock('../ui/toasts', () => ({ useNotify: () => () => {} }))

const { CloudSettings } = await import('./CloudSettings')

const html = (state: CloudState, pending = 0, last_upload_at: string | null = null) => {
  status.cloud = { state, pending, last_upload_at }
  return renderToStaticMarkup(<CloudSettings />)
}

describe('the «Copia en la nube» screen', () => {
  it('while the status is unknown it shows neither the status nor the code form', () => {
    status.cloud = null
    const page = renderToStaticMarkup(<CloudSettings />)
    expect(page).not.toContain('Código de conexión')
    expect(page).not.toContain('Por subir')
  })

  it.each(['not_connected', 'revoked'] as const)('%s asks for the code', (state) => {
    const page = html(state, 3)
    expect(page).toContain('Código de conexión')
    expect(page).toContain('Conectar a la nube')
  })

  it.each(['up_to_date', 'uploading', 'offline', 'stuck'] as const)(
    '%s does not ask for a code',
    (state) => {
      expect(html(state, 3)).not.toContain('Código de conexión')
    },
  )

  it('every state explains itself in Spanish', () => {
    const expected: Record<CloudState, RegExp> = {
      up_to_date: /guardado en la nube/,
      uploading: /subiendo/,
      offline: /no tiene internet/,
      revoked: /ya no acepta/,
      stuck: /no se pudo guardar/,
      not_connected: /todavía no sube nada/,
    }
    for (const [state, text] of Object.entries(expected))
      expect(html(state as CloudState, 2)).toMatch(text)
  })

  it('shows the pending count in singular and plural', () => {
    expect(html('offline', 1)).toContain('1 cambio<')
    expect(html('offline', 5)).toContain('5 cambios')
  })

  it('without ever having connected it does not show the pending list or the last upload', () => {
    const page = html('not_connected', 8)
    expect(page).not.toContain('Por subir')
    expect(page).not.toContain('Última subida')
  })

  it('«Todavía no» when nothing was ever confirmed, the date otherwise', () => {
    expect(html('offline', 2, null)).toContain('Todavía no')
    const page = html('up_to_date', 0, '2026-10-29T15:00:00.000Z')
    expect(page).not.toContain('Todavía no')
    expect(page).toMatch(/2026/)
  })

  it('the code field is limited, case-insensitive for typing and off for autocomplete', () => {
    const page = html('not_connected')
    expect(page).toContain('maxLength="20"')
    expect(page).toContain('autoComplete="off"')
    expect(page).toContain('uppercase')
  })
})
