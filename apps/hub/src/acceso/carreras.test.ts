import { nuevoId } from '@pos/core'
import { type MensajeHub, SalaSync } from '@pos/sync'
import { describe, expect, it } from 'vitest'
import {
  ABRIR,
  autorizarEvento,
  datosAnular,
  type MontajeHub,
  montarHub,
  pedidoConItemEnviado,
  sumar,
} from './montaje-hub'
import { actualizarVersionado, SISTEMA } from './registros'
import { ENTREGA_AUTORIZADO_MS, VIGENCIA_AUTORIZACION_MS } from './servicio'

// Carreras entre el comprobante de supervisor, la sesión, el reloj del dispositivo y la
// revocación, con el hub de sincronización completo (docs/SYNC.md#seguridad).

interface OpcionesComprobante {
  quien?: 'gerente' | 'admin'
  /** Hora del evento respecto de la emisión del comprobante (la fija el dispositivo al pedirlo). */
  desfase?: number
  /** Ítem que se anula (por defecto, el que sí existe). */
  itemId?: string
}

/** El mesero tiene un ítem enviado y pide que la gerente autorice anularlo. */
function conComprobante(m: MontajeHub, o: OpcionesComprobante = {}) {
  const base = pedidoConItemEnviado(m)
  // Un rato después de abrir la sesión, para poder probar eventos «anteriores» al comprobante.
  m.avanzar(5 * 60_000)
  const emitida = m.reloj()
  const hora = sumar(emitida, o.desfase ?? 0)
  const sinComprobante = m.evento(
    base.conexion,
    base.sesion,
    'ItemAnulado',
    datosAnular(o.itemId ?? base.itemId),
    {
      agregado_id: base.pedido,
      motivo: 'El cliente cambió de idea',
      secuencia_base: 3,
      hora_dispositivo: hora,
      hora_estimada_hub: hora,
    },
  )
  const { comprobante, evento } = autorizarEvento(
    m,
    base.conexion,
    base.sesion,
    m.personas[o.quien ?? 'gerente'].pin,
    sinComprobante,
  )
  /** El evento autorizado, con ajustes que el dispositivo no debería poder hacer (y se firma de nuevo). */
  const anular = (extras: object = {}) => m.firmado(base.sesion, { ...evento, ...extras })
  return {
    ...base,
    evento,
    eventoId: evento.id,
    autorizacionId: comprobante.autorizacionId,
    emitida,
    anular,
  }
}

const comprobante = (m: MontajeHub) =>
  m.db.prepare('SELECT supervisor_id, usada_en FROM autorizacion').get()
const eventos = (m: MontajeHub) => Number(m.db.prepare('SELECT count(*) AS n FROM evento').get()?.n)
const cambiarRol = (m: MontajeHub, usuarioId: string, rolId: string) =>
  actualizarVersionado(
    m.db,
    'usuario',
    m.restauranteId,
    usuarioId,
    { rol_id: rolId },
    SISTEMA,
    m.reloj(),
  )

describe('un comprobante, un solo evento', () => {
  it('dos eventos con el mismo comprobante en un lote: solo el suyo pasa', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const otro = c.anular({ id: nuevoId() })
    const r = m.hub.recibirLote(c.conexion, [c.anular(), otro])

    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'rechazado'])
    expect(r.resultados[1]).toMatchObject({ motivo: 'autorizacion_invalida' })
    expect(comprobante(m)).toMatchObject({ usada_en: m.reloj() })
  })

  it('un intruso que va antes con el comprobante ajeno no lo gasta: el legítimo entra en otro lote', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const otro = c.anular({ id: nuevoId() })

    // En el mismo lote, el rechazo arrastra a los siguientes del mismo pedido (depende de él).
    const junto = m.hub.recibirLote(c.conexion, [otro, c.anular()])
    expect(junto.resultados.map((x) => x.estado)).toEqual(['rechazado', 'rechazado'])
    expect(comprobante(m)).toMatchObject({ usada_en: null })

    // Pero el comprobante sigue siendo del suyo: en un lote aparte, el legítimo pasa.
    const aparte = montarHub()
    const d = conComprobante(aparte)
    aparte.hub.recibirLote(d.conexion, [d.anular({ id: nuevoId() })])
    expect(aparte.hub.recibirLote(d.conexion, [d.anular()]).resultados[0]?.estado).toBe(
      'confirmado',
    )
  })

  it('el mismo evento dos veces en el lote se guarda una vez y ambas dan la misma respuesta', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const antes = eventos(m)
    const r = m.hub.recibirLote(c.conexion, [c.anular(), c.anular()])

    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(r.resultados[0]).toEqual(r.resultados[1])
    expect(eventos(m)).toBe(antes + 1)
  })

  it('el mismo id con otro contenido no aprovecha el comprobante ya usado', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.hub.recibirLote(c.conexion, [c.anular()])
    const otro = m.hub.recibirLote(c.conexion, [c.anular({ motivo: 'Otro motivo' })])

    expect(otro.resultados[0]).toMatchObject({ estado: 'rechazado', motivo: 'id_repetido' })
  })

  it('un evento rechazado por una regla del pedido no gasta el comprobante', () => {
    const m = montarHub()
    // El ítem no existe: el comprobante es válido para ese contenido, pero la regla lo rechaza.
    const c = conComprobante(m, { itemId: nuevoId() })
    const r = m.hub.recibirLote(c.conexion, [c.anular()])

    expect(r.resultados[0]?.estado).toBe('rechazado')
    expect(r.resultados[0]).not.toMatchObject({ motivo: 'autorizacion_invalida' })
    expect(comprobante(m)).toMatchObject({ usada_en: null })
    expect(eventos(m)).toBe(3)
  })

  it('un comprobante con el evento rechazado por esquema tampoco se gasta', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const r = m.hub.recibirLote(c.conexion, [{ ...c.anular(), datos: 'no es un objeto' }])

    expect(r.resultados[0]?.estado).toBe('rechazado')
    expect(comprobante(m)).toMatchObject({ usada_en: null })
  })

  it('el comprobante es para ese contenido exacto: cualquier cambio lo invalida y no lo gasta', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const cambios: Record<string, object> = {
      otroPedido: { agregado_id: nuevoId() },
      otraCantidad: { datos: { ...datosAnular(c.itemId), cantidad: 2 } },
      otroItem: { datos: { ...datosAnular(nuevoId()) } },
      yaPreparado: { datos: { ...datosAnular(c.itemId), ya_preparado: true } },
      otroMotivo: { motivo: 'Cambiado a escondidas' },
      otraHora: {
        hora_dispositivo: sumar(c.emitida, 1000),
        hora_estimada_hub: sumar(c.emitida, 1000),
      },
    }
    for (const [nombre, cambio] of Object.entries(cambios)) {
      const r = m.hub.recibirLote(c.conexion, [c.anular(cambio)])
      expect(r.resultados[0], nombre).toMatchObject({ estado: 'rechazado' })
      expect(comprobante(m), nombre).toMatchObject({ usada_en: null })
    }
    // El evento original, tras tantos intentos fallidos con el mismo id, sigue valiendo.
    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]?.estado).toBe('confirmado')
  })

  it('lo que el dispositivo sí puede ajustar al reenviar (secuencia_base) no invalida el comprobante', () => {
    const m = montarHub()
    const c = conComprobante(m)
    expect(
      m.hub.recibirLote(c.conexion, [c.anular({ secuencia_base: 0 })]).resultados[0]?.estado,
    ).toBe('confirmado')
  })

  it('el comprobante es de la sesión que lo pidió: otra sesión del mismo usuario no lo usa', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.avanzar(1000)
    const otra = m.entrar(c.conexion, 'mesero')
    const robado = m.firmado(otra, { ...c.evento, sesion_id: otra.sesionId })

    expect(m.hub.recibirLote(c.conexion, [robado]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
    // Y el evento de la sesión original, creado antes del cambio, sigue valiendo.
    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]?.estado).toBe('confirmado')
  })

  it('el comprobante de un celular no sirve en otro dispositivo, aunque sea el mismo usuario', () => {
    const m = montarHub()
    const c = conComprobante(m)
    const otro = m.emparejar('mesero', 'Otro celular').conexion
    const s = m.entrar(otro, 'mesero')
    const copia = m.firmado(s, {
      ...c.evento,
      sesion_id: s.sesionId,
      dispositivo_id: otro.dispositivoId,
    })

    expect(m.hub.recibirLote(otro, [copia]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
  })
})

describe('el supervisor cambia antes de que llegue el evento', () => {
  const rechazoPorComprobante = { estado: 'rechazado', motivo: 'autorizacion_invalida' }

  it('si el supervisor se archiva después de autorizar, el comprobante ya no vale', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.acceso.archivarUsuario(m.personas.gerente.usuarioId)

    const r = m.hub.recibirLote(c.conexion, [c.anular()])
    expect(r.resultados[0]).toMatchObject(rechazoPorComprobante)
    expect(m.hub.pedido(c.pedido)?.items[c.itemId]?.estado).toBe('enviado')
  })

  it('si cambia al supervisor a un rol sin el permiso, deja de valer', () => {
    const m = montarHub()
    const c = conComprobante(m)
    cambiarRol(m, m.personas.gerente.usuarioId, m.roles.mesero)

    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]).toMatchObject(
      rechazoPorComprobante,
    )
  })

  it('si al rol del supervisor se le quita el permiso, deja de valer', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.db
      .prepare(
        "UPDATE rol_permiso SET activo = 0 WHERE rol_id = ? AND permiso = 'anular_item_enviado'",
      )
      .run(m.roles.gerente)

    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]).toMatchObject(
      rechazoPorComprobante,
    )
  })

  it('si se archiva el rol entero del supervisor, deja de valer', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.db.prepare('UPDATE rol SET activo = 0 WHERE id = ?').run(m.roles.gerente)

    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]).toMatchObject(
      rechazoPorComprobante,
    )
  })

  it('un supervisor que cambió de PIN sigue siendo el mismo supervisor: el comprobante vale', () => {
    const m = montarHub()
    const c = conComprobante(m)
    m.acceso.regenerarPin(m.personas.gerente.usuarioId)

    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: m.personas.gerente.usuarioId },
    })
  })

  it('si el propio mesero ya tiene el permiso al llegar el evento, no hace falta el comprobante', () => {
    const m = montarHub()
    const c = conComprobante(m)
    cambiarRol(m, m.personas.mesero.usuarioId, m.roles.gerente)

    const r = m.hub.recibirLote(c.conexion, [c.anular()])
    expect(r.resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: null },
    })
    // El comprobante no se gastó: no hizo falta.
    expect(comprobante(m)).toMatchObject({ usada_en: null })
  })

  describe('al autor del evento le quitan el permiso o lo archivan', () => {
    /** La gerente anula un ítem sin conexión; luego el administrador cambia su situación. */
    function gerenteSinConexion() {
      const m = montarHub()
      const { conexion } = m.emparejar('mesero')
      const sesion = m.entrar(conexion, 'gerente')
      const anular = (hora: string) =>
        m.evento(conexion, sesion, 'ItemAnulado', datosAnular(nuevoId()), {
          motivo: 'x',
          hora_dispositivo: hora,
          hora_estimada_hub: hora,
        })
      return { m, conexion, sesion, anular }
    }

    it('lo que hizo antes del cambio va a cuarentena para que alguien lo revise; lo de después, rechazado', () => {
      const { m, conexion, anular } = gerenteSinConexion()
      const antes = anular(m.reloj())
      m.avanzar(10 * 60_000)
      cambiarRol(m, m.personas.gerente.usuarioId, m.roles.mesero)
      const cambio = m.reloj()
      m.avanzar(10 * 60_000)
      const despues = anular(sumar(cambio, 1000))

      const r = m.hub.recibirLote(conexion, [antes, despues])
      expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
      expect(r.resultados[1]).toMatchObject({ motivo: 'sin_permiso' })
      expect(
        m.db.prepare('SELECT motivo FROM evento_cuarentena WHERE evento_id = ?').get(antes.id)
          ?.motivo,
      ).toBe('permisos_cambiados')
      expect(eventos(m)).toBe(0)
    })

    it('el borde: justo en el instante del cambio ya cuenta como posterior', () => {
      const { m, conexion, anular } = gerenteSinConexion()
      m.avanzar(10 * 60_000)
      cambiarRol(m, m.personas.gerente.usuarioId, m.roles.mesero)
      const cambio = m.reloj()

      const r = m.hub.recibirLote(conexion, [anular(sumar(cambio, -1)), anular(cambio)])
      expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
    })

    it('un usuario archivado: lo anterior al archivado se revisa, lo posterior se rechaza', () => {
      const { m, conexion, anular } = gerenteSinConexion()
      const antes = anular(m.reloj())
      m.avanzar(10 * 60_000)
      m.acceso.archivarUsuario(m.personas.gerente.usuarioId)
      const cierre = m.reloj()
      const justoDespues = anular(sumar(cierre, 1000))
      const muchoDespues = anular(sumar(cierre, 61_000))

      const r = m.hub.recibirLote(conexion, [antes, justoDespues, muchoDespues])
      expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado', 'rechazado'])
      expect(r.resultados.slice(1)).toMatchObject([
        { motivo: 'usuario_inactivo' },
        { motivo: 'sesion_cerrada' },
      ])
    })

    it('el cambio de otro usuario no pone en duda lo de este: sin permiso sigue siendo un rechazo', () => {
      const m = montarHub()
      const { conexion } = m.emparejar('mesero')
      const sesion = m.entrar(conexion, 'mesero')
      const antes = m.evento(conexion, sesion, 'ItemAnulado', datosAnular(nuevoId()), {
        motivo: 'x',
      })
      m.avanzar(10 * 60_000)
      cambiarRol(m, m.personas.cajero.usuarioId, m.roles.contador)

      expect(m.hub.recibirLote(conexion, [antes]).resultados[0]).toMatchObject({
        estado: 'rechazado',
        motivo: 'sin_permiso',
      })
    })
  })
})

describe('evento que llega tarde pero se creó a tiempo', () => {
  it('sin conexión: creado a los 119 s del comprobante y recibido media hora después, vale', () => {
    const m = montarHub()
    const c = conComprobante(m, { desfase: 119_000 })
    m.avanzar(30 * 60_000)

    const r = m.hub.recibirLote(c.conexion, [c.anular()])
    expect(r.resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: m.personas.gerente.usuarioId },
    })
  })

  it('los bordes de la vigencia: -60 s y +120 s valen; un milisegundo más, no', () => {
    const casos: [number, 'confirmado' | 'rechazado'][] = [
      [-60_001, 'rechazado'],
      [-60_000, 'confirmado'],
      [0, 'confirmado'],
      [VIGENCIA_AUTORIZACION_MS, 'confirmado'],
      [VIGENCIA_AUTORIZACION_MS + 1, 'rechazado'],
    ]
    for (const [desfase, esperado] of casos) {
      const m = montarHub()
      const c = conComprobante(m, { desfase })
      const r = m.hub.recibirLote(c.conexion, [c.anular()])
      expect(r.resultados[0]?.estado, `desfase ${desfase}`).toBe(esperado)
      if (esperado === 'rechazado')
        expect(r.resultados[0]).toMatchObject({ motivo: 'autorizacion_invalida' })
    }
  })

  it('un evento con hora de mucho después del comprobante (reloj adelantado) no estira la vigencia', () => {
    const m = montarHub()
    const c = conComprobante(m, { desfase: 10 * 60_000 })

    expect(m.hub.recibirLote(c.conexion, [c.anular()]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
  })

  it('el comprobante se entrega al hub en 12 horas, a más tardar', () => {
    const casos: [number, 'confirmado' | 'rechazado'][] = [
      [ENTREGA_AUTORIZADO_MS - 1, 'confirmado'],
      [ENTREGA_AUTORIZADO_MS, 'confirmado'],
      [ENTREGA_AUTORIZADO_MS + 1, 'rechazado'],
    ]
    for (const [espera, esperado] of casos) {
      const m = montarHub()
      const c = conComprobante(m)
      m.avanzar(espera)
      const r = m.hub.recibirLote(c.conexion, [c.anular()])
      expect(r.resultados[0]?.estado, `espera ${espera}`).toBe(esperado)
    }
  })
})

describe('sesiones y reloj', () => {
  it('los bordes de la tolerancia de 60 s al inicio de la sesión', () => {
    const casos: [number, 'confirmado' | 'rechazado'][] = [
      [-60_001, 'rechazado'],
      [-60_000, 'confirmado'],
      [0, 'confirmado'],
    ]
    for (const [desfase, esperado] of casos) {
      const m = montarHub()
      m.avanzar(60 * 60_000)
      const { conexion } = m.emparejar('mesero')
      const sesion = m.entrar(conexion, 'mesero')
      const hora = sumar(m.reloj(), desfase)
      const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
        hora_dispositivo: hora,
        hora_estimada_hub: hora,
      })
      const r = m.hub.recibirLote(conexion, [ev])
      expect(r.resultados[0]?.estado, `desfase ${desfase}`).toBe(esperado)
      if (esperado === 'rechazado')
        expect(r.resultados[0]).toMatchObject({ motivo: 'sesion_cerrada' })
    }
  })

  it('los bordes de la tolerancia de 60 s al cierre de la sesión', () => {
    const casos: [number, 'confirmado' | 'rechazado'][] = [
      [0, 'confirmado'],
      [60_000, 'confirmado'],
      [60_001, 'rechazado'],
    ]
    for (const [desfase, esperado] of casos) {
      const m = montarHub()
      const { conexion } = m.emparejar('mesero')
      const sesion = m.entrar(conexion, 'mesero')
      m.avanzar(30 * 60_000)
      const cierre = m.reloj()
      expect(m.acceso.cerrarSesion(conexion, sesion)).toEqual({ ok: true })
      const hora = sumar(cierre, desfase)
      const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
        hora_dispositivo: hora,
        hora_estimada_hub: hora,
      })
      // Se recibe mucho después: lo que cuenta es la hora del evento.
      m.avanzar(60 * 60_000)
      const r = m.hub.recibirLote(conexion, [ev])
      expect(r.resultados[0]?.estado, `desfase ${desfase}`).toBe(esperado)
    }
  })

  it('con la sesión abierta, un evento con hora futura se acepta pero el hub usa su propia hora', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    const futura = sumar(m.reloj(), 3 * 60 * 60_000)
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
      hora_dispositivo: futura,
      hora_estimada_hub: futura,
    })

    const r = m.hub.recibirLote(conexion, [ev])
    expect(r.resultados[0]?.estado).toBe('confirmado')
    const fila = m.db.prepare('SELECT recibido_en, dia_operativo FROM evento').get()
    expect(fila?.recibido_en).toBe(m.reloj())
    // 20:00 UTC = 15:00 en Bogotá: el día operativo es el de hoy, no el de las 23:00 del reloj adelantado.
    expect(fila?.dia_operativo).toBe('2026-10-24')
  })

  it('con la sesión cerrada, la hora futura no sirve para colarse después del cierre', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    m.avanzar(10 * 60_000)
    m.acceso.cerrarSesion(conexion, sesion)
    const futura = sumar(m.reloj(), 10 * 60_000)
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
      hora_dispositivo: futura,
      hora_estimada_hub: futura,
    })

    expect(m.hub.recibirLote(conexion, [ev]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'sesion_cerrada',
    })
  })

  it('una hora que no es una hora se rechaza por esquema, no se cuela por la comparación', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    for (const basura of ['mañana', '', '2026-13-45T99:99:99Z', 'NaN', '0']) {
      const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
        hora_estimada_hub: basura,
      })
      const r = m.hub.recibirLote(conexion, [ev])
      expect(r.resultados[0]?.estado, basura).toBe('rechazado')
    }
    expect(eventos(m)).toBe(0)
  })

  it('el cambio de usuario en el dispositivo: lo del primero creado antes vale, lo creado después no', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const ana = m.entrar(conexion, 'mesero')
    const antes = m.evento(conexion, ana, 'PedidoAbierto', ABRIR)
    m.avanzar(10 * 60_000)
    m.entrar(conexion, 'mesero2')
    m.avanzar(5 * 60_000)
    const despues = m.evento(conexion, ana, 'PedidoAbierto', ABRIR)

    const r = m.hub.recibirLote(conexion, [antes, despues])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'rechazado'])
    expect(r.resultados[1]).toMatchObject({ motivo: 'sesion_cerrada' })
  })

  it('recibir eventos cuenta como uso de la sesión, sin pasar de la hora del hub ni retroceder', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    const ultimo = () =>
      m.db.prepare('SELECT ultimo_uso FROM sesion WHERE id = ?').get(sesion.sesionId)?.ultimo_uso

    m.avanzar(10 * 60_000)
    const reciente = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR)
    m.hub.recibirLote(conexion, [reciente])
    expect(ultimo()).toBe(m.reloj())

    // Un evento viejo que llega después no retrocede el último uso.
    const viejo = sumar(m.reloj(), -5 * 60_000)
    m.avanzar(1000)
    m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
        hora_dispositivo: viejo,
        hora_estimada_hub: viejo,
      }),
    ])
    expect(ultimo()).toBe(sumar(m.reloj(), -1000))

    // Uno con hora futura no lo adelanta más allá del reloj del hub.
    const futura = sumar(m.reloj(), 30_000)
    m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
        hora_dispositivo: futura,
        hora_estimada_hub: futura,
      }),
    ])
    expect(ultimo()).toBe(m.reloj())
  })

  it('el secreto de la sesión, no su id, es lo que permite pedir un comprobante', () => {
    const m = montarHub()
    const { conexion, sesion } = pedidoConItemEnviado(m)
    const r = m.acceso.autorizar(conexion, {
      sesionId: sesion.sesionId,
      secreto: 'x'.repeat(43),
      pin: m.personas.gerente.pin,
      accion: 'anular_item_enviado',
      agregadoId: nuevoId(),
      eventoId: nuevoId(),
      huella: '0'.repeat(64),
    })
    expect(r).toMatchObject({ ok: false, codigo: 'sesion_invalida' })
    expect(m.db.prepare('SELECT count(*) AS n FROM autorizacion').get()?.n).toBe(0)
  })
})

describe('la firma de los eventos', () => {
  function enSesion() {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    return { m, conexion, sesion }
  }

  it('sin firma, o con una firma que no es de esta sesión, el evento se rechaza', () => {
    const { m, conexion, sesion } = enSesion()
    const otra = m.entrar(m.emparejar('mesero', 'Otro').conexion, 'mesero2')
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR)
    const { firma: _firma, ...sinFirma } = ev
    const casos = {
      sinFirma,
      firmaAjena: m.firmado(otra, ev),
      firmaCero: { ...ev, firma: '0'.repeat(64) },
    }
    for (const [nombre, malo] of Object.entries(casos)) {
      const r = m.hub.recibirLote(conexion, [{ ...malo, id: nuevoId() }])
      expect(r.resultados[0], nombre).toMatchObject({
        estado: 'rechazado',
        motivo: 'firma_invalida',
      })
    }
    expect(eventos(m)).toBe(0)
  })

  it('cambiar cualquier campo después de firmar invalida la firma', () => {
    const { m, conexion, sesion } = enSesion()
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR)
    const cambios: Record<string, object> = {
      datos: { datos: { ...ABRIR, comensales: 9 } },
      hora: { hora_estimada_hub: sumar(m.reloj(), 1000) },
      motivo: { motivo: 'otro' },
      agregado: { agregado_id: nuevoId() },
    }
    for (const [nombre, cambio] of Object.entries(cambios)) {
      const r = m.hub.recibirLote(conexion, [{ ...ev, id: nuevoId(), ...cambio }])
      expect(r.resultados[0], nombre).toMatchObject({ motivo: 'firma_invalida' })
    }
  })

  it('el id del evento va dentro de la firma: no se puede reusar la firma con otro id', () => {
    const { m, conexion, sesion } = enSesion()
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR)
    expect(m.hub.recibirLote(conexion, [{ ...ev, id: nuevoId() }]).resultados[0]).toMatchObject({
      motivo: 'firma_invalida',
    })
  })

  it('sesión y usuario se revisan antes que la firma', () => {
    const { m, conexion, sesion } = enSesion()
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR)
    const otro = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, {
      usuario_id: m.personas.gerente.usuarioId,
    })

    expect(m.acceso.verificar(conexion, { ...ev, sesion_id: nuevoId() }, null)).toMatchObject({
      motivo: 'sesion_desconocida',
      cuarentena: true,
    })
    expect(m.acceso.verificar(conexion, otro, null)).toMatchObject({ motivo: 'usuario_distinto' })
  })

  it('la secuencia_base no está firmada: el dispositivo la baja a 0 al reenviar a un hub restaurado', () => {
    const { m, conexion, sesion } = enSesion()
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { secuencia_base: 7 })
    const r = m.hub.recibirLote(conexion, [{ ...ev, secuencia_base: 0 }])

    expect(r.resultados[0]?.estado).toBe('confirmado')
  })

  it('la firma no queda guardada con el evento', () => {
    const { m, conexion, sesion } = enSesion()
    const ev = m.evento(conexion, sesion, 'PedidoAbierto', ABRIR)
    m.hub.recibirLote(conexion, [ev])

    const guardado = JSON.stringify(m.db.prepare('SELECT * FROM evento').get())
    expect(guardado).not.toContain(String(ev.firma))
  })
})

describe('el permiso depende del contenido y del estado del pedido', () => {
  const extra = (precio: number) => ({
    modificador_id: nuevoId(),
    nombre: 'Extra',
    precio_extra: precio,
  })

  function conItemConExtra() {
    const m = montarHub()
    const base = pedidoConItemEnviado(m, [extra(3000)])
    const cambiar = (modificadores: object[], extras: object = {}) =>
      m.evento(
        base.conexion,
        base.sesion,
        'ItemModificadoTrasEnvio',
        { item_id: base.itemId, comanda_id: base.comandaId, modificadores },
        { agregado_id: base.pedido, secuencia_base: 3, ...extras },
      )
    return { m, base, cambiar }
  }

  it('abaratar un ítem ya enviado es una anulación parcial: el mesero no puede, ni quitando todos los extras', () => {
    const { m, base, cambiar } = conItemConExtra()
    for (const modificadores of [[], [extra(1000)], [extra(2999)]]) {
      const r = m.hub.recibirLote(base.conexion, [cambiar(modificadores, { id: nuevoId() })])
      expect(
        r.resultados[0],
        JSON.stringify(modificadores.map((x) => x.precio_extra)),
      ).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    }
  })

  it('cambiar por algo igual o más caro, o solo las notas, lo hace cualquiera con «tomar_pedido»', () => {
    const { m, base, cambiar } = conItemConExtra()
    const notas = m.evento(
      base.conexion,
      base.sesion,
      'ItemModificadoTrasEnvio',
      { item_id: base.itemId, comanda_id: base.comandaId, notas: 'sin hielo' },
      { agregado_id: base.pedido, secuencia_base: 3 },
    )
    const r = m.hub.recibirLote(base.conexion, [
      cambiar([extra(3000)]),
      cambiar([extra(8000)], { secuencia_base: 4 }),
      { ...notas, secuencia_base: 5 },
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
  })

  it('con el comprobante de «anular_item_enviado» sí se abarata, y el supervisor queda registrado', () => {
    const { m, base, cambiar } = conItemConExtra()
    const { evento } = autorizarEvento(
      m,
      base.conexion,
      base.sesion,
      m.personas.gerente.pin,
      cambiar([]),
    )

    expect(m.hub.recibirLote(base.conexion, [evento]).resultados[0]).toMatchObject({
      estado: 'confirmado',
      aceptacion: { autorizado_por_id: m.personas.gerente.usuarioId },
    })
  })

  it('un comprobante de «tomar_pedido» no alcanza para abaratar', () => {
    const { m, base, cambiar } = conItemConExtra()
    // La gerente tiene los dos permisos; el comprobante se emite solo para el más débil.
    const { evento } = autorizarEvento(
      m,
      base.conexion,
      base.sesion,
      m.personas.gerente.pin,
      cambiar([]),
      'tomar_pedido',
    )

    expect(m.hub.recibirLote(base.conexion, [evento]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'autorizacion_invalida',
    })
  })
})

describe('revocar un dispositivo con trabajo pendiente', () => {
  /** Un celular conectado a la sala, con su sesión abierta y una caja con el administrador. */
  function conSala() {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.acceso.autenticar)
    const celular = m.emparejar('mesero')
    const sesion = m.entrar(celular.conexion, 'mesero')
    const caja = m.emparejar('caja').conexion
    const admin = m.entrar(caja, 'admin')
    const recibidos: MensajeHub[] = []
    const enlace = sala.conectar((x) => recibidos.push(x))
    enlace.recibir({
      tipo: 'hola',
      token: celular.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    const revocar = () => {
      const r = m.acceso.revocarDispositivo(caja, {
        ...admin,
        dispositivoId: celular.conexion.dispositivoId,
      })
      if (!r.ok) throw new Error(r.mensaje)
      sala.revocar(celular.conexion.dispositivoId, r.revocadoEn)
      return r.revocadoEn
    }
    const resultados = () => recibidos.flatMap((x) => (x.tipo === 'resultado' ? x.resultados : []))
    return { m, sala, celular, sesion, caja, admin, enlace, recibidos, revocar, resultados }
  }

  const abrir = (c: ReturnType<typeof conSala>, hora: string) =>
    c.m.evento(c.celular.conexion, c.sesion, 'PedidoAbierto', ABRIR, {
      hora_dispositivo: hora,
      hora_estimada_hub: hora,
    })

  it('revocar entre dos lotes: el primero entra, el segundo no', () => {
    const c = conSala()
    c.enlace.recibir({
      tipo: 'empujar',
      lote_id: 'l1',
      eventos: [abrir(c, c.m.reloj())],
    })
    c.m.avanzar(1000)
    c.revocar()
    c.m.avanzar(1000)
    c.enlace.recibir({
      tipo: 'empujar',
      lote_id: 'l2',
      eventos: [abrir(c, c.m.reloj())],
    })

    expect(c.resultados().map((x) => x.estado)).toEqual(['confirmado', 'rechazado'])
    expect(eventos(c.m)).toBe(1)
  })

  it('un lote creado antes de la revocación pero recibido después va a cuarentena, no se pierde ni entra', () => {
    const c = conSala()
    const antes = abrir(c, c.m.reloj())
    c.m.avanzar(5000)
    const revocadoEn = c.revocar()
    c.enlace.recibir({ tipo: 'empujar', lote_id: 'l1', eventos: [antes] })

    expect(c.resultados().map((x) => x.estado)).toEqual(['cuarentena'])
    expect(eventos(c.m)).toBe(0)
    expect(
      c.m.db.prepare('SELECT motivo FROM evento_cuarentena WHERE evento_id = ?').get(antes.id)
        ?.motivo,
    ).toBe('dispositivo_revocado')
    expect(revocadoEn).toBe(c.m.reloj())
  })

  it('el borde: un evento con la hora exacta de la revocación ya no cuenta como anterior', () => {
    const c = conSala()
    c.m.avanzar(5000)
    const revocadoEn = c.revocar()
    c.enlace.recibir({
      tipo: 'empujar',
      lote_id: 'l1',
      eventos: [
        abrir(c, sumar(revocadoEn, -1)),
        abrir(c, revocadoEn),
        abrir(c, sumar(revocadoEn, 1)),
      ],
    })

    expect(c.resultados().map((x) => x.estado)).toEqual(['cuarentena', 'rechazado', 'rechazado'])
  })

  it('un lote mixto de un dispositivo revocado: cada evento sigue su camino y el lote no se corta', () => {
    const c = conSala()
    const a = abrir(c, c.m.reloj())
    c.m.avanzar(5000)
    c.revocar()
    c.m.avanzar(5000)
    const b = abrir(c, c.m.reloj())
    c.enlace.recibir({ tipo: 'empujar', lote_id: 'l1', eventos: [a, b, a] })

    // El tercero repite al primero: misma respuesta.
    expect(c.resultados().map((x) => x.estado)).toEqual(['cuarentena', 'rechazado', 'cuarentena'])
  })

  it('un comprobante pedido antes de la revocación no se gasta con lo que queda en cuarentena', () => {
    const c = conSala()
    const sinComprobante = c.m.evento(
      c.celular.conexion,
      c.sesion,
      'ItemAnulado',
      datosAnular(nuevoId()),
      { motivo: 'x' },
    )
    const { evento } = autorizarEvento(
      c.m,
      c.celular.conexion,
      c.sesion,
      c.m.personas.gerente.pin,
      sinComprobante,
    )
    c.m.avanzar(10_000)
    c.revocar()
    c.enlace.recibir({ tipo: 'empujar', lote_id: 'l1', eventos: [evento] })

    expect(c.resultados().map((x) => x.estado)).toEqual(['cuarentena'])
    expect(comprobante(c.m)).toMatchObject({ usada_en: null })
    expect(eventos(c.m)).toBe(0)
  })

  it('revocar cierra las sesiones del equipo: aunque una conexión vieja no se entere, no pide comprobantes', () => {
    const c = conSala()
    const viejaConexion = c.celular.conexion // sigue creyendo que no está revocado
    c.revocar()

    expect(
      c.m.acceso.autorizar(viejaConexion, {
        ...c.sesion,
        pin: c.m.personas.gerente.pin,
        accion: 'anular_item_enviado',
        agregadoId: nuevoId(),
        eventoId: nuevoId(),
        huella: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false, codigo: 'sesion_invalida' })
    expect(c.m.acceso.cerrarSesion(viejaConexion, c.sesion)).toMatchObject({ ok: false })
    const alDia = c.m.acceso.autenticar(c.celular.token)
    expect(alDia?.revocadoEn).toBe(c.m.reloj())
    expect(c.m.acceso.iniciarSesion(alDia as never, c.m.personas.mesero.pin)).toMatchObject({
      codigo: 'dispositivo_revocado',
    })
  })

  it('un equipo revocado no aprueba emparejamientos aunque tenga el PIN del administrador', () => {
    const c = conSala()
    c.revocar()
    const alDia = c.m.acceso.autenticar(c.celular.token) as never

    expect(
      c.m.acceso.crearEmparejamiento(
        { pin: c.m.personas.admin.pin, nombre: 'Intruso', tipo: 'caja' },
        alDia,
      ),
    ).toMatchObject({ ok: false, codigo: 'dispositivo_revocado' })
  })

  it('revocar dos veces no cambia la fecha ni avisa dos veces', () => {
    const c = conSala()
    const primera = c.revocar()
    c.m.avanzar(60_000)
    const r2 = c.m.acceso.revocarDispositivo(c.caja, {
      ...c.admin,
      dispositivoId: c.celular.conexion.dispositivoId,
    })

    expect(r2).toEqual({ ok: true, revocadoEn: primera })
    expect(c.m.revocados).toEqual([c.celular.conexion.dispositivoId])
  })

  it('no se puede retirar un equipo que no existe, ni con el id de otra cosa', () => {
    const c = conSala()
    for (const id of [nuevoId(), '', c.m.restauranteId, c.m.personas.mesero.usuarioId])
      expect(
        c.m.acceso.revocarDispositivo(c.caja, { ...c.admin, dispositivoId: id }),
        id,
      ).toMatchObject({ ok: false, codigo: 'datos_invalidos' })
    expect(c.m.revocados).toEqual([])
  })

  it('la secuencia de revocación queda en el dispositivo, con quién lo retiró', () => {
    const c = conSala()
    pedidoConItemEnviado(c.m)
    c.revocar()
    const fila = c.m.db
      .prepare(
        'SELECT revocado_en, secuencia_revocacion, usuario_id, dispositivo_id FROM dispositivo WHERE id = ?',
      )
      .get(c.celular.conexion.dispositivoId)

    expect(fila).toEqual({
      revocado_en: c.m.reloj(),
      secuencia_revocacion: 3,
      usuario_id: c.m.personas.admin.usuarioId,
      dispositivo_id: c.caja.dispositivoId,
    })
  })

  it('tras 500 eventos en cuarentena de un equipo revocado, los siguientes se rechazan', () => {
    const c = conSala()
    const eventosViejos = Array.from({ length: 501 }, () => abrir(c, c.m.reloj()))
    c.m.avanzar(5000)
    c.revocar()
    for (let i = 0; i < eventosViejos.length; i += 100)
      c.enlace.recibir({
        tipo: 'empujar',
        lote_id: `l${i}`,
        eventos: eventosViejos.slice(i, i + 100),
      })

    const estados = c.resultados().map((x) => x.estado)
    expect(estados.filter((e) => e === 'cuarentena')).toHaveLength(500)
    expect(estados.at(-1)).toBe('rechazado')
  })
})
