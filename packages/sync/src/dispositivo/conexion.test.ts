import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MensajeDispositivo } from '../protocolo'
import { type Canal, GestorConexion, type Manejadores } from './conexion'

// Escenario 13 de docs/SYNC.md: reconexión al volver a la pantalla con reloj simulado.

class CanalFalso implements Canal {
  enviados: MensajeDispositivo[] = []
  cerrado = false
  readonly manejadores: Manejadores
  constructor(manejadores: Manejadores) {
    this.manejadores = manejadores
  }
  enviar(m: MensajeDispositivo) {
    this.enviados.push(m)
  }
  cerrar() {
    this.cerrado = true
  }
}

function montar() {
  const canales: CanalFalso[] = []
  const estados: string[] = []
  const eventos = { conectado: 0, desconectado: 0 }
  const gestor = new GestorConexion({
    abrir: (m) => {
      const canal = new CanalFalso(m)
      canales.push(canal)
      return canal
    },
    alConectar: () => {
      eventos.conectado += 1
    },
    alDesconectar: () => {
      eventos.desconectado += 1
    },
    alMensaje: () => {},
    alCambiarEstado: (e) => estados.push(e),
    temporizadores: {
      ahora: () => Date.now(),
      setTimeout: (t, ms) => setTimeout(t, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (t, ms) => setInterval(t, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    },
  })
  const ultimo = () => canales.at(-1) as CanalFalso
  return { gestor, canales, estados, eventos, ultimo }
}

describe('gestor de conexión', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('conecta y avisa', () => {
    const { gestor, ultimo, eventos, estados } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()

    expect(eventos.conectado).toBe(1)
    expect(estados).toEqual(['conectando', 'conectado'])
  })

  it('un intento que no abre en 4 s se abandona y se reintenta con espera creciente', () => {
    const { gestor, canales } = montar()
    gestor.iniciar()

    vi.advanceTimersByTime(3999)
    expect(canales).toHaveLength(1)
    vi.advanceTimersByTime(1) // 4 s: se abandona
    expect(canales[0]?.cerrado).toBe(true)
    vi.advanceTimersByTime(1000) // primer reintento al segundo
    expect(canales).toHaveLength(2)
    vi.advanceTimersByTime(4000 + 1999)
    expect(canales).toHaveLength(2)
    vi.advanceTimersByTime(1) // segundo reintento a los 2 s
    expect(canales).toHaveLength(3)
  })

  it('la espera entre reintentos crece hasta 5 s como máximo', () => {
    const { gestor, canales, ultimo } = montar()
    gestor.iniciar()
    const esperas: number[] = []
    for (let i = 0; i < 7; i++) {
      ultimo().manejadores.alCerrar()
      const antes = canales.length
      let ms = 0
      while (canales.length === antes) {
        vi.advanceTimersByTime(100)
        ms += 100
      }
      esperas.push(ms)
    }
    expect(esperas).toEqual([1000, 2000, 3000, 4000, 5000, 5000, 5000])
  })

  it('al volver a la pantalla sin conexión reconecta de inmediato, aunque el reintento estuviera lejos', () => {
    const { gestor, canales, ultimo } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    for (let i = 0; i < 4; i++) ultimo().manejadores.alCerrar() // varios cierres: espera de 4 s
    const antes = canales.length

    gestor.cambiarVisibilidad(true)

    expect(canales.length).toBe(antes + 1)
  })

  it('al volver con un canal que parece abierto pero no responde, lo descarta a los 3 s', () => {
    const { gestor, canales, ultimo, eventos } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    vi.advanceTimersByTime(60_000)

    gestor.cambiarVisibilidad(true)
    expect(ultimo().enviados.at(-1)).toMatchObject({ tipo: 'ping' })
    vi.advanceTimersByTime(2999)
    expect(canales).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(canales[0]?.cerrado).toBe(true)
    expect(eventos.desconectado).toBe(1)
    // Recién volvió: el reintento sale de inmediato.
    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(2)
  })

  it('si responde al ping, el canal sigue', () => {
    const { gestor, canales, ultimo } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    vi.advanceTimersByTime(10_000)
    gestor.cambiarVisibilidad(true)
    vi.advanceTimersByTime(100)
    ultimo().manejadores.alMensaje({ tipo: 'pong', marca: 'x' })
    vi.advanceTimersByTime(5000)

    expect(canales).toHaveLength(1)
    expect(canales[0]?.cerrado).toBe(false)
  })

  it('un cierre justo después de volver se reintenta de inmediato', () => {
    const { gestor, canales, ultimo } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    gestor.cambiarVisibilidad(true)
    ultimo().manejadores.alCerrar() // Safari avisa el cierre al volver

    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(2)
  })

  it('tras volver, solo el primer reintento es inmediato: los siguientes esperan', () => {
    const { gestor, canales, ultimo } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    gestor.cambiarVisibilidad(true)
    ultimo().manejadores.alCerrar() // el hub no está: cierra al instante
    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(2)

    ultimo().manejadores.alCerrar() // segundo intento seguido: ya espera (2 s)
    vi.advanceTimersByTime(1999)
    expect(canales).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(canales).toHaveLength(3)
  })

  it('detener avisa que quedó desconectado', () => {
    const { gestor, ultimo, estados, eventos } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()
    gestor.detener()
    gestor.detener()

    expect(estados).toEqual(['conectando', 'conectado', 'desconectado'])
    expect(eventos.desconectado).toBe(1)
  })

  it('un canal que avisa que abrió dentro de `abrir` se atiende igual', () => {
    const conectados: Canal[] = []
    const gestor = new GestorConexion({
      abrir: (m) => {
        const canal = new CanalFalso(m)
        m.alAbrir()
        return canal
      },
      alConectar: (canal) => conectados.push(canal),
      alDesconectar: () => {},
      alMensaje: () => {},
    })
    gestor.iniciar()

    expect(conectados).toHaveLength(1)
    gestor.detener()
  })

  it('sin latidos durante 15 s con la pantalla visible, descarta y reconecta; con la pantalla oculta, no', () => {
    const { gestor, canales, ultimo } = montar()
    gestor.iniciar()
    ultimo().manejadores.alAbrir()

    vi.advanceTimersByTime(14_000)
    ultimo().manejadores.alMensaje({ tipo: 'latido' })
    vi.advanceTimersByTime(14_000)
    expect(canales).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(canales[0]?.cerrado).toBe(true)

    vi.advanceTimersByTime(1000)
    ultimo().manejadores.alAbrir()
    gestor.cambiarVisibilidad(false)
    vi.advanceTimersByTime(60_000)
    expect(canales).toHaveLength(2)
  })

  it('un canal viejo que avisa tarde no afecta al actual, y detener corta todo', () => {
    const { gestor, canales, ultimo, eventos } = montar()
    gestor.iniciar()
    const viejo = ultimo()
    vi.advanceTimersByTime(4000 + 1000)
    ultimo().manejadores.alAbrir()
    viejo.manejadores.alAbrir()
    viejo.manejadores.alCerrar()
    expect(eventos.conectado).toBe(1)

    gestor.detener()
    vi.advanceTimersByTime(60_000)
    expect(canales).toHaveLength(2)
    expect(canales[1]?.cerrado).toBe(true)
  })
})
