import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { localIps, phoneAddresses } from './addresses'
import { createAppServer } from './server'

const network = (address: string, extra: Partial<NetworkInterfaceInfo> = {}) =>
  ({
    address,
    family: 'IPv4',
    internal: false,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...extra,
  }) as NetworkInterfaceInfo

describe('phone addresses', () => {
  const interfaces = {
    lo: [network('127.0.0.1', { internal: true })],
    wifi: [
      network('192.168.1.20'),
      network('fe80::1', { family: 'IPv6' } as Partial<NetworkInterfaceInfo>),
    ],
    ethernet: [network('10.0.0.5'), network('172.16.3.4'), network('172.32.0.1')],
    vpn: [network('100.64.1.2'), network('8.8.8.8')],
    'vEthernet (WSL)': [network('172.20.0.1')],
    'vEthernet (External Switch)': [network('192.168.1.21')],
    'VirtualBox Host-Only Network': [network('192.168.56.1')],
  }

  it('keeps only private IPv4 addresses of this machine, not its virtual networks', () => {
    expect(localIps(interfaces)).toEqual(['192.168.1.20', '10.0.0.5', '172.16.3.4', '192.168.1.21'])
  })

  it('builds the address with the port, without repeats', () => {
    expect(
      phoneAddresses(4000, { a: [network('192.168.1.20')], b: [network('192.168.1.20')] }),
    ).toEqual(['http://192.168.1.20:4000'])
    expect(phoneAddresses(4000, {})).toEqual([])
  })

  it('the hub answers them without a session: anyone on the network can already see them', async () => {
    const app = createAppServer({ addresses: () => ['http://192.168.1.20:4000'] })
    const r = await app.inject({ method: 'GET', url: '/api/addresses' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ addresses: ['http://192.168.1.20:4000'] })
    await app.close()
  })

  it('without the option the route does not exist', async () => {
    const app = createAppServer()
    expect((await app.inject({ method: 'GET', url: '/api/addresses' })).statusCode).toBe(404)
    await app.close()
  })
})
