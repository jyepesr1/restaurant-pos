import type { ShiftReconciliation, UnappliedMovement } from '@pos/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UnappliedNotice } from './engine'

// What the screens show of what the hub did not apply (task 1.7b), rendered on the server (no
// browser): the notice with «Entendido» on every screen, and the register close that waits for
// the hub and lists the unapplied money apart.

const state: { notices: UnappliedNotice[] } = { notices: [] }

vi.mock('./context', () => ({
  useFloor: () => ({
    connection: 'connected',
    pendingList: 0,
    session: {
      sessionId: 's',
      secret: 'x',
      user: { id: 'u', name: 'Carla', role: 'Cajera' },
      permissions: ['record_payment'],
      lastUsed: 0,
    },
    simulatingOffline: false,
    catalog: null,
    printers: [],
    cloud: null,
    unappliedNotices: state.notices,
  }),
  floor: { acknowledgeUnapplied: async () => {}, simulateOffline: () => {}, exit: async () => {} },
}))
vi.mock('../ui/theme', () => ({ useTheme: () => ({ dark: false, select: () => {} }) }))
vi.mock('../ui/route', () => ({
  useRoute: () => ({ route: '/', params: new URLSearchParams() }),
  navigate: () => {},
}))
vi.mock('../ui/toasts', () => ({ useNotify: () => () => {} }))

const { FloorFrame } = await import('./FloorFrame')
const { Closeout, NO_NETWORK, Result, WaitingForHub } = await import('./Register')
const { NotApplied } = await import('./Check')
const { NOT_CHARGED, NOT_VOIDED } = await import('./unapplied')

/** Without tags and with plain spaces, to read it as text. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const movement = (over: Partial<UnappliedMovement>): UnappliedMovement => ({
  eventId: 'e1',
  orderId: 'o1',
  type: 'PaymentRecorded',
  method: 'cash',
  customMethodId: null,
  amount: 40_000,
  tip: 0,
  userId: 'u',
  time: '2026-10-26T20:00:00.000Z',
  ...over,
})

const reconciliation = (unapplied: UnappliedMovement[] = []): ShiftReconciliation => ({
  shiftId: 's1',
  registerId: 'r1',
  base: 100_000,
  openedAt: '2026-10-26T13:00:00.000Z',
  byMethod: [],
  movements: [],
  cashCounts: [],
  unapplied,
  cash: { charged: 0, refunds: 0, cashIn: 0, cashOut: 0, tipPayouts: 0, expected: 100_000 },
  closed: null,
})

const closeout = (pendingMoney: number, unapplied: UnappliedMovement[] = []) =>
  renderToStaticMarkup(
    <Closeout
      reconciliation={reconciliation(unapplied)}
      rules={null}
      quantities={{}}
      onQuantitiesChange={() => {}}
      methods={[]}
      reports={{}}
      onReportsChange={() => {}}
      openTables={[]}
      noNetwork={null}
      online
      pendingMoney={pendingMoney}
      onBack={() => {}}
      onClose={() => {}}
    />,
  )

const frame = () =>
  renderToStaticMarkup(
    <FloorFrame title="Salón">
      <p>contenido</p>
    </FloorFrame>,
  )

describe('the notice of what the hub did not apply', () => {
  it('shows in the top bar with its text, who did it and «Entendido», as an alert', () => {
    state.notices = [
      { eventId: 'e1', text: 'El pago de $40.000 en efectivo no se aplicó.', userId: 'u' },
    ]
    const html = frame()
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain(
      'No se aplicó (lo hizo Carla) El pago de $40.000 en efectivo no se aplicó.',
    )
    expect(html).toContain('aria-label="Entendido: El pago de $40.000 en efectivo no se aplicó."')
    // Inside the sticky header (it stays in view while scrolling), above the screen's content.
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).toMatch(/^<header class="sticky top-0/)
    expect(header).toContain('Entendido')
    expect(header).toContain('id="unapplied-notice"')
    expect(header).toContain('tabindex="-1"')
    // Alone it does not count itself.
    expect(text(html)).not.toContain('1 de 1')
  })

  it('several: one at a time, the oldest first, saying how many there are', () => {
    state.notices = [
      { eventId: 'e1', text: 'Primero.', userId: 'u' },
      { eventId: 'e2', text: 'Segundo.', userId: 'u' },
      { eventId: 'e3', text: 'Tercero.', userId: 'otro' },
    ]
    const t = text(frame())
    expect(t).toContain('1 de 3')
    expect(t).toContain('Primero.')
    expect(t).not.toContain('Segundo.')
    expect(t).not.toContain('Tercero.')
    expect(t.match(/Entendido/g)).toHaveLength(1)
  })

  it('without knowing who did it, it does not make up a name', () => {
    state.notices = [{ eventId: 'e3', text: 'Tercero.', userId: 'otro' }]
    const t = text(frame())
    expect(t).toContain('No se aplicó Tercero.')
    expect(t).not.toContain('lo hizo')
  })

  it('without notices there is nothing', () => {
    state.notices = []
    const html = frame()
    expect(html).not.toContain('Entendido')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('unapplied-notice')
  })
})

describe('the check after a charge or a void the hub did not apply', () => {
  it('says it was not done and points at the notice', () => {
    expect(NOT_CHARGED).toBe('No se cobró: la cuenta ya estaba cerrada. Mira el aviso de arriba.')
    expect(NOT_VOIDED).toBe(
      'No se anuló el pago: la cuenta ya estaba cerrada. Mira el aviso de arriba.',
    )
    const html = renderToStaticMarkup(<NotApplied text={NOT_CHARGED} />)
    expect(html).toContain('role="status"')
    expect(text(html)).toContain(NOT_CHARGED)
  })
})

describe('the register close', () => {
  it('waits for the hub to confirm this device’s money of the shift before saving the count', () => {
    const waiting = closeout(2)
    expect(text(waiting)).toContain('Esperando a que el PC de caja confirme 2 movimientos.')
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>Guardar el conteo/)
    expect(text(closeout(1))).toContain('confirme 1 movimiento.')
    const ready = closeout(0)
    expect(ready).not.toContain('Esperando a que el PC de caja')
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Guardar el conteo/)
  })

  it('a long wait says what to look at and whom to tell; a short one does not yet', () => {
    const SLOW =
      'Todavía no confirma. Mira el contador de pendientes arriba; si no baja, avisa al dueño.'
    expect(text(closeout(2))).not.toContain('Todavía no confirma')
    expect(text(renderToStaticMarkup(<WaitingForHub pending={2} />))).not.toContain(SLOW)
    expect(text(renderToStaticMarkup(<WaitingForHub pending={2} slowAfterMs={0} />))).toContain(
      `Esperando a que el PC de caja confirme 2 movimientos. Cuando los confirme, sigue el cierre. ${SLOW}`,
    )
  })

  it('without the hub it says to check the network and that the register PC is on', () => {
    expect(NO_NETWORK).toBe(
      'Sin conexión con el hub del local: no se pueden registrar movimientos ni cerrar la caja hasta que vuelva. Revisa el cable o el Wi-Fi, o que el PC de caja esté encendido.',
    )
  })

  it('lists the unapplied money apart from what there should be, with method and sign', () => {
    const list = [
      movement({}),
      movement({ eventId: 'e2', type: 'RefundRecorded', amount: -5_000, tip: 0 }),
      movement({ eventId: 'e3', type: 'PaymentVoided', method: null, amount: null, tip: null }),
    ]
    const t = text(
      renderToStaticMarkup(
        <Result
          reconciliation={{
            ...reconciliation(list),
            closed: {
              expected: 100_000,
              counted: 100_000,
              variance: 0,
              justification: null,
              otherMethods: [],
              time: '',
            },
          }}
          rules={null}
        />,
      ),
    )
    expect(t).toContain('Movimientos no aplicados')
    expect(t).toContain(
      'Se registraron, pero no cambiaron la caja: la cuenta ya estaba cerrada. No van en «Debería haber».',
    )
    expect(t).toContain('Pago · Efectivo +$40.000')
    expect(t).toContain('Devolución · Efectivo -$5.000')
    expect(t).toContain('Pago anulado monto no disponible')
    // What there should be does not include them.
    expect(t).toContain('Debería haber $100.000')
    expect(t.indexOf('Debería haber')).toBeLessThan(t.indexOf('Movimientos no aplicados'))
  })

  it('without unapplied money the close does not mention it', () => {
    const t = text(
      renderToStaticMarkup(
        <Result
          reconciliation={{
            ...reconciliation(),
            closed: {
              expected: 100_000,
              counted: 100_000,
              variance: 0,
              justification: null,
              otherMethods: [],
              time: '',
            },
          }}
          rules={null}
        />,
      ),
    )
    expect(t).not.toContain('no aplicados')
  })
})
