import { esPermiso, PERMISOS, type Permiso, TIPOS_EVENTO_PEDIDO } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { montarAcceso } from './montaje'
import { autorizarEvento } from './montaje-hub'

// La matriz de docs/MODELO_DATOS.md#permisos, escrita aquí a mano (no leída del código) y
// comprobada de punta a punta: roles sembrados en la base × cada tipo de evento, por `verificar`.

type Rol = 'admin' | 'gerente' | 'cajero' | 'mesero' | 'cocina' | 'contador'
const ROLES: Rol[] = ['admin', 'gerente', 'cajero', 'mesero', 'cocina', 'contador']

const DOC: Record<Permiso, Rol[]> = {
  tomar_pedido: ['admin', 'gerente', 'cajero', 'mesero'],
  quitar_item_no_enviado: ['admin', 'gerente', 'cajero', 'mesero'],
  anular_item_enviado: ['admin', 'gerente'],
  cancelar_pedido: ['admin', 'gerente'],
  descontar: ['admin', 'gerente'],
  cortesia: ['admin', 'gerente'],
  reasignar_mesa: ['admin', 'gerente', 'cajero'],
  dividir_cuenta: ['admin', 'gerente', 'cajero'],
  registrar_pago: ['admin', 'gerente', 'cajero'],
  anular_pago: ['admin', 'gerente'],
  cerrar_mesa: ['admin', 'gerente', 'cajero'],
  reabrir_cuenta: ['admin', 'gerente'],
  abrir_turno_caja: ['admin', 'gerente', 'cajero'],
  cerrar_turno_caja: ['admin', 'gerente', 'cajero'],
  movimiento_caja: ['admin', 'gerente', 'cajero'],
  abrir_cajon_sin_venta: ['admin', 'gerente'],
  marcar_preparacion: ['admin', 'gerente', 'mesero', 'cocina'],
  agotar_producto: ['admin', 'gerente', 'cajero', 'cocina'],
  editar_catalogo: ['admin', 'gerente'],
  editar_precios: ['admin', 'gerente'],
  administrar_usuarios: ['admin'],
  administrar_dispositivos: ['admin'],
  ver_reportes: ['admin', 'gerente', 'contador'],
  ver_reportes_propios: ['cajero', 'mesero'],
}

/** Qué permiso pide cada evento según la columna «Permiso» de la tabla del documento. */
const EVENTO_DOC: Record<string, Permiso | null> = {
  PedidoAbierto: 'tomar_pedido',
  ComensalesCambiados: 'tomar_pedido',
  ItemAgregado: 'tomar_pedido',
  ItemCambiado: 'tomar_pedido',
  ItemsEnviados: 'tomar_pedido',
  ItemModificadoTrasEnvio: 'tomar_pedido',
  ComandaReimpresa: 'tomar_pedido',
  CursoRetenido: 'tomar_pedido',
  CursoMarchado: 'tomar_pedido',
  ItemsMovidos: 'tomar_pedido',
  PedidoMovidoDeMesa: 'tomar_pedido',
  PedidosUnidos: 'tomar_pedido',
  PrecuentaImpresa: 'tomar_pedido',
  ItemQuitado: 'quitar_item_no_enviado',
  ItemAnulado: 'anular_item_enviado',
  PedidoCancelado: 'cancelar_pedido',
  DescuentoAplicado: 'descontar',
  DescuentoRetirado: 'descontar',
  MeseroAsignado: 'reasignar_mesa',
  CuentaDividida: 'dividir_cuenta',
  DivisionDeshecha: 'dividir_cuenta',
  PagoRegistrado: 'registrar_pago',
  PagoAnulado: 'anular_pago',
  ReembolsoRegistrado: 'anular_pago',
  PedidoCerrado: 'cerrar_mesa',
  PedidoReabierto: 'reabrir_cuenta',
  ItemEnPreparacion: 'marcar_preparacion',
  ItemListo: 'marcar_preparacion',
  ItemEntregado: 'marcar_preparacion',
  ItemDevueltoACola: 'marcar_preparacion',
  PedidoRescateCreado: null,
  // Agotado (86): eventos del producto, no del pedido (tarea 1.3).
  ProductoAgotado: 'agotar_producto',
  ProductoDisponible: 'agotar_producto',
}

const SOLO_CAJA_DOC = ['PagoRegistrado', 'PagoAnulado', 'ReembolsoRegistrado', 'PedidoCerrado']

function montar() {
  const m = montarAcceso()
  const cocina = m.acceso.crearUsuario({ nombre: 'Coco', rolId: m.roles.cocina })
  const contador = m.acceso.crearUsuario({ nombre: 'Conta', rolId: m.roles.contador })
  const pin: Record<Rol, string> = {
    admin: m.personas.admin.pin,
    gerente: m.personas.gerente.pin,
    cajero: m.personas.cajero.pin,
    mesero: m.personas.mesero.pin,
    cocina: cocina.pin,
    contador: contador.pin,
  }
  const usuarios: Record<Rol, string> = {
    admin: m.personas.admin.usuarioId,
    gerente: m.personas.gerente.usuarioId,
    cajero: m.personas.cajero.usuarioId,
    mesero: m.personas.mesero.usuarioId,
    cocina: cocina.usuarioId,
    contador: contador.usuarioId,
  }

  /** Un dispositivo del tipo dado, con sesión abierta de ese rol (uno por rol: no se pisan). */
  function sesionDe(rol: Rol, tipo: 'caja' | 'mesero' | 'kds') {
    const { conexion } = m.emparejar(tipo, `${tipo}-${rol}`)
    const r = m.acceso.iniciarSesion(conexion, pin[rol])
    if (!r.ok) throw new Error(r.mensaje)
    return { conexion, sesion: r }
  }
  return { ...m, pin, usuarios, sesionDe }
}

describe('la matriz de permisos del documento, por rol', () => {
  it('la tabla del documento cubre todas las claves de permiso y todos los tipos de evento', () => {
    expect(Object.keys(DOC).sort()).toEqual([...PERMISOS].sort())
    expect(Object.keys(EVENTO_DOC).sort()).toEqual([...TIPOS_EVENTO_PEDIDO].sort())
  })

  it('cada rol sembrado en la base tiene exactamente los permisos de su columna', () => {
    const m = montar()
    for (const rol of ROLES) {
      const esperados = PERMISOS.filter((p) => DOC[p].includes(rol)).sort()
      expect(m.acceso.permisosDe(m.usuarios[rol]), rol).toEqual(esperados)
    }
  })

  it('la sesión entrega al dispositivo los permisos de su rol', () => {
    const m = montar()
    for (const rol of ROLES) {
      const { sesion } = m.sesionDe(rol, 'caja')
      expect([...sesion.permisos].sort(), rol).toEqual(
        PERMISOS.filter((p) => DOC[p].includes(rol)).sort(),
      )
    }
  })

  for (const rol of ROLES) {
    it(`${rol}: cada evento se acepta o se niega según la matriz (desde una caja)`, () => {
      const m = montar()
      const { conexion, sesion } = m.sesionDe(rol, 'caja')
      const fallos: string[] = []
      for (const tipo of TIPOS_EVENTO_PEDIDO) {
        const permiso = EVENTO_DOC[tipo] as Permiso | null
        const v = m.acceso.verificar(conexion, m.evento(conexion, sesion, tipo, {}), null)
        const esperado =
          permiso === null
            ? { ok: false, motivo: 'solo_hub' }
            : DOC[permiso].includes(rol)
              ? { ok: true, autorizadoPorId: null, autorizacionId: null }
              : { ok: false, motivo: 'sin_permiso' }
        if (JSON.stringify(v) !== JSON.stringify(esperado))
          fallos.push(`${tipo}: ${JSON.stringify(v)} (esperaba ${JSON.stringify(esperado)})`)
      }
      expect(fallos).toEqual([])
    })
  }

  it('la cortesía pide su propio permiso, no el de descontar', () => {
    const m = montar()
    for (const rol of ROLES) {
      const { conexion, sesion } = m.sesionDe(rol, 'caja')
      const cortesia = m.evento(conexion, sesion, 'DescuentoAplicado', { regla: 'cortesia' })
      const porcentaje = m.evento(conexion, sesion, 'DescuentoAplicado', { regla: 'porcentaje' })
      expect(m.acceso.verificar(conexion, cortesia, null).ok, `${rol} cortesía`).toBe(
        DOC.cortesia.includes(rol),
      )
      expect(m.acceso.verificar(conexion, porcentaje, null).ok, `${rol} descuento`).toBe(
        DOC.descontar.includes(rol),
      )
    }
  })

  it('si a un rol se le quita solo «cortesia», sigue pudiendo descontar (y al revés)', () => {
    const m = montar()
    const { conexion, sesion } = m.sesionDe('gerente', 'caja')
    const cortesia = m.evento(conexion, sesion, 'DescuentoAplicado', { regla: 'cortesia' })
    const porcentaje = m.evento(conexion, sesion, 'DescuentoAplicado', { regla: 'porcentaje' })

    m.db
      .prepare("UPDATE rol_permiso SET activo = 0 WHERE permiso = 'cortesia' AND rol_id = ?")
      .run(m.roles.gerente)
    expect(m.acceso.verificar(conexion, cortesia, null)).toEqual({
      ok: false,
      motivo: 'sin_permiso',
    })
    expect(m.acceso.verificar(conexion, porcentaje, null).ok).toBe(true)
  })

  it('pagos, reembolsos y cierres solo salen de una caja: ni el administrador desde un celular o un KDS', () => {
    const m = montar()
    for (const tipoDispositivo of ['mesero', 'kds'] as const)
      for (const rol of ROLES) {
        const { conexion, sesion } = m.sesionDe(rol, tipoDispositivo)
        for (const tipo of SOLO_CAJA_DOC)
          expect(
            m.acceso.verificar(conexion, m.evento(conexion, sesion, tipo, {}), null),
            `${rol}/${tipoDispositivo}/${tipo}`,
          ).toEqual({ ok: false, motivo: 'solo_caja' })
      }
  })

  it('el resto de eventos no distingue el tipo de dispositivo', () => {
    const m = montar()
    const tipos = TIPOS_EVENTO_PEDIDO.filter(
      (t) => !SOLO_CAJA_DOC.includes(t) && EVENTO_DOC[t] !== null,
    )
    for (const tipoDispositivo of ['mesero', 'caja', 'kds'] as const) {
      const { conexion, sesion } = m.sesionDe('gerente', tipoDispositivo)
      for (const t of tipos)
        expect(m.acceso.verificar(conexion, m.evento(conexion, sesion, t, {}), null).ok, t).toBe(
          true,
        )
    }
  })

  it('PedidoRescateCreado lo emite solo el hub: ni el administrador lo crea', () => {
    const m = montar()
    const { conexion, sesion } = m.sesionDe('admin', 'caja')
    expect(
      m.acceso.verificar(conexion, m.evento(conexion, sesion, 'PedidoRescateCreado', {}), null),
    ).toEqual({ ok: false, motivo: 'solo_hub' })
  })
})

describe('comprobante de supervisor para cada evento sin permiso', () => {
  it('quien no tiene el permiso lo consigue con un supervisor que sí lo tiene, para todo evento posible', () => {
    const m = montar()
    // El mesero escribe en una caja: así se prueban también pagos y cierres.
    const { conexion, sesion } = m.sesionDe('mesero', 'caja')
    const sinPermiso = TIPOS_EVENTO_PEDIDO.filter((t) => {
      const p = EVENTO_DOC[t] as Permiso | null
      return p !== null && !DOC[p].includes('mesero')
    })
    expect(sinPermiso.length).toBeGreaterThan(10)

    for (const tipo of sinPermiso) {
      const ev = m.evento(conexion, sesion, tipo, { regla: 'cortesia' })
      const accion = EVENTO_DOC[tipo] as Permiso
      // «cortesia» solo aplica a DescuentoAplicado con esa regla.
      const necesaria = tipo === 'DescuentoAplicado' ? 'cortesia' : accion
      const { comprobante, evento } = autorizarEvento(
        m,
        conexion,
        sesion,
        m.pin.admin,
        ev,
        necesaria,
      )
      expect(m.acceso.verificar(conexion, evento, null), tipo).toEqual({
        ok: true,
        autorizadoPorId: m.usuarios.admin,
        autorizacionId: comprobante.autorizacionId,
      })
    }
  })

  it('un supervisor sin ese permiso no puede emitir el comprobante, rol por rol y permiso por permiso', () => {
    const m = montar()
    // El administrador (con todos los permisos) está en el celular; los demás intentan autorizar.
    const { conexion, sesion } = m.sesionDe('mesero', 'mesero')
    // Un intento tras otro sería esperar: cada PIN válido (de alguien sin el permiso) cuenta como fallo.
    // Se avanza el reloj lo suficiente para que la espera nunca estorbe.
    for (const permiso of PERMISOS)
      for (const rol of ROLES) {
        m.avanzar(61_000)
        const r = m.acceso.autorizar(conexion, {
          ...sesion,
          pin: m.pin[rol],
          accion: permiso,
          agregadoId: m.restauranteId,
          eventoId: `${permiso}-${rol}`.padEnd(26, 'X').slice(0, 26),
          huella: '0'.repeat(64),
        })
        if (rol === 'mesero') {
          expect(r, `mesero/${permiso}`).toMatchObject({ ok: false, codigo: 'autoautorizacion' })
        } else if (DOC[permiso].includes(rol)) {
          expect(r.ok, `${rol}/${permiso}`).toBe(true)
        } else {
          expect(r, `${rol}/${permiso}`).toMatchObject({ ok: false, codigo: 'pin_incorrecto' })
        }
      }
  })

  it('el comprobante de «descontar» no sirve para una cortesía, ni al revés', () => {
    const m = montar()
    const { conexion, sesion } = m.sesionDe('mesero', 'caja')
    const intentar = (emitidoPara: Permiso, regla: string) => {
      const ev = m.evento(conexion, sesion, 'DescuentoAplicado', { regla })
      const r = autorizarEvento(m, conexion, sesion, m.pin.gerente, ev, emitidoPara)
      return m.acceso.verificar(conexion, r.evento, null)
    }

    expect(intentar('descontar', 'cortesia')).toEqual({
      ok: false,
      motivo: 'autorizacion_invalida',
    })
    expect(intentar('cortesia', 'porcentaje')).toEqual({
      ok: false,
      motivo: 'autorizacion_invalida',
    })
    expect(intentar('cortesia', 'cortesia').ok).toBe(true)
    expect(intentar('descontar', 'porcentaje').ok).toBe(true)
  })

  it('el comprobante no salta la regla «solo desde la caja»', () => {
    const m = montar()
    const { conexion, sesion } = m.sesionDe('mesero', 'mesero')
    const ev = m.evento(conexion, sesion, 'PagoRegistrado', {})
    const r = autorizarEvento(m, conexion, sesion, m.pin.admin, ev, 'registrar_pago')

    expect(m.acceso.verificar(conexion, r.evento, null)).toEqual({
      ok: false,
      motivo: 'solo_caja',
    })
  })

  it('una acción que no es permiso (ni inventada) no se autoriza', () => {
    const m = montar()
    const { conexion, sesion } = m.sesionDe('mesero', 'mesero')
    for (const accion of ['borrar_todo', '', 'constructor', '__proto__', 'TOMAR_PEDIDO'])
      expect(
        m.acceso.autorizar(conexion, {
          ...sesion,
          pin: m.pin.admin,
          accion,
          agregadoId: m.restauranteId,
          eventoId: `E-${accion}`.padEnd(26, 'X').slice(0, 26),
          huella: '0'.repeat(64),
        }),
        accion,
      ).toMatchObject({ ok: false, codigo: 'datos_invalidos' })
    for (const p of PERMISOS) expect(esPermiso(p)).toBe(true)
  })
})
