import { nuevoId } from '@pos/core'
import { leerEscpos } from '@pos/printing'
import { HubSync } from '@pos/sync'
import { AlmacenSqlite } from '@pos/sync/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { montarAcceso } from '../acceso/montaje'
import { ABRIR, item } from '../acceso/montaje-hub'
import { insertarVersionado, SISTEMA } from '../acceso/registros'
import { ColaImpresion } from './cola'
import { trabajosDeEvento } from './comandas'
import { abrirImpresoraDePrueba, type ImpresoraDePrueba } from './impresora-prueba'

// De punta a punta en el hub (ADR-015): el mesero envía, el hub guarda la comanda en la cola en
// la misma transacción del evento y la cola la manda a la impresora de red de la estación.

const abiertas: ImpresoraDePrueba[] = []
afterEach(async () => {
  for (const i of abiertas.splice(0)) await i.cerrar()
})

async function montar() {
  const m = montarAcceso()
  const ahora = m.reloj()
  const cocina = insertarVersionado(
    m.db,
    'estacion',
    m.restauranteId,
    { nombre: 'Cocina', orden: 1 },
    SISTEMA,
    ahora,
  )
  const barra = insertarVersionado(
    m.db,
    'estacion',
    m.restauranteId,
    { nombre: 'Barra', orden: 2 },
    SISTEMA,
    ahora,
  )
  const opciones = { db: m.db, restauranteId: m.restauranteId, zonaHoraria: 'America/Bogota' }
  const cola = new ColaImpresion({ db: m.db, restauranteId: m.restauranteId })
  const hub = new HubSync(new AlmacenSqlite(m.db, m.restauranteId), {
    restauranteId: m.restauranteId,
    zonaHoraria: 'America/Bogota',
    inicioDiaOperativo: '06:00',
    instancia: 'hub-1',
    reloj: m.reloj,
    acceso: m.acceso,
    alGuardar: (evento, cambios) => {
      trabajosDeEvento(opciones, evento, cambios)
    },
  })
  const impresora = async (
    nombre: string,
    estaciones: string[],
    respaldo: string | null = null,
  ) => {
    const prueba = await abrirImpresoraDePrueba()
    abiertas.push(prueba)
    const id = insertarVersionado(
      m.db,
      'impresora',
      m.restauranteId,
      {
        nombre,
        conexion: 'red',
        direccion: '127.0.0.1',
        puerto: prueba.puerto,
        ancho: 80,
        pagina_codigos: 'pc850',
        respaldo_id: respaldo,
        estacion_ids: JSON.stringify(estaciones),
      },
      SISTEMA,
      ahora,
    )
    return { id, prueba }
  }
  const { conexion } = m.emparejar('mesero')
  const sesion = m.entrar(conexion, 'mesero')
  /** Abre un pedido con un plato de cocina y una bebida de barra, y los envía. */
  const enviar = () => {
    const pedido = nuevoId()
    const plato = {
      ...item([{ modificador_id: nuevoId(), nombre: 'Término medio', precio_extra: 0 }]),
      nombre: 'Tagliata',
      comensal: 1,
    }
    const bebida = { ...item(), nombre: 'Aperol Spritz' }
    const en = { agregado_id: pedido }
    const base = m.db.prepare('SELECT coalesce(max(secuencia), 0) AS s FROM evento').get()
      ?.s as number
    const r = hub.recibirLote(conexion, [
      m.evento(conexion, sesion, 'PedidoAbierto', ABRIR, { ...en, secuencia_base: base }),
      m.evento(conexion, sesion, 'ItemAgregado', plato, { ...en, secuencia_base: base + 1 }),
      m.evento(conexion, sesion, 'ItemAgregado', bebida, { ...en, secuencia_base: base + 2 }),
      m.evento(
        conexion,
        sesion,
        'ItemsEnviados',
        {
          comandas: [
            { comanda_id: nuevoId(), estacion_id: cocina, item_ids: [plato.item_id] },
            { comanda_id: nuevoId(), estacion_id: barra, item_ids: [bebida.item_id] },
          ],
        },
        { ...en, secuencia_base: base + 3 },
      ),
    ])
    expect(r.resultados.map((x) => x.estado)).toEqual([
      'confirmado',
      'confirmado',
      'confirmado',
      'confirmado',
    ])
    return r.aceptados.at(-1)
  }
  return { m, cola, hub, cocina, barra, impresora, enviar }
}

const pendientes = (m: ReturnType<typeof montarAcceso>) =>
  Number(
    m.db.prepare("SELECT count(*) AS n FROM trabajo_impresion WHERE estado = 'pendiente'").get()?.n,
  )

describe('comandas impresas', () => {
  it('cada estación imprime lo suyo, con número del día seguido', async () => {
    const t = await montar()
    const cocina = await t.impresora('Cocina', [t.cocina])
    const barra = await t.impresora('Barra', [t.barra])
    const enviado = t.enviar()
    expect(Object.values(enviado?.asignaciones.numeros_comanda ?? {})).toEqual([1, 2])
    expect(pendientes(t.m)).toBe(2)
    await t.cola.vuelta()
    expect(pendientes(t.m)).toBe(0)
    await cocina.prueba.esperar(1)
    await barra.prueba.esperar(1)
    const enCocina = leerEscpos(cocina.prueba.recibidos[0] as Uint8Array).texto
    expect(enCocina).toContain('COCINA')
    expect(enCocina).toContain('Tagliata')
    expect(enCocina).toContain('> Término medio')
    expect(enCocina).toMatch(/Mesa +#1/)
    expect(enCocina).not.toContain('Aperol')
    expect(leerEscpos(barra.prueba.recibidos[0] as Uint8Array).texto).toContain('Aperol Spritz')
    // Un segundo envío sigue la numeración del día.
    const otro = t.enviar()
    expect(Object.values(otro?.asignaciones.numeros_comanda ?? {})).toEqual([3, 4])
  })

  it('una estación sin impresora no deja trabajos', async () => {
    const t = await montar()
    await t.impresora('Barra', [t.barra])
    t.enviar()
    expect(pendientes(t.m)).toBe(1)
  })

  it('si la impresora no responde, se reintenta, y a los 3 fallos sale por la de respaldo', async () => {
    const t = await montar()
    const respaldo = await t.impresora('Respaldo', [])
    const cocina = await t.impresora('Cocina', [t.cocina], respaldo.id)
    await cocina.prueba.apagar(true)
    let ahora = Date.now()
    const cola = new ColaImpresion({
      db: t.m.db,
      restauranteId: t.m.restauranteId,
      reloj: () => ahora,
    })
    t.enviar()
    for (let i = 0; i < 3; i++) {
      if (i > 0) ahora += 60_000
      await cola.vuelta()
    }
    expect(cola.estado().find((e) => e.id === cocina.id)?.estado).toBe('falla')
    expect(cocina.prueba.recibidos).toHaveLength(0)
    await cola.vuelta()
    await respaldo.prueba.esperar(1)
    expect(respaldo.prueba.recibidos).toHaveLength(1)
    expect(leerEscpos(respaldo.prueba.recibidos[0] as Uint8Array).texto).toContain('Tagliata')
    const fila = t.m.db.prepare("SELECT * FROM trabajo_impresion WHERE tipo = 'comanda'").get()
    expect(fila?.estado).toBe('impreso')
    expect(fila?.impreso_en_id).toBe(respaldo.id)
    expect(Number(fila?.intentos)).toBe(4)
  })

  it('el reintento del mismo envío no duplica la comanda', async () => {
    const t = await montar()
    await t.impresora('Cocina', [t.cocina])
    const evento = t.enviar()
    if (!evento) throw new Error('sin evento')
    const cambios = [{ antes: null, despues: t.hub.pedido(evento.agregado_id) }]
    // Ya enviado: no queda nada «pendiente → enviado» y no se arma nada nuevo.
    expect(
      trabajosDeEvento(
        { db: t.m.db, restauranteId: t.m.restauranteId, zonaHoraria: 'America/Bogota' },
        evento,
        cambios,
      ),
    ).toBe(0)
    expect(pendientes(t.m)).toBe(1)
  })

  it('la principal se vuelve a probar al vencer su espera y, si ya responde, imprime lo suyo', async () => {
    const t = await montar()
    const respaldo = await t.impresora('Respaldo', [])
    const cocina = await t.impresora('Cocina', [t.cocina], respaldo.id)
    await cocina.prueba.apagar(true)
    let ahora = Date.now()
    const cola = new ColaImpresion({
      db: t.m.db,
      restauranteId: t.m.restauranteId,
      reloj: () => ahora,
    })
    t.enviar()
    for (let i = 0; i < 3; i++) {
      if (i > 0) ahora += 60_000
      await cola.vuelta()
    }
    await cocina.prueba.apagar(false)
    ahora += 60_000
    t.enviar()
    await cola.vuelta()
    await cola.vuelta()
    await cocina.prueba.esperar(2)
    expect(cocina.prueba.recibidos).toHaveLength(2)
    expect(respaldo.prueba.recibidos).toHaveLength(0)
    expect(cola.estado().find((e) => e.id === cocina.id)?.estado).toBe('lista')
  })
})
