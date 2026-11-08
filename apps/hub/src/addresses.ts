import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os'

// Where the phones open the hub. As a Windows service (task 1.13) there is no window that prints
// it, so the register shows it in «Personal y roles → Equipos».

const isPrivateIp = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
/** Networks that only exist inside the PC (WSL, Hyper-V, virtual machines, Docker, VPNs). */
const VIRTUAL =
  /vEthernet \((WSL|Default Switch)|VirtualBox|VMware|Docker|vmnet|vboxnet|utun|Tailscale|ZeroTier/i

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

/**
 * Private IPv4 addresses of this machine, without its virtual networks: the ones the phones should
 * open on the local network.
 */
export function localIps(interfaces: Interfaces = networkInterfaces()): string[] {
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, networks]) => networks ?? [])
    .filter(
      (network) => network?.family === 'IPv4' && !network.internal && isPrivateIp(network.address),
    )
    .map((network) => network?.address as string)
}

/** `http://<ip>:<port>` for each private address, without repeats. */
export const phoneAddresses = (port: number, interfaces?: Interfaces): string[] => [
  ...new Set(localIps(interfaces).map((ip) => `http://${ip}:${port}`)),
]
