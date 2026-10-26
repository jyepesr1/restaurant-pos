import {
  cuadreDeTurno,
  type EstadoPedido,
  type EventoPedido,
  informe,
  nuevoId,
  reconstruir,
  totalesPedido,
} from '@pos/core'
import { aplicarMigraciones } from '@pos/db'
import { abrirBase } from '@pos/db/node'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { accionArb } from '../../core/src/pruebas/simulador'
import { AlmacenMemoria } from './hub/almacen'
import { AlmacenSqlite } from './hub/almacen-sqlite'
import { cierreDeTurno, cuadreGuardado, datosDeInforme } from './hub/informe'
import { armarHistoria, cargar, DIAS, type PlanDeHistoria } from './pruebas/historias'
import { AHORA, baseSqlite } from './pruebas/montaje'

// Lo que el hub lee de la base para los reportes (tarea 1.9, docs/KPIS.md#período), con historias
// al azar del simulador del reductor: pagos, anulaciones y reembolsos de otro día, pedidos
// reabiertos y vueltos a cerrar, y turnos de caja. Lo mismo con el almacén en memoria y con SQLite.

const CONFIG = { seed: 20_261_041, numRuns: 120 }
const CONFIG_INFORME = { ventas_por_mesero: 'quien_agrega', redondeo_modo: 'mitad_arriba' } as const

const plan = fc.record<PlanDeHistoria>({
  acciones: fc.array(accionArb, { minLength: 10, maxLength: 70, size: 'max' }),
  dias: fc.array(fc.nat(2), { minLength: 1, maxLength: 150 }),
  cierra: fc.tuple(fc.boolean(), fc.boolean()),
  propinas: fc.tuple(fc.constantFrom(0, 1_000), fc.constantFrom(0, 2_500)),
})
const ventana = fc.record({ desde: fc.nat(2), largo: fc.nat(2) })
const rango = (v: { desde: number; largo: number }) => ({
  desde: DIAS[Math.min(v.desde, 2)] as string,
  hasta: DIAS[Math.min(v.desde + v.largo, 2)] as string,
})

const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

function almacenes(eventos: readonly EventoPedido[]) {
  const memoria = new AlmacenMemoria()
  cargar(memoria, eventos)
  const { db, restauranteId } = baseSqlite()
  const sqlite = new AlmacenSqlite(db, restauranteId)
  cargar(sqlite, eventos)
  return { memoria, sqlite, db, restauranteId }
}

describe('datosDeInforme con historias al azar', () => {
  it('es igual con el almacén en memoria, con SQLite y tras reabrir la base', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memoria, sqlite, db, restauranteId } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const enMemoria = datosDeInforme(memoria, desde, hasta)
        const enSqlite = datosDeInforme(sqlite, desde, hasta)
        expect(enSqlite).toEqual(enMemoria)
        // «Reiniciar el hub»: otro almacén sobre la misma base da lo mismo.
        expect(datosDeInforme(new AlmacenSqlite(db, restauranteId), desde, hasta)).toEqual(
          enMemoria,
        )
        // Y el informe que sale de ellos.
        expect(informe({ ...enSqlite, config: CONFIG_INFORME })).toEqual(
          informe({ ...enMemoria, config: CONFIG_INFORME }),
        )
      }),
      CONFIG,
    )
  })

  it('hay un cierre por cada PedidoCerrado del período, con el pedido al cerrar y en su cierre anterior', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memoria, sqlite } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const datos = datosDeInforme(memoria, desde, hasta)
        expect(datosDeInforme(sqlite, desde, hasta).cierres).toEqual(datos.cierres)
        const cierres = h.eventos.filter(
          (e) => e.tipo === 'PedidoCerrado' && e.dia_operativo >= desde && e.dia_operativo <= hasta,
        )
        expect(datos.cierres).toHaveLength(cierres.length)
        for (const [i, c] of cierres.entries()) {
          const dato = datos.cierres[i]
          const previos = h.eventos.filter(
            (e) =>
              e.tipo === 'PedidoCerrado' &&
              e.agregado_id === c.agregado_id &&
              e.secuencia < c.secuencia,
          )
          const hasta1 = (secuencia: number) =>
            reconstruir(
              h.eventos.filter((e) => e.secuencia <= secuencia),
              c.agregado_id,
            )
          expect(dato?.despues).toEqual(hasta1(c.secuencia))
          // El primer cierre no tiene anterior; los demás parten del cierre inmediatamente anterior.
          const anterior = previos.at(-1)
          expect(dato?.antes ?? null).toEqual(anterior ? hasta1(anterior.secuencia) : null)
          expect(dato?.despues.estado).toBe('cerrado')
        }
      }),
      { ...CONFIG, seed: 20_261_042 },
    )
  })

  it('los eventos del período son los de su día, en orden, y cada reverso trae su pago', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { sqlite } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const datos = datosDeInforme(sqlite, desde, hasta)
        const secuencias = datos.eventos.map((e) => e.secuencia)
        expect(secuencias).toEqual([...secuencias].sort((a, b) => (a ?? 0) - (b ?? 0)))
        expect(new Set(datos.eventos.map((e) => e.id)).size).toBe(datos.eventos.length)
        const pagos = new Set(
          datos.eventos.filter((e) => e.tipo === 'PagoRegistrado').map((e) => e.datos.pago_id),
        )
        const delPeriodo = h.eventos.filter(
          (e) =>
            e.dia_operativo >= desde &&
            e.dia_operativo <= hasta &&
            [
              'PagoRegistrado',
              'PagoAnulado',
              'ReembolsoRegistrado',
              'ItemAnulado',
              'PedidoCancelado',
              'MovimientoCajaRegistrado',
            ].includes(e.tipo),
        )
        // Todo lo del período está, y lo que sobra son solo pagos de otro día que alguien reversó.
        const ids = new Set(datos.eventos.map((e) => e.id))
        for (const e of delPeriodo) expect(ids).toContain(e.id)
        const delDia = new Set(delPeriodo.map((e) => e.id))
        for (const e of datos.eventos) {
          if (delDia.has(e.id)) continue
          expect(e.tipo).toBe('PagoRegistrado')
          expect(
            datos.eventos.some(
              (x) =>
                (x.tipo === 'PagoAnulado' || x.tipo === 'ReembolsoRegistrado') &&
                x.datos.pago_id === (e.datos as { pago_id: string }).pago_id,
            ),
          ).toBe(true)
        }
        for (const e of datos.eventos) {
          if (e.tipo === 'PagoAnulado' || e.tipo === 'ReembolsoRegistrado')
            expect(pagos).toContain(e.datos.pago_id)
        }
      }),
      { ...CONFIG, seed: 20_261_043 },
    )
  })

  it('las anulaciones y reembolsos de un pago de otro día restan el día en que se registran', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { sqlite } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const r = informe({ ...datosDeInforme(sqlite, desde, hasta), config: CONFIG_INFORME })
        // Aparte, sobre todos los eventos: el dinero que entró o salió por medio en esos días.
        const pagos = new Map(
          h.eventos
            .filter((e) => e.tipo === 'PagoRegistrado')
            .map((e) => [e.datos.pago_id, e.datos] as const),
        )
        const esperado = new Map<string, number>()
        const mover = (clave: string, n: number) =>
          esperado.set(clave, (esperado.get(clave) ?? 0) + n)
        for (const e of h.eventos) {
          if (e.dia_operativo < desde || e.dia_operativo > hasta) continue
          if (e.tipo === 'PagoRegistrado')
            mover(
              `${e.datos.medio}:${e.datos.medio_propio_id ?? ''}`,
              e.datos.monto + e.datos.ajuste_redondeo,
            )
          else if (e.tipo === 'PagoAnulado') {
            const o = pagos.get(e.datos.pago_id)
            if (o) mover(`${o.medio}:${o.medio_propio_id ?? ''}`, -(o.monto + o.ajuste_redondeo))
          } else if (e.tipo === 'ReembolsoRegistrado') {
            const o = pagos.get(e.datos.pago_id)
            mover(`${e.datos.medio}:${o?.medio_propio_id ?? ''}`, -e.datos.monto_venta)
          }
        }
        for (const m of r.porMedio)
          expect(m.venta, `${m.medio}`).toBe(
            esperado.get(`${m.medio}:${m.medioPropioId ?? ''}`) ?? 0,
          )
        // Lo que no salió en el informe tiene que ser 0 en el oráculo.
        const salieron = new Set(r.porMedio.map((m) => `${m.medio}:${m.medioPropioId ?? ''}`))
        for (const [clave, n] of esperado) if (!salieron.has(clave)) expect(n).toBe(0)
      }),
      { ...CONFIG, seed: 20_261_044 },
    )
  })

  it('cada anulación vale unidades × el precio con extras que tenía el ítem, esté donde esté hoy', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { sqlite } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const r = informe({ ...datosDeInforme(sqlite, desde, hasta), config: CONFIG_INFORME })
        // El precio de cada ítem, tomado de su alta o de la copia que viajó al mover o unir.
        const precios = new Map<string, number>()
        const copia = (i: {
          item_id: string
          precio_unitario: number
          modificadores: { precio_extra: number }[]
        }) =>
          precios.set(
            i.item_id,
            i.precio_unitario + suma(i.modificadores.map((m) => m.precio_extra)),
          )
        for (const e of h.eventos) {
          if (e.tipo === 'ItemAgregado') copia(e.datos)
          else if (e.tipo === 'ItemsMovidos' || e.tipo === 'PedidosUnidos')
            for (const m of e.datos.items) copia(m.item)
        }
        const anulados = h.eventos.filter(
          (e) => e.tipo === 'ItemAnulado' && e.dia_operativo >= desde && e.dia_operativo <= hasta,
        )
        expect(r.anulaciones.map((a) => a.eventoId)).toEqual(anulados.map((e) => e.id))
        for (const [i, a] of r.anulaciones.entries()) {
          const e = anulados[i]
          if (e?.tipo !== 'ItemAnulado') throw new Error('desorden')
          expect(a.valor).toBe(e.datos.cantidad * (precios.get(e.datos.item_id) ?? Number.NaN))
          expect(a.nombre).not.toBe('Producto')
        }
      }),
      { ...CONFIG, seed: 20_261_049 },
    )
  })

  it('el neto del período es lo pagado de más en cada cierre que en el anterior, sin reembolsos', () => {
    const pagado = (p: EstadoPedido | null) =>
      suma(
        Object.values(p?.pagos ?? {})
          .filter((x) => !x.anulado)
          .map((x) => x.monto - x.reembolsadoVenta),
      )
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memoria } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const datos = datosDeInforme(memoria, desde, hasta)
        const r = informe({ ...datos, config: CONFIG_INFORME })
        expect(r.ventas.neto).toBe(
          suma(datos.cierres.map((c) => pagado(c.despues) - pagado(c.antes))),
        )
        expect(suma(r.porProducto.map((x) => x.neto))).toBe(r.ventas.neto)
        expect(suma(r.porMesero.map((x) => x.neto))).toBe(r.ventas.neto)
        expect(suma(r.ventas.impuestos.map((x) => x.base + x.impuesto))).toBe(r.ventas.neto)
        // Una cuenta y sus comensales se cuentan una vez: en el primer cierre.
        expect(r.ventas.comensales).toBe(
          suma(datos.cierres.filter((c) => c.antes === null).map((c) => c.despues.comensales)),
        )
      }),
      { ...CONFIG, seed: 20_261_045 },
    )
  })
})

describe('turnos de caja leídos de la base', () => {
  it('el cuadre guardado, los cobros del turno y el cierre son los mismos en memoria y en SQLite', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = armarHistoria(p)
        const { memoria, sqlite } = almacenes(h.eventos)
        for (const [n, turno] of h.turnos.entries()) {
          const apertura = DIAS[0]
          const cobrosEsperados = h.eventos.filter(
            (e) =>
              ['PagoRegistrado', 'PagoAnulado', 'ReembolsoRegistrado'].includes(e.tipo) &&
              (e.datos as { turno_caja_id?: string }).turno_caja_id === turno,
          )
          expect(memoria.cobrosDeTurno(turno, apertura).map((e) => e.id)).toEqual(
            cobrosEsperados.map((e) => e.id),
          )
          expect(sqlite.cobrosDeTurno(turno, apertura).map((e) => e.id)).toEqual(
            cobrosEsperados.map((e) => e.id),
          )
          // El cuadre desde la base es el del turno calculado con todos los eventos.
          const completo = cuadreDeTurno(h.eventos, turno)
          expect(cuadreGuardado(sqlite, turno)).toEqual(completo)
          expect(cuadreGuardado(memoria, turno)).toEqual(completo)
          const cierre = cierreDeTurno(sqlite, turno)
          expect(cierreDeTurno(memoria, turno)).toEqual(cierre)
          if (p.cierra[n as 0 | 1]) {
            expect(cierre?.cuadre.cerrado).not.toBeNull()
            expect(cierre?.diaOperativo).toBe(DIAS[2])
            expect(cierre?.diaApertura).toBe(DIAS[0])
          } else expect(cierre).toBeNull()
        }
      }),
      { ...CONFIG, seed: 20_261_046 },
    )
  })

  it('un turno sin abrir o inventado no tiene cuadre ni cierre ni cobros', () => {
    const { memoria, sqlite } = almacenes([])
    for (const a of [memoria, sqlite]) {
      const id = nuevoId()
      expect(cuadreGuardado(a, id)).toBeNull()
      expect(cierreDeTurno(a, id)).toBeNull()
      expect(a.cobrosDeTurno(id, DIAS[0])).toEqual([])
      expect(a.eventosDelPeriodo(['PedidoCerrado'], DIAS[0], DIAS[2])).toEqual([])
      expect(a.eventosDelPeriodo([], DIAS[0], DIAS[2])).toEqual([])
    }
  })
})

describe('multirestaurante: el informe de uno no ve al otro', () => {
  /** Una base con dos restaurantes: el segundo se agrega a la del montaje. */
  function dosRestaurantes() {
    const { db, restauranteId: a } = baseSqlite()
    const b = nuevoId()
    db.prepare(
      `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
       VALUES (?, ?, ?, ?, 1, 'Otro', '{}')`,
    ).run(b, b, AHORA, AHORA)
    return { db, a, b }
  }

  it('con historias distintas, cada informe es el mismo que sin el otro restaurante', () => {
    fc.assert(
      fc.property(plan, plan, ventana, (pa, pb, v) => {
        const ha = armarHistoria(pa)
        const hb = armarHistoria(pb)
        const { db, a, b } = dosRestaurantes()
        const almA = new AlmacenSqlite(db, a)
        const almB = new AlmacenSqlite(db, b)
        // Entrelazados: A, B, A, B...
        const n = Math.max(ha.eventos.length, hb.eventos.length)
        for (let i = 0; i < n; i++) {
          const ea = ha.eventos[i]
          const eb = hb.eventos[i]
          if (ea) cargar(almA, [ea])
          if (eb) cargar(almB, [eb])
        }
        const solo = (eventos: EventoPedido[]) => {
          const m = new AlmacenMemoria()
          cargar(m, eventos)
          return m
        }
        const { desde, hasta } = rango(v)
        expect(datosDeInforme(almA, desde, hasta)).toEqual(
          datosDeInforme(solo(ha.eventos), desde, hasta),
        )
        expect(datosDeInforme(almB, desde, hasta)).toEqual(
          datosDeInforme(solo(hb.eventos), desde, hasta),
        )
        // Los turnos del uno no existen para el otro (el simulador comparte el id TURNO: los cuadres
        // de cada restaurante cuentan solo sus propios pagos).
        for (const t of ha.turnos) {
          expect(cuadreGuardado(almA, t)).toEqual(cuadreGuardado(solo(ha.eventos), t))
          expect(cuadreGuardado(almB, t)).toEqual(cuadreGuardado(solo(hb.eventos), t))
        }
      }),
      { ...CONFIG, numRuns: 40, seed: 20_261_047 },
    )
  })

  it('con los mismos ids en los dos, lo de uno nunca aparece en el otro', () => {
    const h = armarHistoria({
      acciones: [],
      dias: [1],
      cierra: [true, true],
      propinas: [0, 0],
    })
    const { db, a, b } = dosRestaurantes()
    const almA = new AlmacenSqlite(db, a)
    const almB = new AlmacenSqlite(db, b)
    cargar(almA, h.eventos)
    for (const t of h.turnos) {
      expect(cierreDeTurno(almA, t)).not.toBeNull()
      expect(cierreDeTurno(almB, t)).toBeNull()
      expect(cuadreGuardado(almB, t)).toBeNull()
      expect(almB.cobrosDeTurno(t, DIAS[0])).toEqual([])
    }
    const vacio = datosDeInforme(almB, DIAS[0], DIAS[2])
    expect(vacio).toMatchObject({
      cierres: [],
      relacionados: [],
      eventos: [],
      cierresDeCaja: [],
    })
    expect(datosDeInforme(almA, DIAS[0], DIAS[2]).cierresDeCaja).toHaveLength(2)
  })

  it('misma base en un archivo: reabrirla sigue separando los restaurantes', () => {
    // Una base nueva por prueba, sin tocar la de nadie más.
    const db = abrirBase(':memory:')
    aplicarMigraciones(db)
    const ids = [nuevoId(), nuevoId()] as const
    for (const id of ids)
      db.prepare(
        `INSERT INTO restaurante (id, restaurante_id, creado_en, actualizado_en, version, nombre, config)
         VALUES (?, ?, ?, ?, 1, 'R', '{}')`,
      ).run(id, id, AHORA, AHORA)
    const h = armarHistoria({
      acciones: [],
      dias: [2],
      cierra: [true, false],
      propinas: [500, 0],
    })
    cargar(new AlmacenSqlite(db, ids[0]), h.eventos)
    const reabierto = new AlmacenSqlite(db, ids[1])
    expect(datosDeInforme(reabierto, DIAS[0], DIAS[2]).eventos).toEqual([])
    expect(
      datosDeInforme(new AlmacenSqlite(db, ids[0]), DIAS[0], DIAS[2]).cierresDeCaja,
    ).toHaveLength(1)
  })
})

describe('las historias llegan a los casos que importan', () => {
  it('hay cierres en otro día, reaperturas, reversos de otro día, turnos cerrados y propinas', () => {
    const visto = {
      cerrados: 0,
      cierreDeUnaReapertura: 0,
      reabiertoSinCerrar: 0,
      reversoDeOtroDia: 0,
      turnoCerrado: 0,
    }
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memoria } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const datos = datosDeInforme(memoria, desde, hasta)
        if (datos.cierres.length > 0) visto.cerrados += 1
        if (datos.cierres.some((c) => c.antes !== null)) visto.cierreDeUnaReapertura += 1
        if (datos.cierresDeCaja.length > 0) visto.turnoCerrado += 1
        for (const estado of h.servicio.estados) {
          if (!estado) continue
          const cierres = h.eventos.filter(
            (e) => e.tipo === 'PedidoCerrado' && e.agregado_id === estado.id,
          )
          const reabierto = h.eventos.some(
            (e) => e.tipo === 'PedidoReabierto' && e.agregado_id === estado.id,
          )
          if (reabierto && estado.estado === 'abierto' && cierres.length > 0)
            visto.reabiertoSinCerrar += 1
        }
        const registrados = new Map(
          h.eventos
            .filter((e) => e.tipo === 'PagoRegistrado')
            .map((e) => [e.datos.pago_id, e.dia_operativo] as const),
        )
        if (
          datos.eventos.some(
            (e) =>
              (e.tipo === 'PagoAnulado' || e.tipo === 'ReembolsoRegistrado') &&
              registrados.get(e.datos.pago_id) !== e.dia_operativo,
          )
        )
          visto.reversoDeOtroDia += 1
      }),
      { ...CONFIG, numRuns: 300, seed: 20_261_048 },
    )
    for (const [caso, n] of Object.entries(visto)) expect(n, caso).toBeGreaterThan(0)
  })
})

// ── Lo ya reportado de un día no cambia (DINERO.md#día-operativo-e-informes) ──────────────────

const ventasDe = (a: AlmacenMemoria | AlmacenSqlite, desde: string, hasta = desde) =>
  informe({ ...datosDeInforme(a, desde, hasta), config: CONFIG_INFORME })

/** Historias con los días en orden, como en la vida real: nada nuevo cae en un día ya pasado. */
const planOrdenado = fc.record<PlanDeHistoria>({
  acciones: fc.array(accionArb, { minLength: 10, maxLength: 80, size: 'max' }),
  dias: fc.constant([1]),
  cierra: fc.constant<[boolean, boolean]>([false, false]),
  propinas: fc.constant<[number, number]>([0, 0]),
  cortes: fc
    .tuple(fc.nat(50), fc.nat(50))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
})

const CAMPOS = ['bruto', 'anulado', 'descuentos', 'neto', 'ajustes', 'propinas'] as const

describe('lo reportado de un día no cambia', () => {
  it('el informe de un día es el mismo hoy que tras cualquier evento posterior en otros días', () => {
    fc.assert(
      fc.property(planOrdenado, (p) => {
        const h = armarHistoria(p)
        const { memoria, sqlite } = almacenes(h.eventos)
        for (const dia of DIAS) {
          // Lo que se sabía al terminar ese día: todo lo registrado hasta él.
          const hastaElDia = h.eventos.filter((e) => e.dia_operativo <= dia)
          const { memoria: ayer, sqlite: ayerSqlite } = almacenes(hastaElDia)
          const entonces = ventasDe(ayer, dia)
          expect(ventasDe(memoria, dia)).toEqual(entonces)
          expect(ventasDe(sqlite, dia)).toEqual(entonces)
          expect(ventasDe(ayerSqlite, dia)).toEqual(entonces)
        }
      }),
      { ...CONFIG, seed: 20_261_050, numRuns: 60 },
    )
  })

  it('ni los cierres de mesa de ese día cambian: cada uno parte del cierre anterior y llega al suyo', () => {
    fc.assert(
      fc.property(planOrdenado, (p) => {
        const h = armarHistoria(p)
        const { memoria } = almacenes(h.eventos)
        for (const dia of DIAS) {
          const { memoria: ayer } = almacenes(h.eventos.filter((e) => e.dia_operativo <= dia))
          expect(datosDeInforme(memoria, dia, dia).cierres).toEqual(
            datosDeInforme(ayer, dia, dia).cierres,
          )
          expect(datosDeInforme(memoria, dia, dia).eventos).toEqual(
            datosDeInforme(ayer, dia, dia).eventos,
          )
        }
      }),
      { ...CONFIG, seed: 20_261_051, numRuns: 40 },
    )
  })
})

describe('Σ por días = el estado final', () => {
  it('lo que suman los días de un pedido reabierto es su estado al último cierre', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = armarHistoria(p)
        const { memoria } = almacenes(h.eventos)
        const dias = DIAS.map((d) => ventasDe(memoria, d).ventas)
        const esperado = { bruto: 0, anulado: 0, descuentos: 0, neto: 0, ajustes: 0, propinas: 0 }
        let cuentas = 0
        let comensales = 0
        for (const id of h.servicio.pedidos) {
          const cierres = h.eventos.filter(
            (e) => e.tipo === 'PedidoCerrado' && e.agregado_id === id,
          )
          const primero = cierres.at(0)
          const ultimo = cierres.at(-1)
          if (!primero || !ultimo) continue
          const estadoEn = (secuencia: number) =>
            reconstruir(
              h.eventos.filter((e) => e.secuencia <= secuencia),
              id,
            ) as EstadoPedido
          const final = totalesPedido(estadoEn(ultimo.secuencia))
          esperado.bruto += final.bruto
          esperado.anulado += final.anulado
          esperado.descuentos += final.descuento
          esperado.neto += final.neto
          esperado.ajustes += final.ajustes
          esperado.propinas += final.propinas
          const inicial = estadoEn(primero.secuencia)
          comensales += inicial.comensales
          if (totalesPedido(inicial).neto > 0) cuentas += 1
        }
        for (const campo of CAMPOS)
          expect(suma(dias.map((d) => d[campo])), campo).toBe(esperado[campo])
        expect(suma(dias.map((d) => d.cuentas))).toBe(cuentas)
        expect(suma(dias.map((d) => d.comensales))).toBe(comensales)
      }),
      { ...CONFIG, seed: 20_261_052, numRuns: 100 },
    )
  })

  it('cada día, base + impuesto es su neto, también cuando el neto del día es negativo', () => {
    fc.assert(
      fc.property(plan, (p) => {
        const h = armarHistoria(p)
        const { memoria } = almacenes(h.eventos)
        for (const d of DIAS) {
          const v = ventasDe(memoria, d).ventas
          expect(suma(v.impuestos.map((i) => i.base + i.impuesto))).toBe(v.neto)
        }
      }),
      { ...CONFIG, seed: 20_261_054 },
    )
  })
})

describe('un rango es la suma de sus días', () => {
  it('neto, bruto, anulado, descuentos, ajustes, propinas, cuentas y comensales', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memoria, sqlite } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const dias = DIAS.filter((d) => d >= desde && d <= hasta)
        const todo = ventasDe(sqlite, desde, hasta).ventas
        const porDia = dias.map((d) => ventasDe(memoria, d).ventas)
        for (const campo of [...CAMPOS, 'cuentas', 'comensales'] as const)
          expect(todo[campo], campo).toBe(suma(porDia.map((d) => d[campo])))
      }),
      { ...CONFIG, seed: 20_261_055 },
    )
  })

  it('por medio, por mesero, por producto, anulaciones, cancelaciones, descuentos y fondo', () => {
    fc.assert(
      fc.property(plan, ventana, (p, v) => {
        const h = armarHistoria(p)
        const { memoria } = almacenes(h.eventos)
        const { desde, hasta } = rango(v)
        const dias = DIAS.filter((d) => d >= desde && d <= hasta)
        const todo = ventasDe(memoria, desde, hasta)
        const porDia = dias.map((d) => ventasDe(memoria, d))
        const sumarPor = <T>(
          lista: T[][],
          clave: (x: T) => string,
          campos: ((x: T) => number)[],
        ) => {
          const m = new Map<string, number[]>()
          for (const fila of lista.flat()) {
            const acc = m.get(clave(fila)) ?? campos.map(() => 0)
            campos.forEach((c, i) => {
              acc[i] = (acc[i] ?? 0) + c(fila)
            })
            m.set(clave(fila), acc)
          }
          // Lo que suma cero no sale en el informe.
          return new Map([...m].filter(([, a]) => a.some((n) => n !== 0)))
        }
        const comoMapa = <T>(lista: T[], clave: (x: T) => string, campos: ((x: T) => number)[]) =>
          sumarPor([lista], clave, campos)

        const medio = (m: { medio: string; medioPropioId: string | null }) =>
          `${m.medio}:${m.medioPropioId ?? ''}`
        expect(
          comoMapa(todo.porMedio, medio, [(m) => m.venta, (m) => m.propina, (m) => m.pagos]),
        ).toEqual(
          sumarPor(
            porDia.map((d) => d.porMedio),
            medio,
            [(m) => m.venta, (m) => m.propina, (m) => m.pagos],
          ),
        )
        expect(
          comoMapa(todo.porMesero, (m) => m.usuarioId, [(m) => m.neto, (m) => m.cuentas]),
        ).toEqual(
          sumarPor(
            porDia.map((d) => d.porMesero),
            (m) => m.usuarioId,
            [(m) => m.neto, (m) => m.cuentas],
          ),
        )
        const producto = (x: { productoId: string; varianteId: string | null }) =>
          `${x.productoId}:${x.varianteId ?? ''}`
        expect(comoMapa(todo.porProducto, producto, [(x) => x.unidades, (x) => x.neto])).toEqual(
          sumarPor(
            porDia.map((d) => d.porProducto),
            producto,
            [(x) => x.unidades, (x) => x.neto],
          ),
        )
        expect(todo.anulaciones.map((a) => a.eventoId)).toEqual(
          porDia.flatMap((d) => d.anulaciones.map((a) => a.eventoId)),
        )
        expect(todo.cancelaciones.map((a) => a.eventoId)).toEqual(
          porDia.flatMap((d) => d.cancelaciones.map((a) => a.eventoId)),
        )
        expect(todo.descuentos).toHaveLength(suma(porDia.map((d) => d.descuentos.length)))
        for (const campo of ['propinas', 'pagadas', 'saldo'] as const)
          expect(todo.fondoPropinas[campo]).toBe(suma(porDia.map((d) => d.fondoPropinas[campo])))
      }),
      { ...CONFIG, seed: 20_261_056 },
    )
  })
})
