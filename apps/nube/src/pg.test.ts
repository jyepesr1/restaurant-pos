import { PGlite } from '@electric-sql/pglite'
import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { copiaItem, evento } from '../../../packages/core/src/pruebas/fabrica'
import { migrar } from './migraciones'
import { Nube } from './nube'
import { sqlDePg } from './pg'

// El conector de `pg` (el del Worker y los comandos) sobre un Postgres embebido: un cliente de
// mentira que pasa las consultas a PGlite como lo haría node-postgres con un servidor real.

function clienteDe(db: PGlite) {
  return {
    async query(texto: string, parametros?: unknown[]) {
      if (parametros === undefined) {
        // Como pg: sin parámetros, el texto puede traer varias sentencias.
        const r = await db.exec(texto)
        return { rows: r.at(-1)?.rows ?? [] }
      }
      return db.query(texto, parametros)
    },
  }
}

describe('sqlDePg', () => {
  it('migra, registra un hub y guarda un lote como con PGlite directo', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteDe(db) as never)
    expect(await migrar(sql)).toEqual([1])
    const nube = new Nube(sql, () => new Date('2026-10-26T15:00:00Z'))
    const restaurante = nuevoId()
    await nube.crearRestaurante({ id: restaurante, nombre: 'R' })
    const codigo = await nube.crearCodigo(restaurante)
    if (!codigo) throw new Error('sin código')
    const hubId = nuevoId()
    const r = await nube.registrarHub({
      codigo: codigo.codigo,
      hub_id: hubId,
      sede_id: nuevoId(),
      nombre: 'Caja',
      instancia: 'i',
    })
    if (!r.ok) throw new Error(r.motivo)
    const hub = await nube.autenticar(r.credencial)
    if (!hub) throw new Error('sin hub')
    const pedido = nuevoId()
    const eventos = [
      evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: null, comensales: 2 }),
      evento(pedido, 'ItemAgregado', copiaItem()),
    ]
    const resultados = await nube.recibirEventos(hub, eventos)
    expect(resultados.map((x) => x.estado)).toEqual(['guardado', 'guardado'])
    expect(await nube.ultimaSecuencia(hub)).toBe(Math.max(...eventos.map((e) => e.secuencia)))
  })

  it('si el trabajo falla, la transacción se deshace', async () => {
    const db = new PGlite()
    const sql = sqlDePg(clienteDe(db) as never)
    await migrar(sql)
    const id = nuevoId()
    await expect(
      sql.transaccion(async (tx) => {
        await tx.query('INSERT INTO restaurante (id, nombre) VALUES ($1, $2)', [id, 'R'])
        throw new Error('se cayó')
      }),
    ).rejects.toThrow('se cayó')
    expect(await sql.query('SELECT 1 FROM restaurante WHERE id = $1', [id])).toEqual([])
  })
})
