import { newId } from '@pos/core'
import type { Conexion } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import { ESPERA_MAXIMA_MS, FALLOS_DE_UN_EQUIPO_PARA_AVISO, FALLOS_PARA_AVISO } from './intentos'
import { montarAcceso } from './montaje'

// Fuerza bruta sobre el PIN y el código de emparejamiento (ADR-008, docs/SYNC.md#seguridad).

const BAD_VALUES = ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']

describe('emparejamiento: aprobar con el PIN del administrador', () => {
  const request = (m: ReturnType<typeof montarAcceso>, connection: Conexion | null, pin: string) =>
    m.access.crearEmparejamiento({ pin, name: 'Equipo', type: 'waiter' }, connection)

  it('el primer equipo (hub sin ninguno) tiene una espera única para todo el hub, venga de donde venga', () => {
    const m = montarAcceso()
    for (const pin of BAD_VALUES.slice(0, 3)) request(m, null, pin)

    // Ni cambiando de IP ni con el PIN bueno: la caja recién instalada espera.
    expect(request(m, null, m.people.admin.pin)).toMatchObject({ ok: false, code: 'wait' })
    m.advance(2000)
    expect(request(m, null, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('con un equipo ya emparejado, pedir sin equipo no vale y no cuenta como intento', () => {
    const m = montarAcceso()
    const register = m.emparejar('register').connection
    for (let i = 0; i < 50; i++)
      expect(request(m, null, BAD_VALUES[i % 8] as string)).toMatchObject({
        ok: false,
        code: 'unpaired_device',
      })

    // Nadie quedó esperando por esos intentos.
    expect(request(m, register, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('desde un equipo, adivinar el PIN del administrador hace esperar a ese equipo y a ninguno más', () => {
    const m = montarAcceso()
    const a = m.emparejar('register', 'A').connection
    const b = m.emparejar('waiter', 'B').connection
    for (const pin of BAD_VALUES.slice(0, 3)) request(m, a, pin)

    expect(request(m, a, m.people.admin.pin)).toMatchObject({ ok: false, code: 'wait' })
    expect(request(m, b, m.people.admin.pin)).toMatchObject({ ok: true })
    m.advance(2000)
    expect(request(m, a, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('revocar equipos no reabre el «primer emparejamiento» mientras quede alguno sin revocar', () => {
    const m = montarAcceso()
    const register = m.emparejar('register').connection
    const phone = m.emparejar('waiter')
    const thirdOne = m.emparejar('register', 'Tercera').connection
    const admin = m.entrar(thirdOne, 'admin')
    for (const d of [register, phone.connection])
      m.access.revocarDispositivo(thirdOne, { ...admin, dispositivoId: d.dispositivoId })

    expect(request(m, null, m.people.admin.pin)).toMatchObject({ code: 'unpaired_device' })
    expect(request(m, thirdOne, m.people.admin.pin)).toMatchObject({ ok: true })
  })

  it('el PIN de un mesero no aprueba, y gasta intentos del equipo como cualquier fallo', () => {
    const m = montarAcceso()
    const register = m.emparejar('register').connection
    const r = [
      request(m, register, m.people.waiter.pin),
      request(m, register, m.people.cashier.pin),
      request(m, register, m.people.manager.pin),
    ]

    expect(r.map((x) => (x.ok ? 'ok' : x.code))).toEqual(['wrong_pin', 'wrong_pin', 'wrong_pin'])
    expect(request(m, register, m.people.admin.pin)).toMatchObject({ code: 'wait' })
  })
})

describe('emparejamiento: canjear el código desde una IP', () => {
  const nuevoCodigo = (m: ReturnType<typeof montarAcceso>, name = 'X') => {
    const register = m.emparejar('register', `Caja ${name}`).connection
    const c = m.access.crearEmparejamiento({ pin: m.people.admin.pin, name, type: 'kds' }, register)
    if (!c.ok) throw new Error(c.message)
    return c
  }

  it('el acierto de otra IP no reinicia la espera de quien viene fallando', () => {
    const m = montarAcceso()
    const buena = nuevoCodigo(m)
    for (let i = 0; i < 3; i++) m.access.emparejar('AAAAAAAA', '10.0.0.66')
    const delay = () => m.access.emparejar('AAAAAAAA', '10.0.0.66')
    expect(delay()).toMatchObject({ code: 'wait' })

    expect(m.access.emparejar(buena.code, '10.0.0.5')).toMatchObject({ ok: true })

    expect(delay()).toMatchObject({ code: 'wait' })
  })

  it('un acierto tampoco borra los fallos de la misma IP: no sirve para alternar y seguir adivinando', () => {
    const m = montarAcceso()
    const register = m.emparejar('register').connection
    let esperas = 0
    for (let ronda = 0; ronda < 30; ronda++) {
      const c = m.access.crearEmparejamiento(
        { pin: m.people.admin.pin, name: 'X', type: 'kds' },
        register,
      )
      if (!c.ok) {
        m.advance(60_000)
        continue
      }
      for (const code of ['AAAAAAAA', 'BBBBBBBB', c.code]) {
        const r = m.access.emparejar(code, '10.0.0.66')
        if (!r.ok && r.code === 'wait') esperas++
      }
    }
    expect(esperas).toBeGreaterThan(0)
  })

  it('la X-Forwarded-For no sirve para cambiar de identidad: el hub mira la conexión', async () => {
    const { crearServidor } = await import('../servidor')
    const m = montarAcceso()
    const app = crearServidor({ access: m.access })
    const intento = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/pair',
        payload: { code: 'AAAAAAAA' },
        headers: { 'x-forwarded-for': ip, 'x-real-ip': ip },
      })

    const respuestas = []
    for (let i = 0; i < 4; i++) respuestas.push(await intento(`203.0.113.${i}`))
    expect(respuestas.map((r) => r.statusCode)).toEqual([400, 400, 400, 429])
  })

  it('un intento durante la espera no la alarga', () => {
    const m = montarAcceso()
    for (let i = 0; i < 3; i++) m.access.emparejar('AAAAAAAA', '10.0.0.66')
    for (let i = 0; i < 200; i++)
      expect(m.access.emparejar('AAAAAAAA', '10.0.0.66')).toMatchObject({ code: 'wait' })

    m.advance(2000)
    expect(m.access.emparejar('AAAAAAAA', '10.0.0.66')).toMatchObject({
      code: 'invalid_code',
    })
  })

  it('un código ya usado cuenta como fallo', () => {
    const m = montarAcceso()
    const c = nuevoCodigo(m)
    expect(m.access.emparejar(c.code, '10.0.0.9')).toMatchObject({ ok: true })
    for (let i = 0; i < 2; i++)
      expect(m.access.emparejar(c.code, '10.0.0.66')).toMatchObject({
        code: 'invalid_code',
      })
    expect(m.access.emparejar(c.code, '10.0.0.66')).toMatchObject({
      code: 'invalid_code',
      esperaMs: 2000,
    })
    expect(m.access.emparejar(c.code, '10.0.0.66')).toMatchObject({ code: 'wait' })
  })

  it('el código se canjea una vez aunque lleguen dos canjes seguidos', () => {
    const m = montarAcceso()
    const c = nuevoCodigo(m)
    const before = Number(m.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)
    const r = [m.access.emparejar(c.code, '10.0.0.8'), m.access.emparejar(c.code, '10.0.0.9')]

    expect(r.map((x) => x.ok)).toEqual([true, false])
    expect(Number(m.db.prepare('SELECT count(*) AS n FROM devices').get()?.n)).toBe(before + 1)
  })

  it('el código sirve con espacios y minúsculas, pero nada que se le parezca', () => {
    const m = montarAcceso()
    const c = nuevoCodigo(m)
    for (const casi of [c.code.slice(0, 7), `${c.code}A`, c.code.replace(/./, '0'), ''])
      expect(m.access.emparejar(casi, `ip-${casi}`)).toMatchObject({ code: 'invalid_code' })
    expect(m.access.emparejar(`  ${c.code.toLowerCase()} `, '10.0.0.7')).toMatchObject({
      ok: true,
    })
  })

  it('el aviso al administrador sale a los 20 fallos del hub entero, venga de donde venga', () => {
    const m = montarAcceso()
    for (let i = 0; i < FALLOS_PARA_AVISO - 1; i++) m.access.emparejar('AAAAAAAA', `10.0.1.${i}`)
    expect(m.avisos).toEqual([])
    m.access.emparejar('AAAAAAAA', '10.0.2.1')
    expect(m.avisos).toHaveLength(1)
    expect(m.avisos[0]).toContain(String(FALLOS_PARA_AVISO))
  })

  it('y otro aviso cuando un solo equipo acumula fallos despacio, respetando la espera', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    for (let i = 0; i < FALLOS_DE_UN_EQUIPO_PARA_AVISO; i++) {
      m.advance(61_000) // nunca topa con la espera ni pasa 10 minutos sin errores
      m.access.startSession(connection, BAD_VALUES[i % 8] as string)
    }
    expect(
      m.avisos.filter((a) => a.includes(`${FALLOS_DE_UN_EQUIPO_PARA_AVISO} PIN`)),
    ).toHaveLength(1)
  })
})

describe('PIN en un dispositivo', () => {
  it('la espera crece 2, 4, 8… s y se respeta justo en el borde', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const esperas: (number | undefined)[] = []
    for (let i = 0; i < 6; i++) {
      const r = m.access.startSession(connection, BAD_VALUES[i] as string)
      esperas.push(r.ok ? undefined : r.esperaMs)
      if (!r.ok && r.esperaMs) {
        // Un milisegundo antes de cumplirse sigue esperando; al cumplirse, deja intentar.
        m.advance(r.esperaMs - 1)
        expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({
          code: 'wait',
        })
        m.advance(1)
      }
    }
    expect(esperas).toEqual([0, 0, 2000, 4000, 8000, 16_000])
  })

  it('la espera nunca pasa de 60 s, ni tras cientos de fallos', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    let last = 0
    for (let i = 0; i < 300; i++) {
      const r = m.access.startSession(connection, BAD_VALUES[i % BAD_VALUES.length] as string)
      if (!r.ok && r.esperaMs !== undefined) {
        last = r.esperaMs
        expect(r.esperaMs).toBeLessThanOrEqual(ESPERA_MAXIMA_MS)
        m.advance(r.esperaMs)
      }
    }
    expect(last).toBe(ESPERA_MAXIMA_MS)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('el PIN correcto durante la espera no entra, y tampoco cuenta ni la alarga', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    for (const pin of BAD_VALUES.slice(0, 3)) m.access.startSession(connection, pin)
    for (let i = 0; i < 50; i++)
      expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({
        code: 'wait',
      })
    m.advance(2000)
    expect(m.access.startSession(connection, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('el acierto de otro equipo no reinicia la espera de este', () => {
    const m = montarAcceso()
    const a = m.emparejar('waiter', 'A').connection
    const b = m.emparejar('waiter', 'B').connection
    for (const pin of BAD_VALUES.slice(0, 3)) m.access.startSession(a, pin)

    expect(m.access.startSession(b, m.people.waiter.pin)).toMatchObject({ ok: true })
    expect(m.access.startSession(a, m.people.waiter.pin)).toMatchObject({ code: 'wait' })
  })

  it('los fallos de un equipo no hacen esperar a otro, ni siquiera el de la misma IP', () => {
    const m = montarAcceso()
    const a = m.emparejar('waiter', 'A').connection
    const b = m.emparejar('waiter', 'B').connection
    for (const pin of BAD_VALUES.slice(0, 6)) m.access.startSession(a, pin)
    for (const pin of BAD_VALUES.slice(0, 2)) m.access.startSession(b, pin)

    expect(m.access.startSession(b, m.people.waiter.pin)).toMatchObject({ ok: true })
  })

  it('los fallos del PIN de supervisor y los del inicio de sesión comparten la misma espera', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const session = m.entrar(connection, 'waiter')
    const adivinar = (pin: string) =>
      m.access.autorizar(connection, {
        ...session,
        pin,
        action: 'void_sent_item',
        agregadoId: newId(),
        eventId: newId(),
        fingerprint: '0'.repeat(64),
      })
    adivinar(BAD_VALUES[0] as string)
    adivinar(BAD_VALUES[1] as string)
    // El tercer fallo llega por otra puerta y activa la espera para las dos.
    expect(m.access.startSession(connection, BAD_VALUES[2] as string)).toMatchObject({
      esperaMs: 2000,
    })
    expect(adivinar(m.people.manager.pin)).toMatchObject({ code: 'wait' })
  })

  it('un PIN de supervisor de alguien sin el permiso cuenta como fallo, igual que uno inexistente', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const session = m.entrar(connection, 'waiter')
    const data = () => ({
      ...session,
      // El cajero puede autorizar anulaciones (ADR-013), no cortesías.
      action: 'comp',
      agregadoId: newId(),
      eventId: newId(),
      fingerprint: '0'.repeat(64),
    })
    const r = [
      m.access.autorizar(connection, { ...data(), pin: m.people.cashier.pin }),
      m.access.autorizar(connection, { ...data(), pin: '0001' }),
      m.access.autorizar(connection, { ...data(), pin: m.people.waiter2.pin }),
    ]

    expect(r.map((x) => (x.ok ? 'ok' : x.code))).toEqual(['wrong_pin', 'wrong_pin', 'wrong_pin'])
    expect((r[2] as { esperaMs: number }).esperaMs).toBe(2000)
    expect(m.access.autorizar(connection, { ...data(), pin: m.people.manager.pin })).toMatchObject({
      code: 'wait',
    })
  })

  it('escribir el propio PIN entre intentos no es un salvoconducto para seguir adivinando', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const session = m.entrar(connection, 'waiter')
    const data = () => ({
      ...session,
      action: 'void_sent_item',
      agregadoId: newId(),
      eventId: newId(),
      fingerprint: '0'.repeat(64),
    })
    // Ana adivina el PIN de la gerente: dos intentos, su propio PIN, dos intentos, su propio PIN…
    // Si el propio PIN reinicia el conteo, nunca llega a la espera y puede probar los 10 000 PIN.
    let esperas = 0
    for (let ronda = 0; ronda < 100; ronda++) {
      for (const pin of [
        BAD_VALUES[ronda % 8] as string,
        BAD_VALUES[(ronda + 1) % 8] as string,
        m.people.waiter.pin,
      ]) {
        const r = m.access.autorizar(connection, { ...data(), pin })
        if (!r.ok && r.code === 'wait') esperas++
      }
    }
    expect(esperas).toBeGreaterThan(0)
  })

  it('iniciar sesión con el propio PIN válido entre intentos errados tampoco borra el conteo', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    let esperas = 0
    for (let ronda = 0; ronda < 100; ronda++) {
      for (const pin of [
        BAD_VALUES[ronda % 8] as string,
        BAD_VALUES[(ronda + 1) % 8] as string,
        m.people.waiter.pin,
      ]) {
        const r = m.access.startSession(connection, pin)
        if (!r.ok && r.code === 'wait') esperas++
      }
    }
    expect(esperas).toBeGreaterThan(0)
  })

  it('pasada la ventana de 10 minutos sin fallos se empieza de cero', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    m.access.startSession(connection, BAD_VALUES[0] as string)
    m.access.startSession(connection, BAD_VALUES[1] as string)
    m.advance(10 * 60_000)

    expect(m.access.startSession(connection, BAD_VALUES[2] as string)).toMatchObject({
      esperaMs: 0,
    })
  })

  it('formatos que no son un PIN fallan igual que un PIN equivocado y cuentan como fallo', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    const pin = m.people.waiter.pin
    const raros = [
      `${pin}\n`,
      ` ${pin}`,
      `${pin} `,
      `${pin}0`,
      pin.slice(1),
      '',
      '０１２３',
      '١٢٣٤',
      '1e3',
      '-123',
    ]

    const respuestas = raros.slice(0, 2).map((p) => m.access.startSession(connection, p))
    expect(respuestas).toEqual([
      { ok: false, code: 'wrong_pin', message: 'PIN incorrecto', esperaMs: 0 },
      { ok: false, code: 'wrong_pin', message: 'PIN incorrecto', esperaMs: 0 },
    ])
    m.access.startSession(connection, raros[2] as string)
    for (const p of raros.slice(3)) {
      m.advance(60_000)
      expect(m.access.startSession(connection, p), JSON.stringify(p)).toMatchObject({
        code: 'wrong_pin',
      })
    }
  })

  it('el mensaje de un PIN equivocado no revela si el PIN existe, ni de quién es', () => {
    const m = montarAcceso()
    const a = m.emparejar('waiter', 'A').connection
    const b = m.emparejar('waiter', 'B').connection
    const nonexistent = m.access.startSession(a, '0001')
    // Un usuario archivado también parece «no existe».
    m.access.archivarUsuario(m.people.waiter2.userId)
    const archived = m.access.startSession(b, m.people.waiter2.pin)

    expect(archived).toEqual(nonexistent)
  })

  it('la respuesta de error nunca incluye el PIN escrito', () => {
    const m = montarAcceso()
    const { connection } = m.emparejar()
    for (const pin of ['0001', '0002', '0003', '0004'])
      expect(JSON.stringify(m.access.startSession(connection, pin))).not.toContain(pin)
  })
})
