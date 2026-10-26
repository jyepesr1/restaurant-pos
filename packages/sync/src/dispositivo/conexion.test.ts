import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MensajeDispositivo } from '../protocolo'
import { type Channel, GestorConexion, type Manejadores } from './conexion'

// Escenario 13 de docs/SYNC.md: reconexión al volver a la pantalla con reloj simulado.

class CanalFalso implements Channel {
  enviados: MensajeDispositivo[] = []
  closed = false
  readonly manejadores: Manejadores
  constructor(manejadores: Manejadores) {
    this.manejadores = manejadores
  }
  send(m: MensajeDispositivo) {
    this.enviados.push(m)
  }
  close() {
    this.closed = true
  }
}

function montar() {
  const canales: CanalFalso[] = []
  const statuses: string[] = []
  const events = { connected: 0, disconnected: 0 }
  const gestor = new GestorConexion({
    open: (m) => {
      const channel = new CanalFalso(m)
      canales.push(channel)
      return channel
    },
    alConectar: () => {
      events.connected += 1
    },
    alDesconectar: () => {
      events.disconnected += 1
    },
    alMensaje: () => {},
    alCambiarEstado: (e) => statuses.push(e),
    temporizadores: {
      ahora: () => Date.now(),
      setTimeout: (t, ms) => setTimeout(t, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (t, ms) => setInterval(t, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    },
  })
  const latest = () => canales.at(-1) as CanalFalso
  return { gestor, canales, statuses, events, latest }
}

describe('gestor de conexión', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('conecta y avisa', () => {
    const { gestor, latest, events, statuses } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()

    expect(events.connected).toBe(1)
    expect(statuses).toEqual(['connecting', 'connected'])
  })

  it('un intento que no abre en 4 s se abandona y se reintenta con espera creciente', () => {
    const { gestor, canales } = montar()
    gestor.begin()

    vi.advanceTimersByTime(3999)
    expect(canales).toHaveLength(1)
    vi.advanceTimersByTime(1) // 4 s: se abandona
    expect(canales[0]?.closed).toBe(true)
    vi.advanceTimersByTime(1000) // primer reintento al segundo
    expect(canales).toHaveLength(2)
    vi.advanceTimersByTime(4000 + 1999)
    expect(canales).toHaveLength(2)
    vi.advanceTimersByTime(1) // segundo reintento a los 2 s
    expect(canales).toHaveLength(3)
  })

  it('la espera entre reintentos crece hasta 5 s como máximo', () => {
    const { gestor, canales, latest } = montar()
    gestor.begin()
    const esperas: number[] = []
    for (let i = 0; i < 7; i++) {
      latest().manejadores.alCerrar()
      const before = canales.length
      let ms = 0
      while (canales.length === before) {
        vi.advanceTimersByTime(100)
        ms += 100
      }
      esperas.push(ms)
    }
    expect(esperas).toEqual([1000, 2000, 3000, 4000, 5000, 5000, 5000])
  })

  it('al volver a la pantalla sin conexión reconecta de inmediato, aunque el reintento estuviera lejos', () => {
    const { gestor, canales, latest } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    for (let i = 0; i < 4; i++) latest().manejadores.alCerrar() // varios cierres: espera de 4 s
    const before = canales.length

    gestor.cambiarVisibilidad(true)

    expect(canales.length).toBe(before + 1)
  })

  it('al volver con un canal que parece abierto pero no responde, lo descarta a los 3 s', () => {
    const { gestor, canales, latest, events } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    vi.advanceTimersByTime(60_000)

    gestor.cambiarVisibilidad(true)
    expect(latest().enviados.at(-1)).toMatchObject({ type: 'ping' })
    vi.advanceTimersByTime(2999)
    expect(canales).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(canales[0]?.closed).toBe(true)
    expect(events.disconnected).toBe(1)
    // Recién volvió: el reintento sale de inmediato.
    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(2)
  })

  it('si responde al ping, el canal sigue', () => {
    const { gestor, canales, latest } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    vi.advanceTimersByTime(10_000)
    gestor.cambiarVisibilidad(true)
    vi.advanceTimersByTime(100)
    latest().manejadores.alMensaje({ type: 'pong', brand: 'x' })
    vi.advanceTimersByTime(5000)

    expect(canales).toHaveLength(1)
    expect(canales[0]?.closed).toBe(false)
  })

  it('un cierre justo después de volver se reintenta de inmediato', () => {
    const { gestor, canales, latest } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    gestor.cambiarVisibilidad(true)
    latest().manejadores.alCerrar() // Safari avisa el cierre al volver

    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(2)
  })

  it('tras volver, solo el primer reintento es inmediato: los siguientes esperan', () => {
    const { gestor, canales, latest } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    gestor.cambiarVisibilidad(true)
    latest().manejadores.alCerrar() // el hub no está: cierra al instante
    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(2)

    latest().manejadores.alCerrar() // segundo intento seguido: ya espera (2 s)
    vi.advanceTimersByTime(1999)
    expect(canales).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(3)
  })

  it('detener avisa que quedó desconectado', () => {
    const { gestor, latest, statuses, events } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()
    gestor.detener()
    gestor.detener()

    expect(statuses).toEqual(['connecting', 'connected', 'disconnected'])
    expect(events.disconnected).toBe(1)
  })

  it('un canal que avisa que abrió dentro de `abrir` se atiende igual', () => {
    const conectados: Channel[] = []
    const gestor = new GestorConexion({
      open: (m) => {
        const channel = new CanalFalso(m)
        m.alAbrir()
        return channel
      },
      alConectar: (channel) => conectados.push(channel),
      alDesconectar: () => {},
      alMensaje: () => {},
    })
    gestor.begin()

    expect(conectados).toHaveLength(1)
    gestor.detener()
  })

  it('sin latidos durante 15 s con la pantalla visible, descarta y reconecta; con la pantalla oculta, no', () => {
    const { gestor, canales, latest } = montar()
    gestor.begin()
    latest().manejadores.alAbrir()

    vi.advanceTimersByTime(14_000)
    latest().manejadores.alMensaje({ type: 'heartbeat' })
    vi.advanceTimersByTime(14_000)
    expect(canales).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(canales[0]?.closed).toBe(true)

    vi.advanceTimersByTime(1000)
    latest().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    vi.advanceTimersByTime(60_000)
    expect(canales).toHaveLength(2)
  })

  it('un canal viejo que avisa tarde no afecta al actual, y detener corta todo', () => {
    const { gestor, canales, latest, events } = montar()
    gestor.begin()
    const oldOne = latest()
    vi.advanceTimersByTime(4000 + 1000)
    latest().manejadores.alAbrir()
    oldOne.manejadores.alAbrir()
    oldOne.manejadores.alCerrar()
    expect(events.connected).toBe(1)

    gestor.detener()
    vi.advanceTimersByTime(60_000)
    expect(canales).toHaveLength(2)
    expect(canales[1]?.closed).toBe(true)
  })
})
