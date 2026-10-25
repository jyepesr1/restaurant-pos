import { nuevoId } from '@pos/core'
import { COLUMNAS, leerEscpos } from '@pos/printing'
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
function enviarN(
  t: MontajeImpresion,
  ana: Equipo,
  n: number,
  estacion = t.cocina,
  nombre = 'Plato',
) {
  for (let i = 0; i < n; i++) {
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: `${nombre} ${i + 1}`, estacion }])
    t.enviar(ana, pedido, items)
  }
}

const estadoDe = (t: MontajeImpresion, id: string) => t.cola.estado().find((e) => e.id === id)
const nombresImpresos = (p: { textos(): string[] }) =>
  p.textos().map((x) => /Plato (\d+)/.exec(x)?.[1])

describe('reintentos con espera creciente', () => {
  it('espera 1, 2, 4, 8, 16 y 30 s entre intentos, y se queda en 30 s sin rendirse', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 1)
    const esperas = [1, 2, 4, 8, 16, 30, 30, 30].map((s) => s * SEG)
    expect(cocina.papel.intentos).toBe(0)
    let intentos = 0
    for (const espera of esperas) {
      await t.cola.vuelta()
      intentos += 1
      expect(cocina.papel.intentos).toBe(intentos)
      // Un instante antes de vencer la espera no se vuelve a intentar.
      t.avanzar(espera - 1)
      await t.cola.vuelta()
      expect(cocina.papel.intentos).toBe(intentos)
      t.avanzar(1)
    }
    expect(t.pendientes()).toBe(1)
  })

  it('después de 40 fallos sigue pendiente, sin descartarse, y cada intento cuenta', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 1)
    for (let i = 0; i < 40; i++) {
      await t.cola.vuelta()
      t.avanzar(31 * SEG)
    }
    const [fila] = t.trabajos()
    expect(fila).toMatchObject({ estado: 'pendiente', intentos: 40 })
    expect(String(fila?.ultimo_error)).toContain('rechazó la conexión')
    cocina.papel.apagada = false
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(0)
    expect(t.trabajos()[0]).toMatchObject({
      estado: 'impreso',
      intentos: 41,
      impreso_en_id: cocina.id,
    })
  })

  it('cuando la impresora vuelve, saca lo pendiente en el orden en que se envió', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 4)
    await t.cola.vuelta()
    // Mientras está caída no se salta a la siguiente: solo se intenta la primera.
    expect(cocina.papel.intentos).toBe(1)
    cocina.papel.apagada = false
    t.avanzar(2 * SEG)
    await t.cola.vuelta()
    expect(nombresImpresos(cocina.papel)).toEqual(['1', '2', '3', '4'])
    expect(t.pendientes()).toBe(0)
  })

  it('una comanda nueva no pasa delante de una que espera en la misma impresora', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const ana = t.equipo()
    cocina.papel.apagada = true
    enviarN(t, ana, 1)
    await t.cola.vuelta()
    enviarN(t, ana, 1)
    cocina.papel.apagada = false
    t.avanzar(2 * SEG)
    await t.cola.vuelta()
    expect(cocina.papel.textos().map((x) => /#(\d+)/.exec(x)?.[1])).toEqual(['1', '2'])
    expect(t.trabajos().map((f) => f.estado)).toEqual(['impreso', 'impreso'])
  })

  it('el orden es el de llegada (rowid) aunque el reloj del PC se haya corregido hacia atrás', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const ana = t.equipo()
    enviarN(t, ana, 2)
    // El reloj del PC se corrigió hacia atrás: la segunda quedó con una hora anterior a la primera.
    t.db
      .prepare(
        'UPDATE trabajo_impresion SET creado_en = ? WHERE rowid = (SELECT max(rowid) FROM trabajo_impresion)',
      )
      .run('2026-10-24T10:00:00.000Z')
    await t.cola.vuelta()
    // La primera en llegar sale primero: sus números de comanda salen 1 y luego 2.
    expect(cocina.papel.textos().map((x) => /#(\d+)/.exec(x)?.[1])).toEqual(['1', '2'])
  })

  it('cada impresora sigue su ritmo: una caída no retrasa a la otra', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const barra = t.impresoraNueva('Barra', [t.barra])
    cocina.papel.apagada = true
    const ana = t.equipo()
    enviarN(t, ana, 3, t.cocina)
    enviarN(t, ana, 3, t.barra)
    await t.cola.vuelta()
    expect(barra.papel.recibidos).toHaveLength(3)
    expect(cocina.papel.recibidos).toHaveLength(0)
    expect(estadoDe(t, cocina.id)).toMatchObject({ estado: 'falla', pendientes: 3 })
    expect(estadoDe(t, barra.id)).toMatchObject({ estado: 'lista', pendientes: 0, error: null })
  })

  it('el estado cuenta las comandas en espera y dice qué pasó, en palabras', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 2)
    expect(estadoDe(t, cocina.id)).toMatchObject({ estado: 'lista', pendientes: 2 })
    await t.cola.vuelta()
    expect(estadoDe(t, cocina.id)).toEqual({
      id: cocina.id,
      nombre: 'Cocina',
      estado: 'falla',
      error: 'La impresora rechazó la conexión: revisa el puerto (casi siempre 9100).',
      pendientes: 2,
    })
    cocina.papel.apagada = false
    t.avanzar(5 * SEG)
    await t.cola.vuelta()
    expect(estadoDe(t, cocina.id)).toMatchObject({ estado: 'lista', error: null, pendientes: 0 })
  })
})

describe('impresora de respaldo', () => {
  async function montarConRespaldo() {
    const t = montarImpresion()
    const respaldo = t.impresoraNueva('Respaldo', [], { ancho: 58, pagina_codigos: 'wpc1252' })
    const cocina = t.impresoraNueva('Cocina', [t.cocina], { respaldo_id: respaldo.id })
    cocina.papel.apagada = true
    const ana = t.equipo()
    return { t, respaldo, cocina, ana }
  }

  const fallar = async (t: MontajeImpresion, veces = FALLOS_PARA_RESPALDO) => {
    for (let i = 0; i < veces; i++) {
      await t.cola.vuelta()
      t.avanzar(60 * SEG)
    }
  }

  it('a los 3 fallos seguidos la comanda sale por el respaldo, impresa con el ancho del respaldo', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    await fallar(t, 2)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    await fallar(t, 1)
    expect(cocina.papel.intentos).toBe(3)
    // Justo después del tercer fallo la espera de la cocina no ha vencido: sale por el respaldo.
    t.avanzar(-60 * SEG + 1)
    await t.cola.vuelta()
    expect(respaldo.papel.recibidos).toHaveLength(1)
    const bytes = respaldo.papel.recibidos[0] as Uint8Array
    // 58 mm: ninguna línea de texto pasa de 32 columnas; y usa la tabla wpc1252 (ESC t 16).
    expect([...bytes.slice(2, 5)]).toEqual([0x1b, 0x74, 16])
    for (const linea of leerEscpos(bytes).texto.split('\n'))
      expect(linea.length).toBeLessThanOrEqual(COLUMNAS[58])
    expect(t.trabajos()[0]).toMatchObject({
      estado: 'impreso',
      impresora_id: cocina.id,
      impreso_en_id: respaldo.id,
    })
  })

  it('el aviso a los equipos sigue diciendo que la impresora original no responde', async () => {
    const { t, cocina, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    await fallar(t)
    t.avanzar(-60 * SEG + 1)
    await t.cola.vuelta()
    expect(estadoDe(t, cocina.id)).toMatchObject({ estado: 'falla' })
    const ultimo = t.estadosAvisados.at(-1) as { id: string; estado: string }[]
    expect(ultimo.find((e) => e.id === cocina.id)?.estado).toBe('falla')
  })

  it('cuando la original se arregla, la próxima comanda la prueba y vuelve a salir por ella', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    await fallar(t)
    t.avanzar(-60 * SEG + 1)
    await t.cola.vuelta()
    expect(respaldo.papel.recibidos).toHaveLength(1)
    // Se enciende la impresora y llegan tres comandas más.
    cocina.papel.apagada = false
    t.avanzar(60 * SEG)
    enviarN(t, ana, 3, t.cocina, 'Nueva')
    await t.cola.vuelta()
    // La prueba lleva solo una comanda; el resto espera esa vuelta.
    expect(cocina.papel.recibidos).toHaveLength(1)
    expect(respaldo.papel.recibidos).toHaveLength(1)
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(3)
    expect(respaldo.papel.recibidos).toHaveLength(1)
    expect(estadoDe(t, cocina.id)).toMatchObject({ estado: 'lista', error: null })
    expect(t.pendientes()).toBe(0)
  })

  it('si la prueba de la original falla, esa vuelta no imprime nada y la siguiente usa el respaldo', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    enviarN(t, ana, 2)
    await fallar(t) // 3 fallos
    t.avanzar(1) // vence la espera del tercer fallo
    const antes = cocina.papel.intentos
    await t.cola.vuelta() // prueba (falla otra vez): solo se intenta una comanda
    expect(cocina.papel.intentos).toBe(antes + 1)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    await t.cola.vuelta() // ya no toca probar: sale todo por el respaldo
    expect(respaldo.papel.recibidos).toHaveLength(2)
    expect(cocina.papel.intentos).toBe(antes + 1)
  })

  it('un respaldo que también falla: nada sale, las dos quedan en falla y nada se pierde', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    respaldo.papel.apagada = true
    enviarN(t, ana, 2)
    await fallar(t) // los 3 fallos
    for (let i = 0; i < 4; i++) {
      await t.cola.vuelta() // prueba de la original
      await t.cola.vuelta() // y enseguida, el respaldo
      t.avanzar(60 * SEG)
    }
    expect(cocina.papel.recibidos).toHaveLength(0)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    expect(respaldo.papel.intentos).toBeGreaterThan(0)
    expect(estadoDe(t, cocina.id)?.estado).toBe('falla')
    expect(estadoDe(t, respaldo.id)?.estado).toBe('falla')
    expect(t.pendientes()).toBe(2)
    // Vuelve el respaldo: sale todo, en orden.
    respaldo.papel.apagada = false
    t.avanzar(60 * SEG)
    await t.cola.vuelta()
    await t.cola.vuelta()
    expect(nombresImpresos(respaldo.papel)).toEqual(['1', '2'])
    expect(t.pendientes()).toBe(0)
  })

  it('un respaldo archivado no se usa: la comanda espera a la original', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(respaldo.id)
    enviarN(t, ana, 1)
    await fallar(t, 6)
    expect(respaldo.papel.intentos).toBe(0)
    expect(t.pendientes()).toBe(1)
    cocina.papel.apagada = false
    t.avanzar(60 * SEG)
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(1)
  })

  it('una impresora archivada con respaldo pasa sus comandas pendientes al respaldo sin esperar fallos', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    cocina.papel.apagada = false
    enviarN(t, ana, 2)
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(cocina.id)
    await t.cola.vuelta()
    expect(cocina.papel.intentos).toBe(0)
    expect(nombresImpresos(respaldo.papel)).toEqual(['1', '2'])
    expect(t.trabajos().every((f) => f.impreso_en_id === respaldo.id)).toBe(true)
  })

  it('las comandas propias del respaldo y las que le llegan de otra salen juntas, en orden de llegada', async () => {
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    t.db
      .prepare('UPDATE impresora SET estacion_ids = ? WHERE id = ?')
      .run(JSON.stringify([t.barra]), respaldo.id)
    enviarN(t, ana, 1, t.cocina, 'Cocina')
    await fallar(t)
    enviarN(t, ana, 1, t.barra, 'Barra')
    enviarN(t, ana, 1, t.cocina, 'Cocina')
    t.avanzar(-60 * SEG + 1)
    await t.cola.vuelta()
    expect(respaldo.papel.recibidos).toHaveLength(3)
    expect(cocina.papel.recibidos).toHaveLength(0)
    expect(respaldo.papel.textos().map((x) => (x.includes('BARRA') ? 'barra' : 'cocina'))).toEqual([
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
    const { t, respaldo, cocina, ana } = await montarConRespaldo()
    enviarN(t, ana, 1)
    t.cola.despertar()
    await t.cola.listo()
    for (let i = 0; i < 120; i++) {
      t.avanzar(1 * SEG)
      await vi.advanceTimersByTimeAsync(1 * SEG)
      await t.cola.listo()
    }
    t.cola.detener()
    expect(cocina.papel.intentos).toBeGreaterThanOrEqual(FALLOS_PARA_RESPALDO)
    expect(respaldo.papel.recibidos).toHaveLength(1)
  })

  it('las páginas de prueba nunca salen por el respaldo', async () => {
    const { t, respaldo, cocina } = await montarConRespaldo()
    t.db
      .prepare(
        `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
         VALUES ('01PRUEBA0000000000000000AA', ?, ?, 'prueba', '{"impresora":"Cocina","estaciones":[],"hora":"x"}', ?)`,
      )
      .run(t.restauranteId, cocina.id, new Date(t.reloj()).toISOString())
    await fallar(t, 6)
    expect(respaldo.papel.recibidos).toHaveLength(0)
    expect(t.pendientes()).toBe(1)
  })
})

describe('páginas de prueba', () => {
  const insertarPrueba = (t: MontajeImpresion, impresoraId: string) =>
    t.db
      .prepare(
        `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
         VALUES ('01PRUEBA0000000000000000BB', ?, ?, 'prueba', '{"impresora":"Cocina","estaciones":["Cocina"],"hora":"3:00 p. m."}', ?)`,
      )
      .run(t.restauranteId, impresoraId, new Date(t.reloj()).toISOString())

  it('sale con la regla del ancho de la impresora', async () => {
    const t = montarImpresion()
    const chica = t.impresoraNueva('Chica', [], { ancho: 58 })
    insertarPrueba(t, chica.id)
    await t.cola.vuelta()
    const texto = chica.papel.textos()[0] as string
    expect(texto.replaceAll('\n', ' ')).toContain('PRUEBA DE IMPRESIÓN')
    expect(texto.split('\n')).toContain(`${'1234567890'.repeat(3)}12`)
  })

  it('si no sale en 5 minutos se descarta sola, con el motivo, y deja de contar como pendiente', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    insertarPrueba(t, cocina.id)
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(1)
    t.avanzar(VIGENCIA_PRUEBA_MS - 1000)
    cocina.papel.apagada = true
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(1)
    t.avanzar(2000)
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(0)
    expect(t.trabajos()[0]).toMatchObject({
      estado: 'descartado',
      ultimo_error: 'La prueba no salió en 5 minutos',
      descartado_por_id: null,
    })
  })

  it('una prueba vencida no frena a las comandas que están detrás', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    insertarPrueba(t, cocina.id)
    t.avanzar(VIGENCIA_PRUEBA_MS + 1000)
    enviarN(t, t.equipo(), 1)
    cocina.papel.apagada = false
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(1)
    expect(cocina.papel.textos()[0]).toContain('Plato 1')
  })
})

describe('una impresora archivada sin respaldo', () => {
  it('sus comandas esperan sin imprimirse ni intentarse, y no se pierden', async () => {
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.cocina])
    enviarN(t, t.equipo(), 2)
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(vieja.id)
    await t.cola.vuelta()
    expect(vieja.papel.intentos).toBe(0)
    expect(t.pendientes()).toBe(2)
    // No aparece entre las impresoras activas.
    expect(t.cola.estado()).toEqual([])
  })

  it('no gira a toda prisa: la próxima vuelta se programa a 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.cocina])
    enviarN(t, t.equipo(), 1)
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(vieja.id)
    const vuelta = vi.spyOn(t.cola, 'vuelta')
    t.cola.despertar()
    await t.cola.listo()
    expect(vuelta).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(vuelta).toHaveBeenCalledTimes(1)
    t.avanzar(30 * SEG)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(vuelta).toHaveBeenCalledTimes(2)
    t.cola.detener()
  })

  it('al reactivar la impresora (o reimprimir en otra) las comandas salen', async () => {
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.cocina])
    enviarN(t, t.equipo(), 1)
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(vieja.id)
    await t.cola.vuelta()
    t.db.prepare('UPDATE impresora SET activo = 1 WHERE id = ?').run(vieja.id)
    t.avanzar(31 * SEG)
    await t.cola.vuelta()
    expect(vieja.papel.recibidos).toHaveLength(1)
  })

  it('la caja ve por qué no sale una comanda de una impresora archivada sin respaldo', async () => {
    // El motivo vive solo en la memoria de la cola y las archivadas no aparecen en `estado()`: la
    // lista de pendientes muestra la comanda sin error.
    const t = montarImpresion()
    const vieja = t.impresoraNueva('Vieja', [t.cocina])
    enviarN(t, t.equipo(), 1)
    t.db.prepare('UPDATE impresora SET activo = 0 WHERE id = ?').run(vieja.id)
    await t.cola.vuelta()
    expect(String(t.trabajos()[0]?.ultimo_error ?? '')).toMatch(/archivada/)
  })
})

describe('contenido que no se entiende', () => {
  it.each(['null', '{}', '{"tipo":"nueva"}', '[1,2]', '"texto"'])(
    'el trabajo con contenido %s se descarta y no frena al siguiente',
    async (contenido) => {
      const t = montarImpresion()
      const cocina = t.impresoraNueva('Cocina', [t.cocina])
      t.db
        .prepare(
          `INSERT INTO trabajo_impresion (id, restaurante_id, impresora_id, tipo, contenido, creado_en)
           VALUES ('01MALO000000000000000000AA', ?, ?, 'comanda', ?, ?)`,
        )
        .run(t.restauranteId, cocina.id, contenido, new Date(t.reloj()).toISOString())
      enviarN(t, t.equipo(), 1)
      await t.cola.vuelta()
      const malo = t.trabajos().find((f) => f.id === '01MALO000000000000000000AA')
      const bueno = t.trabajos().find((f) => f.id !== '01MALO000000000000000000AA')
      expect(malo).toMatchObject({
        estado: 'descartado',
        ultimo_error: 'No se pudo armar la comanda',
      })
      expect(bueno?.estado).toBe('impreso')
      expect(cocina.papel.recibidos).toHaveLength(1)
    },
  )
})

describe('el hub reiniciado con trabajos pendientes', () => {
  it('al arrancar sale todo lo que quedó en la cola, aunque antes hubiera fallado', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const barra = t.impresoraNueva('Barra', [t.barra])
    cocina.papel.apagada = true
    const ana = t.equipo()
    enviarN(t, ana, 2, t.cocina)
    enviarN(t, ana, 1, t.barra)
    // El hub se cae justo después de aceptar los envíos: la cola no alcanzó a imprimir.
    t.cola.detener()
    expect(t.pendientes()).toBe(3)

    // Vuelve a arrancar: otra cola sobre la misma base, sin la memoria de los fallos.
    cocina.papel.apagada = false
    const arrancada = t.crearCola()
    arrancada.despertar()
    await arrancada.listo()
    expect(nombresImpresos(cocina.papel)).toEqual(['1', '2'])
    expect(barra.papel.recibidos).toHaveLength(1)
    expect(t.pendientes()).toBe(0)
    arrancada.detener()
  })

  it('la cola nueva no recuerda la espera de la anterior: reintenta de inmediato', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 1)
    for (let i = 0; i < 4; i++) {
      await t.cola.vuelta()
      t.avanzar(60 * SEG)
    }
    const antes = cocina.papel.intentos
    t.cola.detener()
    cocina.papel.apagada = false
    const arrancada = t.crearCola()
    await arrancada.vuelta()
    expect(cocina.papel.intentos).toBe(antes + 1)
    expect(t.pendientes()).toBe(0)
    expect(t.trabajos()[0]?.intentos).toBe(antes + 1)
  })

  it('lo ya impreso no se imprime otra vez al reiniciar', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    enviarN(t, t.equipo(), 2)
    await t.cola.vuelta()
    const otra = t.crearCola()
    await otra.vuelta()
    await otra.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(2)
  })

  it('lo descartado por la caja no vuelve al reiniciar', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    enviarN(t, t.equipo(), 1)
    t.db
      .prepare("UPDATE trabajo_impresion SET estado = 'descartado', terminado_en = ?")
      .run(new Date(t.reloj()).toISOString())
    await t.crearCola().vuelta()
    expect(cocina.papel.recibidos).toHaveLength(0)
  })

  it('con una impresora real a medias (la comanda llegó pero no se confirmó), se reimprime: más vale repetida que perdida', async () => {
    let primera = true
    const t = montarImpresion({
      enviar: (base) => async (destino, bytes) => {
        await base(destino, bytes)
        if (primera) {
          primera = false
          throw new Error('se cortó la conexión antes de cerrar')
        }
      },
    })
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    enviarN(t, t.equipo(), 1)
    await t.cola.vuelta()
    t.avanzar(2 * SEG)
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(2)
    expect(t.trabajos()[0]).toMatchObject({ estado: 'impreso', intentos: 2 })
  })
})

describe('la caída de la impresora no frena la sincronización', () => {
  it('con la cola trabada esperando a una impresora, el hub sigue aceptando eventos', async () => {
    let soltar: () => void = () => {}
    const puerta = new Promise<void>((r) => {
      soltar = r
    })
    const t = montarImpresion({
      enviar: (base) => async (destino, bytes) => {
        await puerta
        return base(destino, bytes)
      },
    })
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const ana = t.equipo()
    enviarN(t, ana, 1)
    t.cola.despertar() // queda esperando a la impresora
    // Mientras tanto, pedidos nuevos entran y se confirman, uno tras otro.
    const resultados: string[] = []
    for (let i = 0; i < 10; i++) {
      const { pedido, items } = t.pedidoCon(ana, [{ nombre: `Otro ${i}`, estacion: t.cocina }])
      resultados.push(t.enviar(ana, pedido, items).estado as string)
    }
    expect(new Set(resultados)).toEqual(new Set(['confirmado']))
    expect(cocina.papel.recibidos).toHaveLength(0)
    expect(t.pendientes()).toBe(11)
    soltar()
    await t.cola.listo()
    // Lo que se acumuló sale en la vuelta siguiente, en orden.
    await t.cola.vuelta()
    expect(cocina.papel.recibidos).toHaveLength(11)
    expect(t.pendientes()).toBe(0)
  })

  it('con la impresora apagada, los equipos conectados siguen recibiendo los eventos', async () => {
    const { SalaSync } = await import('@pos/sync')
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    const ana = t.equipo()
    const luis = t.equipo('mesero2')
    const sala = new SalaSync(t.hub, t.acceso.autenticar)
    const recibidos: { tipo: string }[] = []
    const aAna = sala.conectar(() => {})
    const aLuis = sala.conectar((m) => recibidos.push(m))
    aAna.recibir({
      tipo: 'hola',
      token: ana.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    aLuis.recibir({
      tipo: 'hola',
      token: luis.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    const { pedido, items } = t.pedidoCon(ana, [{ nombre: 'Pizza', estacion: t.cocina }])
    const base = Number(t.db.prepare('SELECT max(secuencia) AS s FROM evento').get()?.s)
    const enviarEvento = t.evento(
      ana.conexion,
      ana.sesion,
      'ItemsEnviados',
      { comandas: [{ comanda_id: nuevoId(), estacion_id: t.cocina, item_ids: [items[0]?.id] }] },
      { agregado_id: pedido, secuencia_base: base },
    )
    aAna.recibir({ tipo: 'empujar', lote_id: 'l1', eventos: [enviarEvento] })
    expect(recibidos.filter((m) => m.tipo === 'nuevo')).toHaveLength(1)
    await t.cola.vuelta()
    expect(t.pendientes()).toBe(1)
  })

  it('una cola que revienta por algo del hub avisa y no tumba nada', async () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.cocina])
    enviarN(t, t.equipo(), 1)
    const rota = t.crearCola({
      enviar: () => {
        throw new TypeError('bug del transporte') // lanza síncrono, no rechaza
      },
    })
    rota.despertar()
    await expect(rota.listo()).resolves.toBeUndefined()
    // Un lanzamiento síncrono del transporte cuenta como fallo de la impresora, no del hub.
    expect(t.pendientes()).toBe(1)
    rota.detener()
  })
})

describe('despertar y vueltas simultáneas', () => {
  it('muchos despertares seguidos no imprimen una comanda dos veces', async () => {
    let enVuelo = 0
    let maximo = 0
    const t = montarImpresion({
      enviar: (base) => async (destino, bytes) => {
        enVuelo += 1
        maximo = Math.max(maximo, enVuelo)
        await Promise.resolve()
        await Promise.resolve()
        await base(destino, bytes)
        enVuelo -= 1
      },
    })
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    enviarN(t, t.equipo(), 5)
    for (let i = 0; i < 20; i++) t.cola.despertar()
    await t.cola.listo()
    expect(cocina.papel.recibidos).toHaveLength(5)
    expect(maximo).toBe(1)
    expect(t.pendientes()).toBe(0)
  })

  it('un trabajo nuevo que llega durante una vuelta se imprime en la vuelta siguiente, sin esperar', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const ana = t.equipo()
    enviarN(t, ana, 1)
    t.cola.despertar()
    enviarN(t, ana, 1) // llega mientras corre la primera vuelta
    t.cola.despertar()
    await t.cola.listo()
    expect(cocina.papel.recibidos).toHaveLength(2)
  })

  it('después de detener, despertar no hace nada', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    enviarN(t, t.equipo(), 1)
    t.cola.detener()
    t.cola.despertar()
    await t.cola.listo()
    expect(cocina.papel.recibidos).toHaveLength(0)
    expect(t.pendientes()).toBe(1)
  })

  it('el temporizador vuelve a intentar cuando vence la espera, sin que nadie lo despierte', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 1)
    t.cola.despertar()
    await t.cola.listo()
    expect(cocina.papel.intentos).toBe(1)
    cocina.papel.apagada = false
    t.avanzar(1 * SEG)
    await vi.advanceTimersByTimeAsync(1 * SEG)
    await t.cola.listo()
    expect(cocina.papel.recibidos).toHaveLength(1)
    expect(t.pendientes()).toBe(0)
    t.cola.detener()
  })
})

describe('avisos a los equipos', () => {
  it('avisa al primer repaso y después solo cuando algo cambia', async () => {
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    await t.cola.vuelta()
    expect(t.estadosAvisados).toHaveLength(1)
    await t.cola.vuelta()
    await t.cola.vuelta()
    expect(t.estadosAvisados).toHaveLength(1)
    cocina.papel.apagada = true
    enviarN(t, t.equipo(), 1)
    await t.cola.vuelta()
    expect(t.estadosAvisados).toHaveLength(2)
    t.avanzar(31 * SEG)
    await t.cola.vuelta() // sigue igual de mal: mismo mensaje, no se repite... salvo el error
    const antes = t.estadosAvisados.length
    t.avanzar(31 * SEG)
    await t.cola.vuelta()
    expect(t.estadosAvisados.length).toBe(antes)
    cocina.papel.apagada = false
    t.avanzar(31 * SEG)
    await t.cola.vuelta()
    expect(t.estadosAvisados.at(-1)).toMatchObject([
      { id: cocina.id, estado: 'lista', pendientes: 0 },
    ])
  })

  it('«una comanda no se pudo armar» aparece como una impresora en falla durante 15 minutos', async () => {
    const t = montarImpresion()
    t.impresoraNueva('Cocina', [t.cocina])
    expect(t.cola.estado().map((e) => e.id)).not.toContain('comandas')
    t.cola.comandaSinArmar()
    const aviso = t.cola.estado().find((e) => e.id === 'comandas')
    expect(aviso).toMatchObject({ estado: 'falla', pendientes: 0 })
    expect(aviso?.error).toMatch(/Pedidos en cocina/)
    expect(t.estadosAvisados.at(-1)).toEqual(t.cola.estado())
    t.avanzar(15 * 60 * SEG - 1)
    expect(t.cola.estado().map((e) => e.id)).toContain('comandas')
    t.avanzar(1)
    expect(t.cola.estado().map((e) => e.id)).not.toContain('comandas')
  })

  it('repetir el aviso de «no se pudo armar» reinicia los 15 minutos y no duplica la entrada', () => {
    const t = montarImpresion()
    t.cola.comandaSinArmar()
    t.avanzar(10 * 60 * SEG)
    t.cola.comandaSinArmar()
    t.avanzar(10 * 60 * SEG)
    expect(t.cola.estado().filter((e) => e.id === 'comandas')).toHaveLength(1)
  })

  it('una impresora archivada no aparece en el estado', () => {
    const t = montarImpresion()
    t.impresoraNueva('Vieja', [t.cocina], { activo: 0 })
    const buena = t.impresoraNueva('Buena', [t.barra])
    expect(t.cola.estado().map((e) => e.id)).toEqual([buena.id])
  })
})

describe('el aviso de la cola llega a los equipos por la sala (como lo cablea main.ts)', () => {
  it('quien está conectado lo recibe al cambiar y quien se conecta después, al saludar', async () => {
    const { SalaSync } = await import('@pos/sync')
    const t = montarImpresion()
    const cocina = t.impresoraNueva('Cocina', [t.cocina])
    const sala = new SalaSync(t.hub, t.acceso.autenticar)
    const cola = t.crearCola({ alCambiar: (estados) => sala.avisarImpresoras(estados) })
    const ana = t.equipo()
    const luis = t.equipo('mesero2')
    const deAna: { tipo: string; impresoras?: { estado: string; pendientes: number }[] }[] = []
    const aAna = sala.conectar((m) => deAna.push(m as never))
    aAna.recibir({
      tipo: 'hola',
      token: ana.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })

    cocina.papel.apagada = true
    enviarN(t, ana, 1)
    await cola.vuelta()
    const ultimo = deAna.filter((m) => m.tipo === 'impresoras').at(-1)
    expect(ultimo?.impresoras).toMatchObject([{ estado: 'falla', pendientes: 1 }])

    const deLuis: { tipo: string; impresoras?: { estado: string }[] }[] = []
    const aLuis = sala.conectar((m) => deLuis.push(m as never))
    aLuis.recibir({
      tipo: 'hola',
      token: luis.token,
      hub_instancia: null,
      hasta: 0,
      version_app: 'x',
    })
    expect(deLuis.map((m) => m.tipo)).toEqual(['bienvenido', 'impresoras'])
    expect(deLuis[1]?.impresoras).toMatchObject([{ estado: 'falla' }])

    cocina.papel.apagada = false
    t.avanzar(2 * SEG)
    await cola.vuelta()
    expect(deAna.filter((m) => m.tipo === 'impresoras').at(-1)?.impresoras).toMatchObject([
      { estado: 'lista', pendientes: 0 },
    ])
    expect(deLuis.filter((m) => m.tipo === 'impresoras').at(-1)?.impresoras).toMatchObject([
      { estado: 'lista' },
    ])
  })
})
