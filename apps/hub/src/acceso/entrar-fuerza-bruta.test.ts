import { describe, expect, it } from 'vitest'
import {
  ESPERA_MAXIMA_MS,
  FALLOS_DE_UN_EQUIPO_PARA_AVISO,
  FALLOS_PARA_AVISO,
  VENTANA_AVISO_MS,
} from './intentos'
import { montarApi } from './montaje-api'

// Fuerza bruta contra `POST /api/entrar` sin token (ADR-013): PIN y contraseña, rotando IP, y el
// aviso al administrador. Reloj manual: nada espera de verdad.

const ip = (n: number) => `10.1.${Math.floor(n / 250)}.${(n % 250) + 1}`

/** Un PIN con formato válido que no es de nadie del montaje. */
function pinsAjenos(m: { personas: Record<string, { pin: string }> }, cuantos: number) {
  const propios = new Set(Object.values(m.personas).map((p) => p.pin))
  const r: string[] = []
  for (let n = 0; r.length < cuantos; n++) {
    const pin = String(n).padStart(4, '0')
    if (!propios.has(pin)) r.push(pin)
  }
  return r
}

describe('PIN sin token, rotando IP', () => {
  it('cada IP nueva tiene sus dos intentos libres: el freno por IP no basta, y se sabe (riesgo aceptado ADR-013)', async () => {
    const api = montarApi()
    const pins = pinsAjenos(api, 200)
    const estados = new Set<number>()
    for (const [i, pin] of pins.entries())
      estados.add((await api.post('/api/entrar', { pin }, { ip: ip(i) })).statusCode)
    expect([...estados]).toEqual([401])
    // Y ni un equipo registrado: ningún acierto, ningún navegador anotado.
    expect(Number(api.db.prepare('SELECT count(*) AS n FROM dispositivo').get()?.n)).toBe(0)
  })

  it('el aviso al administrador sale al fallo número 20 del hub entero, aunque cada IP falle una vez', async () => {
    const api = montarApi()
    const pins = pinsAjenos(api, FALLOS_PARA_AVISO + 5)
    for (const [i, pin] of pins.slice(0, FALLOS_PARA_AVISO - 1).entries())
      await api.post('/api/entrar', { pin }, { ip: ip(i) })
    expect(api.avisos).toEqual([])
    await api.post('/api/entrar', { pin: pins[FALLOS_PARA_AVISO - 1] }, { ip: ip(99) })
    expect(api.avisos).toHaveLength(1)
    expect(api.avisos[0]).toMatch(/20 PIN/)
    // Seguir probando no inunda al administrador con un aviso por intento.
    for (const [i, pin] of pins.slice(FALLOS_PARA_AVISO).entries())
      await api.post('/api/entrar', { pin }, { ip: ip(100 + i) })
    expect(api.avisos).toHaveLength(1)
  })

  it('quien prueba despacio desde un mismo navegador registrado dispara el aviso del equipo', async () => {
    const api = montarApi()
    const celular = (await api.post('/api/entrar', { pin: api.personas.mesero.pin })).json()
    const token = celular.equipo.token as string
    const [pin] = pinsAjenos(api, 1) as [string]
    let fallos = 0
    while (fallos < FALLOS_DE_UN_EQUIPO_PARA_AVISO) {
      const r = await api.post('/api/entrar', { pin }, { token, ip: ip(fallos) })
      // Respeta la espera: cada intento llega cuando ya se puede.
      if (r.statusCode === 429) api.avanzar(Number(r.json().espera_ms) + 1)
      else fallos++
    }
    expect(api.avisos.some((a) => /seguidos desde dispositivo:/.test(a))).toBe(true)
  })

  it('con el mismo token, cambiar de IP no reinicia la espera: se cuenta por equipo', async () => {
    const api = montarApi()
    const celular = (await api.post('/api/entrar', { pin: api.personas.mesero.pin })).json()
    const token = celular.equipo.token as string
    for (const [i, pin] of pinsAjenos(api, 3).entries())
      await api.post('/api/entrar', { pin }, { token, ip: ip(i) })
    const luego = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero2.pin },
      { token, ip: ip(500) },
    )
    expect(luego.statusCode).toBe(429)
    expect(luego.json()).toMatchObject({ error: 'espera' })
  })

  it('X-Forwarded-For no cambia de identidad: el hub mira la conexión', async () => {
    const api = montarApi()
    for (const [i, pin] of pinsAjenos(api, 3).entries())
      await api.post(
        '/api/entrar',
        { pin },
        {
          ip: '10.9.9.9',
          cabeceras: { 'x-forwarded-for': `1.2.3.${i}`, 'x-real-ip': `8.8.8.${i}` },
        },
      )
    const r = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero.pin },
      { ip: '10.9.9.9', cabeceras: { 'x-forwarded-for': '1.2.3.200' } },
    )
    expect(r.statusCode).toBe(429)
  })

  it('un token inventado o vacío no sirve para probar PIN: 401 sin gastar intentos de nadie', async () => {
    const api = montarApi()
    for (const token of ['inventado', 'x'.repeat(500), ' ']) {
      const r = await api.post('/api/entrar', { pin: '0001' }, { token, ip: '10.8.8.8' })
      expect([401, 400]).toContain(r.statusCode)
    }
    // La IP sigue limpia: su acierto entra de inmediato.
    const ok = await api.post('/api/entrar', { pin: api.personas.mesero.pin }, { ip: '10.8.8.8' })
    expect(ok.statusCode).toBe(201)
  })

  it('el atacante no deja sin servicio a los meseros: otro navegador, con su PIN, entra durante el ataque', async () => {
    const api = montarApi()
    for (const [i, pin] of pinsAjenos(api, 150).entries())
      await api.post('/api/entrar', { pin }, { ip: ip(i % 3) })
    const ok = await api.post('/api/entrar', { pin: api.personas.mesero2.pin }, { ip: '10.77.0.1' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().usuario.nombre).toBe('Luis')
  })

  it('la espera de una IP sube hasta 60 s y la respuesta trae retry-after coherente', async () => {
    const api = montarApi()
    let ultimo = 0
    for (let n = 0; n < 40; n++) {
      const r = await api.post('/api/entrar', { pin: '0002' }, { ip: '10.5.5.5' })
      if (r.statusCode === 429) {
        const ms = Number(r.json().espera_ms)
        expect(ms).toBeGreaterThan(0)
        expect(ms).toBeLessThanOrEqual(ESPERA_MAXIMA_MS)
        expect(Number(r.headers['retry-after'])).toBe(Math.ceil(ms / 1000))
        ultimo = ms
        api.avanzar(ms)
      }
    }
    expect(ultimo).toBeGreaterThan(0)
  })
})

describe('contraseña sin token', () => {
  const credencialesMalas = (usuario: string, i: number) => ({
    usuario,
    contrasena: `mala-${i}-xxxxxxxx`,
  })

  it('rotar la IP no libra de la espera de la cuenta: desde la 3.ª, todas las IP esperan', async () => {
    const api = montarApi()
    const usuario = api.personas.admin.usuario as string
    for (let i = 0; i < 3; i++)
      await api.post('/api/entrar', credencialesMalas(usuario, i), { ip: ip(i) })
    for (let i = 10; i < 20; i++) {
      const r = await api.post('/api/entrar', credencialesMalas(usuario, i), { ip: ip(i) })
      expect(r.statusCode, `IP ${ip(i)}`).toBe(429)
    }
    // Ni siquiera la contraseña buena entra durante la espera.
    expect((await api.post('/api/entrar', api.admin(), { ip: ip(77) })).statusCode).toBe(429)
  })

  it('en una hora de intentos seguidos desde IP siempre nuevas, solo caben unas decenas de intentos', async () => {
    const api = montarApi()
    const usuario = api.personas.admin.usuario as string
    let permitidos = 0
    for (let s = 0; s < 3600; s++) {
      const r = await api.post('/api/entrar', credencialesMalas(usuario, s), { ip: ip(s) })
      if (r.statusCode === 401) permitidos++
      expect([401, 429]).toContain(r.statusCode)
      api.avanzar(1000)
    }
    // La espera por cuenta tiene tope de 10 s: 2 libres + la rampa 2, 4, 8 s + uno cada 10 s.
    expect(permitidos).toBeLessThan(420)
  })

  it('el aviso al administrador también salta con contraseñas: cada fallo cuenta una sola vez (no por IP y otra por cuenta)', async () => {
    const api = montarApi()
    // Cuentas distintas desde IP distintas: así ninguna espera y los 20 fallos caben en 10 minutos.
    for (let i = 0; i < 19; i++)
      await api.post('/api/entrar', credencialesMalas(`persona${i}`, i), { ip: ip(i) })
    expect(api.avisos).toEqual([])
    await api.post('/api/entrar', credencialesMalas('persona19', 19), { ip: ip(19) })
    expect(api.avisos).toHaveLength(1)
    expect(api.avisos[0]).toMatch(/^20 PIN o códigos errados/)
  })

  it('probar muchas cuentas distintas desde una IP: la IP espera aunque ninguna cuenta se repita', async () => {
    const api = montarApi()
    for (let i = 0; i < 3; i++)
      await api.post('/api/entrar', credencialesMalas(`persona${i}`, i), { ip: '10.4.4.4' })
    const r = await api.post('/api/entrar', credencialesMalas('persona9', 9), { ip: '10.4.4.4' })
    expect(r.statusCode).toBe(429)
  })

  it('bloquear la cuenta del administrador desde fuera dura 10 s como máximo y no afecta a los meseros', async () => {
    const api = montarApi()
    const usuario = api.personas.admin.usuario as string
    // Un atacante sostiene la espera de la cuenta durante 10 minutos.
    let maxima = 0
    for (let s = 0; s < 600; s++) {
      const r = await api.post('/api/entrar', credencialesMalas(usuario, s), { ip: ip(s) })
      if (r.statusCode === 429) maxima = Math.max(maxima, Number(r.json().espera_ms))
      api.avanzar(1000)
    }
    expect(maxima).toBeGreaterThan(0)
    expect(maxima).toBeLessThanOrEqual(10_000)
    // Los meseros (PIN, otra llave de espera) siguen entrando.
    const mesero = await api.post(
      '/api/entrar',
      { pin: api.personas.mesero.pin },
      { ip: '10.3.3.3' },
    )
    expect(mesero.statusCode).toBe(201)
    // Y al callar el atacante, la cuenta vuelve en cuanto pasa la espera.
    api.avanzar(10_001)
    expect((await api.post('/api/entrar', api.admin(), { ip: '10.3.3.4' })).statusCode).toBe(201)
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: `conContrasena` (servicio.ts) aplica el tope como `min(10 s, espera que queda)`. Con la
  // espera real en 64 s, lo que queda sigue siendo mayor a 10 s hasta el final: el hub dice
  // «espera 10 s» pero responde 429 durante casi 60 s, y quien reintenta a los 10 s vuelve a
  // oír «10 s». Esperaba que 10 s después del último fallo la cuenta aceptara otro intento.
  it('la espera por cuenta no pasa de 10 s de verdad', async () => {
    const api = montarApi()
    const usuario = api.personas.admin.usuario as string
    for (let s = 0; s < 12; s++) {
      const r = await api.post('/api/entrar', credencialesMalas(usuario, s), { ip: ip(s) })
      if (r.statusCode === 429) api.avanzar(Number(r.json().espera_ms) + 1)
    }
    api.avanzar(10_001)
    const r = await api.post('/api/entrar', credencialesMalas(usuario, 77), { ip: ip(900) })
    expect(r.statusCode).toBe(401)
  })

  it('los fallos se olvidan tras 10 minutos de calma y la cuenta empieza de cero', async () => {
    const api = montarApi()
    const usuario = api.personas.admin.usuario as string
    for (let i = 0; i < 3; i++)
      await api.post('/api/entrar', credencialesMalas(usuario, i), { ip: ip(i) })
    api.avanzar(VENTANA_AVISO_MS + 1)
    for (let i = 0; i < 2; i++) {
      const r = await api.post('/api/entrar', credencialesMalas(usuario, i), { ip: ip(50 + i) })
      expect(r.statusCode).toBe(401)
    }
  })

  it('un acierto no borra los fallos: alternar la contraseña buena con malas no evita la espera', async () => {
    const api = montarApi()
    const usuario = api.personas.admin.usuario as string
    // La IP es la misma; entre fallo y fallo entra bien. El tercer fallo debe esperar igual.
    const estados: number[] = []
    for (let i = 0; i < 4; i++) {
      estados.push(
        (await api.post('/api/entrar', credencialesMalas(usuario, i), { ip: '10.6.6.6' }))
          .statusCode,
      )
      estados.push((await api.post('/api/entrar', api.admin(), { ip: '10.6.6.6' })).statusCode)
    }
    expect(estados).toContain(429)
  })

  it('el PIN del administrador no sirve como contraseña ni como PIN de entrada, y gasta intentos', async () => {
    const api = montarApi()
    const pin = api.personas.admin.pin
    const usuario = api.personas.admin.usuario as string
    expect(
      (await api.post('/api/entrar', { usuario, contrasena: pin.repeat(2) }, { ip: ip(1) }))
        .statusCode,
    ).toBe(401)
    expect((await api.post('/api/entrar', { pin }, { ip: ip(2) })).statusCode).toBe(401)
    // La contraseña de arriba fue el 1.er fallo de la cuenta (el PIN solo cuenta por IP): con dos
    // más, el siguiente intento, desde cualquier IP, espera.
    await api.post('/api/entrar', credencialesMalas(usuario, 1), { ip: ip(3) })
    await api.post('/api/entrar', credencialesMalas(usuario, 2), { ip: ip(4) })
    expect(
      (await api.post('/api/entrar', credencialesMalas(usuario, 3), { ip: ip(5) })).statusCode,
    ).toBe(429)
  })
})
