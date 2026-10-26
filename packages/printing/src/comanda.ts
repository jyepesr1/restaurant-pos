import type { PaginaCodigos } from './codificacion'
import { aLosLados, type Formato, type Linea, parrafo } from './documento'

// Qué lleva una comanda y cómo se ve en papel (ADR-015). El hub arma `Comanda` con los datos ya
// resueltos (nombres de mesa, mesero y estación, la hora en la zona del restaurante): aquí solo se
// decide el orden y el estilo.

/** `nota`: cambió la nota de todo el pedido con platos ya en cocina (alergias: que no se pierda). */
export type TipoComanda =
  | 'nueva'
  | 'reimpresion'
  | 'modificacion'
  | 'anulacion'
  | 'nota'
  /** Platos ya en cocina que pasaron a otra mesa: la cocina debe llevarlos a la nueva. */
  | 'traslado'
export type CursoComanda = 'entrada' | 'fuerte' | 'postre'

export interface ItemComanda {
  cantidad: number
  nombre: string
  comensal: number | null
  curso: CursoComanda | null
  /** Opciones elegidas (término, sin cebolla, adicionales): van resaltadas. */
  opciones: string[]
  notas: string | null
}

export interface Comanda {
  tipo: TipoComanda
  /** «Cocina», «Barra»… */
  estacion: string
  /** Número del día; la reimpresión y la anulación llevan el de la comanda original. */
  numero: number | null
  /** «Mesa 6», «Para llevar», «Domicilio», «Barra». */
  destino: string
  /** Número de pedido del día. */
  pedido: number | null
  mesero: string
  /** Ya formateada en la zona horaria del restaurante («8:42 p. m.»). */
  hora: string
  comensales: number | null
  items: ItemComanda[]
  /** Cursos que siguen retenidos en el pedido: la cocina sabe que vienen después. */
  retenidos?: CursoComanda[]
  /** La nota de todo el pedido («alérgico al maní»): sale arriba, resaltada. */
  notaPedido?: string | null
  /** En un cambio de mesa, dónde estaba antes («Mesa 5»). */
  antes?: string | null
}

const TITULO: Record<TipoComanda, string | null> = {
  nueva: null,
  reimpresion: 'REIMPRESIÓN',
  modificacion: 'CAMBIO',
  anulacion: 'ANULAR',
  nota: 'NOTA NUEVA',
  traslado: 'CAMBIO DE MESA',
}

const NOMBRE_CURSO: Record<CursoComanda, string> = {
  entrada: 'Entrada',
  fuerte: 'Fuerte',
  postre: 'Postre',
}

const ORDEN_CURSO: (CursoComanda | null)[] = [null, 'entrada', 'fuerte', 'postre']

function lineasItem(item: ItemComanda, formato: Formato, anulacion: boolean): Linea[] {
  const persona = item.comensal ? `  P${item.comensal}` : ''
  const lineas: Linea[] = aLosLados(
    `${anulacion ? '-' : ''}${item.cantidad} x ${item.nombre}`,
    persona.trim(),
    formato,
    { grande: true },
  )
  for (const opcion of item.opciones)
    lineas.push(...parrafo(`> ${opcion}`, formato, { negrita: true }))
  if (item.notas) lineas.push(...parrafo(`NOTA: ${item.notas}`, formato, { invertido: true }))
  return lineas
}

/** La comanda partida en líneas para una impresora de ese ancho y esa tabla de caracteres. */
export function lineasComanda(
  comanda: Comanda,
  formato: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const titulo = TITULO[comanda.tipo]
  const encabezado = titulo ? `${titulo} · ${comanda.estacion}` : comanda.estacion
  const datos = [
    comanda.pedido ? `Pedido ${comanda.pedido}` : null,
    comanda.mesero,
    comanda.hora,
    comanda.comensales ? `${comanda.comensales} pers.` : null,
  ].filter((d): d is string => !!d)

  const lineas: Linea[] = [
    ...parrafo(encabezado.toUpperCase(), formato, { grande: true, invertido: true, centro: true }),
    { espacio: true },
    ...aLosLados(comanda.destino, comanda.numero ? `#${comanda.numero}` : '', formato, {
      grande: true,
    }),
    ...parrafo(datos.join(' · '), formato),
    ...(comanda.antes ? parrafo(`Antes: ${comanda.antes}`, formato, { negrita: true }) : []),
    ...(comanda.notaPedido
      ? parrafo(`NOTA DEL PEDIDO: ${comanda.notaPedido}`, formato, {
          invertido: true,
          negrita: true,
        })
      : comanda.tipo === 'nota'
        ? parrafo('SE QUITÓ LA NOTA DEL PEDIDO', formato, { invertido: true, negrita: true })
        : []),
    { separador: true },
  ]

  const anulacion = comanda.tipo === 'anulacion'
  const conCurso = comanda.items.some((i) => i.curso)
  for (const curso of ORDEN_CURSO) {
    const items = comanda.items.filter((i) => i.curso === curso)
    if (items.length === 0) continue
    if (conCurso && curso)
      lineas.push(...parrafo(NOMBRE_CURSO[curso].toUpperCase(), formato, { negrita: true }))
    for (const item of items) lineas.push(...lineasItem(item, formato, anulacion))
    lineas.push({ separador: true })
  }

  const retenidos = comanda.retenidos ?? []
  if (retenidos.length > 0)
    lineas.push(
      ...parrafo(
        `En espera: ${retenidos.map((c) => NOMBRE_CURSO[c]).join(', ')}. Sale cuando el mesero lo marche.`,
        formato,
      ),
    )
  return lineas
}

/**
 * Página de prueba: confirma que la impresora responde, que el ancho es el correcto (la regla
 * debe llenar justo una línea) y que la tabla de caracteres imprime las tildes.
 */
export function lineasPrueba(
  datos: { impresora: string; estaciones: string[]; hora: string },
  formato: { columnas: number; pagina: PaginaCodigos },
): Linea[] {
  const regla = '1234567890'.repeat(Math.ceil(formato.columnas / 10)).slice(0, formato.columnas)
  return [
    ...parrafo('PRUEBA DE IMPRESIÓN', formato, { grande: true, invertido: true, centro: true }),
    { espacio: true },
    ...parrafo(datos.impresora, formato, { grande: true }),
    ...parrafo(
      datos.estaciones.length > 0
        ? `Imprime: ${datos.estaciones.join(', ')}`
        : 'Todavía no imprime ninguna estación',
      formato,
    ),
    ...parrafo(datos.hora, formato),
    { separador: true },
    ...parrafo('La regla debe llenar una sola línea:', formato),
    { texto: regla },
    { espacio: true },
    ...parrafo('Tildes y eñes: ñ Ñ á é í ó ú Á É Í Ó Ú ü ¿¡', formato, { negrita: true }),
    ...parrafo(
      'Si salen símbolos raros en vez de tildes, cambia la tabla de caracteres de esta impresora.',
      formato,
    ),
    { separador: true },
    ...parrafo('Faro', formato, { centro: true }),
  ]
}
