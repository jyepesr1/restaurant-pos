import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// «Para conectar un celular» in «Personal y roles → Equipos» (task 1.13): the hub runs as a Windows
// service with no window, so the register is where the phones' address is read.

vi.mock('./context', () => ({ useFloor: () => ({}), floor: {} }))
vi.mock('./FloorFrame', () => ({ FloorFrame: ({ children }: { children: unknown }) => children }))
vi.mock('../ui/toasts', () => ({ useNotify: () => () => {} }))

const { PhoneAddressCard } = await import('./Staff')
const html = (addresses: string[]) =>
  renderToStaticMarkup(<PhoneAddressCard addresses={addresses} />)

describe('the phone address card', () => {
  it('shows the address to open on the staff Wi-Fi', () => {
    const page = html(['http://192.168.1.20:4000'])
    expect(page).toContain('Para conectar un celular')
    expect(page).toContain('Wi-Fi del personal')
    expect(page).toContain('http://192.168.1.20:4000')
    expect(page).not.toContain('empieza igual')
  })

  it('with several addresses it says which one to use', () => {
    const page = html(['http://192.168.1.20:4000', 'http://10.0.0.5:4000'])
    expect(page).toContain('http://10.0.0.5:4000')
    expect(page).toContain('Usa la que empieza igual que la dirección de las impresoras.')
  })

  it('without a local network it says what to check', () => {
    const page = html([])
    expect(page).toContain('no está en la red del local')
    expect(page).not.toContain('Wi-Fi del personal y abre')
  })
})
