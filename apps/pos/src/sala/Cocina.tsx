import type { Catalogo } from '@pos/sync'
import { useEffect, useRef, useState } from 'react'
import { useAhora } from '../ui/ahora'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { TONOS_FUERTES, TONOS_SUAVES } from '../ui/Etiqueta'
import { minutos } from '../ui/formato'
import { IndicadorConexion } from '../ui/IndicadorConexion'
import { Icono, type NombreIcono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { useTema } from '../ui/tema'
import { type ComandaEnCocina, type Demora, demora, tiemposDe } from './comandas'
import { sala, useSala, useVistaLocal } from './contexto'
import { MarcoSala } from './MarcoSala'
import type { TrabajoPendiente } from './motor'
import { Confirmar } from './Personal'
import { CANALES } from './pedido'

// Lo que está en cocina (ADR-015). En la caja es «Pedidos en cocina»: lo enviado que falta
// entregar, por estación, con su tiempo y su color; quien puede marcar toca «Listo» si cocina
// avisa. En una pantalla de cocina es todo lo que hay: tarjetas grandes y un solo toque, «Listo».

/**
 * Cómo se ve cada demora. «A tiempo» va sin color, solo con borde (decisión del dueño): el verde
 * en cocina queda para «Listo para llevar», y lo que resalta es lo demorado.
 */
const DEMORAS: Record<
  Demora,
  { icono: NombreIcono; texto: string; tarjeta: string; reloj: string; etiqueta: string }
> = {
  a_tiempo: {
    icono: 'reloj',
    texto: 'A tiempo',
    tarjeta: 'border-borde bg-superficie text-texto',
    reloj: 'border-2 border-borde bg-superficie text-texto',
    etiqueta: 'border-2 border-borde bg-superficie text-texto',
  },
  demorada: {
    icono: 'reloj',
    texto: 'Demorada',
    tarjeta: `border-proceso-fuerte/60 ${TONOS_SUAVES.proceso}`,
    reloj: TONOS_FUERTES.proceso,
    etiqueta: TONOS_SUAVES.proceso,
  },
  muy_demorada: {
    icono: 'alerta',
    texto: 'Muy demorada',
    tarjeta: `border-alerta-fuerte ${TONOS_SUAVES.alerta}`,
    reloj: TONOS_FUERTES.alerta,
    etiqueta: TONOS_SUAVES.alerta,
  },
}

const TODAS = '__todas'

function destino(catalogo: Catalogo, c: ComandaEnCocina): string {
  const p = c.pedido.estado
  if (p.mesaId) {
    const mesa = catalogo.mesas.find((m) => m.id === p.mesaId)
    return mesa ? `Mesa ${mesa.nombre}` : 'Mesa'
  }
  const canal = CANALES[p.canal as keyof typeof CANALES] ?? 'Pedido'
  return p.numeroDia ? `${canal} #${p.numeroDia}` : canal
}

/** «Pedidos en cocina», dentro del marco de la caja. */
export function PedidosEnCocina() {
  return (
    <MarcoSala titulo="Pedidos en cocina">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 md:p-6">
        <AvisoImpresoras />
        <Tablero modo="caja" />
      </div>
    </MarcoSala>
  )
}

/** La pantalla de cocina: sin marco, para una tablet o un televisor táctil en la cocina o la barra. */
export function PantallaCocina() {
  const { equipo, catalogo, conexion, pendientes, impresoras } = useSala()
  const { oscuro, elegir } = useTema()
  const ahora = useAhora(15_000)
  const propia = (catalogo?.pantallas ?? []).find((p) => p.dispositivoId === equipo?.dispositivoId)
  useEffect(() => {
    document.title = `${equipo?.nombre ?? 'Pantalla de cocina'} · Faro`
  }, [equipo?.nombre])
  usePantallaEncendida()
  return (
    <div className="flex min-h-dvh flex-col bg-fondo text-texto">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-linea bg-lateral px-4 py-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {equipo?.nombre ?? 'Pantalla de cocina'}
        </h1>
        <span className="cifras text-2xl font-semibold text-texto-suave">
          {new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(ahora)}
        </span>
        <span className="flex-1" />
        <IndicadorConexion
          estado={
            conexion === 'conectado'
              ? 'solo_local'
              : conexion === 'conectando'
                ? 'conectando'
                : 'sin_conexion'
          }
          pendientes={pendientes}
          impresorasConFalla={impresoras.filter((i) => i.estado === 'falla').length}
        />
        <ConSonido />
        <Boton
          variante="fantasma"
          icono={oscuro ? 'sol' : 'luna'}
          aria-label={oscuro ? 'Modo claro' : 'Modo oscuro'}
          onClick={() => elegir(oscuro ? 'claro' : 'oscuro')}
        />
      </header>
      <main className="flex flex-1 flex-col gap-4 p-4">
        {conexion !== 'conectado' && (
          <p className="rounded-2xl bg-alerta-suave p-4 text-xl font-semibold text-alerta-texto">
            Sin conexión con la caja: los pedidos nuevos no llegan hasta que vuelva. Revisa el
            Wi-Fi.
          </p>
        )}
        <AvisoImpresoras grande />
        {propia ? (
          <Tablero modo="pantalla" estaciones={propia.estacionIds} />
        ) : (
          // Sin saber sus estaciones no se muestra nada: la de barra no debe ver lo de cocina.
          <p className="text-xl text-texto-suave">Leyendo qué estaciones muestra esta pantalla…</p>
        )}
      </main>
    </div>
  )
}

/** Que la tablet no se apague ni se bloquee mientras muestra las comandas. */
function usePantallaEncendida() {
  useEffect(() => {
    let candado: { release: () => Promise<void> } | null = null
    const pedir = () => {
      if (document.hidden) return
      const wl = (
        navigator as unknown as {
          wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> }
        }
      ).wakeLock
      wl?.request('screen')
        .then((c) => {
          candado = c
        })
        .catch(() => {})
    }
    pedir()
    document.addEventListener('visibilitychange', pedir)
    return () => {
      document.removeEventListener('visibilitychange', pedir)
      void candado?.release().catch(() => {})
    }
  }, [])
}

const CLAVE_SONIDO = 'pos-cocina-sonido'

function leerSonido() {
  try {
    return localStorage.getItem(CLAVE_SONIDO) !== 'no'
  } catch {
    return true
  }
}

let audio: AudioContext | null = null

/**
 * El contexto de sonido. Las tablets lo dejan callado hasta que alguien toca la pantalla: se
 * crea y se reanuda con cada toque, y la pantalla avisa mientras siga callado.
 */
function contextoSonido(): AudioContext | null {
  try {
    const Contexto =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Contexto) return null
    audio ??= new Contexto()
    if (audio.state === 'suspended') void audio.resume().catch(() => {})
    return audio
  } catch {
    return null
  }
}

/** Un «ding» al llegar una comanda (brief §4.4): un tono corto, sin archivos de sonido. */
function sonar() {
  const ctx = contextoSonido()
  if (!ctx) return
  try {
    const tono = ctx.createOscillator()
    const volumen = ctx.createGain()
    tono.frequency.value = 880
    volumen.gain.setValueAtTime(0.3, ctx.currentTime)
    volumen.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
    tono.connect(volumen).connect(ctx.destination)
    tono.start()
    tono.stop(ctx.currentTime + 0.6)
  } catch {
    // Sin sonido no pasa nada: la tarjeta igual aparece.
  }
}

let sonidoActivo = leerSonido()

function ConSonido() {
  const [activo, setActivo] = useState(sonidoActivo)
  const [callado, setCallado] = useState(false)
  // El primer toque en cualquier parte despierta el sonido.
  useEffect(() => {
    const despertar = () => {
      const ctx = contextoSonido()
      setCallado(ctx?.state === 'suspended')
    }
    const revisar = setInterval(() => setCallado(audio?.state !== 'running'), 5000)
    window.addEventListener('pointerdown', despertar)
    return () => {
      clearInterval(revisar)
      window.removeEventListener('pointerdown', despertar)
    }
  }, [])
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      onClick={() => {
        sonidoActivo = !activo
        setActivo(sonidoActivo)
        try {
          localStorage.setItem(CLAVE_SONIDO, sonidoActivo ? 'si' : 'no')
        } catch {
          // Se recuerda solo mientras la pantalla esté abierta.
        }
        if (sonidoActivo) sonar()
      }}
      className={`inline-flex min-h-12 items-center gap-2 rounded-xl border px-4 font-semibold focus-visible:outline-3 focus-visible:outline-foco ${activo && callado ? 'border-proceso-fuerte bg-proceso-suave text-proceso-texto' : 'border-borde bg-superficie'}`}
    >
      <Icono nombre={activo ? 'check' : 'cerrar'} />
      {!activo ? 'Sonido: no' : callado ? 'Toca para activar el sonido' : 'Sonido: sí'}
    </button>
  )
}

/** Las comandas, en tarjetas; en la pantalla de cocina, solo las de sus estaciones. */
function Tablero({
  modo,
  estaciones = null,
}: {
  modo: 'caja' | 'pantalla'
  estaciones?: string[] | null
}) {
  const { catalogo, sesion, equipo } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const ahora = sala.ahoraHub(useAhora(15_000))
  const [filtro, setFiltro] = useState(TODAS)
  const vistas = useRef<Set<string> | null>(null)
  const comandas = (vista?.comandas ?? []).filter(
    (c) =>
      (estaciones === null || estaciones.includes(c.estacionId)) &&
      (filtro === TODAS || c.estacionId === filtro),
  )

  // En la pantalla suena una vez por cada comanda que llega (no al abrirla con lo que ya había).
  useEffect(() => {
    if (modo !== 'pantalla' || !vista) return
    const ids = new Set(comandas.map((c) => c.comandaId))
    if (vistas.current && sonidoActivo && [...ids].some((id) => !vistas.current?.has(id))) sonar()
    vistas.current = ids
  })

  if (!catalogo || !vista) return <p className="text-texto-suave">Leyendo lo de cocina…</p>
  const tiempos = tiemposDe(catalogo.restaurante)
  // «Listo» lo marca la cocina (su pantalla) o la caja cuando cocina avisa; en el celular del
  // mesero esta vista es solo para mirar, y lo suyo es «Entregar» en el pedido.
  const puedeMarcar =
    (sesion?.permisos.includes('marcar_preparacion') ?? false) &&
    (modo === 'pantalla' || equipo?.tipo === 'caja')
  const puedeReimprimir = modo === 'caja' && (sesion?.permisos.includes('tomar_pedido') ?? false)
  const deLaVista =
    estaciones === null
      ? catalogo.estaciones
      : catalogo.estaciones.filter((e) => estaciones.includes(e.id))
  const enCurso = comandas.filter((c) => !c.lista)
  const listas = comandas.filter((c) => c.lista)

  const marcarListo = async (c: ComandaEnCocina) => {
    const ids = c.items.filter((i) => i.estado !== 'listo').map((i) => i.id)
    try {
      await sala.registrar('ItemListo', c.pedido.estado.id, { item_ids: ids })
      avisar(
        `${destino(catalogo, c)}: listo`,
        () =>
          void sala
            .registrar('ItemDevueltoACola', c.pedido.estado.id, { item_ids: ids })
            .catch(() => {}),
      )
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo marcar')
    }
  }
  const recuperar = async (c: ComandaEnCocina) => {
    try {
      await sala.registrar('ItemDevueltoACola', c.pedido.estado.id, {
        item_ids: c.items.map((i) => i.id),
      })
      avisar(`${destino(catalogo, c)} volvió a la cola`)
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo recuperar')
    }
  }
  const reimprimir = async (c: ComandaEnCocina) => {
    try {
      await sala.registrar('ComandaReimpresa', c.pedido.estado.id, { comanda_id: c.comandaId })
      avisar(`Reimprimiendo ${destino(catalogo, c)}`)
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo reimprimir')
    }
  }

  const sinRecepcion = deLaVista.filter((e) => e.imprime === false && e.pantalla === false)
  const conteo = (d: Demora) =>
    enCurso.filter((c) => demora(c.enviadaEn, ahora, tiempos) === d).length

  return (
    <div className="flex flex-col gap-4">
      {deLaVista.length > 1 && (
        <Grupo etiqueta="Estación" className="flex flex-wrap gap-2">
          <Opcion elegida={filtro === TODAS} alElegir={() => setFiltro(TODAS)}>
            Todas
          </Opcion>
          {deLaVista.map((e) => (
            <Opcion key={e.id} elegida={filtro === e.id} alElegir={() => setFiltro(e.id)}>
              {e.nombre}
            </Opcion>
          ))}
        </Grupo>
      )}

      {modo === 'caja' && sinRecepcion.length > 0 && (
        <p className="rounded-2xl bg-proceso-suave p-4 text-proceso-texto">
          {`${sinRecepcion.map((e) => e.nombre).join(' y ')} no ${sinRecepcion.length === 1 ? 'tiene' : 'tienen'} impresora ni pantalla: lo que se envía allá no le llega a nadie. Configúralo en «Cocina e impresoras».`}
        </p>
      )}

      <ul
        className={`flex flex-wrap gap-x-5 gap-y-2 ${modo === 'pantalla' ? 'text-lg' : 'text-sm'}`}
        aria-label="Cómo va de tiempo"
      >
        {(Object.keys(DEMORAS) as Demora[]).map((d) => (
          <li key={d} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold ${DEMORAS[d].etiqueta}`}
            >
              <Icono nombre={DEMORAS[d].icono} className="size-4" />
              {DEMORAS[d].texto}
            </span>
            <span className="cifras text-texto-suave">{conteo(d)}</span>
          </li>
        ))}
        <li className="text-texto-suave">
          {`Demorada desde ${tiempos.amarillo} min, muy demorada desde ${tiempos.rojo} min`}
        </li>
      </ul>

      {enCurso.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-borde p-8 text-center text-lg text-texto-suave">
          {modo === 'pantalla'
            ? 'Nada por preparar. Lo nuevo aparece aquí con un sonido.'
            : 'Nada en cocina por ahora.'}
        </p>
      ) : (
        <ul
          className={`grid gap-4 ${modo === 'pantalla' ? 'grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]'}`}
        >
          {enCurso.map((c) => (
            <li key={c.comandaId}>
              <Tarjeta
                catalogo={catalogo}
                comanda={c}
                ahora={ahora}
                tiempos={tiempos}
                grande={modo === 'pantalla'}
                acciones={
                  <>
                    {puedeMarcar && (
                      <Boton
                        variante="exito"
                        grande={modo === 'pantalla'}
                        icono="check"
                        className="flex-1"
                        onClick={() => marcarListo(c)}
                      >
                        Listo
                      </Boton>
                    )}
                    {puedeReimprimir &&
                      catalogo.estaciones.find((e) => e.id === c.estacionId)?.imprime && (
                        <Boton
                          variante="fantasma"
                          icono="impresora"
                          aria-label={`Reimprimir ${destino(catalogo, c)}`}
                          onClick={() => reimprimir(c)}
                        >
                          Reimprimir
                        </Boton>
                      )}
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}

      {listas.length > 0 && (
        <section aria-labelledby="titulo-listas" className="flex flex-col gap-3">
          <h2 id="titulo-listas" className="text-lg font-semibold">
            {`Listo para llevar (${listas.length})`}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {listas.map((c) => (
              <li
                key={c.comandaId}
                className={`flex min-h-14 items-center gap-3 rounded-2xl py-2 pr-2 pl-4 ${TONOS_SUAVES.libre}`}
              >
                <Icono nombre="servir" />
                <span className="font-semibold">{destino(catalogo, c)}</span>
                <span className="text-sm">
                  {c.items.reduce((s, i) => s + i.cantidad - i.cantidadAnulada, 0)} prod.
                </span>
                {puedeMarcar && (
                  <Boton
                    variante="fantasma"
                    grande={modo === 'pantalla'}
                    icono="deshacer"
                    onClick={() => recuperar(c)}
                  >
                    Volver a cocina
                  </Boton>
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-texto-suave">
            Salen de aquí cuando el mesero toca «Entregar».
          </p>
        </section>
      )}
    </div>
  )
}

function Tarjeta({
  catalogo,
  comanda: c,
  ahora,
  tiempos,
  grande,
  acciones,
}: {
  catalogo: Catalogo
  comanda: ComandaEnCocina
  ahora: number
  tiempos: { amarillo: number; rojo: number }
  grande: boolean
  acciones: React.ReactNode
}) {
  const d = DEMORAS[demora(c.enviadaEn, ahora, tiempos)]
  const estacion = catalogo.estaciones.find((e) => e.id === c.estacionId)?.nombre
  const mesero = catalogo.personal.find((u) => u.id === c.pedido.estado.meseroAsignadoId)?.nombre
  const desde = Math.max(0, (ahora - Date.parse(c.enviadaEn)) / 60_000)
  return (
    <article
      aria-label={`${destino(catalogo, c)}, ${d.texto}, ${minutos(desde)}`}
      className={`flex h-full flex-col gap-3 rounded-2xl border-2 p-4 ${d.tarjeta}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <span className={`font-bold ${grande ? 'text-3xl' : 'text-xl'}`}>
          {destino(catalogo, c)}
        </span>
        {c.numero !== null && (
          <span className={`cifras font-bold ${grande ? 'text-3xl' : 'text-lg'}`}>#{c.numero}</span>
        )}
      </header>
      <div className={`flex flex-wrap items-center gap-2 ${grande ? 'text-lg' : 'text-sm'}`}>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full font-bold ${d.reloj} ${grande ? 'px-3 py-1 text-2xl' : 'px-2.5 py-0.5 text-sm'}`}
        >
          <Icono nombre={d.icono} className={grande ? 'size-6' : 'size-4'} />
          <span className="cifras">{minutos(desde)}</span>
        </span>
        <span>{[estacion, mesero].filter(Boolean).join(' · ')}</span>
      </div>
      {c.pedido.estado.notas && (
        <p
          className={`flex items-start gap-2 rounded-lg border-2 border-borde bg-superficie px-2 py-1 text-texto ${grande ? 'text-xl' : ''}`}
        >
          <Icono
            nombre="lapiz"
            className={grande ? 'mt-0.5 size-6 shrink-0' : 'mt-0.5 size-4 shrink-0'}
          />
          <span>
            <span className="block text-sm font-semibold uppercase">Para todo el pedido</span>
            <span className="font-bold">{c.pedido.estado.notas}</span>
          </span>
        </p>
      )}
      <ul className="flex flex-1 flex-col gap-3">
        {c.items.map((i) => (
          <li key={i.id} className={grande ? 'text-2xl' : ''}>
            <span className="cifras font-bold">{i.cantidad - i.cantidadAnulada} ×</span>{' '}
            <span className="font-semibold">{i.nombre}</span>
            {i.comensal !== null && (
              <span className={grande ? 'text-xl' : 'text-sm'}> · P{i.comensal}</span>
            )}
            {i.estado === 'listo' && (
              <span className={`font-semibold ${grande ? 'text-xl' : 'text-sm'}`}> · listo</span>
            )}
            {i.modificadores.length > 0 && (
              <span className={`block font-bold ${grande ? 'text-xl' : ''}`}>
                {i.modificadores.map((m) => `> ${m.nombre}`).join('  ')}
              </span>
            )}
            {i.notas && (
              <span
                className={`mt-1 flex items-start gap-2 rounded-lg border-2 border-current bg-superficie px-2 py-1 font-bold ${grande ? 'text-xl' : ''}`}
              >
                <Icono
                  nombre="alerta"
                  className={grande ? 'mt-0.5 size-6 shrink-0' : 'mt-0.5 size-4 shrink-0'}
                />
                {i.notas}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">{acciones}</div>
    </article>
  )
}

/**
 * Si alguna impresora no responde: cuál, por qué, y lo que no ha salido (descartar, para quien
 * maneja la caja). En la pantalla de cocina, en letra grande y sin descartar.
 */
function AvisoImpresoras({ grande = false }: { grande?: boolean }) {
  const { impresoras, sesion } = useSala()
  const avisar = useAvisar()
  const caidas = impresoras.filter((i) => i.estado === 'falla')
  const puedeVer =
    sesion?.permisos.some((p) => p === 'administrar_dispositivos' || p === 'registrar_pago') ??
    false
  const [trabajos, setTrabajos] = useState<TrabajoPendiente[] | null>(null)
  const [descartando, setDescartando] = useState<string | null>(null)
  const clave = caidas.map((i) => `${i.id}:${i.pendientes}`).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: `clave` avisa que cambió la cola
  useEffect(() => {
    if (!puedeVer || caidas.length === 0) {
      setTrabajos(null)
      return
    }
    sala
      .pendientesImpresion()
      .then(setTrabajos)
      .catch(() => setTrabajos(null))
  }, [clave, puedeVer])

  if (caidas.length === 0) return null
  const descartar = async (t: TrabajoPendiente) => {
    setDescartando(null)
    try {
      await sala.descartarTrabajo(t.id)
      setTrabajos((ts) => ts?.filter((x) => x.id !== t.id) ?? null)
      avisar('Comanda descartada')
    } catch (e) {
      avisar(e instanceof Error ? e.message : 'No se pudo descartar')
    }
  }
  return (
    <section
      role="alert"
      className={`flex flex-col gap-3 rounded-2xl border-2 border-alerta-fuerte bg-alerta-suave p-4 text-alerta-texto ${grande ? 'text-xl' : ''}`}
    >
      {caidas.map((i) => (
        <p key={i.id} className="flex items-start gap-2">
          <Icono nombre="impresora" className="mt-0.5 size-5 shrink-0" />
          <span>
            <span className="font-bold">{`${i.nombre} no imprime. `}</span>
            {i.error}
            {i.pendientes > 0 &&
              ` Hay ${i.pendientes} ${i.pendientes === 1 ? 'comanda esperando' : 'comandas esperando'}: salen solas cuando vuelva.`}
          </span>
        </p>
      ))}
      {trabajos && trabajos.length > 0 && (
        <ul className="flex flex-col gap-2">
          {trabajos.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-superficie p-2 pl-3 text-texto"
            >
              <span className="flex-1">
                <span className="font-semibold">{t.que}</span>
                <span className="text-sm text-texto-suave">{` · ${t.impresora} · ${t.intentos} ${t.intentos === 1 ? 'intento' : 'intentos'}`}</span>
              </span>
              {descartando === t.id ? (
                <div className="w-full">
                  <Confirmar
                    pregunta={`¿Descartar «${t.que}»? No se imprimirá: si la cocina no la tiene, díselo.`}
                    si="Descartar"
                    ocupado={false}
                    alConfirmar={() => descartar(t)}
                    alCancelar={() => setDescartando(null)}
                  />
                </div>
              ) : (
                <Boton variante="fantasma" icono="borrar" onClick={() => setDescartando(t.id)}>
                  Descartar
                </Boton>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Avisa al mesero cuando algo de sus mesas queda listo para llevar (ADR-015): un aviso y una
 * vibración, una vez por comanda. No avisa lo que ya estaba listo al abrir la app.
 */
export function AvisoListos() {
  const { catalogo, sesion } = useSala()
  const vista = useVistaLocal()
  const avisar = useAvisar()
  const conocidas = useRef<{ usuario: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!vista || !catalogo || !sesion) return
    // Otro mesero entró en este celular: lo que ya estaba listo no es una novedad para él.
    if (conocidas.current?.usuario !== sesion.usuario.id) conocidas.current = null
    const mias = vista.comandas.filter(
      (c) => c.lista && c.pedido.estado.meseroAsignadoId === sesion.usuario.id,
    )
    const ids = new Set(mias.map((c) => c.comandaId))
    if (conocidas.current) {
      const nuevas = mias.filter((c) => !conocidas.current?.ids.has(c.comandaId))
      for (const c of nuevas) avisar(`${destino(catalogo, c)}: listo para llevar`)
      if (nuevas.length > 0) navigator.vibrate?.([80, 60, 80])
    }
    conocidas.current = { usuario: sesion.usuario.id, ids }
  }, [vista, catalogo, sesion, avisar])
  return null
}
