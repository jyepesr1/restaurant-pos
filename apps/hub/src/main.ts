import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aplicarMigraciones, type BaseSqlite, versionActual } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './acceso/inicial'
import { Intentos } from './acceso/intentos'
import { cargarClave } from './acceso/secretos'
import { ServicioAcceso } from './acceso/servicio'
import { crearServidor } from './servidor'

const PUERTO_POR_DEFECTO = 4000
const ARCHIVO_PIN_ADMIN = 'pin-administrador.txt'
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

/** Restaurante, roles, administrador y la clave de los PIN (tarea 0.7). */
function prepararAcceso(db: BaseSqlite) {
  try {
    const { clave, nueva, creadaEn } = cargarClave(dirDatos)
    const ahora = new Date().toISOString()
    const restauranteId = asegurarRestaurante(db, ahora)
    const roles = asegurarRoles(db, restauranteId, ahora)
    // Por ahora el aviso al administrador va a la ventana del hub; con la caja (Fase 1), a su pantalla.
    const intentos = new Intentos(Date.now, (aviso) => console.warn(`⚠ Seguridad: ${aviso}`))
    const acceso = new ServicioAcceso({ db, restauranteId, clave, intentos, claveDesde: creadaEn })
    const admin = asegurarAdministrador(db, acceso, roles.admin, nueva)
    return { acceso, ...admin }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error)
    console.error(`No se pudo preparar el acceso del hub: ${detalle}`)
    process.exit(1)
  }
}

const puerto = leerPuerto()
// La sincronización por WebSocket se conecta en la tarea 0.10.
const db = prepararBase()
const { acceso, pin: pinAdmin, avisos } = prepararAcceso(db)
const app = crearServidor({
  dirApp,
  diagnostico: { dirDatos },
  acceso,
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

for (const aviso of avisos) console.warn(`⚠ ${aviso}`)
if (pinAdmin) {
  // Se muestra una sola vez: el hub guarda solo su huella. Si la salida no es una ventana (el
  // servicio de Windows la manda a un archivo de log), va a un archivo aparte para borrar.
  if (process.stdout.isTTY) {
    console.log(`\nPIN del administrador: ${pinAdmin}`)
    console.log('Anótalo en un lugar seguro: no se vuelve a mostrar.')
  } else {
    const ruta = join(dirDatos, ARCHIVO_PIN_ADMIN)
    writeFileSync(ruta, `${pinAdmin}\n`, { mode: 0o600 })
    console.log(`\nEl PIN del administrador quedó en ${ruta}: anótalo y borra ese archivo.`)
  }
}

console.log('\nHub en marcha. Abre en los dispositivos de la misma red:')
for (const ip of ipsLocales()) {
  console.log(`  http://${ip}:${puerto}`)
}
