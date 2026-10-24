import { existsSync, mkdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aplicarMigraciones, type BaseSqlite, versionActual } from '@pos/db'
import { abrirBase } from '@pos/db/node'
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

/** Abre la base en exclusiva (un solo hub por carpeta de datos) y la lleva a la última versión. */
function prepararBase(): BaseSqlite {
  try {
    mkdirSync(dirDatos, { recursive: true })
    const base = abrirBase(join(dirDatos, 'pos.sqlite'), { exclusiva: true })
    const aplicadas = aplicarMigraciones(base)
    console.log(
      aplicadas.length > 0
        ? `Base de datos actualizada a la versión ${versionActual(base)}.`
        : `Base de datos en la versión ${versionActual(base)}.`,
    )
    return base
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error)
    console.error(`No se pudo abrir la base de datos del hub: ${detalle}`)
    process.exit(1)
  }
}

const puerto = leerPuerto()
// Las rutas que usan la base llegan con la sincronización (tarea 0.6); por ahora solo se abre,
// se migra y se cierra limpia al apagar.
const db = prepararBase()
const app = crearServidor({
  dirApp,
  diagnostico: { dirDatos },
  versionBase: versionActual(db),
  logger: true,
})

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(senal, async () => {
    await app.close()
    db.close()
    process.exit(0)
  })
}

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
