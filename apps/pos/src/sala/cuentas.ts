import {
  cobradoEnEfectivo,
  dividirPorItems,
  type EstadoPedido,
  exigirPesos,
  type MedioPago,
  type ModoRedondeoEfectivo,
  partesIguales,
  propinaDelPedido,
  propinaPendienteDeCuenta,
  repartirPropina,
  saldoCuenta,
  totalesItem,
  totalesPedido,
} from '@pos/core'
import type { Catalogo, EventoLocal } from '@pos/sync'

// Precuenta, división y cobro (tarea 1.6, docs/DINERO.md): cada monto sale del código de dinero
// de `@pos/core` con las reglas del restaurante que trae la carta. Las pantallas solo muestran lo
// que se calcula aquí.

export type ReglasCobro = NonNullable<Catalogo['restaurante']['cobro']>

export const NOMBRE_MEDIO: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  breb: 'Bre-B',
  transferencia: 'Transferencia',
  bono: 'Bono',
  otro: 'Otro',
}

/** Una opción del cobro: un medio, la tarjeta crédito o débito, o un medio propio. */
export interface OpcionCobro {
  clave: string
  nombre: string
  medio: MedioPago
  tipoTarjeta: 'credito' | 'debito' | null
  medioPropioId: string | null
}

/**
 * Lo que sale al cobrar, en este orden: los medios habilitados (la tarjeta, como crédito y como
 * débito) y después los propios del restaurante (tarea 1.6).
 */
export function opcionesDeCobro(reglas: ReglasCobro): OpcionCobro[] {
  const opciones: OpcionCobro[] = []
  const base = { tipoTarjeta: null, medioPropioId: null }
  for (const medio of reglas.mediosPago) {
    if (medio === 'tarjeta') {
      opciones.push(
        { ...base, clave: 'credito', nombre: 'Tarjeta crédito', medio, tipoTarjeta: 'credito' },
        { ...base, clave: 'debito', nombre: 'Tarjeta débito', medio, tipoTarjeta: 'debito' },
      )
    } else opciones.push({ ...base, clave: medio, nombre: NOMBRE_MEDIO[medio], medio })
  }
  for (const m of reglas.mediosPropios ?? [])
    opciones.push({ ...base, clave: m.id, nombre: m.nombre, medio: 'otro', medioPropioId: m.id })
  return opciones
}

/** El nombre de un medio en un pago: el propio por su nombre (aunque esté archivado, «Otro»). */
export const nombreDeMedio = (
  medio: MedioPago,
  medioPropioId: string | null | undefined,
  reglas: ReglasCobro | null,
) =>
  medio === 'otro'
    ? (reglas?.mediosPropios?.find((m) => m.id === medioPropioId)?.nombre ?? 'Otro')
    : NOMBRE_MEDIO[medio]

/** «INC 8 %», «IVA 19 %», «Exento» (el mismo nombre que la precuenta impresa). */
export function nombreImpuesto(tipo: 'inc' | 'iva' | 'exento', tarifa: number): string {
  if (tipo === 'exento' || tarifa === 0) return 'Exento'
  return `${tipo.toUpperCase()} ${`${tarifa / 100}`.replace('.', ',')} %`
}

/** Las reglas del cobro del restaurante; un hub de antes de la 1.6 no las manda. */
export const reglasDe = (catalogo: Catalogo | null): ReglasCobro | null =>
  catalogo?.restaurante.cobro ?? null

const configDe = (r: ReglasCobro) => ({
  propina_sugerida: r.propinaSugerida,
  redondeo_modo: r.redondeoModo,
})

/** Propina sugerida de `monto` del pedido (el saldo, una cuenta o lo que se cobra ahora). */
export const propinaSugeridaDe = (pedido: EstadoPedido, monto: number, reglas: ReglasCobro) =>
  monto <= 0 ? 0 : propinaDelPedido(pedido, monto, configDe(reglas))

/**
 * En efectivo, la propina se sugiere redondeada al múltiplo del efectivo para que se pueda pagar
 * con billetes; el cajero la puede cambiar. Con los demás medios va exacta (DINERO.md).
 */
export const propinaParaEfectivo = (propina: number, reglas: ReglasCobro) =>
  cobradoEnEfectivo(propina, reglas.redondeoEfectivo, reglas.redondeoEfectivoModo)

/**
 * La propina sugerida de un pago de `valor` sobre lo que falta (`disponible`): la propina de lo
 * que falta antes del pago menos la de lo que faltará después. Así los pagos parciales suman la
 * propina entera, sin un peso de más por redondeo (docs/DINERO.md#propina-sugerida).
 */
export function propinaDePago(
  pedido: EstadoPedido,
  cuenta: { monto: number; propinaSugerida: number } | null,
  disponible: number,
  valor: number,
  reglas: ReglasCobro,
): number {
  if (valor <= 0 || valor > disponible) return 0
  const pendiente = (saldo: number) =>
    cuenta ? propinaPendienteDeCuenta(cuenta, saldo) : propinaSugeridaDe(pedido, saldo, reglas)
  return Math.max(0, pendiente(disponible) - pendiente(disponible - valor))
}

/**
 * La propina de un pago con otro porcentaje (5 %, 15 %…) en puntos básicos, por la misma regla
 * que la sugerida: sobre la base sin impuestos de lo que se cobra.
 */
export const propinaConPorcentaje = (
  pedido: EstadoPedido,
  disponible: number,
  valor: number,
  puntos: number,
  reglas: ReglasCobro,
) => propinaDePago(pedido, null, disponible, valor, { ...reglas, propinaSugerida: puntos })

/** Una línea de la precuenta: lo que sigue en pie, con su neto. */
export interface LineaCuenta {
  id: string
  cantidad: number
  nombre: string
  opciones: string[]
  neto: number
}

export function lineasDe(pedido: EstadoPedido): LineaCuenta[] {
  return Object.values(pedido.items)
    .filter((i) => i.estado !== 'anulado' && i.cantidad > i.cantidadAnulada)
    .sort((a, b) => a.orden - b.orden)
    .map((i) => ({
      id: i.id,
      cantidad: i.cantidad - i.cantidadAnulada,
      nombre: i.nombre,
      opciones: i.modificadores.map((m) => m.nombre),
      neto: totalesItem(pedido, i).neto,
    }))
}

/** Una cuenta de un pedido dividido, con lo que le falta pagar. */
export interface CuentaVisible {
  id: string
  nombre: string
  monto: number
  saldo: number
  /** La propina fijada al dividir. */
  propinaSugerida: number
  /** Lo que falta de esa propina, según lo que falta de la cuenta. */
  propinaPendiente: number
}

/**
 * Lo que queda por cobrar: las cuentas de la división con su saldo y, aparte, lo que no quedó en
 * ninguna cuenta (agregado después de dividir, o lo que no se repartió).
 */
export function porCobrar(pedido: EstadoPedido): {
  saldo: number
  cuentas: CuentaVisible[]
  sinAsignar: number
} {
  const { saldo } = totalesPedido(pedido)
  if (!pedido.cuentas) return { saldo, cuentas: [], sinAsignar: 0 }
  const cuentas = pedido.cuentas
    .map((c) => ({
      id: c.id,
      nombre: c.nombre,
      monto: c.monto,
      saldo: Math.max(0, saldoCuenta(pedido, c.id) ?? 0),
      propinaSugerida: c.propinaSugerida,
    }))
    .map((c) => ({ ...c, propinaPendiente: propinaPendienteDeCuenta(c, c.saldo) }))
  const enCuentas = cuentas.reduce((a, c) => a + c.saldo, 0)
  return { saldo, cuentas, sinAsignar: Math.max(0, saldo - enCuentas) }
}

/** Los datos de `CuentaDividida`: montos fijos y la propina de cada cuenta. */
export interface CuentaNueva {
  cuenta_id: string
  nombre: string
  monto: number
  propina_sugerida: number
  items: { item_id: string; fraccion: { n: number; d: number } }[]
}

/**
 * La propina de cada cuenta: la de lo que se divide, repartida en proporción a lo que paga cada
 * una (DINERO.md#propina-sugerida).
 */
function conPropinas(
  pedido: EstadoPedido,
  montos: readonly number[],
  reglas: ReglasCobro,
): number[] {
  const total = montos.reduce((a, m) => a + m, 0)
  return total === 0
    ? montos.map(() => 0)
    : repartirPropina(propinaSugeridaDe(pedido, total, reglas), montos)
}

/** El saldo en `personas` partes iguales por mayor residuo (100.000 ÷ 3 = 33.334 + 33.333 + 33.333). */
export function enPartesIguales(
  pedido: EstadoPedido,
  personas: number,
  reglas: ReglasCobro,
  nuevoId: () => string,
): CuentaNueva[] {
  const { saldo } = totalesPedido(pedido)
  const montos = partesIguales(saldo, personas)
  const propinas = conPropinas(pedido, montos, reglas)
  return montos.map((monto, i) => ({
    cuenta_id: nuevoId(),
    nombre: `Persona ${i + 1}`,
    monto,
    propina_sugerida: propinas[i] ?? 0,
    items: [],
  }))
}

/**
 * Cada producto a la cuenta que lo paga; uno que tocan varias cuentas se reparte entre ellas en
 * partes iguales. Lo que nadie toma queda sin asignar y se cobra aparte. Solo antes del primer
 * pago: después se divide el saldo en partes iguales (DINERO.md#división-de-la-cuenta).
 */
export function porProductos(
  pedido: EstadoPedido,
  asignadas: ReadonlyMap<string, readonly number[]>,
  cuentas: number,
  reglas: ReglasCobro,
  nuevoId: () => string,
): { cuentas: CuentaNueva[]; sinAsignar: number } {
  const lineas = lineasDe(pedido)
  // Un producto que otro equipo anuló mientras se dividía ya no cuenta.
  const vigentes = new Set(lineas.map((l) => l.id))
  const asignaciones = [...asignadas]
    .filter(([itemId]) => vigentes.has(itemId))
    .flatMap(([itemId, de]) =>
      de
        .filter((c) => c < cuentas)
        .map((cuenta, _i, todas) => ({ cuenta, itemId, fraccion: { n: 1, d: todas.length } })),
    )
  const { montos, sinAsignar } = dividirPorItems(
    lineas.map((l) => ({ itemId: l.id, neto: l.neto })),
    asignaciones,
    cuentas,
  )
  const propinas = conPropinas(pedido, montos, reglas)
  return {
    cuentas: montos.map((monto, i) => ({
      cuenta_id: nuevoId(),
      nombre: `Cuenta ${i + 1}`,
      monto,
      propina_sugerida: propinas[i] ?? 0,
      items: asignaciones
        .filter((a) => a.cuenta === i)
        .map((a) => ({ item_id: a.itemId, fraccion: a.fraccion })),
    })),
    sinAsignar,
  }
}

/** Al quitar cuentas, lo de las que ya no existen vuelve a «sin asignar». */
export function recortarAsignaciones(
  asignadas: ReadonlyMap<string, readonly number[]>,
  cuentas: number,
): Map<string, number[]> {
  const nuevas = new Map<string, number[]>()
  for (const [item, de] of asignadas) {
    const quedan = de.filter((c) => c < cuentas)
    if (quedan.length > 0) nuevas.set(item, quedan)
  }
  return nuevas
}

export interface CalculoEfectivo {
  /** Lo que se cobra por la venta: el monto, redondeado solo si deja el saldo en 0. */
  cobrado: number
  ajuste: number
  /** Venta + propina: lo mínimo que entrega el cliente. */
  aEntregar: number
  cambio: number
  /** Lo que falta si lo recibido no alcanza (0 si alcanza). */
  falta: number
  /** La regla de redondeo que va en el evento, solo en el pago que deja el saldo en 0. */
  redondeo: { multiplo: number; modo: ModoRedondeoEfectivo } | null
}

/**
 * Un pago en efectivo (DINERO.md#pagos): `recibido = monto + ajuste_redondeo + propina + cambio`.
 * El redondeo va solo en el pago que deja el saldo en 0 (`saldo` es el disponible de la cuenta).
 */
export function pagoEnEfectivo(
  p: { saldo: number; monto: number; propina: number; recibido: number },
  reglas: ReglasCobro,
): CalculoEfectivo {
  for (const [nombre, valor] of Object.entries(p)) exigirPesos(valor, nombre)
  if (p.monto <= 0 || p.monto > p.saldo)
    throw new RangeError(`El monto debe ser mayor que 0 y no pasar del saldo (${p.saldo})`)
  const cierra = p.monto === p.saldo
  const cobrado = cierra
    ? cobradoEnEfectivo(p.saldo, reglas.redondeoEfectivo, reglas.redondeoEfectivoModo)
    : p.monto
  const aEntregar = cobrado + p.propina
  const sobra = p.recibido - aEntregar
  return {
    cobrado,
    ajuste: cobrado - p.monto,
    aEntregar,
    cambio: Math.max(0, sobra),
    falta: Math.max(0, -sobra),
    redondeo:
      cierra && cobrado !== p.monto
        ? { multiplo: reglas.redondeoEfectivo, modo: reglas.redondeoEfectivoModo }
        : null,
  }
}

/** El turno abierto de una caja (tarea 1.6): el último `TurnoAbierto` vigente de ese equipo. */
export interface TurnoVisible {
  id: string
  base: number
  abiertoEn: string
  /** Aún no lo confirma el hub. */
  porConfirmar: boolean
}

export function turnoDeCaja(locales: readonly EventoLocal[], cajaId: string): TurnoVisible | null {
  let turno: TurnoVisible | null = null
  for (const l of locales) {
    const e = l.evento
    if (e.tipo !== 'TurnoAbierto' || e.datos.caja_id !== cajaId) continue
    if (l.estado !== 'confirmado' && l.estado !== 'pendiente') continue
    const candidato = {
      id: e.agregado_id,
      base: e.datos.base,
      abiertoEn: e.recibido_en ?? e.hora_estimada_hub,
      porConfirmar: l.estado === 'pendiente',
    }
    if (!turno || candidato.abiertoEn > turno.abiertoEn) turno = candidato
  }
  return turno
}

/**
 * Lo cobrado en un turno, por medio de pago: venta (con su redondeo) y propina. Una anulación o
 * un reembolso cae en el turno en que se registra, no en el del pago (docs/DINERO.md#caja).
 */
export interface ResumenTurno {
  porMedio: {
    medio: MedioPago
    medioPropioId: string | null
    venta: number
    propina: number
    pagos: number
  }[]
  pagos: number
}

export function resumenTurno(locales: readonly EventoLocal[], turnoId: string): ResumenTurno {
  const vigentes = locales.filter((l) => l.estado === 'confirmado' || l.estado === 'pendiente')
  type Medio = { medio: MedioPago; medioPropioId: string | null }
  const pagosPorId = new Map<string, Medio & { venta: number; propina: number }>()
  for (const { evento: e } of vigentes)
    if (e.tipo === 'PagoRegistrado')
      pagosPorId.set(e.datos.pago_id, {
        medio: e.datos.medio,
        medioPropioId: e.datos.medio_propio_id ?? null,
        venta: e.datos.monto + e.datos.ajuste_redondeo,
        propina: e.datos.propina,
      })
  const porMedio = new Map<string, Medio & { venta: number; propina: number; pagos: number }>()
  const sumar = (de: Medio, venta: number, propina: number, pagos: number) => {
    const clave = `${de.medio}:${de.medioPropioId ?? ''}`
    const m = porMedio.get(clave) ?? { ...de, venta: 0, propina: 0, pagos: 0 }
    m.venta += venta
    m.propina += propina
    m.pagos += pagos
    porMedio.set(clave, m)
  }
  for (const { evento: e } of vigentes) {
    if (e.tipo === 'PagoRegistrado' && e.datos.turno_caja_id === turnoId)
      sumar(
        { medio: e.datos.medio, medioPropioId: e.datos.medio_propio_id ?? null },
        e.datos.monto + e.datos.ajuste_redondeo,
        e.datos.propina,
        1,
      )
    if (e.tipo === 'PagoAnulado' && e.datos.turno_caja_id === turnoId) {
      const pago = pagosPorId.get(e.datos.pago_id)
      if (pago) sumar(pago, -pago.venta, -pago.propina, -1)
    }
    if (e.tipo === 'ReembolsoRegistrado' && e.datos.turno_caja_id === turnoId) {
      const pago = pagosPorId.get(e.datos.pago_id)
      sumar(
        { medio: e.datos.medio, medioPropioId: pago?.medioPropioId ?? null },
        -e.datos.monto_venta,
        -e.datos.monto_propina,
        0,
      )
    }
  }
  const lista = [...porMedio.values()]
  return { porMedio: lista, pagos: lista.reduce((a, m) => a + m.pagos, 0) }
}
