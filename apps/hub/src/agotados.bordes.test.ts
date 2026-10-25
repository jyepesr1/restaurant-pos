import { type EventoNuevo, nuevoId } from '@pos/core'
import { HubSync, type MensajeHub, SalaSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { describe, expect, it } from 'vitest'
import { ABRIR, item, type MontajeHub, montarHub, sumar } from './acceso/montaje-hub'
import { actualizarVersionado, SISTEMA } from './acceso/registros'

// Agotado (86) con el control de acceso real del hub: cuarentena, revocación, difusión a los
// demás equipos y que un ítem de un producto agotado se acepte (docs/SYNC.md, tarea 1.3).

const DE_PRODUCTO = (producto: string) => ({
  agregado_tipo: 'producto' as const,
  agregado_id: producto,
})
const datos = (producto: string, variante: string | null = null) => ({
  producto_id: producto,
  variante_id: variante,
})

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

const estadoEn = (m: MontajeHub, id: string) =>
  m.db.prepare('SELECT estado FROM evento_cuarentena WHERE evento_id = ?').get(id) ??
  m.db.prepare('SELECT motivo FROM evento_rechazado WHERE evento_id = ?').get(id)

describe('cuarentena y rechazos de un agotado', () => {
  /** Un cajero con su sesión abierta en la caja, y una función para armar un agotado a una hora. */
  function cajaConSesion() {
    const m = montarHub()
    const { conexion } = m.emparejar('caja')
    const sesion = m.entrar(conexion, 'cajero')
    const producto = nuevoId()
    const agotar = (hora = m.reloj(), extras = {}) =>
      m.evento(conexion, sesion, 'ProductoAgotado', datos(producto), {
        ...DE_PRODUCTO(producto),
        hora_dispositivo: hora,
        hora_estimada_hub: hora,
        ...extras,
      })
    return { m, conexion, sesion, producto, agotar }
  }

  it('al cajero le quitan el permiso: lo de antes va a cuarentena y lo de después se rechaza', () => {
    const { m, conexion, agotar } = cajaConSesion()
    const antes = agotar()
    m.avanzar(10 * 60_000)
    cambiarRol(m, m.personas.cajero.usuarioId, m.roles.mesero)
    const cambio = m.reloj()
    m.avanzar(10 * 60_000)
    const despues = agotar(sumar(cambio, 1000))

    const r = m.hub.recibirLote(conexion, [antes, despues])

    expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
    expect(r.resultados[1]).toMatchObject({ motivo: 'sin_permiso' })
    expect(
      m.db.prepare('SELECT motivo FROM evento_cuarentena WHERE evento_id = ?').get(antes.id)
        ?.motivo,
    ).toBe('permisos_cambiados')
    // Ni lo uno ni lo otro entró a la secuencia ni cambió pedido alguno.
    expect(m.db.prepare('SELECT count(*) AS n FROM evento').get()?.n).toBe(0)
    expect(r.aceptados).toEqual([])
  })

  it('al cajero lo archivan: lo de antes va a cuarentena y lo de después se rechaza', () => {
    const { m, conexion, agotar } = cajaConSesion()
    const antes = agotar()
    m.avanzar(10 * 60_000)
    m.acceso.archivarUsuario(m.personas.cajero.usuarioId)
    const archivado = m.reloj()
    m.avanzar(10 * 60_000)
    const despues = agotar(sumar(archivado, 1000))

    const r = m.hub.recibirLote(conexion, [antes, despues])

    expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
    expect(
      m.db.prepare('SELECT motivo FROM evento_cuarentena WHERE evento_id = ?').get(antes.id)
        ?.motivo,
    ).toBe('usuario_archivado')
    expect(r.resultados[1]).toMatchObject({ motivo: 'usuario_inactivo' })
  })

  it('un dispositivo revocado: el agotado de antes va a cuarentena y el de después se rechaza', () => {
    const { m, conexion, agotar } = cajaConSesion()
    const antes = agotar()
    m.avanzar(60_000)
    const revocado = { ...conexion, revocadoEn: m.reloj() }
    m.avanzar(60_000)
    const despues = agotar()

    const r = m.hub.recibirLote(revocado, [antes, despues])

    expect(r.resultados.map((x) => x.estado)).toEqual(['cuarentena', 'rechazado'])
    expect(r.resultados[1]).toMatchObject({ motivo: 'dispositivo_revocado' })
    expect(
      m.db.prepare('SELECT motivo FROM evento_cuarentena WHERE evento_id = ?').get(antes.id)
        ?.motivo,
    ).toBe('dispositivo_revocado')
  })

  it('una sesión que el hub no conoce va a cuarentena, sin tumbar al hub', () => {
    const { m, conexion, sesion, producto } = cajaConSesion()
    const ajena = { ...sesion, sesionId: nuevoId() }
    const e = m.evento(conexion, ajena, 'ProductoAgotado', datos(producto), DE_PRODUCTO(producto))
    expect(m.hub.recibirLote(conexion, [e]).resultados).toEqual([
      { id: e.id, estado: 'cuarentena' },
    ])
  })

  it('sin sesión, con la firma alterada o de otro dispositivo se rechaza', () => {
    const { m, conexion, sesion, producto, agotar } = cajaConSesion()
    const sinSesion = m.evento(
      conexion,
      { ...sesion, sesionId: null as unknown as string },
      'ProductoAgotado',
      datos(producto),
      { ...DE_PRODUCTO(producto), sesion_id: null },
    )
    const alterado = { ...agotar(), datos: datos(producto, nuevoId()) }
    const deOtro = { ...agotar(), dispositivo_id: nuevoId() }

    const r = m.hub.recibirLote(conexion, [sinSesion, alterado, deOtro])

    expect(r.resultados.map((x) => (x.estado === 'rechazado' ? x.motivo : x.estado))).toEqual([
      'sin_sesion',
      'firma_invalida',
      'dispositivo_distinto',
    ])
  })

  it('el mesero no puede, ni siquiera con el agotado de otro; cajero, gerente y administrador sí', () => {
    const m = montarHub()
    const producto = nuevoId()
    const probar = (quien: 'mesero' | 'cajero' | 'gerente' | 'admin') => {
      const { conexion } = m.emparejar(quien === 'cajero' ? 'caja' : 'mesero')
      const sesion = m.entrar(conexion, quien)
      const e = m.evento(
        conexion,
        sesion,
        'ProductoAgotado',
        datos(producto),
        DE_PRODUCTO(producto),
      )
      return m.hub.recibirLote(conexion, [e]).resultados[0]
    }
    expect(probar('mesero')).toMatchObject({ estado: 'rechazado', motivo: 'sin_permiso' })
    for (const quien of ['cajero', 'gerente', 'admin'] as const)
      expect(probar(quien), quien).toMatchObject({ estado: 'confirmado' })
  })

  it('un agotado rechazado en el lote no arrastra al pedido ni a otros productos', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('mesero')
    const sesion = m.entrar(conexion, 'mesero')
    const x = nuevoId()
    const y = nuevoId()
    const pedido = nuevoId()
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { agregado_id: pedido }),
      m.evento(conexion, sesion, 'ProductoAgotado', datos(x), DE_PRODUCTO(x)),
      m.evento(conexion, sesion, 'ProductoDisponible', datos(x), DE_PRODUCTO(x)),
      m.evento(conexion, sesion, 'ItemAgregado', item(), {
        agregado_id: pedido,
        secuencia_base: 1,
      }),
      m.evento(conexion, sesion, 'ProductoAgotado', datos(y), DE_PRODUCTO(y)),
    ])
    // El mesero no tiene permiso: los de producto se rechazan (el permiso se juzga antes que la
    // dependencia), pero el pedido y su ítem siguen su camino.
    expect(r.resultados.map((e) => (e.estado === 'rechazado' ? e.motivo : e.estado))).toEqual([
      'confirmado',
      'sin_permiso',
      'sin_permiso',
      'confirmado',
      'sin_permiso',
    ])
  })
})

describe('contenido del agotado', () => {
  it('es idempotente: el mismo evento recibe la misma respuesta; con otro contenido, id_repetido', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('caja')
    const sesion = m.entrar(conexion, 'cajero')
    const producto = nuevoId()
    const e = m.evento(conexion, sesion, 'ProductoAgotado', datos(producto), DE_PRODUCTO(producto))

    const a = m.hub.recibirLote(conexion, [e])
    const b = m.hub.recibirLote(conexion, [e])
    expect(b.resultados).toEqual(a.resultados)
    expect(b.aceptados).toEqual([])
    expect(m.db.prepare('SELECT count(*) AS n FROM evento').get()?.n).toBe(1)

    const otro = m.firmado(sesion, { ...e, datos: datos(producto, nuevoId()) } as EventoNuevo)
    expect(m.hub.recibirLote(conexion, [otro]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'id_repetido',
    })
  })

  it('una secuencia_base inventada se rechaza igual que en un pedido', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('caja')
    const sesion = m.entrar(conexion, 'cajero')
    const producto = nuevoId()
    const e = m.evento(conexion, sesion, 'ProductoAgotado', datos(producto), {
      ...DE_PRODUCTO(producto),
      secuencia_base: 50,
    })
    expect(m.hub.recibirLote(conexion, [e]).resultados[0]).toMatchObject({
      estado: 'rechazado',
      motivo: 'secuencia_base_invalida',
    })
  })

  it('se guarda como evento del producto y sobrevive al reinicio sin tocar los pedidos', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('caja')
    const sesion = m.entrar(conexion, 'cajero')
    const pedido = nuevoId()
    const producto = nuevoId()
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { agregado_id: pedido }),
      m.evento(conexion, sesion, 'ProductoAgotado', datos(producto), DE_PRODUCTO(producto)),
      m.evento(conexion, sesion, 'ItemAgregado', item(), {
        agregado_id: pedido,
        secuencia_base: 1,
      }),
      m.evento(conexion, sesion, 'ProductoDisponible', datos(producto), DE_PRODUCTO(producto)),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(Array(4).fill('confirmado'))
    expect(
      m.db
        .prepare('SELECT agregado_tipo, agregado_id FROM evento WHERE tipo = ?')
        .get('ProductoAgotado'),
    ).toEqual({ agregado_tipo: 'producto', agregado_id: producto })
    const antes = structuredClone(m.hub.pedido(pedido))

    const reiniciado = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
      restauranteId: m.restauranteId,
      zonaHoraria: 'America/Bogota',
      inicioDiaOperativo: '06:00',
      instancia: 'hub-1',
      reloj: m.reloj,
      acceso: m.acceso,
    })
    expect(reiniciado.pedido(pedido)).toEqual(antes)
    expect(reiniciado.pedido(producto)).toBeNull()
    expect(reiniciado.tienePedidoAbierto(nuevoId())).toBe(false)
    expect(reiniciado.traer(0, 'caja').eventos.map((e) => e.tipo)).toEqual([
      'PedidoAbierto',
      'ProductoAgotado',
      'ItemAgregado',
      'ProductoDisponible',
    ])
  })
})

describe('un ítem de un producto agotado', () => {
  it('se acepta: quien lo pidió sin conexión no se queda sin su pedido', () => {
    const m = montarHub()
    const caja = m.emparejar('caja')
    const cajero = m.entrar(caja.conexion, 'cajero')
    const celular = m.emparejar('mesero')
    const mesero = m.entrar(celular.conexion, 'mesero')
    const pedido = nuevoId()
    const producto = nuevoId()
    const it1 = { ...item(), producto_id: producto }

    // La caja agota el producto (secuencia 1); el mesero, sin saberlo, pide el producto.
    m.hub.recibirLote(caja.conexion, [
      m.evento(caja.conexion, cajero, 'ProductoAgotado', datos(producto), DE_PRODUCTO(producto)),
    ])
    const r = m.hub.recibirLote(celular.conexion, [
      m.evento(celular.conexion, mesero, 'PedidoAbierto', ABRIR, { agregado_id: pedido }),
      m.evento(celular.conexion, mesero, 'ItemAgregado', it1, { agregado_id: pedido }),
    ])

    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado'])
    expect(r.resultados[1]).toMatchObject({ conflicto: null })
    expect(Object.keys(m.hub.pedido(pedido)?.items ?? {})).toEqual([it1.item_id])
    expect(m.hub.conflictos()).toEqual([])
  })

  it('tampoco se rechaza cuando el agotado llega después en el mismo lote', () => {
    const m = montarHub()
    const { conexion } = m.emparejar('caja')
    const sesion = m.entrar(conexion, 'cajero')
    const pedido = nuevoId()
    const producto = nuevoId()
    const r = m.hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { agregado_id: pedido }),
      m.evento(conexion, sesion, 'ProductoAgotado', datos(producto), DE_PRODUCTO(producto)),
      m.evento(
        conexion,
        sesion,
        'ItemAgregado',
        { ...item(), producto_id: producto },
        {
          agregado_id: pedido,
          secuencia_base: 1,
        },
      ),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual(['confirmado', 'confirmado', 'confirmado'])
  })
})

describe('el aviso nuevo llega a los demás equipos', () => {
  it('un agotado de la caja lo reciben el celular y la cocina, sin la sesión de quien lo hizo', () => {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.acceso.autenticar)
    const caja = m.emparejar('caja')
    const celular = m.emparejar('mesero')
    const cocina = m.emparejar('kds')
    const recibidos: Record<string, MensajeHub[]> = { caja: [], celular: [], cocina: [] }
    const abrir = (nombre: string, token: string) => {
      const enlace = sala.conectar((x) => recibidos[nombre]?.push(x))
      enlace.recibir({ tipo: 'hola', token, hub_instancia: null, hasta: 0, version_app: 'x' })
      return enlace
    }
    const enCaja = abrir('caja', caja.token)
    abrir('celular', celular.token)
    abrir('cocina', cocina.token)

    const cajero = m.entrar(caja.conexion, 'cajero')
    const producto = nuevoId()
    const botella = nuevoId()
    const e = m.evento(
      caja.conexion,
      cajero,
      'ProductoAgotado',
      datos(producto, botella),
      DE_PRODUCTO(producto),
    )
    enCaja.recibir({ tipo: 'empujar', lote_id: 'l1', eventos: [e] })

    for (const nombre of ['celular', 'cocina', 'caja']) {
      const nuevo = recibidos[nombre]?.find((x) => x.tipo === 'nuevo')
      expect(nuevo, nombre).toMatchObject({
        evento: {
          id: e.id,
          tipo: 'ProductoAgotado',
          agregado_tipo: 'producto',
          secuencia: 1,
          datos: { producto_id: producto, variante_id: botella },
        },
        hasta_anterior: 0,
        hasta: 1,
      })
    }
    // Los demás no reciben la sesión de quien lo creó; la caja, que es suya, sí.
    const deCelular = recibidos.celular?.find((x) => x.tipo === 'nuevo')
    expect(deCelular?.tipo === 'nuevo' && deCelular.evento.sesion_id).toBeNull()
    const deCaja = recibidos.caja?.find((x) => x.tipo === 'nuevo')
    expect(deCaja?.tipo === 'nuevo' && deCaja.evento.sesion_id).toBe(cajero.sesionId)
  })

  it('un equipo revocado no recibe el aviso, y uno que se conecta después lo trae con `traer`', () => {
    const m = montarHub()
    const sala = new SalaSync(m.hub, m.acceso.autenticar)
    const caja = m.emparejar('caja')
    const celular = m.emparejar('mesero')
    const recibidos: MensajeHub[] = []
    const enlace = sala.conectar((x) => recibidos.push(x))
    enlace.recibir({
      tipo: 'hola',
      token: celular.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    sala.revocar(celular.conexion.dispositivoId, m.reloj())

    const cajero = m.entrar(caja.conexion, 'cajero')
    const producto = nuevoId()
    m.hub.recibirLote(caja.conexion, [
      m.evento(caja.conexion, cajero, 'ProductoAgotado', datos(producto), DE_PRODUCTO(producto)),
    ])
    expect(recibidos.some((x) => x.tipo === 'nuevo')).toBe(false)

    const tarde: MensajeHub[] = []
    const otro = sala.conectar((x) => tarde.push(x))
    const nuevoCelular = m.emparejar('mesero')
    otro.recibir({
      tipo: 'hola',
      token: nuevoCelular.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    otro.recibir({ tipo: 'traer', desde: 0 })
    const eventos = tarde.find((x) => x.tipo === 'eventos')
    expect(eventos?.tipo === 'eventos' && eventos.eventos.map((e) => e.tipo)).toEqual([
      'ProductoAgotado',
    ])
  })
})

// Evita que el helper `estadoEn` quede sin uso si se simplifican las pruebas anteriores.
void estadoEn
