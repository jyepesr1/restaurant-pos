import { nuevoId } from '@pos/core'
import { describe, expect, it } from 'vitest'
import { copiaItem, evento } from '../../../packages/core/src/pruebas/fabrica'
import { atender, MAX_BYTES_CUERPO } from './api'
import { MIGRACIONES_NUBE, migrar } from './migraciones'
import { MAX_EVENTOS_POR_LOTE, normalizarCodigo, nuevoCodigo } from './nube'
import { baseDePrueba } from './pruebas/pglite'

// La API de la nube (tarea 1.10) contra un Postgres embebido: crear el restaurante, registrar el
// hub con un código de un solo uso y subir eventos sin duplicar.

const ADMIN = 'token-de-administracion-de-prueba'
const AHORA = new Date('2026-10-26T15:00:00.000Z')

async function mundo() {
  const { sql, db } = await baseDePrueba()
  const reloj = { ahora: AHORA }
  const pedir = (metodo: string, ruta: string, cuerpo?: unknown, token?: string) =>
    atender(
      new Request(`https://nube.faro.test${ruta}`, {
        method: metodo,
        headers: {
          ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body:
          cuerpo === undefined
            ? undefined
            : typeof cuerpo === 'string'
              ? cuerpo
              : JSON.stringify(cuerpo),
      }),
      { sql, tokenAdmin: ADMIN, reloj: () => reloj.ahora },
    )
  const restaurante = nuevoId()
  const sede = nuevoId()
  /** Crea el restaurante, un código y registra un hub; devuelve su credencial. */
  const hubRegistrado = async (rest = restaurante, hubId = nuevoId()) => {
    await pedir('POST', '/v1/admin/restaurantes', { id: rest, nombre: 'La Spritzzería' }, ADMIN)
    const { codigo } = await (
      await pedir('POST', '/v1/admin/codigos', { restaurante_id: rest }, ADMIN)
    ).json()
    const r = await pedir('POST', '/v1/hubs/registro', {
      codigo,
      hub_id: hubId,
      sede_id: sede,
      nombre: 'Caja principal',
      instancia: 'instancia-1',
    })
    expect(r.status).toBe(201)
    const { credencial } = await r.json()
    return { credencial: credencial as string, hubId }
  }
  return { sql, db, reloj, pedir, restaurante, sede, hubRegistrado }
}

/** Un pedido con dos eventos, como los guarda el hub (con secuencia, día y hora del hub). */
function eventosDePedido(secuencia = 1) {
  const pedido = nuevoId()
  return [
    evento(pedido, 'PedidoAbierto', { canal: 'salon', mesa_id: nuevoId(), comensales: 2 }, {
      secuencia,
      dia_operativo: '2026-10-26',
    } as never),
    evento(pedido, 'ItemAgregado', copiaItem(), {
      secuencia: secuencia + 1,
      dia_operativo: '2026-10-26',
    } as never),
  ]
}

describe('migraciones de la nube', () => {
  it('aplican una vez; repetirlas no hace nada; editar una ya aplicada falla', async () => {
    const { sql } = await baseDePrueba()
    expect(await migrar(sql)).toEqual([])
    const editada = MIGRACIONES_NUBE.map((m) => ({ ...m, sql: `${m.sql}\n-- cambio` }))
    await expect(migrar(sql, editada)).rejects.toThrow(/cambió después de aplicarse/)
  })

  it('los eventos no se cambian ni se borran', async () => {
    const { pedir, hubRegistrado, db } = await mundo()
    const { credencial } = await hubRegistrado()
    await pedir('POST', '/v1/eventos', { eventos: eventosDePedido() }, credencial)
    await expect(db.query("UPDATE evento SET tipo = 'x'")).rejects.toThrow(/solo se agregan/)
    await expect(db.query('DELETE FROM evento')).rejects.toThrow(/solo se agregan/)
  })
})

describe('administración y registro del hub', () => {
  it('sin el token de administración no se crea nada', async () => {
    const { pedir, restaurante } = await mundo()
    const sin = await pedir('POST', '/v1/admin/restaurantes', { id: restaurante, nombre: 'X' })
    expect(sin.status).toBe(401)
    const otro = await pedir(
      'POST',
      '/v1/admin/restaurantes',
      { id: restaurante, nombre: 'X' },
      'otro',
    )
    expect(otro.status).toBe(401)
  })

  it('sin token de administración configurado, las rutas de administración no sirven', async () => {
    const { sql } = await baseDePrueba()
    const r = await atender(
      new Request('https://nube.faro.test/v1/admin/restaurantes', {
        method: 'POST',
        headers: { authorization: 'Bearer cualquiera' },
        body: JSON.stringify({ id: nuevoId(), nombre: 'X' }),
      }),
      { sql },
    )
    expect(r.status).toBe(401)
  })

  it('crear el restaurante dos veces no lo duplica; un código para uno que no existe da 404', async () => {
    const { pedir, restaurante } = await mundo()
    const datos = { id: restaurante, nombre: 'La Spritzzería' }
    expect((await pedir('POST', '/v1/admin/restaurantes', datos, ADMIN)).status).toBe(201)
    expect((await pedir('POST', '/v1/admin/restaurantes', datos, ADMIN)).status).toBe(200)
    const r = await pedir('POST', '/v1/admin/codigos', { restaurante_id: nuevoId() }, ADMIN)
    expect(r.status).toBe(404)
  })

  it('el código sirve una vez, sin importar mayúsculas ni guiones, y vence a las 24 horas', async () => {
    const { pedir, restaurante, sede, reloj } = await mundo()
    await pedir('POST', '/v1/admin/restaurantes', { id: restaurante, nombre: 'R' }, ADMIN)
    const nuevo = async () =>
      (
        await (
          await pedir('POST', '/v1/admin/codigos', { restaurante_id: restaurante }, ADMIN)
        ).json()
      ).codigo as string
    const registrar = (codigo: string, hub_id = nuevoId()) =>
      pedir('POST', '/v1/hubs/registro', {
        codigo,
        hub_id,
        sede_id: sede,
        nombre: 'Caja',
        instancia: 'i',
      })

    const codigo = await nuevo()
    expect(codigo).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect((await registrar(` ${codigo.toLowerCase().replaceAll('-', ' ')} `)).status).toBe(201)
    expect((await registrar(codigo)).status).toBe(403)

    const otro = await nuevo()
    reloj.ahora = new Date(AHORA.getTime() + 24 * 60 * 60 * 1000 + 1)
    expect((await registrar(otro)).status).toBe(403)
  })

  it('un hub ya registrado no se registra de nuevo con otro código', async () => {
    const { pedir, hubRegistrado, restaurante, sede } = await mundo()
    const { hubId } = await hubRegistrado()
    const { codigo } = await (
      await pedir('POST', '/v1/admin/codigos', { restaurante_id: restaurante }, ADMIN)
    ).json()
    const r = await pedir('POST', '/v1/hubs/registro', {
      codigo,
      hub_id: hubId,
      sede_id: sede,
      nombre: 'Caja',
      instancia: 'i',
    })
    expect(r.status).toBe(409)
  })

  it('los códigos no se repiten y solo usan letras y números fáciles de dictar', () => {
    const codigos = new Set(Array.from({ length: 2000 }, nuevoCodigo))
    expect(codigos.size).toBe(2000)
    for (const c of codigos) expect(normalizarCodigo(c)).not.toMatch(/[01OIL]/)
  })
})

describe('subir eventos', () => {
  it('guarda un lote, y reenviarlo no lo duplica', async () => {
    const { pedir, hubRegistrado, db } = await mundo()
    const { credencial } = await hubRegistrado()
    const eventos = eventosDePedido()
    const r = await pedir('POST', '/v1/eventos', { eventos }, credencial)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resultados: eventos.map((e) => ({ id: e.id, estado: 'guardado' })),
      ultima_secuencia: 2,
    })
    const otra = await (await pedir('POST', '/v1/eventos', { eventos }, credencial)).json()
    expect(otra.resultados.map((x: { estado: string }) => x.estado)).toEqual([
      'ya_estaba',
      'ya_estaba',
    ])
    expect((await db.query('SELECT count(*)::int AS n FROM evento')).rows).toEqual([{ n: 2 }])
  })

  it('el mismo id con otro contenido no pisa el guardado: queda para revisión', async () => {
    const { pedir, hubRegistrado, db } = await mundo()
    const { credencial } = await hubRegistrado()
    const [abierto] = eventosDePedido()
    if (!abierto) throw new Error('sin evento')
    await pedir('POST', '/v1/eventos', { eventos: [abierto] }, credencial)
    const cambiado = { ...abierto, datos: { ...abierto.datos, comensales: 9 } }
    const r = await (await pedir('POST', '/v1/eventos', { eventos: [cambiado] }, credencial)).json()
    expect(r.resultados).toEqual([{ id: abierto.id, estado: 'distinto' }])
    const [guardado] = (
      await db.query<{ c: number }>(
        "SELECT (contenido->'datos'->>'comensales')::int AS c FROM evento",
      )
    ).rows
    expect(guardado?.c).toBe(2)
    expect((await db.query('SELECT count(*)::int AS n FROM evento_distinto')).rows).toEqual([
      { n: 1 },
    ])
  })

  it('un evento mal formado no tumba el lote: los demás se guardan', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    const r = await (
      await pedir('POST', '/v1/eventos', { eventos: [a, { id: 'x', tipo: 'Nada' }, b] }, credencial)
    ).json()
    expect(r.resultados.map((x: { estado: string }) => x.estado)).toEqual([
      'guardado',
      'invalido',
      'guardado',
    ])
  })

  it('sin credencial, con una inventada o con un hub revocado no se sube nada', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial, hubId } = await hubRegistrado()
    const eventos = eventosDePedido()
    expect((await pedir('POST', '/v1/eventos', { eventos })).status).toBe(401)
    expect((await pedir('POST', '/v1/eventos', { eventos }, 'inventada')).status).toBe(401)
    expect((await pedir('POST', '/v1/admin/hubs/revocar', { hub_id: hubId }, ADMIN)).status).toBe(
      204,
    )
    expect((await pedir('POST', '/v1/eventos', { eventos }, credencial)).status).toBe(401)
  })

  it('cada restaurante ve solo lo suyo, aunque los ids de los eventos coincidan', async () => {
    const { pedir, hubRegistrado, db } = await mundo()
    const a = await hubRegistrado(nuevoId())
    const b = await hubRegistrado(nuevoId())
    const eventos = eventosDePedido()
    await pedir('POST', '/v1/eventos', { eventos }, a.credencial)
    // El mismo evento en otro restaurante no es «ya estaba»: es suyo.
    const r = await (await pedir('POST', '/v1/eventos', { eventos }, b.credencial)).json()
    expect(r.resultados.map((x: { estado: string }) => x.estado)).toEqual(['guardado', 'guardado'])
    expect((await db.query('SELECT count(*)::int AS n FROM evento')).rows).toEqual([{ n: 4 }])
    const ultima = await (await pedir('GET', '/v1/eventos/ultima', undefined, b.credencial)).json()
    expect(ultima).toEqual({ ultima_secuencia: 2 })
  })

  it('límites: lote vacío, más de 500 eventos, cuerpo que no es JSON o demasiado grande', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial } = await hubRegistrado()
    expect((await pedir('POST', '/v1/eventos', { eventos: [] }, credencial)).status).toBe(400)
    const muchos = Array.from({ length: MAX_EVENTOS_POR_LOTE + 1 }, () => ({}))
    expect((await pedir('POST', '/v1/eventos', { eventos: muchos }, credencial)).status).toBe(400)
    expect((await pedir('POST', '/v1/eventos', '{no es json', credencial)).status).toBe(400)
    const enorme = JSON.stringify({ eventos: ['x'.repeat(MAX_BYTES_CUERPO)] })
    const r = await pedir('POST', '/v1/eventos', enorme, credencial)
    expect(r.status).toBe(413)
    expect((await r.json()).error).toBe('lote_grande')
  })

  it('un evento de más de 64 KB es inválido, el resto del lote se guarda', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    if (!a || !b) throw new Error('sin eventos')
    const grande = { ...b, datos: { ...b.datos, notas: 'x'.repeat(70_000) } }
    const r = await (
      await pedir('POST', '/v1/eventos', { eventos: [a, grande] }, credencial)
    ).json()
    expect(r.resultados).toEqual([
      { id: a.id, estado: 'guardado' },
      { id: b.id, estado: 'invalido', motivo: 'demasiado_grande' },
    ])
  })

  it('las rutas que no existen dan 404 y la salud responde', async () => {
    const { pedir } = await mundo()
    expect((await pedir('GET', '/v1/salud')).status).toBe(200)
    expect((await pedir('GET', '/v1/nada')).status).toBe(404)
  })
})

describe('seguridad por fila en la base', () => {
  it('dentro de un restaurante solo se ven sus eventos, y no se puede escribir en otro', async () => {
    const { pedir, hubRegistrado, sql } = await mundo()
    const restA = nuevoId()
    const restB = nuevoId()
    const a = await hubRegistrado(restA)
    const b = await hubRegistrado(restB)
    await pedir('POST', '/v1/eventos', { eventos: eventosDePedido() }, a.credencial)
    await pedir('POST', '/v1/eventos', { eventos: eventosDePedido() }, b.credencial)
    const enRestaurante = <T>(rest: string, trabajo: (tx: typeof sql) => Promise<T>) =>
      sql.transaccion(async (tx) => {
        await tx.query("SELECT set_config('faro.restaurante_id', $1, true)", [rest])
        await tx.query('SET LOCAL ROLE faro_datos')
        return trabajo(tx)
      })
    // Una consulta sin filtro igual ve solo lo de su restaurante.
    const vistos = await enRestaurante(restA, (tx) =>
      tx.query<{ r: string }>('SELECT DISTINCT restaurante_id AS r FROM evento'),
    )
    expect(vistos).toEqual([{ r: restA }])
    // Sin decir el restaurante no se ve nada.
    const nada = await sql.transaccion(async (tx) => {
      await tx.query('SET LOCAL ROLE faro_datos')
      return tx.query('SELECT 1 FROM evento')
    })
    expect(nada).toEqual([])
    // Escribir un evento de B desde una transacción de A falla.
    await expect(
      enRestaurante(restA, (tx) =>
        tx.query(
          `INSERT INTO evento (restaurante_id, id, hub_id, tipo, agregado_tipo, agregado_id,
             secuencia_hub, dia_operativo, recibido_en, contenido, huella)
           VALUES ($1, $2, $3, 't', 'pedido', $2, 1, '2026-10-26', now(), '{}', 'h')`,
          [restB, nuevoId(), b.hubId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    // El rol de la API tampoco puede borrar ni cambiar el registro de hubs más allá de lo suyo.
    await expect(enRestaurante(restA, (tx) => tx.query('DELETE FROM hub'))).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('revisión de código (1.10)', () => {
  it('un texto con carácter nulo o medio sustituto es inválido y no tumba el lote', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    if (!a || !b) throw new Error('sin eventos')
    const nulo = { ...b, datos: { ...b.datos, notas: `con ${String.fromCharCode(0)} nulo` } }
    const r = await (await pedir('POST', '/v1/eventos', { eventos: [a, nulo] }, credencial)).json()
    expect(r.resultados).toEqual([
      { id: a.id, estado: 'guardado' },
      { id: b.id, estado: 'invalido', motivo: 'caracter_no_valido' },
    ])
    const [c] = eventosDePedido(10)
    if (!c) throw new Error('sin evento')
    const suelto = { ...c, datos: { ...c.datos, [`clave\uD800`]: 1 } }
    const r2 = await (await pedir('POST', '/v1/eventos', { eventos: [suelto] }, credencial)).json()
    expect(r2.resultados[0]).toMatchObject({ estado: 'invalido', motivo: 'caracter_no_valido' })
  })

  it('ultima_secuencia es la última sin huecos desde 1, no la mayor', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial } = await hubRegistrado()
    const [s1, s2] = eventosDePedido(1)
    const [s3, s4] = eventosDePedido(3)
    const subir = async (eventos: unknown[]) =>
      (await (await pedir('POST', '/v1/eventos', { eventos }, credencial)).json()).ultima_secuencia
    // Llega primero lo de después (3 y 4): falta el 1 y el 2.
    expect(await subir([s3, s4])).toBe(0)
    expect(await subir([s1])).toBe(1)
    expect(await subir([s2])).toBe(4)
  })

  it('el registro se puede repetir con el mismo código y el mismo hub: la credencial anterior se anula', async () => {
    const { pedir, restaurante, sede } = await mundo()
    await pedir('POST', '/v1/admin/restaurantes', { id: restaurante, nombre: 'R' }, ADMIN)
    const { codigo } = await (
      await pedir('POST', '/v1/admin/codigos', { restaurante_id: restaurante }, ADMIN)
    ).json()
    const hub_id = nuevoId()
    const registrar = (id = hub_id) =>
      pedir('POST', '/v1/hubs/registro', {
        codigo,
        hub_id: id,
        sede_id: sede,
        nombre: 'C',
        instancia: 'i',
      })
    const primera = (await (await registrar()).json()).credencial
    const segunda = await registrar()
    expect(segunda.status).toBe(201)
    const nueva = (await segunda.json()).credencial
    expect(nueva).not.toBe(primera)
    expect((await pedir('GET', '/v1/eventos/ultima', undefined, primera)).status).toBe(401)
    expect((await pedir('GET', '/v1/eventos/ultima', undefined, nueva)).status).toBe(200)
    // Otro hub con ese código usado, no.
    expect((await registrar(nuevoId())).status).toBe(403)
  })

  it('un error interno responde 500 sin detalles', async () => {
    const roto = {
      query: async () => {
        throw Object.assign(new Error('relation "secreta" does not exist'), { code: '42P01' })
      },
      ejecutar: async () => {},
      transaccion: async () => {
        throw new Error('x')
      },
    }
    const r = await atender(
      new Request('https://nube.faro.test/v1/eventos/ultima', {
        headers: { authorization: 'Bearer algo' },
      }),
      { sql: roto },
    )
    expect(r.status).toBe(500)
    expect(await r.text()).not.toMatch(/secreta|relation/)
  })
})

describe('lote con un dato que Postgres rechaza', () => {
  it('se guarda el resto y el malo queda inválido, sin 500 ni lote bloqueado', async () => {
    const { pedir, hubRegistrado } = await mundo()
    const { credencial } = await hubRegistrado()
    const [a, b] = eventosDePedido()
    if (!a || !b) throw new Error('sin eventos')
    // Un 30 de febrero pasa por el sobre pero Postgres no lo acepta como fecha.
    const malo = { ...b, dia_operativo: '2026-02-30' }
    const r = await pedir('POST', '/v1/eventos', { eventos: [a, malo] }, credencial)
    expect(r.status).toBe(200)
    const { resultados } = await r.json()
    expect(resultados[0]).toEqual({ id: a.id, estado: 'guardado' })
    expect(resultados[1]).toMatchObject({ id: b.id, estado: 'invalido' })
    // Reenviar el lote da lo mismo: no se queda trabado.
    const otra = await (
      await pedir('POST', '/v1/eventos', { eventos: [a, malo] }, credencial)
    ).json()
    expect(otra.resultados.map((x: { estado: string }) => x.estado)).toEqual([
      'ya_estaba',
      'invalido',
    ])
  })
})
