import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nuevoId } from '@pos/core'
import { type ControlAcceso, HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ABRIR, autorizarEvento, datosAnular, firmar, hubEnCarpeta, item } from './montaje-hub'
import { ARCHIVO_CLAVE } from './secretos'
import type { ServicioAcceso } from './servicio'

// El hub se cae o se reinicia con la misma carpeta de datos (base + clave de los PIN):
// docs/SYNC.md#fallas-y-qué-pasa y ADR-008.

type Levantado = ReturnType<ReturnType<typeof hubEnCarpeta>['levantar']>

describe('reinicio y caídas del hub', () => {
  let carpeta = ''
  let hubs: ReturnType<typeof hubEnCarpeta>
  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-reinicio-'))
    hubs = hubEnCarpeta(join(carpeta, 'datos'))
  })
  afterEach(() => {
    hubs.apagar()
    rmSync(carpeta, { recursive: true, force: true })
  })

  /** Primer arranque: administrador, un dispositivo de caja emparejado y su sesión de admin. */
  function primerArranque() {
    const h = hubs.levantar()
    const adminPin = h.admin.pin as string
    let primero: string | null = null
    const nuevo = (tipo: 'mesero' | 'caja', nombre: string) => {
      // El primer equipo se aprueba sin equipo; los siguientes, desde ese.
      const aprobador = primero ? h.acceso.autenticar(primero) : null
      const c = h.acceso.crearEmparejamiento({ pin: adminPin, nombre, tipo }, aprobador)
      if (!c.ok) throw new Error(c.mensaje)
      const r = h.acceso.emparejar(c.codigo, '10.0.0.9')
      if (!r.ok) throw new Error(r.mensaje)
      primero ??= r.token
      return {
        token: r.token,
        conexion: h.acceso.autenticar(r.token) as NonNullable<
          ReturnType<ServicioAcceso['autenticar']>
        >,
      }
    }
    return { h, adminPin, nuevo }
  }

  const sesion = (
    h: Levantado,
    conexion: Parameters<ServicioAcceso['iniciarSesion']>[0],
    pin: string,
  ) => {
    const r = h.acceso.iniciarSesion(conexion, pin)
    if (!r.ok) throw new Error(r.mensaje)
    return r
  }

  function evento(
    _h: Levantado,
    conexion: { dispositivoId: string },
    s: { sesionId: string; secreto: string; usuario: { id: string } },
    tipo: string,
    datos: unknown,
    extras: object = {},
  ) {
    return firmar(s, {
      id: nuevoId(),
      tipo,
      version_esquema: 1,
      agregado_tipo: 'pedido',
      agregado_id: nuevoId(),
      relacionados: [],
      datos,
      sesion_id: s.sesionId,
      usuario_id: s.usuario.id,
      dispositivo_id: conexion.dispositivoId,
      autorizacion_id: null,
      motivo: null,
      hora_dispositivo: hubs.reloj(),
      hora_estimada_hub: hubs.reloj(),
      secuencia_base: 0,
      ...extras,
    } as never)
  }

  describe('con la misma carpeta', () => {
    it('la clave y los PIN siguen sirviendo, y no se muestra un administrador nuevo', () => {
      const { h, adminPin, nuevo } = primerArranque()
      const mesero = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
      const celular = nuevo('mesero', 'Celular')
      expect(h.claveNueva).toBe(true)
      hubs.apagar()

      const despues = hubs.levantar()
      expect(despues.claveNueva).toBe(false)
      expect(despues.admin).toEqual({ pin: null, avisos: [] })
      expect(despues.restauranteId).toBe(h.restauranteId)
      // El token del dispositivo, el PIN del mesero y el del administrador valen igual.
      const conexion = despues.acceso.autenticar(celular.token)
      expect(conexion).toMatchObject({
        dispositivoId: celular.conexion.dispositivoId,
        revocadoEn: null,
      })
      expect(sesion(despues, conexion as never, mesero.pin).usuario.nombre).toBe('Ana')
      const c = despues.acceso.crearEmparejamiento(
        { pin: adminPin, nombre: 'Otro', tipo: 'kds' },
        conexion,
      )
      expect(c).toMatchObject({ ok: true })
    })

    it('una sesión abierta antes del reinicio sigue valiendo, con su secreto', () => {
      const { h, nuevo } = primerArranque()
      const mesero = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
      const { conexion, token } = nuevo('mesero', 'Celular')
      const s = sesion(h, conexion, mesero.pin)
      const abierto = evento(h, conexion, s, 'PedidoAbierto', ABRIR)
      hubs.apagar()
      hubs.avanzar(30_000)

      const despues = hubs.levantar()
      const nueva = despues.acceso.autenticar(token) as NonNullable<typeof conexion>
      const r = despues.hub.recibirLote(nueva, [abierto])
      expect(r.resultados[0]?.estado).toBe('confirmado')
      expect(despues.acceso.cerrarSesion(nueva, s)).toEqual({ ok: true })
      expect(despues.acceso.cerrarSesion(nueva, { ...s, secreto: 'otro' })).toMatchObject({
        ok: false,
      })
    })

    it('un dispositivo revocado sigue revocado tras el reinicio', () => {
      const { h, adminPin, nuevo } = primerArranque()
      const caja = nuevo('caja', 'Caja')
      const celular = nuevo('mesero', 'Celular')
      const admin = sesion(h, caja.conexion, adminPin)
      const r = h.acceso.revocarDispositivo(caja.conexion, {
        ...admin,
        dispositivoId: celular.conexion.dispositivoId,
      })
      if (!r.ok) throw new Error(r.mensaje)
      hubs.apagar()

      const despues = hubs.levantar()
      expect(despues.acceso.autenticar(celular.token)?.revocadoEn).toBe(r.revocadoEn)
      expect(
        despues.acceso.iniciarSesion(despues.acceso.autenticar(celular.token) as never, adminPin),
      ).toMatchObject({ codigo: 'dispositivo_revocado' })
    })

    it('un usuario archivado sigue archivado: su PIN no entra tras el reinicio', () => {
      const { h, nuevo } = primerArranque()
      const luis = h.acceso.crearUsuario({ nombre: 'Luis', rolId: h.roles.mesero })
      const celular = nuevo('mesero', 'Celular')
      h.acceso.archivarUsuario(luis.usuarioId)
      hubs.apagar()

      const despues = hubs.levantar()
      expect(
        despues.acceso.iniciarSesion(despues.acceso.autenticar(celular.token) as never, luis.pin),
      ).toMatchObject({ codigo: 'pin_incorrecto' })
    })

    it('los códigos de emparejamiento pendientes se pierden, y las esperas por fallos empiezan de cero', () => {
      const { h, adminPin, nuevo } = primerArranque()
      const celular = nuevo('mesero', 'Celular')
      const c = h.acceso.crearEmparejamiento(
        { pin: adminPin, nombre: 'X', tipo: 'kds' },
        celular.conexion,
      )
      if (!c.ok) throw new Error(c.mensaje)
      for (const pin of ['0001', '0002', '0003']) h.acceso.iniciarSesion(celular.conexion, pin)
      expect(h.acceso.iniciarSesion(celular.conexion, adminPin)).toMatchObject({ codigo: 'espera' })
      hubs.apagar()

      const despues = hubs.levantar()
      expect(despues.acceso.emparejar(c.codigo, '10.0.0.1')).toMatchObject({
        codigo: 'codigo_invalido',
      })
      expect(despues.acceso.iniciarSesion(celular.conexion, adminPin)).toMatchObject({ ok: true })
    })

    it('reiniciar varias veces no duplica restaurante, roles ni administrador', () => {
      primerArranque()
      for (let i = 0; i < 4; i++) {
        hubs.apagar()
        const h = hubs.levantar()
        expect(h.admin).toEqual({ pin: null, avisos: [] })
      }
      const h = hubs.levantar()
      const cuenta = (t: string) => Number(h.db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n)
      expect([
        cuenta('restaurante'),
        cuenta('rol'),
        cuenta('usuario'),
        cuenta('usuario_credencial'),
      ]).toEqual([1, 6, 1, 1])
    })
  })

  describe('con la clave borrada', () => {
    it('ningún PIN guardado sirve; el administrador recibe uno nuevo y avisa; los equipos siguen emparejados', () => {
      const { h, adminPin, nuevo } = primerArranque()
      const ana = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
      const celular = nuevo('mesero', 'Celular')
      const abierta = sesion(h, celular.conexion, ana.pin)
      hubs.apagar()
      rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))

      const despues = hubs.levantar()
      expect(despues.claveNueva).toBe(true)
      expect(existsSync(join(carpeta, 'datos', ARCHIVO_CLAVE))).toBe(true)
      expect(despues.admin.pin).toMatch(/^\d{4}$/)
      expect(despues.admin.avisos.join(' ')).toMatch(/clave de los PIN/)
      const conexion = despues.acceso.autenticar(celular.token) as NonNullable<
        typeof celular.conexion
      >
      expect(conexion.dispositivoId).toBe(celular.conexion.dispositivoId)

      // Los PIN de antes no entran; el nuevo del administrador sí.
      hubs.avanzar(60_000)
      if (despues.admin.pin !== adminPin)
        expect(despues.acceso.iniciarSesion(conexion, adminPin)).toMatchObject({
          codigo: 'pin_incorrecto',
        })
      hubs.avanzar(60_000)
      if (despues.admin.pin !== ana.pin)
        expect(despues.acceso.iniciarSesion(conexion, ana.pin)).toMatchObject({
          codigo: 'pin_incorrecto',
        })
      hubs.avanzar(60_000)
      expect(despues.acceso.iniciarSesion(conexion, despues.admin.pin as string)).toMatchObject({
        ok: true,
        usuario: { nombre: 'Administrador' },
      })
      // La sesión que Ana tenía abierta es del dispositivo, no de la clave: se cerró al entrar el admin.
      expect(despues.acceso.cerrarSesion(conexion, abierta)).toMatchObject({ ok: false })
    })

    it('lo que un celular firmó con la sesión de antes de perder la clave va a cuarentena: no entra ni se pierde', () => {
      const { h, nuevo } = primerArranque()
      const ana = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
      const celular = nuevo('mesero', 'Celular')
      const s = sesion(h, celular.conexion, ana.pin)
      const pendiente = evento(h, celular.conexion, s, 'PedidoAbierto', ABRIR)
      hubs.apagar()
      rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))
      hubs.avanzar(60_000)

      // El secreto de cada sesión sale de la clave: con otra clave, la firma ya no cuadra. Como la
      // sesión es de antes de la clave nueva, el gerente decide.
      const despues = hubs.levantar()
      const conexion = despues.acceso.autenticar(celular.token) as never
      const r = despues.hub.recibirLote(conexion, [pendiente])
      expect(r.resultados[0]?.estado).toBe('cuarentena')
      expect(Number(despues.db.prepare('SELECT count(*) AS n FROM evento').get()?.n)).toBe(0)
    })

    it('con el PIN nuevo del administrador se regenera el de cada persona, y el viejo deja de servir', () => {
      const { h, nuevo } = primerArranque()
      const ana = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
      const caja = nuevo('caja', 'Caja')
      hubs.apagar()
      rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))

      const despues = hubs.levantar()
      const nuevoPin = despues.acceso.regenerarPin(ana.usuarioId)
      const c = despues.acceso.crearEmparejamiento(
        { pin: despues.admin.pin as string, nombre: 'Cel', tipo: 'mesero' },
        despues.acceso.autenticar(caja.token),
      )
      if (!c.ok) throw new Error(c.mensaje)
      const e = despues.acceso.emparejar(c.codigo, 'ip')
      if (!e.ok) throw new Error(e.mensaje)
      const conexion = despues.acceso.autenticar(e.token) as never
      expect(despues.acceso.iniciarSesion(conexion, nuevoPin)).toMatchObject({
        ok: true,
        usuario: { nombre: 'Ana' },
      })
    })

    it('la clave nueva queda en la carpeta: al reiniciar otra vez los PIN regenerados sirven', () => {
      const { nuevo } = primerArranque()
      const caja = nuevo('caja', 'Caja')
      hubs.apagar()
      rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))
      const regenerado = hubs.levantar()
      const pin = regenerado.admin.pin as string
      hubs.apagar()

      const otra = hubs.levantar()
      expect(otra.claveNueva).toBe(false)
      expect(otra.admin).toEqual({ pin: null, avisos: [] })
      expect(
        otra.acceso.crearEmparejamiento(
          { pin, nombre: 'X', tipo: 'caja' },
          otra.acceso.autenticar(caja.token),
        ),
      ).toMatchObject({
        ok: true,
      })
    })

    it('un hub nuevo (carpeta vacía) crea su administrador sin el aviso de clave perdida', () => {
      const h = hubs.levantar()
      expect(h.claveNueva).toBe(true)
      expect(h.admin.pin).toMatch(/^\d{4}$/)
      expect(h.admin.avisos).toEqual([])
    })

    it('si la clave se borra y la base también, es un hub nuevo y arranca limpio', () => {
      primerArranque()
      hubs.apagar()
      rmSync(join(carpeta, 'datos'), { recursive: true })

      const h = hubs.levantar()
      expect(h.claveNueva).toBe(true)
      expect(h.admin.avisos).toEqual([])
      expect(Number(h.db.prepare('SELECT count(*) AS n FROM usuario').get()?.n)).toBe(1)
    })
  })

  describe('caída entre autorizar y recibir el evento', () => {
    /** El mesero tiene un ítem enviado y la gerente autoriza anularlo. */
    function conAutorizacion() {
      const { h, nuevo } = primerArranque()
      const gerente = h.acceso.crearUsuario({ nombre: 'Gloria', rolId: h.roles.gerente })
      const ana = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
      const { conexion, token } = nuevo('mesero', 'Celular')
      const s = sesion(h, conexion, ana.pin)
      const pedido = nuevoId()
      const it = item()
      const en = { agregado_id: pedido }
      const lote = [
        evento(h, conexion, s, 'PedidoAbierto', ABRIR, en),
        evento(h, conexion, s, 'ItemAgregado', it, { ...en, secuencia_base: 1 }),
        evento(
          h,
          conexion,
          s,
          'ItemsEnviados',
          { comandas: [{ comanda_id: nuevoId(), estacion_id: nuevoId(), item_ids: [it.item_id] }] },
          { ...en, secuencia_base: 2 },
        ),
      ]
      expect(h.hub.recibirLote(conexion, lote).resultados.map((x) => x.estado)).toEqual([
        'confirmado',
        'confirmado',
        'confirmado',
      ])
      const sinComprobante = evento(h, conexion, s, 'ItemAnulado', datosAnular(it.item_id), {
        agregado_id: pedido,
        motivo: 'El cliente cambió de idea',
        secuencia_base: 3,
      })
      const { comprobante, evento: anular } = autorizarEvento(
        h,
        conexion,
        s,
        gerente.pin,
        sinComprobante as never,
      )
      return {
        h,
        token,
        anular,
        gerente,
        pedido,
        itemId: it.item_id,
        autorizacionId: comprobante.autorizacionId,
      }
    }

    it('el hub se apaga tras emitir el comprobante: al volver, el evento llega y se acepta', () => {
      const c = conAutorizacion()
      hubs.apagar()
      hubs.avanzar(90_000) // se tarda en volver, pero dentro de la vigencia del comprobante

      const despues = hubs.levantar()
      expect(despues.db.prepare('SELECT supervisor_id, usada_en FROM autorizacion').get()).toEqual({
        supervisor_id: c.gerente.usuarioId,
        usada_en: null,
      })
      const conexion = despues.acceso.autenticar(c.token) as never
      const r = despues.hub.recibirLote(conexion, [c.anular])
      expect(r.resultados[0]).toMatchObject({
        estado: 'confirmado',
        aceptacion: { autorizado_por_id: c.gerente.usuarioId },
      })
      expect(despues.db.prepare('SELECT usada_en FROM autorizacion').get()?.usada_en).toBe(
        hubs.reloj(),
      )
    })

    it('si vuelve mucho después, el evento sigue valiendo por la hora en que se creó, no por cuándo llegó', () => {
      const c = conAutorizacion()
      hubs.apagar()
      hubs.avanzar(3 * 60 * 60_000)

      const despues = hubs.levantar()
      const conexion = despues.acceso.autenticar(c.token) as never
      expect(despues.hub.recibirLote(conexion, [c.anular]).resultados[0]?.estado).toBe('confirmado')
    })

    it('el comprobante se gasta una sola vez aunque el hub se reinicie y el celular reenvíe', () => {
      const c = conAutorizacion()
      const conexion = c.h.acceso.autenticar(c.token) as never
      const primera = c.h.hub.recibirLote(conexion, [c.anular])
      hubs.apagar()

      const despues = hubs.levantar()
      const conexion2 = despues.acceso.autenticar(c.token) as never
      const segunda = despues.hub.recibirLote(conexion2, [c.anular])

      expect(segunda.resultados).toEqual(primera.resultados)
      expect(
        Number(
          despues.db.prepare("SELECT count(*) AS n FROM evento WHERE tipo = 'ItemAnulado'").get()
            ?.n,
        ),
      ).toBe(1)
    })

    it('el hub se cae al guardar el evento autorizado: no queda a medias y tras reiniciar el reenvío entra', () => {
      const c = conAutorizacion()
      // Un almacén que "muere" al guardar el evento, como un corte de luz en plena escritura:
      // desde ahí ni siquiera puede anotar un rechazo, y el proceso del hub termina.
      class AlmacenQueSeApaga extends AlmacenSqlite {
        caido = false
        override guardarEvento(..._a: Parameters<AlmacenSqlite['guardarEvento']>): void {
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
        zonaHoraria: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: 'hub-1',
        reloj: hubs.reloj,
        acceso: h.acceso,
      })
      const cuenta = (h: Levantado) =>
        Number(h.db.prepare("SELECT count(*) AS n FROM evento WHERE tipo = 'ItemAnulado'").get()?.n)
      const conexion = c.h.acceso.autenticar(c.token) as never
      const muriendo = new HubSync(new AlmacenQueSeApaga(c.h.db, c.h.restauranteId), configDe(c.h))

      expect(() => muriendo.recibirLote(conexion, [c.anular])).toThrow(/apagado/)
      expect(cuenta(c.h)).toBe(0)
      expect(c.h.db.prepare('SELECT usada_en FROM autorizacion').get()?.usada_en).toBeNull()

      hubs.apagar()
      hubs.avanzar(20_000)
      const despues = hubs.levantar()
      const r = despues.hub.recibirLote(despues.acceso.autenticar(c.token) as never, [c.anular])
      expect(r.resultados[0]).toMatchObject({
        estado: 'confirmado',
        aceptacion: { autorizado_por_id: c.gerente.usuarioId },
      })
      expect(cuenta(despues)).toBe(1)
    })

    it('si falla justo al usar el comprobante, el evento y el comprobante quedan igual que antes', () => {
      const c = conAutorizacion()
      let falla = true
      const cae = (a: ServicioAcceso): ControlAcceso => ({
        verificar: (conexion, ev, pedido) => a.verificar(conexion, ev, pedido),
        registrarUso: (ev, v) => {
          // El comprobante se gasta antes de que la transacción termine...
          a.registrarUso(ev, v)
          if (falla) throw new Error('se fue la luz')
        },
      })
      const hub = new HubSync(new AlmacenSqlite(c.h.db, c.h.restauranteId), {
        restauranteId: c.h.restauranteId,
        zonaHoraria: 'America/Bogota',
        inicioDiaOperativo: '06:00',
        instancia: 'hub-1',
        reloj: hubs.reloj,
        acceso: cae(c.h.acceso),
      })
      const conexion = c.h.acceso.autenticar(c.token) as never
      const r = hub.recibirLote(conexion, [c.anular])

      // ...pero la transacción se deshace: ni evento ni comprobante gastado.
      expect(r.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'error_interno' })
      expect(
        Number(
          c.h.db.prepare("SELECT count(*) AS n FROM evento WHERE tipo = 'ItemAnulado'").get()?.n,
        ),
      ).toBe(0)
      expect(c.h.db.prepare('SELECT usada_en FROM autorizacion').get()?.usada_en).toBeNull()
      falla = false
    })
  })
})
