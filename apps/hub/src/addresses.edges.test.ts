import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { localIps, phoneAddresses } from './addresses'

// The addresses the phones open (task 1.13): which network adapters of a Windows register PC
// count. Adapters that only exist inside the PC are left out; a bridged Hyper-V switch, which
// carries the real LAN, is not.

const nic = (address: string, extra: Partial<NetworkInterfaceInfo> = {}) =>
  ({
    address,
    family: 'IPv4',
    internal: false,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...extra,
  }) as NetworkInterfaceInfo

const ips = (named: Record<string, string[]>) =>
  localIps(Object.fromEntries(Object.entries(named).map(([k, v]) => [k, v.map((a) => nic(a))])))

describe('virtual adapters are skipped', () => {
  it.each([
    'vEthernet (WSL)',
    'vEthernet (WSL (Hyper-V firewall))',
    'vEthernet (Default Switch)',
    'vethernet (default switch)',
    'VirtualBox Host-Only Network',
    'VirtualBox Host-Only Network #2',
    'VMware Network Adapter VMnet1',
    'VMware Network Adapter VMnet8',
    'vmnet1',
    'vboxnet0',
    'docker0',
    'Docker NAT',
    'utun3',
    'Tailscale',
    'ZeroTier One [8056c2e21c000001]',
  ])('%s', (name) => {
    expect(ips({ [name]: ['172.20.144.1'], Ethernet: ['192.168.1.20'] })).toEqual(['192.168.1.20'])
  })
})

describe('the real network stays', () => {
  it.each([
    'Ethernet',
    'Ethernet 2',
    'Wi-Fi',
    'Wi-Fi 2',
    'en0',
    'eth0',
    'wlan0',
    'Conexión de área local',
    'Conexión de red inalámbrica',
    // A Hyper-V external switch bridges the physical card: the LAN address lives on it.
    'vEthernet (External)',
    'vEthernet (Puente)',
    'Local Area Connection* 3',
  ])('%s', (name) => {
    expect(ips({ [name]: ['192.168.1.20'] })).toEqual(['192.168.1.20'])
  })
})

describe('which addresses count', () => {
  it('private ranges only, including both ends of 172.16/12', () => {
    expect(
      ips({
        a: ['10.0.0.1', '10.255.255.254', '192.168.0.1', '172.16.0.1', '172.31.255.254'],
        b: ['172.15.255.255', '172.32.0.0', '192.169.0.1', '11.0.0.1', '9.255.255.255'],
        c: ['169.254.10.10', '100.64.0.1', '8.8.8.8', '127.0.0.1', '0.0.0.0', '255.255.255.255'],
      }),
    ).toEqual(['10.0.0.1', '10.255.255.254', '192.168.0.1', '172.16.0.1', '172.31.255.254'])
  })

  it('IPv6, internal and non-IPv4 entries are ignored', () => {
    expect(
      localIps({
        lo: [nic('192.168.1.1', { internal: true })],
        v6: [nic('fd00::1', { family: 'IPv6' } as Partial<NetworkInterfaceInfo>)],
        old: [nic('192.168.1.2', { family: 4 } as unknown as Partial<NetworkInterfaceInfo>)],
        ok: [nic('192.168.1.3')],
      }),
    ).toEqual(['192.168.1.3'])
  })

  it('an address that looks private only as a prefix of something else is not', () => {
    expect(
      ips({ a: ['10x.0.0.1', '192.168', '172.160.0.1', '172.2.0.1', '1.10.0.0', ''] }),
    ).toEqual([])
  })

  it('adapters with no addresses, or undefined, do not break it', () => {
    expect(localIps({ a: undefined, b: [], c: [nic('10.1.1.1')] })).toEqual(['10.1.1.1'])
    expect(localIps({})).toEqual([])
  })

  it('the order follows the adapters and the same address on two adapters is listed once', () => {
    expect(
      phoneAddresses(4000, { b: [nic('10.0.0.2')], a: [nic('192.168.1.2')], c: [nic('10.0.0.2')] }),
    ).toEqual(['http://10.0.0.2:4000', 'http://192.168.1.2:4000'])
  })

  it('the port goes in as given', () => {
    expect(phoneAddresses(4100, { a: [nic('10.0.0.2')] })).toEqual(['http://10.0.0.2:4100'])
    expect(phoneAddresses(80, { a: [nic('10.0.0.2')] })).toEqual(['http://10.0.0.2:80'])
  })

  it('a Windows PC with WSL, Docker and the LAN gives only the LAN', () => {
    expect(
      phoneAddresses(4000, {
        Ethernet: [nic('192.168.1.44')],
        'vEthernet (WSL (Hyper-V firewall))': [nic('172.28.64.1')],
        'vEthernet (Default Switch)': [nic('172.29.0.1')],
        'VMware Network Adapter VMnet8': [nic('192.168.232.1')],
        'Loopback Pseudo-Interface 1': [nic('127.0.0.1', { internal: true })],
      }),
    ).toEqual(['http://192.168.1.44:4000'])
  })

  it('the real interfaces of this machine do not throw and are all private', () => {
    for (const ip of localIps()) expect(ip).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/)
  })
})
