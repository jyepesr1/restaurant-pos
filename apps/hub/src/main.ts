import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { type BaseSqlite, versionActual } from '@pos/db'
import type { SalaSync } from '@pos/sync'
import {
  abrirDatos,
  dirDatosDe,
  mostrarPines,
  prepararAcceso,
  prepararSincronizacion,
} from './arranque'
import { crearServidor } from './servidor'

const PUERTO_POR_DEFECTO = 4000
const ARCHIVO_PIN_ADMIN = 'pin-administrador.txt'
// Se pueden cambiar con variables de entorno; las pruebas e2e usan carpetas propias para no
// pisar la app ni los datos de un hub que esté sirviendo a celulares reales.
const dirApp = process.env.DIR_APP || fileURLToPath(new URL('../../pos/dist', import.meta.url))
const dirDatos = dirDatosDe()

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
    const { db: base, aplicadas } = abrirDatos(dirDatos)
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
function prepararTodo(db: BaseSqlite) {
  try {
    // La sala se crea después del acceso, pero la revocación de un equipo debe llegarle.
    let sala: SalaSync | null = null
    // Por ahora el aviso al administrador va a la ventana del hub; con la caja (Fase 1), a su pantalla.
    const acceso = prepararAcceso(
      db,
      dirDatos,
      (aviso) => console.warn(`⚠ Seguridad: ${aviso}`),
      (dispositivoId, revocadoEn) => sala?.revocar(dispositivoId, revocadoEn),
    )
    sala = prepararSincronizacion(db, dirDatos, acceso.restauranteId, acceso.acceso, (error, id) =>
      console.error(`Un evento hizo fallar al hub y se rechazó (${id}):`, error),
    )
    return { ...acceso, sala }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error)
    console.error(`No se pudo preparar el acceso del hub: ${detalle}`)
    process.exit(1)
  }
}

const puerto = leerPuerto()
const db = prepararBase()
const { acceso, restauranteId, sala, pin: pinAdmin, avisos } = prepararTodo(db)
const app = crearServidor({
  dirApp,
  diagnostico: { dirDatos },
  acceso,
  sincronizacion: { sala, alFallo: (error) => console.error('Falló la sincronización:', error) },
  catalogo: {
    db,
    restauranteId,
    acceso,
    alCambiar: (version) => sala.avisarCatalogo(version),
    mesaOcupada: (mesaId) => sala.tienePedidoAbierto(mesaId),
  },
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
if (pinAdmin)
  mostrarPines(dirDatos, {
    ventana: [
      `\nPIN del administrador: ${pinAdmin}`,
      'Anótalo en un lugar seguro: no se vuelve a mostrar.',
    ],
    archivo: ARCHIVO_PIN_ADMIN,
    contenido: `${pinAdmin}\n`,
    aviso: (ruta) => `\nEl PIN del administrador quedó en ${ruta}: anótalo y borra ese archivo.`,
  })

console.log('\nHub en marcha. Abre en los dispositivos de la misma red:')
for (const ip of ipsLocales()) {
  console.log(`  http://${ip}:${puerto}`)
}
