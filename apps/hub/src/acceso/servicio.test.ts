import { huellaAutorizable, nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { asegurarAdministrador, asegurarRestaurante, asegurarRoles } from './inicial'
import { firmado, montarAcceso } from './montaje'
import { VIGENCIA_AUTORIZACION_MS, VIGENCIA_CODIGO_MS } from './servicio'

const abrir = { canal: 'salon', mesa_id: null, comensales: 2 }

describe('arranque', () => {
  it('crea restaurante, sede, roles y administrador una sola vez', () => {
    const m = montarAcceso()
    const ahora = m.reloj()
    expect(asegurarRestaurante(m.db, ahora)).toBe(m.restauranteId)
    expect(asegurarRoles(m.db, m.restauranteId, ahora)).toEqual(m.roles)
    expect(asegurarAdministrador(m.db, m.acceso, m.roles.admin, false)).toEqual({
      pin: null,
      avisos: [],
    })

    const cuenta = (tabla: string) =>
      Number(m.db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get()?.n)
    expect(cuenta('restaurante')).toBe(1)
    expect(cuenta('sede')).toBe(1)
    expect(cuenta('rol')).toBe(6)
    expect(m.acceso.permisosDe(m.personas.mesero.usuarioId)).toEqual([
      'marcar_preparacion',
      'quitar_item_no_enviado',
      'tomar_pedido',
      'ver_reportes_propios',
    ])
    // Cada registro de catálogo tomó una versión distinta del contador.
    const versiones = m.db.prepare('SELECT version FROM rol_permiso').all()
    expect(new Set(versiones.map((f) => f.version)).size).toBe(versiones.length)
  })

  it('si se perdió la clave de los PIN, regenera el del administrador y avisa', () => {
    const m = montarAcceso()
    const r = asegurarAdministrador(m.db, m.acceso, m.roles.admin, true)

    expect(r.pin).toMatch(/^\d{4}$/)
    expect(r.avisos.join(' ')).toMatch(/clave de los PIN/)
    expect(
      m.acceso.crearEmparejamiento({ pin: m.personas.admin.pin, nombre: 'X', tipo: 'caja' }, null),
    ).toMatchObject({ ok: false })
    expect(
      m.acceso.crearEmparejamiento({ pin: r.pin as string, nombre: 'X', tipo: 'caja' }, null),
    ).toMatchObject({ ok: true })
  })
})

describe('emparejar un dispositivo', () => {
  it('con PIN de administrador da un código; el código se cambia por un token una sola vez', () => {
    const m = montarAcceso()
    const codigo = m.acceso.crearEmparejamiento(
      { pin: m.personas.admin.pin, nombre: 'Celular Ana', tipo: 'mesero' },
      null,
    )
    if (!codigo.ok) throw new Error(codigo.mensaje)
    const r = m.acceso.emparejar(codigo.codigo.toLowerCase(), '10.0.0.6')
    if (!r.ok) throw new Error(r.mensaje)

    expect(m.acceso.autenticar(r.token)).toEqual({
      dispositivoId: r.dispositivoId,
      tipo: 'mesero',
      revocadoEn: null,
    })
    expect(m.acceso.emparejar(codigo.codigo, '10.0.0.6')).toMatchObject({
      ok: false,
      codigo: 'codigo_invalido',
    })
    // En la base queda la huella del token, no el token.
    const credencial = m.db.prepare('SELECT token_hash FROM dispositivo_credencial').get()
    expect(credencial?.token_hash).not.toBe(r.token)
    expect(m.acceso.autenticar('otro')).toBeNull()
  })

  it('el PIN de un mesero no aprueba, con el mismo mensaje que un PIN que no existe', () => {
    const m = montarAcceso()
    const conMesero = m.acceso.crearEmparejamiento(
      { pin: m.personas.mesero.pin, nombre: 'X', tipo: 'mesero' },
      null,
    )
    expect(conMesero).toMatchObject({ ok: false, codigo: 'pin_incorrecto' })
    const inexistente = m.acceso.crearEmparejamiento(
      { pin: '0001', nombre: 'X', tipo: 'mesero' },
      null,
    )
    expect(inexistente).toMatchObject({ ok: false, codigo: 'pin_incorrecto' })
    expect(conMesero).toEqual(inexistente)
  })

  it('el código vence a los 5 minutos', () => {
    const m = montarAcceso()
    const codigo = m.acceso.crearEmparejamiento(
      { pin: m.personas.admin.pin, nombre: 'X', tipo: 'kds' },
      null,
    )
    if (!codigo.ok) throw new Error(codigo.mensaje)
    m.avanzar(VIGENCIA_CODIGO_MS)
    expect(m.acceso.emparejar(codigo.codigo, 'ip')).toMatchObject({ codigo: 'codigo_invalido' })
  })

  it('rechaza nombre vacío o tipo desconocido', () => {
    const m = montarAcceso()
    const pin = m.personas.admin.pin
    expect(m.acceso.crearEmparejamiento({ pin, nombre: '  ', tipo: 'caja' }, null)).toMatchObject({
      codigo: 'datos_invalidos',
    })
    expect(
      m.acceso.crearEmparejamiento({ pin, nombre: 'X', tipo: 'tostadora' }, null),
    ).toMatchObject({ codigo: 'datos_invalidos' })
  })

  it('probar códigos al azar desde una IP la hace esperar', () => {
    const m = montarAcceso()
    for (let i = 0; i < 3; i++) m.acceso.emparejar('AAAAAAAA', '10.0.0.66')
    expect(m.acceso.emparejar('AAAAAAAA', '10.0.0.66')).toMatchObject({ codigo: 'espera' })
    expect(m.acceso.emparejar('AAAAAAAA', '10.0.0.67')).toMatchObject({ codigo: 'codigo_invalido' })
  })
})

describe('sesiones con PIN', () => {
  it('el PIN identifica a la persona y trae sus permisos', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const r = m.entrar(conexion, 'cajero')

    expect(r.usuario).toMatchObject({ nombre: 'Carlos', rol: 'Cajero' })
    expect(r.permisos).toContain('registrar_pago')
    expect(r.secreto).not.toBe('')
    const fila = m.db.prepare('SELECT secreto_hash FROM sesion').get()
    expect(fila?.secreto_hash).not.toBe(r.secreto)
  })

  it('tres PIN errados en un dispositivo lo hacen esperar; a los demás no', () => {
    const m = montarAcceso()
    const a = m.emparejar('mesero', 'A').conexion
    const b = m.emparejar('mesero', 'B').conexion
    const errado = ['0001', '0002', '0003']
    const r = errado.map((pin) => m.acceso.iniciarSesion(a, pin))

    expect(r.map((x) => (x.ok ? 'ok' : x.esperaMs))).toEqual([0, 0, 2000])
    expect(m.acceso.iniciarSesion(a, m.personas.mesero.pin)).toMatchObject({ codigo: 'espera' })
    expect(m.acceso.iniciarSesion(b, m.personas.mesero.pin)).toMatchObject({ ok: true })
    m.avanzar(2000)
    expect(m.acceso.iniciarSesion(a, m.personas.mesero.pin)).toMatchObject({ ok: true })
  })

  it('escribir otro PIN cierra la sesión anterior del dispositivo', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const ana = m.entrar(conexion, 'mesero')
    m.entrar(conexion, 'mesero2')

    expect(m.acceso.cerrarSesion(conexion, ana)).toMatchObject({ codigo: 'sesion_invalida' })
  })

  it('cerrar la sesión exige su secreto y el mismo dispositivo', () => {
    const m = montarAcceso()
    const a = m.emparejar().conexion
    const b = m.emparejar().conexion
    const s = m.entrar(a, 'mesero')

    expect(m.acceso.cerrarSesion(a, { ...s, secreto: 'x' })).toMatchObject({ ok: false })
    expect(m.acceso.cerrarSesion(b, s)).toMatchObject({ ok: false })
    expect(m.acceso.cerrarSesion(a, s)).toEqual({ ok: true })
  })

  it('los PIN son únicos entre los activos; archivar libera el PIN y cierra sus sesiones', () => {
    const m = montarAcceso()
    const pines = new Set<string>()
    for (let i = 0; i < 300; i++)
      pines.add(m.acceso.crearUsuario({ nombre: `U${i}`, rolId: m.roles.mesero }).pin)
    expect(pines.size).toBe(300)

    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'mesero')
    m.acceso.archivarUsuario(m.personas.mesero.usuarioId)
    expect(m.acceso.iniciarSesion(conexion, m.personas.mesero.pin)).toMatchObject({
      codigo: 'pin_incorrecto',
    })
    expect(m.acceso.cerrarSesion(conexion, s)).toMatchObject({ codigo: 'sesion_invalida' })
  })

  it('regenerar el PIN invalida el anterior', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const nuevo = m.acceso.regenerarPin(m.personas.mesero.usuarioId)
    expect(m.acceso.iniciarSesion(conexion, m.personas.mesero.pin).ok).toBe(
      nuevo === m.personas.mesero.pin,
    )
    expect(m.acceso.iniciarSesion(conexion, nuevo)).toMatchObject({ ok: true })
  })
})

describe('qué eventos puede crear cada quien', () => {
  it('el mesero toma pedidos; anular un ítem enviado le pide autorización', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'mesero')

    expect(
      m.acceso.verificar(conexion, m.evento(conexion, s, 'PedidoAbierto', abrir), null),
    ).toEqual({
      ok: true,
      autorizadoPorId: null,
      autorizacionId: null,
    })
    expect(
      m.acceso.verificar(conexion, m.evento(conexion, s, 'ItemAnulado', {}, { motivo: 'x' }), null),
    ).toEqual({ ok: false, motivo: 'sin_permiso' })
  })

  it('con el PIN de la gerente, el comprobante vale para ese evento, una vez', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'mesero')
    const anular = m.evento(conexion, s, 'ItemAnulado', {}, { motivo: 'Se equivocó' })
    const a = m.acceso.autorizar(conexion, {
      ...s,
      pin: m.personas.gerente.pin,
      accion: 'anular_item_enviado',
      agregadoId: anular.agregado_id,
      eventoId: anular.id,
      huella: huellaAutorizable(anular),
    })
    if (!a.ok) throw new Error(a.mensaje)
    expect(a.supervisor.nombre).toBe('Gloria')
    const conComprobante = firmado(s, { ...anular, autorizacion_id: a.autorizacionId })

    const v = m.acceso.verificar(conexion, conComprobante, null)
    expect(v).toEqual({
      ok: true,
      autorizadoPorId: m.personas.gerente.usuarioId,
      autorizacionId: a.autorizacionId,
    })
    if (v.ok) m.acceso.registrarUso(conComprobante, v)
    expect(m.acceso.verificar(conexion, conComprobante, null)).toEqual({
      ok: false,
      motivo: 'autorizacion_invalida',
    })
    // La sesión del mesero sigue abierta.
    expect(m.acceso.cerrarSesion(conexion, s)).toEqual({ ok: true })
  })

  it('el comprobante no sirve para otro evento, otro pedido, otra acción ni pasados 2 minutos', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'mesero')
    const anular = m.evento(conexion, s, 'ItemAnulado', {}, { motivo: 'x' })
    const a = m.acceso.autorizar(conexion, {
      ...s,
      pin: m.personas.gerente.pin,
      accion: 'anular_item_enviado',
      agregadoId: anular.agregado_id,
      eventoId: anular.id,
      huella: huellaAutorizable(anular),
    })
    if (!a.ok) throw new Error(a.mensaje)
    // Cada cambio se firma de nuevo, como lo haría un dispositivo modificado.
    const con = (cambios: object) =>
      m.acceso.verificar(
        conexion,
        firmado(s, { ...anular, autorizacion_id: a.autorizacionId, ...cambios }),
        null,
      )

    expect(con({ id: nuevoId() })).toMatchObject({ motivo: 'autorizacion_invalida' })
    expect(con({ agregado_id: nuevoId() })).toMatchObject({ motivo: 'autorizacion_invalida' })
    expect(con({ tipo: 'PedidoCancelado' })).toMatchObject({ motivo: 'autorizacion_invalida' })
    const tarde = new Date(Date.parse(m.reloj()) + VIGENCIA_AUTORIZACION_MS + 1).toISOString()
    expect(con({ hora_estimada_hub: tarde })).toMatchObject({ motivo: 'autorizacion_invalida' })
    expect(con({})).toMatchObject({ ok: true })
  })

  it('nadie se autoriza a sí mismo, y un PIN sin el permiso no autoriza', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'gerente')
    const datos = {
      ...s,
      accion: 'anular_item_enviado',
      agregadoId: nuevoId(),
      eventoId: nuevoId(),
      huella: 'a'.repeat(64),
    }

    expect(m.acceso.autorizar(conexion, { ...datos, pin: m.personas.gerente.pin })).toMatchObject({
      codigo: 'autoautorizacion',
    })
    expect(m.acceso.autorizar(conexion, { ...datos, pin: m.personas.cajero.pin })).toMatchObject({
      codigo: 'pin_incorrecto',
    })
    expect(m.acceso.autorizar(conexion, { ...datos, pin: m.personas.admin.pin })).toMatchObject({
      ok: true,
    })
    expect(m.acceso.autorizar(conexion, { ...datos, pin: m.personas.admin.pin })).toMatchObject({
      codigo: 'ya_autorizado',
    })
  })

  it('pagos y cierres solo desde la caja, aunque el usuario sea cajero', () => {
    const m = montarAcceso()
    const celular = m.emparejar('mesero').conexion
    const caja = m.emparejar('caja').conexion
    const enCelular = m.entrar(celular, 'cajero')
    const enCaja = m.entrar(caja, 'cajero')

    expect(
      m.acceso.verificar(celular, m.evento(celular, enCelular, 'PedidoCerrado', {}), null),
    ).toEqual({
      ok: false,
      motivo: 'solo_caja',
    })
    expect(
      m.acceso.verificar(caja, m.evento(caja, enCaja, 'PedidoCerrado', {}), null),
    ).toMatchObject({
      ok: true,
    })
  })

  it('el hub no cree lo que dice el evento: sesión, usuario y dispositivo deben cuadrar', () => {
    const m = montarAcceso()
    const a = m.emparejar().conexion
    const b = m.emparejar().conexion
    const sa = m.entrar(a, 'mesero')
    const ev = m.evento(a, sa, 'PedidoAbierto', abrir)

    expect(m.acceso.verificar(a, { ...ev, sesion_id: null }, null)).toMatchObject({
      motivo: 'sin_sesion',
    })
    expect(m.acceso.verificar(b, ev, null)).toMatchObject({ motivo: 'sesion_ajena' })
    expect(
      m.acceso.verificar(a, { ...ev, usuario_id: m.personas.gerente.usuarioId }, null),
    ).toMatchObject({ motivo: 'usuario_distinto' })
    expect(m.acceso.verificar(a, { ...ev, sesion_id: nuevoId() }, null)).toEqual({
      ok: false,
      motivo: 'sesion_desconocida',
      cuarentena: true,
    })
    expect(
      m.acceso.verificar(a, firmado(sa, { ...ev, tipo: 'PedidoRescateCreado' } as typeof ev), null),
    ).toMatchObject({ motivo: 'solo_hub' })
  })

  it('la sesión se juzga a la hora del evento: lo hecho sin conexión antes del cierre vale', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'mesero')
    const antes = m.evento(conexion, s, 'PedidoAbierto', abrir)
    m.avanzar(40 * 60_000)
    m.acceso.cerrarSesion(conexion, s)
    m.avanzar(5 * 60_000)
    const despues = m.evento(conexion, s, 'PedidoAbierto', abrir)

    expect(m.acceso.verificar(conexion, antes, null)).toMatchObject({ ok: true })
    expect(m.acceso.verificar(conexion, despues, null)).toMatchObject({ motivo: 'sesion_cerrada' })
  })

  it('el permiso se evalúa con el rol al recibir: un usuario archivado ya no crea nada', () => {
    const m = montarAcceso()
    const { conexion } = m.emparejar()
    const s = m.entrar(conexion, 'mesero')
    const ev = m.evento(conexion, s, 'PedidoAbierto', abrir)
    m.acceso.archivarUsuario(m.personas.mesero.usuarioId)

    expect(m.acceso.verificar(conexion, ev, null)).toMatchObject({ motivo: 'usuario_inactivo' })
  })
})

describe('revocar un dispositivo', () => {
  it('solo el administrador, no el propio equipo, y avisa a la sala', () => {
    const m = montarAcceso()
    const caja = m.emparejar('caja').conexion
    const celular = m.emparejar('mesero')
    const gerente = m.entrar(caja, 'gerente')
    const datos = { dispositivoId: celular.conexion.dispositivoId }

    expect(m.acceso.revocarDispositivo(caja, { ...gerente, ...datos })).toMatchObject({
      codigo: 'sin_permiso',
    })
    const admin = m.entrar(caja, 'admin')
    expect(
      m.acceso.revocarDispositivo(caja, { ...admin, dispositivoId: caja.dispositivoId }),
    ).toMatchObject({ codigo: 'datos_invalidos' })
    const r = m.acceso.revocarDispositivo(caja, { ...admin, ...datos })

    expect(r).toEqual({ ok: true, revocadoEn: m.reloj() })
    expect(m.revocados).toEqual([celular.conexion.dispositivoId])
    expect(m.acceso.autenticar(celular.token)?.revocadoEn).toBe(m.reloj())
    expect(
      m.acceso.iniciarSesion(m.acceso.autenticar(celular.token) as never, m.personas.mesero.pin),
    ).toMatchObject({ codigo: 'dispositivo_revocado' })
  })
})
