import { newId } from '@pos/core'
import { COLUMNS, readEscpos } from '@pos/printing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FALLOS_PARA_RESPALDO, VIGENCIA_PRUEBA_MS } from './cola'
import { type Equipo, type MontajeImpresion, montarImpresion } from './montaje-impresion'

// La cola de impresión (ADR-015): reintentos con espera creciente, respaldo, archivadas, el hub
// reiniciado con trabajos pendientes y la caída de la impresora sin frenar a los demás. El reloj
// es manual (`t.avanzar`) y la red de impresoras es de mentira: nada espera de verdad.

afterEach(() => {
  vi.useRealTimers()
})

const SEG = 1000

/** Manda al hub `n` envíos de un plato a la estación; cada uno deja un trabajo por impresora. */
function enviarN(t: MontajeImpresion, ana: Equipo, n: number, station = t.kitchen, name = 'Plato') {
  for (let i = 0; i < n; i++) {
    const { order, items } = t.orderWith(ana, [{ name: `${name} ${i + 1}`, station }])
    t.send(ana, order, items)
  }
}

const stateOf = (t: MontajeImpresion, id: string) => t.cola.status().find((e) => e.id === id)
const nombresImpresos = (p: { texts(): string[] }) =>
  p.texts().map((x) => /Plato (\d+)/.exec(x)?.[1])

describe('reintentos con espera creciente', () => {
  it('espera 1, 2, 4, 8, 16 y 30 s entre intentos, y se queda en 30 s sin rendirse', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 1)
    const esperas = [1, 2, 4, 8, 16, 30, 30, 30].map((s) => s * SEG)
    expect(kitchen.papel.attempts).toBe(0)
    let attempts = 0
    for (const delay of esperas) {
      await t.cola.runOnce()
      attempts += 1
      expect(kitchen.papel.attempts).toBe(attempts)
      // Un instante antes de vencer la espera no se vuelve a intentar.
      t.advance(delay - 1)
      await t.cola.runOnce()
      expect(kitchen.papel.attempts).toBe(attempts)
      t.advance(1)
    }
    expect(t.pendingList()).toBe(1)
  })

  it('después de 40 fallos sigue pendiente, sin descartarse, y cada intento cuenta', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 1)
    for (let i = 0; i < 40; i++) {
      await t.cola.runOnce()
      t.advance(31 * SEG)
    }
    const [row] = t.trabajos()
    expect(row).toMatchObject({ status: 'pending', attempts: 40 })
    expect(String(row?.last_error)).toContain('rechazó la conexión')
    kitchen.papel.apagada = false
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(0)
    expect(t.trabajos()[0]).toMatchObject({
      status: 'printed',
      attempts: 41,
      printed_on_id: kitchen.id,
    })
  })

  it('cuando la impresora vuelve, saca lo pendiente en el orden en que se envió', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 4)
    await t.cola.runOnce()
    // Mientras está caída no se salta a la siguiente: solo se intenta la primera.
    expect(kitchen.papel.attempts).toBe(1)
    kitchen.papel.apagada = false
    t.advance(2 * SEG)
    await t.cola.runOnce()
    expect(nombresImpresos(kitchen.papel)).toEqual(['1', '2', '3', '4'])
    expect(t.pendingList()).toBe(0)
  })

  it('una comanda nueva no pasa delante de una que espera en la misma impresora', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const ana = t.device()
    kitchen.papel.apagada = true
    enviarN(t, ana, 1)
    await t.cola.runOnce()
    enviarN(t, ana, 1)
    kitchen.papel.apagada = false
    t.advance(2 * SEG)
    await t.cola.runOnce()
    expect(kitchen.papel.texts().map((x) => /#(\d+)/.exec(x)?.[1])).toEqual(['1', '2'])
    expect(t.trabajos().map((f) => f.status)).toEqual(['printed', 'printed'])
  })

  it('el orden es el de llegada (rowid) aunque el reloj del PC se haya corregido hacia atrás', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const ana = t.device()
    enviarN(t, ana, 2)
    // El reloj del PC se corrigió hacia atrás: la segunda quedó con una hora anterior a la primera.
    t.db
      .prepare(
        'UPDATE print_jobs SET created_at = ? WHERE rowid = (SELECT max(rowid) FROM print_jobs)',
      )
      .run('2026-10-24T10:00:00.000Z')
    await t.cola.runOnce()
    // La primera en llegar sale primero: sus números de comanda salen 1 y luego 2.
    expect(kitchen.papel.texts().map((x) => /#(\d+)/.exec(x)?.[1])).toEqual(['1', '2'])
  })

  it('cada impresora sigue su ritmo: una caída no retrasa a la otra', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const bar = t.impresoraNueva('Barra', [t.bar])
    kitchen.papel.apagada = true
    const ana = t.device()
    enviarN(t, ana, 3, t.kitchen)
    enviarN(t, ana, 3, t.bar)
    await t.cola.runOnce()
    expect(bar.papel.recibidos).toHaveLength(3)
    expect(kitchen.papel.recibidos).toHaveLength(0)
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'failed', pendingList: 3 })
    expect(stateOf(t, bar.id)).toMatchObject({ status: 'ready', pendingList: 0, error: null })
  })

  it('el estado cuenta las comandas en espera y dice qué pasó, en palabras', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 2)
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'ready', pendingList: 2 })
    await t.cola.runOnce()
    expect(stateOf(t, kitchen.id)).toEqual({
      id: kitchen.id,
      name: 'Cocina',
      status: 'failed',
      error: 'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
      pendingList: 2,
    })
    kitchen.papel.apagada = false
    t.advance(5 * SEG)
    await t.cola.runOnce()
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'ready', error: null, pendingList: 0 })
  })
})

describe('impresora de respaldo', () => {
  async function montarConRespaldo() {
    const t = montarImpresion()
    const respaldo = t.impresoraNueva('Respaldo', [], { width: 58, code_page: 'wpc1252' })
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen], { fallback_id: respaldo.id })
    kitchen.papel.apagada = true
    const ana = t.device()
    return { t, respaldo, kitchen, ana }
  }

  const fallar = async (t: MontajeImpresion, veces = FALLOS_PARA_RESPALDO) => {
    for (let i = 0; i < veces; i++) {
      await t.cola.runOnce()
      t.advance(60 * SEG)
    }
  }

  it('a los 3 fallos seguidos la comanda sale por el respaldo, impresa con el ancho del respaldo', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    await fallar(t, 2)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    await fallar(t, 1)
    expect(kitchen.papel.attempts).toBe(3)
    // Justo después del tercer fallo la espera de la cocina no ha vencido: sale por el respaldo.
    t.advance(-60 * SEG + 1)
    await t.cola.runOnce()
    expect(respaldo.papel.recibidos).toHaveLength(1)
    const bytes = respaldo.papel.recibidos[0] as Uint8Array
    // 58 mm: ninguna línea de texto pasa de 32 columnas; y usa la tabla wpc1252 (ESC t 16).
    expect([...bytes.slice(2, 5)]).toEqual([0x1b, 0x74, 16])
    for (const line of readEscpos(bytes).text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(COLUMNS[58])
    expect(t.trabajos()[0]).toMatchObject({
      status: 'printed',
      printer_id: kitchen.id,
      printed_on_id: respaldo.id,
    })
  })

  it('el aviso a los equipos sigue diciendo que la impresora original no responde', async () => {
    const { t, kitchen, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    await fallar(t)
    t.advance(-60 * SEG + 1)
    await t.cola.runOnce()
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'failed' })
    const latest = t.estadosAvisados.at(-1) as { id: string; status: string }[]
    expect(latest.find((e) => e.id === kitchen.id)?.status).toBe('failed')
  })

  it('cuando la original se arregla, la próxima comanda la prueba y vuelve a salir por ella', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    await fallar(t)
    t.advance(-60 * SEG + 1)
    await t.cola.runOnce()
    expect(respaldo.papel.recibidos).toHaveLength(1)
    // Se enciende la impresora y llegan tres comandas más.
    kitchen.papel.apagada = false
    t.advance(60 * SEG)
    enviarN(t, ana, 3, t.kitchen, 'Nueva')
    await t.cola.runOnce()
    // La prueba lleva solo una comanda; el resto espera esa vuelta.
    expect(kitchen.papel.recibidos).toHaveLength(1)
    expect(respaldo.papel.recibidos).toHaveLength(1)
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(3)
    expect(respaldo.papel.recibidos).toHaveLength(1)
    expect(stateOf(t, kitchen.id)).toMatchObject({ status: 'ready', error: null })
    expect(t.pendingList()).toBe(0)
  })

  it('si la prueba de la original falla, esa vuelta no imprime nada y la siguiente usa el respaldo', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    enviarN(t, ana, 2)
    await fallar(t) // 3 fallos
    t.advance(1) // vence la espera del tercer fallo
    const before = kitchen.papel.attempts
    await t.cola.runOnce() // prueba (falla otra vez): solo se intenta una comanda
    expect(kitchen.papel.attempts).toBe(before + 1)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    await t.cola.runOnce() // ya no toca probar: sale todo por el respaldo
    expect(respaldo.papel.recibidos).toHaveLength(2)
    expect(kitchen.papel.attempts).toBe(before + 1)
  })

  it('un respaldo que también falla: nada sale, las dos quedan en falla y nada se pierde', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    respaldo.papel.apagada = true
    enviarN(t, ana, 2)
    await fallar(t) // los 3 fallos
    for (let i = 0; i < 4; i++) {
      await t.cola.runOnce() // prueba de la original
      await t.cola.runOnce() // y enseguida, el respaldo
      t.advance(60 * SEG)
    }
    expect(kitchen.papel.recibidos).toHaveLength(0)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    expect(respaldo.papel.attempts).toBeGreaterThan(0)
    expect(stateOf(t, kitchen.id)?.status).toBe('failed')
    expect(stateOf(t, respaldo.id)?.status).toBe('failed')
    expect(t.pendingList()).toBe(2)
    // Vuelve el respaldo: sale todo, en orden.
    respaldo.papel.apagada = false
    t.advance(60 * SEG)
    await t.cola.runOnce()
    await t.cola.runOnce()
    expect(nombresImpresos(respaldo.papel)).toEqual(['1', '2'])
    expect(t.pendingList()).toBe(0)
  })

  it('un respaldo archivado no se usa: la comanda espera a la original', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(respaldo.id)
    enviarN(t, ana, 1)
    await fallar(t, 6)
    expect(respaldo.papel.attempts).toBe(0)
    expect(t.pendingList()).toBe(1)
    kitchen.papel.apagada = false
    t.advance(60 * SEG)
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(1)
  })

  it('una impresora archivada con respaldo pasa sus comandas pendientes al respaldo sin esperar fallos', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    kitchen.papel.apagada = false
    enviarN(t, ana, 2)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(kitchen.id)
    await t.cola.runOnce()
    expect(kitchen.papel.attempts).toBe(0)
    expect(nombresImpresos(respaldo.papel)).toEqual(['1', '2'])
    expect(t.trabajos().every((f) => f.printed_on_id === respaldo.id)).toBe(true)
  })

  it('las comandas propias del respaldo y las que le llegan de otra salen juntas, en orden de llegada', async () => {
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    t.db
      .prepare('UPDATE printers SET station_ids = ? WHERE id = ?')
      .run(JSON.stringify([t.bar]), respaldo.id)
    enviarN(t, ana, 1, t.kitchen, 'Cocina')
    await fallar(t)
    enviarN(t, ana, 1, t.bar, 'Barra')
    enviarN(t, ana, 1, t.kitchen, 'Cocina')
    t.advance(-60 * SEG + 1)
    await t.cola.runOnce()
    expect(respaldo.papel.recibidos).toHaveLength(3)
    expect(kitchen.papel.recibidos).toHaveLength(0)
    expect(respaldo.papel.texts().map((x) => (x.includes('BARRA') ? 'barra' : 'cocina'))).toEqual([
      'cocina',
      'barra',
      'cocina',
    ])
  })

  it('con la original caída, el temporizador solo lleva la comanda al respaldo', async () => {
    // Con 3 fallos, cada vuelta del temporizador cae justo cuando vence la espera de la original y
    // la «prueba» con el trabajo más viejo; nunca llega una vuelta en la que la original esté en
    // espera, que es la única en que se usa el respaldo.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { t, respaldo, kitchen, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    t.cola.despertar()
    await t.cola.ready()
    for (let i = 0; i < 120; i++) {
      t.advance(1 * SEG)
      await vi.advanceTimersByTimeAsync(1 * SEG)
      await t.cola.ready()
    }
    t.cola.detener()
    expect(kitchen.papel.attempts).toBeGreaterThanOrEqual(FALLOS_PARA_RESPALDO)
    expect(respaldo.papel.recibidos).toHaveLength(1)
  })

  it('las páginas de prueba nunca salen por el respaldo', async () => {
    const { t, respaldo, kitchen } = await montarConRespaldo()
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES ('01PRUEBA0000000000000000AA', ?, ?, 'test', '{"printer":"Cocina","stations":[],"time":"x"}', ?)`,
      )
      .run(t.restauranteId, kitchen.id, new Date(t.clock()).toISOString())
    await fallar(t, 6)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    expect(t.pendingList()).toBe(1)
  })
})

describe('páginas de prueba', () => {
  const insertarPrueba = (t: MontajeImpresion, impresoraId: string) =>
    t.db
      .prepare(
        `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
         VALUES ('01PRUEBA0000000000000000BB', ?, ?, 'test', '{"printer":"Cocina","stations":["Cocina"],"time":"3:00 p. m."}', ?)`,
      )
      .run(t.restauranteId, impresoraId, new Date(t.clock()).toISOString())

  it('sale con la regla del ancho de la impresora', async () => {
    const t = montarImpresion()
    const chica = t.impresoraNueva('Chica', [], { width: 58 })
    insertarPrueba(t, chica.id)
    await t.cola.runOnce()
    const text = chica.papel.texts()[0] as string
    expect(text.replaceAll('\n', ' ')).toContain('PRUEBA DE IMPRESIÓN')
    expect(text.split('\n')).toContain(`${'1234567890'.repeat(3)}12`)
  })

  it('si no sale en 5 minutos se descarta sola, con el motivo, y deja de contar como pendiente', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    insertarPrueba(t, kitchen.id)
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(1)
    t.advance(VIGENCIA_PRUEBA_MS - 1000)
    kitchen.papel.apagada = true
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(1)
    t.advance(2000)
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(0)
    expect(t.trabajos()[0]).toMatchObject({
      status: 'discarded',
      last_error: 'La prueba no salió en 5 minutos',
      discarded_by_id: null,
    })
  })

  it('una prueba vencida no frena a las comandas que están detrás', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    insertarPrueba(t, kitchen.id)
    t.advance(VIGENCIA_PRUEBA_MS + 1000)
    enviarN(t, t.device(), 1)
    kitchen.papel.apagada = false
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(1)
    expect(kitchen.papel.texts()[0]).toContain('Plato 1')
  })
})

describe('una impresora archivada sin respaldo', () => {
  it('sus comandas esperan sin imprimirse ni intentarse, y no se pierden', async () => {
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.kitchen])
    enviarN(t, t.device(), 2)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(vieja.id)
    await t.cola.runOnce()
    expect(vieja.papel.attempts).toBe(0)
    expect(t.pendingList()).toBe(2)
    // No aparece entre las impresoras activas.
    expect(t.cola.status()).toEqual([])
  })

  it('no gira a toda prisa: la próxima vuelta se programa a 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.kitchen])
    enviarN(t, t.device(), 1)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(vieja.id)
    const runOnce = vi.spyOn(t.cola, 'runOnce')
    t.cola.despertar()
    await t.cola.ready()
    expect(runOnce).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(runOnce).toHaveBeenCalledTimes(1)
    t.advance(30 * SEG)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(runOnce).toHaveBeenCalledTimes(2)
    t.cola.detener()
  })

  it('al reactivar la impresora (o reimprimir en otra) las comandas salen', async () => {
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.kitchen])
    enviarN(t, t.device(), 1)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(vieja.id)
    await t.cola.runOnce()
    t.db.prepare('UPDATE printers SET active = 1 WHERE id = ?').run(vieja.id)
    t.advance(31 * SEG)
    await t.cola.runOnce()
    expect(vieja.papel.recibidos).toHaveLength(1)
  })

  it('la caja ve por qué no sale una comanda de una impresora archivada sin respaldo', async () => {
    // El motivo vive solo en la memoria de la cola y las archivadas no aparecen en `estado()`: la
    // lista de pendientes muestra la comanda sin error.
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.kitchen])
    enviarN(t, t.device(), 1)
    t.db.prepare('UPDATE printers SET active = 0 WHERE id = ?').run(vieja.id)
    await t.cola.runOnce()
    expect(String(t.trabajos()[0]?.last_error ?? '')).toMatch(/archivada/)
  })
})

describe('contenido que no se entiende', () => {
  it.each(['null', '{}', '{"type":"nueva"}', '[1,2]', '"texto"'])(
    'el trabajo con contenido %s se descarta y no frena al siguiente',
    async (content) => {
      const t = montarImpresion()
      const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
      t.db
        .prepare(
          `INSERT INTO print_jobs (id, restaurant_id, printer_id, type, content, created_at)
           VALUES ('01MALO000000000000000000AA', ?, ?, 'ticket', ?, ?)`,
        )
        .run(t.restauranteId, kitchen.id, content, new Date(t.clock()).toISOString())
      enviarN(t, t.device(), 1)
      await t.cola.runOnce()
      const badCase = t.trabajos().find((f) => f.id === '01MALO000000000000000000AA')
      const good = t.trabajos().find((f) => f.id !== '01MALO000000000000000000AA')
      expect(badCase).toMatchObject({
        status: 'discarded',
        last_error: 'No se pudo armar la comanda',
      })
      expect(good?.status).toBe('printed')
      expect(kitchen.papel.recibidos).toHaveLength(1)
    },
  )
})

describe('el hub reiniciado con trabajos pendientes', () => {
  it('al arrancar sale todo lo que quedó en la cola, aunque antes hubiera fallado', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const bar = t.impresoraNueva('Barra', [t.bar])
    kitchen.papel.apagada = true
    const ana = t.device()
    enviarN(t, ana, 2, t.kitchen)
    enviarN(t, ana, 1, t.bar)
    // El hub se cae justo después de aceptar los envíos: la cola no alcanzó a imprimir.
    t.cola.detener()
    expect(t.pendingList()).toBe(3)

    // Vuelve a arrancar: otra cola sobre la misma base, sin la memoria de los fallos.
    kitchen.papel.apagada = false
    const arrancada = t.crearCola()
    arrancada.despertar()
    await arrancada.ready()
    expect(nombresImpresos(kitchen.papel)).toEqual(['1', '2'])
    expect(bar.papel.recibidos).toHaveLength(1)
    expect(t.pendingList()).toBe(0)
    arrancada.detener()
  })

  it('la cola nueva no recuerda la espera de la anterior: reintenta de inmediato', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 1)
    for (let i = 0; i < 4; i++) {
      await t.cola.runOnce()
      t.advance(60 * SEG)
    }
    const before = kitchen.papel.attempts
    t.cola.detener()
    kitchen.papel.apagada = false
    const arrancada = t.crearCola()
    await arrancada.runOnce()
    expect(kitchen.papel.attempts).toBe(before + 1)
    expect(t.pendingList()).toBe(0)
    expect(t.trabajos()[0]?.attempts).toBe(before + 1)
  })

  it('lo ya impreso no se imprime otra vez al reiniciar', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    enviarN(t, t.device(), 2)
    await t.cola.runOnce()
    const another = t.crearCola()
    await another.runOnce()
    await another.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(2)
  })

  it('lo descartado por la caja no vuelve al reiniciar', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    enviarN(t, t.device(), 1)
    t.db
      .prepare("UPDATE print_jobs SET status = 'discarded', finished_at = ?")
      .run(new Date(t.clock()).toISOString())
    await t.crearCola().runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(0)
  })

  it('con una impresora real a medias (la comanda llegó pero no se confirmó), se reimprime: más vale repetida que perdida', async () => {
    let first = true
    const t = montarImpresion({
      send: (base) => async (target, bytes) => {
        await base(target, bytes)
        if (first) {
          first = false
          throw new Error('se cortó la conexión antes de cerrar')
        }
      },
    })
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    enviarN(t, t.device(), 1)
    await t.cola.runOnce()
    t.advance(2 * SEG)
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(2)
    expect(t.trabajos()[0]).toMatchObject({ status: 'printed', attempts: 2 })
  })
})

describe('la caída de la impresora no frena la sincronización', () => {
  it('con la cola trabada esperando a una impresora, el hub sigue aceptando eventos', async () => {
    let soltar: () => void = () => {}
    const door = new Promise<void>((r) => {
      soltar = r
    })
    const t = montarImpresion({
      send: (base) => async (target, bytes) => {
        await door
        return base(target, bytes)
      },
    })
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const ana = t.device()
    enviarN(t, ana, 1)
    t.cola.despertar() // queda esperando a la impresora
    // Mientras tanto, pedidos nuevos entran y se confirman, uno tras otro.
    const resultados: string[] = []
    for (let i = 0; i < 10; i++) {
      const { order, items } = t.orderWith(ana, [{ name: `Otro ${i}`, station: t.kitchen }])
      resultados.push(t.send(ana, order, items).status as string)
    }
    expect(new Set(resultados)).toEqual(new Set(['confirmed']))
    expect(kitchen.papel.recibidos).toHaveLength(0)
    expect(t.pendingList()).toBe(11)
    soltar()
    await t.cola.ready()
    // Lo que se acumuló sale en la vuelta siguiente, en orden.
    await t.cola.runOnce()
    expect(kitchen.papel.recibidos).toHaveLength(11)
    expect(t.pendingList()).toBe(0)
  })

  it('con la impresora apagada, los equipos conectados siguen recibiendo los eventos', async () => {
    const { SalaSync } = await import('@pos/sync')
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    const ana = t.device()
    const luis = t.device('waiter2')
    const sala = new SalaSync(t.hub, t.access.authenticate)
    const recibidos: { type: string }[] = []
    const aAna = sala.connect(() => {})
    const aLuis = sala.connect((m) => recibidos.push(m))
    aAna.recibir({
      type: 'hello',
      token: ana.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    aLuis.recibir({
      type: 'hello',
      token: luis.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    const { order, items } = t.orderWith(ana, [{ name: 'Pizza', station: t.kitchen }])
    const base = Number(t.db.prepare('SELECT max(sequence) AS s FROM events').get()?.s)
    const sendEvent = t.event(
      ana.connection,
      ana.session,
      'ItemsSent',
      { tickets: [{ ticket_id: newId(), station_id: t.kitchen, item_ids: [items[0]?.id] }] },
      { aggregate_id: order, base_sequence: base },
    )
    aAna.recibir({ type: 'push', lote_id: 'l1', events: [sendEvent] })
    expect(recibidos.filter((m) => m.type === 'new')).toHaveLength(1)
    await t.cola.runOnce()
    expect(t.pendingList()).toBe(1)
  })

  it('una cola que revienta por algo del hub avisa y no tumba nada', async () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.kitchen])
    enviarN(t, t.device(), 1)
    const broken = t.crearCola({
      send: () => {
        throw new TypeError('bug del transporte') // lanza síncrono, no rechaza
      },
    })
    broken.despertar()
    await expect(broken.ready()).resolves.toBeUndefined()
    // Un lanzamiento síncrono del transporte cuenta como fallo de la impresora, no del hub.
    expect(t.pendingList()).toBe(1)
    broken.detener()
  })
})

describe('despertar y vueltas simultáneas', () => {
  it('muchos despertares seguidos no imprimen una comanda dos veces', async () => {
    let enVuelo = 0
    let maximum = 0
    const t = montarImpresion({
      send: (base) => async (target, bytes) => {
        enVuelo += 1
        maximum = Math.max(maximum, enVuelo)
        await Promise.resolve()
        await Promise.resolve()
        await base(target, bytes)
        enVuelo -= 1
      },
    })
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    enviarN(t, t.device(), 5)
    for (let i = 0; i < 20; i++) t.cola.despertar()
    await t.cola.ready()
    expect(kitchen.papel.recibidos).toHaveLength(5)
    expect(maximum).toBe(1)
    expect(t.pendingList()).toBe(0)
  })

  it('un trabajo nuevo que llega durante una vuelta se imprime en la vuelta siguiente, sin esperar', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const ana = t.device()
    enviarN(t, ana, 1)
    t.cola.despertar()
    enviarN(t, ana, 1) // llega mientras corre la primera vuelta
    t.cola.despertar()
    await t.cola.ready()
    expect(kitchen.papel.recibidos).toHaveLength(2)
  })

  it('después de detener, despertar no hace nada', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    enviarN(t, t.device(), 1)
    t.cola.detener()
    t.cola.despertar()
    await t.cola.ready()
    expect(kitchen.papel.recibidos).toHaveLength(0)
    expect(t.pendingList()).toBe(1)
  })

  it('el temporizador vuelve a intentar cuando vence la espera, sin que nadie lo despierte', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 1)
    t.cola.despertar()
    await t.cola.ready()
    expect(kitchen.papel.attempts).toBe(1)
    kitchen.papel.apagada = false
    t.advance(1 * SEG)
    await vi.advanceTimersByTimeAsync(1 * SEG)
    await t.cola.ready()
    expect(kitchen.papel.recibidos).toHaveLength(1)
    expect(t.pendingList()).toBe(0)
    t.cola.detener()
  })
})

describe('avisos a los equipos', () => {
  it('avisa al primer repaso y después solo cuando algo cambia', async () => {
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    await t.cola.runOnce()
    expect(t.estadosAvisados).toHaveLength(1)
    await t.cola.runOnce()
    await t.cola.runOnce()
    expect(t.estadosAvisados).toHaveLength(1)
    kitchen.papel.apagada = true
    enviarN(t, t.device(), 1)
    await t.cola.runOnce()
    expect(t.estadosAvisados).toHaveLength(2)
    t.advance(31 * SEG)
    await t.cola.runOnce() // sigue igual de mal: mismo mensaje, no se repite... salvo el error
    const before = t.estadosAvisados.length
    t.advance(31 * SEG)
    await t.cola.runOnce()
    expect(t.estadosAvisados.length).toBe(before)
    kitchen.papel.apagada = false
    t.advance(31 * SEG)
    await t.cola.runOnce()
    expect(t.estadosAvisados.at(-1)).toMatchObject([
      { id: kitchen.id, status: 'ready', pendingList: 0 },
    ])
  })

  it('«una comanda no se pudo armar» aparece como una impresora en falla durante 15 minutos', async () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.kitchen])
    expect(t.cola.status().map((e) => e.id)).not.toContain('tickets')
    t.cola.comandaSinArmar()
    const alert = t.cola.status().find((e) => e.id === 'tickets')
    expect(alert).toMatchObject({ status: 'failed', pendingList: 0 })
    expect(alert?.error).toMatch(/Pedidos en cocina/)
    expect(t.estadosAvisados.at(-1)).toEqual(t.cola.status())
    t.advance(15 * 60 * SEG - 1)
    expect(t.cola.status().map((e) => e.id)).toContain('tickets')
    t.advance(1)
    expect(t.cola.status().map((e) => e.id)).not.toContain('tickets')
  })

  it('repetir el aviso de «no se pudo armar» reinicia los 15 minutos y no duplica la entrada', () => {
    const t = montarImpresion()
    t.cola.comandaSinArmar()
    t.advance(10 * 60 * SEG)
    t.cola.comandaSinArmar()
    t.advance(10 * 60 * SEG)
    expect(t.cola.status().filter((e) => e.id === 'tickets')).toHaveLength(1)
  })

  it('una impresora archivada no aparece en el estado', () => {
    const t = montarImpresion()
    t.impresoraNueva('Vieja', [t.kitchen], { active: 0 })
    const buena = t.impresoraNueva('Buena', [t.bar])
    expect(t.cola.status().map((e) => e.id)).toEqual([buena.id])
  })
})

describe('el aviso de la cola llega a los equipos por la sala (como lo cablea main.ts)', () => {
  it('quien está conectado lo recibe al cambiar y quien se conecta después, al saludar', async () => {
    const { SalaSync } = await import('@pos/sync')
    const t = montarImpresion()
    const kitchen = t.impresoraNueva('Cocina', [t.kitchen])
    const sala = new SalaSync(t.hub, t.access.authenticate)
    const cola = t.crearCola({ onChange: (statuses) => sala.avisarImpresoras(statuses) })
    const ana = t.device()
    const luis = t.device('waiter2')
    const deAna: { type: string; printers?: { status: string; pendingList: number }[] }[] = []
    const aAna = sala.connect((m) => deAna.push(m as never))
    aAna.recibir({
      type: 'hello',
      token: ana.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })

    kitchen.papel.apagada = true
    enviarN(t, ana, 1)
    await cola.runOnce()
    const latest = deAna.filter((m) => m.type === 'printers').at(-1)
    expect(latest?.printers).toMatchObject([{ status: 'failed', pendingList: 1 }])

    const deLuis: { type: string; printers?: { status: string }[] }[] = []
    const aLuis = sala.connect((m) => deLuis.push(m as never))
    aLuis.recibir({
      type: 'hello',
      token: luis.token,
      hub_instancia: null,
      until: 0,
      version_app: 'x',
    })
    expect(deLuis.map((m) => m.type)).toEqual(['welcome', 'printers'])
    expect(deLuis[1]?.printers).toMatchObject([{ status: 'failed' }])

    kitchen.papel.apagada = false
    t.advance(2 * SEG)
    await cola.runOnce()
    expect(deAna.filter((m) => m.type === 'printers').at(-1)?.printers).toMatchObject([
      { status: 'ready', pendingList: 0 },
    ])
    expect(deLuis.filter((m) => m.type === 'printers').at(-1)?.printers).toMatchObject([
      { status: 'ready' },
    ])
  })
})
