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
    const real = api.people.admin.user as string
    const sequence: unknown[][] = [[], []]
    for (const [i, user] of [real, 'fantasma'].entries()) {
      for (let n = 0; n < 8; n++) {
        const r = await api.post(
          '/api/sign-in',
          { user, password: 'no-es-la-clave' },
          { ip: '10.0.0.40' },
        )
        sequence[i]?.push(cuerpoDe(r))
        api.advance(r.statusCode === 429 ? Number(r.json().espera_ms) : 100)
      }
      // La otra cuenta empieza de cero en tiempo y en IP.
      api.advance(11 * 60_000)
    }
    expect(sequence[0]).toEqual(sequence[1])
    expect(sequence[0]?.[0]).toEqual({
      status: 401,
      cuerpo: { error: 'invalid_credentials', message: 'Usuario o contraseña incorrectos' },
      retry: null,
    })
  })

  it('todas las formas de «no existe» responden igual que una contraseña errada', async () => {
    const api = montarApi()
    // Una persona archivada, una que entra con PIN (sin usuario) y nombres que no son usuarios.
    const archivada = api.access.crearUsuario({
      name: 'Archivada',
      rolId: api.roles.cashier,
      user: 'archivada',
      password: 'clave-correcta-1',
    })
    api.access.archivarUsuario(archivada.userId)
    const casos: { user: string; password: string }[] = [
      { user: api.people.admin.user as string, password: 'clave-equivocada' },
      { user: 'nadie', password: 'clave-equivocada' },
      { user: 'archivada', password: 'clave-correcta-1' },
      { user: 'Ana', password: 'clave-equivocada' },
      { user: '', password: '' },
      { user: ' ', password: 'clave-equivocada' },
      { user: 'a', password: 'clave-equivocada' },
      { user: 'con espacio', password: 'clave-equivocada' },
      { user: 'ñandú', password: 'clave-equivocada' },
      { user: 'x'.repeat(100), password: 'clave-equivocada' },
      { user: "' OR 1=1 --", password: 'clave-equivocada' },
    ]
    const respuestas = []
    for (const [i, c] of casos.entries()) {
      // IP distinta para cada caso y reloj corrido: cada uno es su primer intento.
      respuestas.push(cuerpoDe(await api.post('/api/sign-in', c, { ip: `10.2.0.${i + 1}` })))
      api.advance(11 * 60_000)
    }
    for (const r of respuestas) expect(r).toEqual(respuestas[0])
  })

  it('una persona que entra con PIN no se delata: su nombre como usuario falla igual que cualquier otro', async () => {
    const api = montarApi()
    const aNombre = await api.post('/api/sign-in', {
      user: 'ana',
      password: api.people.waiter.pin.repeat(2),
    })
    const aNadie = await api.post(
      '/api/sign-in',
      { user: 'nadie', password: api.people.waiter.pin.repeat(2) },
      { ip: '10.0.0.41' },
    )
    expect(cuerpoDe(aNombre)).toEqual(cuerpoDe(aNadie))
  })

  it('los errores no repiten el usuario ni la contraseña escritos', async () => {
    const api = montarApi()
    const r = await api.post('/api/sign-in', {
      user: 'quien-sea',
      password: 'la-clave-que-escribi-1',
    })
    expect(r.body).not.toContain('quien-sea')
    expect(r.body).not.toContain('la-clave-que-escribi-1')
  })

  it('el PIN de alguien con contraseña y un PIN que no existe fallan igual', async () => {
    const api = montarApi()
    const conUsuario = await api.post(
      '/api/sign-in',
      { pin: api.people.admin.pin },
      { ip: '10.0.0.50' },
    )
    const nonexistent = await api.post('/api/sign-in', { pin: '0007' }, { ip: '10.0.0.51' })
    expect(cuerpoDe(conUsuario)).toEqual(cuerpoDe(nonexistent))
  })

  it('la espera de una cuenta que no existe se anota igual que la de una real: ambas se bloquean a la 3.ª', async () => {
    const api = montarApi()
    for (const user of [api.people.admin.user as string, 'inventado']) {
      const statuses: number[] = []
      for (let i = 0; i < 4; i++)
        statuses.push(
          (
            await api.post(
              '/api/sign-in',
              { user, password: 'incorrecta-xx' },
              { ip: `10.0.${user.length}.${i}` },
            )
          ).statusCode,
        )
      expect(statuses).toEqual([401, 401, 401, 429])
      api.advance(11 * 60_000)
    }
  })
})
