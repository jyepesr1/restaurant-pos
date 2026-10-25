import { describe, expect, it } from 'vitest'
import { montarApi } from './montaje-api'

// Un usuario que no existe y una contraseña errada no se distinguen desde fuera (ADR-013): mismo
// estado, mismo cuerpo, misma espera, en toda la secuencia de intentos.

const cuerpoDe = (r: {
  statusCode: number
  headers: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: respuesta JSON de prueba, sin tipo
  json: () => any
}) => ({
  status: r.statusCode,
  cuerpo: r.json(),
  retry: r.headers['retry-after'] ?? null,
})

describe('sin pistas sobre qué usuarios existen', () => {
  it('toda una secuencia de intentos sobre una cuenta real y una inventada da respuestas idénticas', async () => {
    const api = montarApi()
    const real = api.personas.admin.usuario as string
    const secuencia: unknown[][] = [[], []]
    for (const [i, usuario] of [real, 'fantasma'].entries()) {
      for (let n = 0; n < 8; n++) {
        const r = await api.post(
          '/api/entrar',
          { usuario, contrasena: 'no-es-la-clave' },
          { ip: '10.0.0.40' },
        )
        secuencia[i]?.push(cuerpoDe(r))
        api.avanzar(r.statusCode === 429 ? Number(r.json().espera_ms) : 100)
      }
      // La otra cuenta empieza de cero en tiempo y en IP.
      api.avanzar(11 * 60_000)
    }
    expect(secuencia[0]).toEqual(secuencia[1])
    expect(secuencia[0]?.[0]).toEqual({
      status: 401,
      cuerpo: { error: 'credenciales_incorrectas', mensaje: 'Usuario o contraseña incorrectos' },
      retry: null,
    })
  })

  it('todas las formas de «no existe» responden igual que una contraseña errada', async () => {
    const api = montarApi()
    // Una persona archivada, una que entra con PIN (sin usuario) y nombres que no son usuarios.
    const archivada = api.acceso.crearUsuario({
      nombre: 'Archivada',
      rolId: api.roles.cajero,
      usuario: 'archivada',
      contrasena: 'clave-correcta-1',
    })
    api.acceso.archivarUsuario(archivada.usuarioId)
    const casos: { usuario: string; contrasena: string }[] = [
      { usuario: api.personas.admin.usuario as string, contrasena: 'clave-equivocada' },
      { usuario: 'nadie', contrasena: 'clave-equivocada' },
      { usuario: 'archivada', contrasena: 'clave-correcta-1' },
      { usuario: 'Ana', contrasena: 'clave-equivocada' },
      { usuario: '', contrasena: '' },
      { usuario: ' ', contrasena: 'clave-equivocada' },
      { usuario: 'a', contrasena: 'clave-equivocada' },
      { usuario: 'con espacio', contrasena: 'clave-equivocada' },
      { usuario: 'ñandú', contrasena: 'clave-equivocada' },
      { usuario: 'x'.repeat(100), contrasena: 'clave-equivocada' },
      { usuario: "' OR 1=1 --", contrasena: 'clave-equivocada' },
    ]
    const respuestas = []
    for (const [i, c] of casos.entries()) {
      // IP distinta para cada caso y reloj corrido: cada uno es su primer intento.
      respuestas.push(cuerpoDe(await api.post('/api/entrar', c, { ip: `10.2.0.${i + 1}` })))
      api.avanzar(11 * 60_000)
    }
    for (const r of respuestas) expect(r).toEqual(respuestas[0])
  })

  it('una persona que entra con PIN no se delata: su nombre como usuario falla igual que cualquier otro', async () => {
    const api = montarApi()
    const aNombre = await api.post('/api/entrar', {
      usuario: 'ana',
      contrasena: api.personas.mesero.pin.repeat(2),
    })
    const aNadie = await api.post(
      '/api/entrar',
      { usuario: 'nadie', contrasena: api.personas.mesero.pin.repeat(2) },
      { ip: '10.0.0.41' },
    )
    expect(cuerpoDe(aNombre)).toEqual(cuerpoDe(aNadie))
  })

  it('los errores no repiten el usuario ni la contraseña escritos', async () => {
    const api = montarApi()
    const r = await api.post('/api/entrar', {
      usuario: 'quien-sea',
      contrasena: 'la-clave-que-escribi-1',
    })
    expect(r.body).not.toContain('quien-sea')
    expect(r.body).not.toContain('la-clave-que-escribi-1')
  })

  it('el PIN de alguien con contraseña y un PIN que no existe fallan igual', async () => {
    const api = montarApi()
    const conUsuario = await api.post(
      '/api/entrar',
      { pin: api.personas.admin.pin },
      { ip: '10.0.0.50' },
    )
    const inexistente = await api.post('/api/entrar', { pin: '0007' }, { ip: '10.0.0.51' })
    expect(cuerpoDe(conUsuario)).toEqual(cuerpoDe(inexistente))
  })

  it('la espera de una cuenta que no existe se anota igual que la de una real: ambas se bloquean a la 3.ª', async () => {
    const api = montarApi()
    for (const usuario of [api.personas.admin.usuario as string, 'inventado']) {
      const estados: number[] = []
      for (let i = 0; i < 4; i++)
        estados.push(
          (
            await api.post(
              '/api/entrar',
              { usuario, contrasena: 'incorrecta-xx' },
              { ip: `10.0.${usuario.length}.${i}` },
            )
          ).statusCode,
        )
      expect(estados).toEqual([401, 401, 401, 429])
      api.avanzar(11 * 60_000)
    }
  })
})
