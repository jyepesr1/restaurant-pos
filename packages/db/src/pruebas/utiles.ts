import { nuevoId } from '@pos/core'
import type { BaseSqlite, ValorSql } from '../sqlite'

export const AHORA = '2026-10-24T15:00:00.000Z'

function insertar(db: BaseSqlite, tabla: string, fila: Record<string, ValorSql>): void {
  const columnas = Object.keys(fila)
  db.prepare(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
  ).run(...Object.values(fila))
}

/** Inserta una fila con las columnas comunes de un registro versionado. */
export function insertarVersionado(
  db: BaseSqlite,
  tabla: string,
  restauranteId: string,
  campos: Record<string, ValorSql>,
  id = nuevoId(),
): string {
  insertar(db, tabla, {
    id,
    restaurante_id: restauranteId,
    creado_en: AHORA,
    actualizado_en: AHORA,
    version: 1,
    ...campos,
  })
  return id
}

/** Restaurante con sede, zona, impuesto, categoría y producto: lo mínimo para casi todo. */
export function sembrar(db: BaseSqlite) {
  const restaurante = nuevoId()
  insertarVersionado(
    db,
    'restaurante',
    restaurante,
    { nombre: 'Prueba', config: '{}' },
    restaurante,
  )
  const sede = insertarVersionado(db, 'sede', restaurante, {
    nombre: 'Envigado',
    zona_horaria: 'America/Bogota',
  })
  const zona = insertarVersionado(db, 'zona', restaurante, { sede_id: sede, nombre: 'Salón' })
  const impuesto = insertarVersionado(db, 'impuesto', restaurante, {
    nombre: 'INC 8 %',
    tipo: 'inc',
    tarifa: 800,
  })
  const categoria = insertarVersionado(db, 'categoria', restaurante, { nombre: 'Pizzas' })
  const producto = insertarVersionado(db, 'producto', restaurante, {
    categoria_id: categoria,
    nombre: 'Margarita',
    precio: 40900,
    impuesto_id: impuesto,
  })
  return { restaurante, sede, zona, impuesto, categoria, producto }
}

export function insertarEvento(
  db: BaseSqlite,
  restaurante: string,
  campos: Record<string, ValorSql> = {},
): Record<string, ValorSql> {
  const fila: Record<string, ValorSql> = {
    restaurante_id: restaurante,
    id: nuevoId(),
    tipo: 'PedidoAbierto',
    version_esquema: 1,
    agregado_tipo: 'pedido',
    agregado_id: nuevoId(),
    datos: '{"canal":"salon"}',
    usuario_id: nuevoId(),
    dispositivo_id: nuevoId(),
    hora_dispositivo: AHORA,
    hora_estimada_hub: AHORA,
    secuencia_base: 0,
    secuencia: 1,
    recibido_en: AHORA,
    dia_operativo: '2026-10-24',
    contenido_hash: 'abc',
    ...campos,
  }
  insertar(db, 'evento', fila)
  return fila
}

export function insertarPedido(
  db: BaseSqlite,
  restaurante: string,
  campos: Record<string, ValorSql> = {},
): string {
  const id = nuevoId()
  insertar(db, 'pedido', {
    id,
    restaurante_id: restaurante,
    canal: 'salon',
    estado: 'abierto',
    abierto_en: AHORA,
    ultima_secuencia: 1,
    ...campos,
  })
  return id
}

export function insertarItem(
  db: BaseSqlite,
  restaurante: string,
  pedido: string,
  campos: Record<string, ValorSql> = {},
): string {
  const id = nuevoId()
  insertar(db, 'pedido_item', {
    id,
    restaurante_id: restaurante,
    pedido_id: pedido,
    orden: 1,
    producto_id: nuevoId(),
    nombre: 'Pinsa',
    precio_unitario: 20900,
    impuesto_tipo: 'inc',
    tarifa: 800,
    cantidad: 1,
    estado: 'pendiente',
    agregado_por: nuevoId(),
    ...campos,
  })
  return id
}

export function insertarConflicto(
  db: BaseSqlite,
  restaurante: string,
  campos: Record<string, ValorSql> = {},
): void {
  insertar(db, 'conflicto', {
    id: nuevoId(),
    restaurante_id: restaurante,
    tipo: 'mesa_duplicada',
    evento_id: nuevoId(),
    agregado_id: nuevoId(),
    descripcion: 'Dos pedidos en la mesa 5',
    detectado_en: AHORA,
    ...campos,
  })
}

export function insertarEnTabla(db: BaseSqlite, tabla: string, fila: Record<string, ValorSql>) {
  insertar(db, tabla, fila)
}
