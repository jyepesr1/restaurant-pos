import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { crearServidor } from './servidor'

const PUERTO_POR_DEFECTO = 4000
// Se pueden cambiar con variables de entorno; las pruebas e2e usan carpetas propias para no
// pisar la app ni los datos de un hub que esté sirviendo a celulares reales.
const dirApp = process.env.DIR_APP || fileURLToPath(new URL('../../pos/dist', import.meta.url))
const dirDatos = process.env.DIR_DATOS || fileURLToPath(new URL('../datos', import.meta.url))

function leerPuerto(): number {
  const valor = process.env.PUERTO
  if (valor === undefined) return PUERTO_POR_DEFECTO
  const puerto = Number(valor)
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    console.error(`PUERTO inválido: "${valor}". Usa un número entre 1 y 65535.`)
    process.exit(1)
  }
  return puerto
}

const esIpPrivada = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

/** IPs privadas IPv4 de este equipo: las que deben abrir los celulares en la red local. */
function ipsLocales(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((red) => red?.family === 'IPv4' && !red.internal && esIpPrivada(red.address))
    .map((red) => red?.address as string)
}

const puerto = leerPuerto()
const app = crearServidor({ dirApp, diagnostico: { dirDatos }, logger: true })

try {
  await app.listen({ host: '0.0.0.0', port: puerto })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`El puerto ${puerto} ya está en uso. ¿El hub ya está abierto en otra ventana?`)
  } else {
    console.error('No se pudo iniciar el hub:', error)
  }
  process.exit(1)
}

if (!existsSync(dirApp)) {
  console.warn(
    '\n⚠ Falta compilar la app: ejecuta `pnpm --filter @pos/app build` y reinicia el hub.',
  )
}

console.log('\nHub en marcha. Abre en los dispositivos de la misma red:')
for (const ip of ipsLocales()) {
  console.log(`  http://${ip}:${puerto}`)
}
