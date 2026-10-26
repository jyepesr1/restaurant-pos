import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import { type ControlAcceso, HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ABRIR, autorizarEvento, datosAnular, firmar, hubEnCarpeta, item } from './montaje-hub'
import { ARCHIVO_CLAVE } from './secretos'
import type { ServicioAcceso } from './servicio'

// El hub se cae o se reinicia con la misma carpeta de datos (base + clave de los PIN):
// docs/SYNC.md#fallas-y-qué-pasa y ADR-008.

type Levantado = ReturnType<ReturnType<typeof hubEnCarpeta>['spinUp']>

/** Lo que devuelve `asegurarAdministrador` cuando no hay nada nuevo que mostrar. */
const SIN_NOVEDAD = { pin: null, user: null, password: null, avisos: [] }

describe('reinicio y caídas del hub', () => {
  let carpeta = ''
  let hubs: ReturnType<typeof hubEnCarpeta>
  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-reinicio-'))
    hubs = hubEnCarpeta(join(carpeta, 'data'))
  })
  afterEach(() => {
    hubs.apagar()
    rmSync(carpeta, { recursive: true, force: true })
  })

  /** Primer arranque: administrador, un dispositivo de caja emparejado y su sesión de admin. */
  function primerArranque() {
    const h = hubs.spinUp()
    const adminPin = h.admin.pin as string
    let firstOne: string | null = null
    const fresh = (type: 'waiter' | 'register', name: string) => {
      // El primer equipo se aprueba sin equipo; los siguientes, desde ese.
      const aprobador = firstOne ? h.access.authenticate(firstOne) : null
      const c = h.access.crearEmparejamiento({ pin: adminPin, name, type }, aprobador)
      if (!c.ok) throw new Error(c.message)
      const r = h.access.emparejar(c.code, '10.0.0.9')
      if (!r.ok) throw new Error(r.message)
      firstOne ??= r.token
      return {
        token: r.token,
        connection: h.access.authenticate(r.token) as NonNullable<
          ReturnType<ServicioAcceso['authenticate']>
        >,
      }
    }
    // El administrador entra con usuario y contraseña (ADR-013); su PIN solo autoriza.
    const credenciales = {
      user: h.admin.user as string,
      password: h.admin.password as string,
    }
    return { h, adminPin, fresh, credenciales }
  }

  const sesionAdmin = (
    h: Levantado,
    connection: Parameters<ServicioAcceso['startSession']>[0],
    credenciales: { user: string; password: string },
  ) => {
    const r = h.access.entrar(credenciales, connection, '10.0.0.9')
    if (!r.ok) throw new Error(r.message)
    return r
  }

  const session = (
    h: Levantado,
    connection: Parameters<ServicioAcceso['startSession']>[0],
    pin: string,
  ) => {
    const r = h.access.startSession(connection, pin)
    if (!r.ok) throw new Error(r.message)
    return r
  }

  function event(
    _h: Levantado,
    connection: { dispositivoId: string },
    s: { sesionId: string; secret: string; user: { id: string } },
    type: string,
    data: unknown,
    extras: object = {},
  ) {
    return firmar(s, {
      id: newId(),
      type,
      schema_version: 1,
      aggregate_type: 'order',
      aggregate_id: newId(),
      related: [],
      data,
      session_id: s.sesionId,
      user_id: s.user.id,
      device_id: connection.dispositivoId,
      authorization_id: null,
      reason: null,
      device_time: hubs.clock(),
      hub_estimated_time: hubs.clock(),
      base_sequence: 0,
      ...extras,
    } as never)
  }

  describe('con la misma carpeta', () => {
    it('la clave y los PIN siguen sirviendo, y no se muestra un administrador nuevo', () => {
      const { h, adminPin, fresh } = primerArranque()
      const waiter = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      expect(h.claveNueva).toBe(true)
      hubs.apagar()

      const after = hubs.spinUp()
      expect(after.claveNueva).toBe(false)
      expect(after.admin).toEqual(SIN_NOVEDAD)
      expect(after.restauranteId).toBe(h.restauranteId)
      // El token del dispositivo, el PIN del mesero y el del administrador valen igual.
      const connection = after.access.authenticate(phone.token)
      expect(connection).toMatchObject({
        dispositivoId: phone.connection.dispositivoId,
        revocadoEn: null,
      })
      expect(session(after, connection as never, waiter.pin).user.name).toBe('Ana')
      const c = after.access.crearEmparejamiento(
        { pin: adminPin, name: 'Otro', type: 'kds' },
        connection,
      )
      expect(c).toMatchObject({ ok: true })
    })

    it('una sesión abierta antes del reinicio sigue valiendo, con su secreto', () => {
      const { h, fresh } = primerArranque()
      const waiter = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const { connection, token } = fresh('waiter', 'Celular')
      const s = session(h, connection, waiter.pin)
      const opened = event(h, connection, s, 'OrderOpened', ABRIR)
      hubs.apagar()
      hubs.advance(30_000)

      const after = hubs.spinUp()
      const newOne = after.access.authenticate(token) as NonNullable<typeof connection>
      const r = after.hub.recibirLote(newOne, [opened])
      expect(r.resultados[0]?.status).toBe('confirmed')
      expect(after.access.cerrarSesion(newOne, s)).toEqual({ ok: true })
      expect(after.access.cerrarSesion(newOne, { ...s, secret: 'other' })).toMatchObject({
        ok: false,
      })
    })

    it('un dispositivo revocado sigue revocado tras el reinicio', () => {
      const { h, adminPin, fresh, credenciales } = primerArranque()
      const register = fresh('register', 'Caja')
      const phone = fresh('waiter', 'Celular')
      const admin = sesionAdmin(h, register.connection, credenciales)
      const r = h.access.revocarDispositivo(register.connection, {
        ...admin,
        dispositivoId: phone.connection.dispositivoId,
      })
      if (!r.ok) throw new Error(r.message)
      hubs.apagar()

      const after = hubs.spinUp()
      expect(after.access.authenticate(phone.token)?.revocadoEn).toBe(r.revocadoEn)
      expect(
        after.access.startSession(after.access.authenticate(phone.token) as never, adminPin),
      ).toMatchObject({ code: 'revoked_device' })
    })

    it('un usuario archivado sigue archivado: su PIN no entra tras el reinicio', () => {
      const { h, fresh } = primerArranque()
      const luis = h.access.crearUsuario({ name: 'Luis', rolId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      h.access.archivarUsuario(luis.userId)
      hubs.apagar()

      const after = hubs.spinUp()
      expect(
        after.access.startSession(after.access.authenticate(phone.token) as never, luis.pin),
      ).toMatchObject({ code: 'wrong_pin' })
    })

    it('los códigos de emparejamiento pendientes se pierden, y las esperas por fallos empiezan de cero', () => {
      const { h, adminPin, fresh } = primerArranque()
      const ana = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      const c = h.access.crearEmparejamiento(
        { pin: adminPin, name: 'X', type: 'kds' },
        phone.connection,
      )
      if (!c.ok) throw new Error(c.message)
      for (const pin of ['0001', '0002', '0003']) h.access.startSession(phone.connection, pin)
      expect(h.access.startSession(phone.connection, ana.pin)).toMatchObject({ code: 'wait' })
      hubs.apagar()

      const after = hubs.spinUp()
      expect(after.access.emparejar(c.code, '10.0.0.1')).toMatchObject({
        code: 'invalid_code',
      })
      expect(after.access.startSession(phone.connection, ana.pin)).toMatchObject({ ok: true })
    })

    it('reiniciar varias veces no duplica restaurante, roles ni administrador', () => {
      primerArranque()
      for (let i = 0; i < 4; i++) {
        hubs.apagar()
        const h = hubs.spinUp()
        expect(h.admin).toEqual(SIN_NOVEDAD)
      }
      const h = hubs.spinUp()
      const check = (t: string) => Number(h.db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)
      expect([
        check('restaurants'),
        check('roles'),
        check('users'),
        check('user_credentials'),
      ]).toEqual([1, 4, 1, 1])
    })
  })

  describe('con la clave borrada', () => {
    it('ningún PIN guardado sirve; el administrador recibe uno nuevo y avisa; los equipos siguen emparejados', () => {
      const { h, adminPin, fresh, credenciales } = primerArranque()
      const ana = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      const abierta = session(h, phone.connection, ana.pin)
      hubs.apagar()
      rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))

      const after = hubs.spinUp()
      expect(after.claveNueva).toBe(true)
      expect(existsSync(join(carpeta, 'data', ARCHIVO_CLAVE))).toBe(true)
      expect(after.admin.pin).toMatch(/^\d{4}$/)
      expect(after.admin.avisos.join(' ')).toMatch(/clave de los PIN/)
      const connection = after.access.authenticate(phone.token) as NonNullable<
        typeof phone.connection
      >
      expect(connection.dispositivoId).toBe(phone.connection.dispositivoId)

      // Los PIN de antes no entran; el nuevo del administrador sí.
      hubs.advance(60_000)
      if (after.admin.pin !== adminPin)
        expect(after.access.startSession(connection, adminPin)).toMatchObject({
          code: 'wrong_pin',
        })
      hubs.advance(60_000)
      if (after.admin.pin !== ana.pin)
        expect(after.access.startSession(connection, ana.pin)).toMatchObject({
          code: 'wrong_pin',
        })
      // La contraseña no depende de la clave de los PIN: el administrador sigue entrando, y su PIN
      // nuevo autoriza.
      hubs.advance(60_000)
      expect(after.admin.password).toBeNull()
      expect(after.access.entrar(credenciales, connection, '10.0.0.9')).toMatchObject({
        ok: true,
        user: { name: 'Administrador' },
      })
      // La sesión que Ana tenía abierta es del dispositivo, no de la clave: se cerró al entrar el admin.
      expect(after.access.cerrarSesion(connection, abierta)).toMatchObject({ ok: false })
    })

    it('lo que un celular firmó con la sesión de antes de perder la clave va a cuarentena: no entra ni se pierde', () => {
      const { h, fresh } = primerArranque()
      const ana = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const phone = fresh('waiter', 'Celular')
      const s = session(h, phone.connection, ana.pin)
      const pending = event(h, phone.connection, s, 'OrderOpened', ABRIR)
      hubs.apagar()
      rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))
      hubs.advance(60_000)

      // El secreto de cada sesión sale de la clave: con otra clave, la firma ya no cuadra. Como la
      // sesión es de antes de la clave nueva, el gerente decide.
      const after = hubs.spinUp()
      const connection = after.access.authenticate(phone.token) as never
      const r = after.hub.recibirLote(connection, [pending])
      expect(r.resultados[0]?.status).toBe('quarantine')
      expect(Number(after.db.prepare('SELECT count(*) AS n FROM events').get()?.n)).toBe(0)
    })

    it('con el PIN nuevo del administrador se regenera el de cada persona, y el viejo deja de servir', () => {
      const { h, fresh } = primerArranque()
      const ana = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const register = fresh('register', 'Caja')
      hubs.apagar()
      rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))

      const after = hubs.spinUp()
      const nuevoPin = after.access.regenerarPin(ana.userId)
      const c = after.access.crearEmparejamiento(
        { pin: after.admin.pin as string, name: 'Cel', type: 'waiter' },
        after.access.authenticate(register.token),
      )
      if (!c.ok) throw new Error(c.message)
      const e = after.access.emparejar(c.code, 'ip')
      if (!e.ok) throw new Error(e.message)
      const connection = after.access.authenticate(e.token) as never
      expect(after.access.startSession(connection, nuevoPin)).toMatchObject({
        ok: true,
        user: { name: 'Ana' },
      })
    })

    it('la clave nueva queda en la carpeta: al reiniciar otra vez los PIN regenerados sirven', () => {
      const { fresh } = primerArranque()
      const register = fresh('register', 'Caja')
      hubs.apagar()
      rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))
      const regenerado = hubs.spinUp()
      const pin = regenerado.admin.pin as string
      hubs.apagar()

      const another = hubs.spinUp()
      expect(another.claveNueva).toBe(false)
      expect(another.admin).toEqual(SIN_NOVEDAD)
      expect(
        another.access.crearEmparejamiento(
          { pin, name: 'X', type: 'register' },
          another.access.authenticate(register.token),
        ),
      ).toMatchObject({
        ok: true,
      })
    })

    it('un hub nuevo (carpeta vacía) crea su administrador sin el aviso de clave perdida', () => {
      const h = hubs.spinUp()
      expect(h.claveNueva).toBe(true)
      expect(h.admin.pin).toMatch(/^\d{4}$/)
      expect(h.admin.avisos).toEqual([])
    })

    it('si la clave se borra y la base también, es un hub nuevo y arranca limpio', () => {
      primerArranque()
      hubs.apagar()
      rmSync(join(carpeta, 'data'), { recursive: true })

      const h = hubs.spinUp()
      expect(h.claveNueva).toBe(true)
      expect(h.admin.avisos).toEqual([])
      expect(Number(h.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBe(1)
    })
  })

  describe('caída entre autorizar y recibir el evento', () => {
    /** El mesero tiene un ítem enviado y la gerente autoriza anularlo. */
    function conAutorizacion() {
      const { h, fresh } = primerArranque()
      // De fábrica, el cajero puede autorizar anulaciones (ADR-013).
      const manager = h.access.crearUsuario({ name: 'Gloria', rolId: h.roles.cashier })
      const ana = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
      const { connection, token } = fresh('waiter', 'Celular')
      const s = session(h, connection, ana.pin)
      const order = newId()
      const it = item()
      const en = { aggregate_id: order }
      const batch = [
        event(h, connection, s, 'OrderOpened', ABRIR, en),
        event(h, connection, s, 'ItemAdded', it, { ...en, base_sequence: 1 }),
        event(
          h,
          connection,
          s,
          'ItemsSent',
          { tickets: [{ ticket_id: newId(), station_id: newId(), item_ids: [it.item_id] }] },
          { ...en, base_sequence: 2 },
        ),
      ]
      expect(h.hub.recibirLote(connection, batch).resultados.map((x) => x.status)).toEqual([
        'confirmed',
        'confirmed',
        'confirmed',
      ])
      const sinComprobante = event(h, connection, s, 'ItemVoided', datosAnular(it.item_id), {
        aggregate_id: order,
        reason: 'El cliente cambió de idea',
        base_sequence: 3,
      })
      const { comprobante, event: voidItem } = autorizarEvento(
        h,
        connection,
        s,
        manager.pin,
        sinComprobante as never,
      )
      return {
        h,
        token,
        voidItem,
        manager,
        order,
        itemId: it.item_id,
        autorizacionId: comprobante.autorizacionId,
      }
    }

    it('el hub se apaga tras emitir el comprobante: al volver, el evento llega y se acepta', () => {
      const c = conAutorizacion()
      hubs.apagar()
      hubs.advance(90_000) // se tarda en volver, pero dentro de la vigencia del comprobante

      const after = hubs.spinUp()
      expect(after.db.prepare('SELECT supervisor_id, used_at FROM authorizations').get()).toEqual({
        supervisor_id: c.manager.userId,
        used_at: null,
      })
      const connection = after.access.authenticate(c.token) as never
      const r = after.hub.recibirLote(connection, [c.voidItem])
      expect(r.resultados[0]).toMatchObject({
        status: 'confirmed',
        aceptacion: { authorized_by_id: c.manager.userId },
      })
      expect(after.db.prepare('SELECT used_at FROM authorizations').get()?.used_at).toBe(
        hubs.clock(),
      )
    })

    it('si vuelve mucho después, el evento sigue valiendo por la hora en que se creó, no por cuándo llegó', () => {
      const c = conAutorizacion()
      hubs.apagar()
      hubs.advance(3 * 60 * 60_000)

      const after = hubs.spinUp()
      const connection = after.access.authenticate(c.token) as never
      expect(after.hub.recibirLote(connection, [c.voidItem]).resultados[0]?.status).toBe(
        'confirmed',
      )
    })

    it('el comprobante se gasta una sola vez aunque el hub se reinicie y el celular reenvíe', () => {
      const c = conAutorizacion()
      const connection = c.h.access.authenticate(c.token) as never
      const first = c.h.hub.recibirLote(connection, [c.voidItem])
      hubs.apagar()

      const after = hubs.spinUp()
      const conexion2 = after.access.authenticate(c.token) as never
      const segunda = after.hub.recibirLote(conexion2, [c.voidItem])

      expect(segunda.resultados).toEqual(first.resultados)
      expect(
        Number(
          after.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ItemVoided'").get()?.n,
        ),
      ).toBe(1)
    })

    it('el hub se cae al guardar el evento autorizado: no queda a medias y tras reiniciar el reenvío entra', () => {
      const c = conAutorizacion()
      // Un almacén que "muere" al guardar el evento, como un corte de luz en plena escritura:
      // desde ahí ni siquiera puede anotar un rechazo, y el proceso del hub termina.
      class AlmacenQueSeApaga extends AlmacenSqlite {
        caido = false
        override saveEvent(..._a: Parameters<AlmacenSqlite['saveEvent']>): void {
          this.caido = true
          throw new Error('se fue la luz')
        }
        override transaccion<T>(trabajo: () => T): T {
          if (this.caido) throw new Error('el hub está apagado')
          return super.transaccion(trabajo)
        }
      }
      const configDe = (h: Levantado) => ({
        restauranteId: h.restauranteId,
        timeZone: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: 'hub-1',
        clock: hubs.clock,
        access: h.access,
      })
      const check = (h: Levantado) =>
        Number(h.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ItemVoided'").get()?.n)
      const connection = c.h.access.authenticate(c.token) as never
      const muriendo = new HubSync(new AlmacenQueSeApaga(c.h.db, c.h.restauranteId), configDe(c.h))

      expect(() => muriendo.recibirLote(connection, [c.voidItem])).toThrow(/apagado/)
      expect(check(c.h)).toBe(0)
      expect(c.h.db.prepare('SELECT used_at FROM authorizations').get()?.used_at).toBeNull()

      hubs.apagar()
      hubs.advance(20_000)
      const after = hubs.spinUp()
      const r = after.hub.recibirLote(after.access.authenticate(c.token) as never, [c.voidItem])
      expect(r.resultados[0]).toMatchObject({
        status: 'confirmed',
        aceptacion: { authorized_by_id: c.manager.userId },
      })
      expect(check(after)).toBe(1)
    })

    it('si falla justo al usar el comprobante, el evento y el comprobante quedan igual que antes', () => {
      const c = conAutorizacion()
      let failing = true
      const cae = (a: ServicioAcceso): ControlAcceso => ({
        verify: (connection, ev, order) => a.verify(connection, ev, order),
        registrarUso: (ev, v) => {
          // El comprobante se gasta antes de que la transacción termine...
          a.registrarUso(ev, v)
          if (failing) throw new Error('se fue la luz')
        },
      })
      const hub = new HubSync(new AlmacenSqlite(c.h.db, c.h.restauranteId), {
        restauranteId: c.h.restauranteId,
        timeZone: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: 'hub-1',
        clock: hubs.clock,
        access: cae(c.h.access),
      })
      const connection = c.h.access.authenticate(c.token) as never
      const r = hub.recibirLote(connection, [c.voidItem])

      // ...pero la transacción se deshace: ni evento ni comprobante gastado.
      expect(r.resultados[0]).toMatchObject({ status: 'rejected', reason: 'internal_error' })
      expect(
        Number(
          c.h.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ItemVoided'").get()?.n,
        ),
      ).toBe(0)
      expect(c.h.db.prepare('SELECT used_at FROM authorizations').get()?.used_at).toBeNull()
      failing = false
    })
  })
})
