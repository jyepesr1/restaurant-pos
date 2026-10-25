import { useCallback, useEffect, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { Icono } from '../ui/iconos'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { navegar } from '../ui/ruta'
import { sala, useSala } from './contexto'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import type { ConfiguracionCocina, ImpresoraCocina } from './motor'
import { Confirmar } from './Personal'

// «Cocina e impresoras» (ADR-015): cómo recibe cada estación sus comandas (impresora, pantalla o
// las dos), las impresoras con su página de prueba, las pantallas de cocina, convertir este equipo
// en una y los minutos del ámbar y el rojo. Para quien administra los equipos.

const PAGINAS: { valor: ImpresoraCocina['pagina_codigos']; nombre: string; detalle: string }[] = [
  {
    valor: 'pc850',
    nombre: 'Con tildes (recomendada)',
    detalle: 'La de casi todas: Jaltech, Epson, Xprinter',
  },
  {
    valor: 'wpc1252',
    nombre: 'Con tildes de Windows',
    detalle: 'Si con la recomendada salen símbolos raros',
  },
  { valor: 'sin_tildes', nombre: 'Sin tildes', detalle: 'Si ninguna imprime bien la ñ' },
]

const NUEVA: ImpresoraCocina = {
  nombre: '',
  conexion: 'red',
  direccion: '',
  puerto: 9100,
  ancho: 80,
  pagina_codigos: 'pc850',
  respaldo_id: null,
  estacion_ids: [],
  activo: true,
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function CocinaAjustes() {
  const avisar = useAvisar()
  const { impresoras: estados } = useSala()
  const [config, setConfig] = useState<ConfiguracionCocina | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editando, setEditando] = useState<ImpresoraCocina | null>(null)

  const cargar = useCallback(() => {
    sala
      .configuracionCocina()
      .then((c) => {
        setConfig(c)
        setError(null)
      })
      .catch((e) => setError(mensaje(e)))
  }, [])
  useEffect(cargar, [cargar])

  if (error && !config)
    return (
      <MarcoSala titulo="Cocina e impresoras">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 p-6">
          <p className="text-alerta-texto">{error}</p>
          <Boton onClick={cargar}>Intentar de nuevo</Boton>
        </div>
      </MarcoSala>
    )
  if (!config)
    return (
      <MarcoSala titulo="Cocina e impresoras">
        <p className="p-6 text-texto-suave">Leyendo la configuración de la caja…</p>
      </MarcoSala>
    )

  const estadoDe = (id: string) =>
    estados.find((e) => e.id === id) ?? config.estados.find((e) => e.id === id)
  const activas = config.impresoras.filter((i) => i.activo)
  const nombreEstacion = (id: string) =>
    config.estaciones.find((e) => e.id === id)?.nombre ?? 'Estación'

  const probar = async (id: string, nombre: string) => {
    try {
      await sala.probarImpresora(id)
      avisar(`Prueba enviada a ${nombre}: revisa que salga el papel`)
    } catch (e) {
      avisar(mensaje(e))
    }
  }

  return (
    <MarcoSala
      titulo="Cocina e impresoras"
      acciones={
        <Boton variante="principal" icono="mas" onClick={() => setEditando({ ...NUEVA })}>
          Agregar impresora
        </Boton>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4 md:p-6">
        <section aria-labelledby="titulo-estaciones" className="flex flex-col gap-3">
          <h2 id="titulo-estaciones" className="text-xl font-bold tracking-tight">
            Cómo recibe cada estación
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {config.estaciones.map((e) => {
              const imp = activas.filter((i) => i.estacion_ids.includes(e.id))
              const pan = config.pantallas.filter((p) => p.estacion_ids.includes(e.id))
              const nada = imp.length === 0 && pan.length === 0
              return (
                <li
                  key={e.id}
                  className="flex flex-col gap-2 rounded-2xl border border-linea bg-superficie p-4"
                >
                  <span className="text-lg font-semibold">{e.nombre}</span>
                  {imp.map((i) => (
                    <span key={i.id} className="flex items-center gap-2">
                      <Icono nombre="impresora" className="size-5" />
                      {i.nombre}
                    </span>
                  ))}
                  {pan.map((p) => (
                    <span key={p.dispositivo_id} className="flex items-center gap-2">
                      <Icono nombre="plano" className="size-5" />
                      {p.nombre}
                    </span>
                  ))}
                  {nada && (
                    <Etiqueta tono="proceso" icono="alerta">
                      No le llega nada: ponle una impresora o una pantalla
                    </Etiqueta>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-sm text-texto-suave">
            Sin pantalla, el mesero marca «Entregado» al llevar el plato y la caja ve lo pendiente
            en «Pedidos en cocina».
          </p>
        </section>

        <section aria-labelledby="titulo-impresoras" className="flex flex-col gap-3">
          <h2 id="titulo-impresoras" className="text-xl font-bold tracking-tight">
            Impresoras de comandas
          </h2>
          {config.impresoras.length === 0 && (
            <div className="rounded-2xl border border-dashed border-borde p-6 text-center">
              <p className="text-texto-suave">
                Todavía no hay impresoras. Agrega la de cocina y la de barra con su dirección de
                red.
              </p>
              <Boton
                variante="principal"
                icono="mas"
                className="mt-3"
                onClick={() => setEditando({ ...NUEVA })}
              >
                Agregar impresora
              </Boton>
            </div>
          )}
          <ul className="flex flex-col gap-3">
            {config.impresoras.map((i) => {
              const estado = estadoDe(i.id)
              return (
                <li
                  key={i.id}
                  className={`flex flex-wrap items-center gap-3 rounded-2xl border border-linea bg-superficie p-4 ${i.activo ? '' : 'opacity-60'}`}
                >
                  <Icono nombre="impresora" className="size-6" />
                  <div className="flex min-w-48 flex-1 flex-col items-start gap-1">
                    <span className="text-lg font-semibold">{i.nombre}</span>
                    <span className="cifras text-sm text-texto-suave">
                      {i.conexion === 'red'
                        ? `${i.direccion}:${i.puerto ?? 9100} · ${i.ancho} mm`
                        : `USB · ${i.ancho} mm`}
                      {i.estacion_ids.length > 0 &&
                        ` · ${i.estacion_ids.map(nombreEstacion).join(', ')}`}
                    </span>
                    {!i.activo ? (
                      <Etiqueta tono="neutro" icono="cerrar">
                        Archivada
                      </Etiqueta>
                    ) : estado?.estado === 'falla' ? (
                      <span className="text-sm font-semibold text-alerta-texto">
                        <Icono nombre="alerta" className="mr-1 inline size-4" />
                        {estado.error}
                        {estado.pendientes > 0 && ` (${estado.pendientes} esperando)`}
                      </span>
                    ) : (
                      <Etiqueta tono="libre" icono="check">
                        {estado?.pendientes ? `Imprimiendo (${estado.pendientes})` : 'Lista'}
                      </Etiqueta>
                    )}
                  </div>
                  {i.activo && (
                    <Boton icono="impresora" onClick={() => probar(i.id, i.nombre)}>
                      Imprimir prueba
                    </Boton>
                  )}
                  <Boton variante="fantasma" icono="lapiz" onClick={() => setEditando({ ...i })}>
                    Editar
                  </Boton>
                </li>
              )
            })}
          </ul>
        </section>

        <Pantallas config={config} alCambiar={cargar} />
        <Tiempos config={config} alCambiar={cargar} />
      </div>

      {editando && (
        <EditarImpresora
          inicial={editando}
          config={config}
          alCerrar={() => setEditando(null)}
          alGuardar={() => {
            setEditando(null)
            cargar()
          }}
        />
      )}
    </MarcoSala>
  )
}

function Estaciones({
  config,
  elegidas,
  alCambiar,
}: {
  config: ConfiguracionCocina
  elegidas: string[]
  alCambiar: (ids: string[]) => void
}) {
  return (
    <Grupo etiqueta="Estaciones" className="flex flex-wrap gap-2">
      {config.estaciones.map((e) => (
        <Opcion
          key={e.id}
          elegida={elegidas.includes(e.id)}
          alElegir={() =>
            alCambiar(
              elegidas.includes(e.id) ? elegidas.filter((x) => x !== e.id) : [...elegidas, e.id],
            )
          }
        >
          {e.nombre}
        </Opcion>
      ))}
    </Grupo>
  )
}

function EditarImpresora({
  inicial,
  config,
  alCerrar,
  alGuardar,
}: {
  inicial: ImpresoraCocina
  config: ConfiguracionCocina
  alCerrar: () => void
  alGuardar: () => void
}) {
  const avisar = useAvisar()
  const [b, setB] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [archivando, setArchivando] = useState(false)
  const cambiar = (parcial: Partial<ImpresoraCocina>) => setB((x) => ({ ...x, ...parcial }))
  const otras = config.impresoras.filter((i) => i.activo && i.id !== b.id)

  const guardar = async (cambios: Partial<ImpresoraCocina> = {}) => {
    const datos = { ...b, ...cambios }
    if (!datos.nombre.trim()) return setError('Ponle un nombre, por ejemplo «Cocina»')
    if (datos.conexion === 'red' && !datos.direccion.trim())
      return setError('Escribe la IP de la impresora (sale en su hoja de configuración)')
    setOcupado(true)
    try {
      await sala.guardarImpresora({
        ...datos,
        nombre: datos.nombre.trim(),
        direccion: datos.direccion.trim(),
      })
      avisar(
        datos.activo ? `Guardaste ${datos.nombre.trim()}` : `Archivaste ${datos.nombre.trim()}`,
      )
      alGuardar()
    } catch (e) {
      setError(mensaje(e))
      setOcupado(false)
    }
  }

  return (
    <PanelLateral
      abierto
      titulo={inicial.id ? `Editar ${inicial.nombre}` : 'Impresora nueva'}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-alerta-texto">
              {error}
            </p>
          )}
          {archivando ? (
            <Confirmar
              pregunta={
                b.respaldo_id
                  ? `¿Archivar ${b.nombre}? Lo que esté esperando sale por la de respaldo. No se borra: se puede volver a usar.`
                  : `¿Archivar ${b.nombre}? No tiene respaldo: lo que esté esperando no saldrá y la caja lo verá en «Pedidos en cocina» para descartarlo o reimprimirlo. No se borra: se puede volver a usar.`
              }
              si="Archivar"
              ocupado={ocupado}
              alConfirmar={() => guardar({ activo: false })}
              alCancelar={() => setArchivando(false)}
            />
          ) : (
            <div className="flex gap-2">
              <Boton
                variante="principal"
                grande
                className="flex-1"
                disabled={ocupado}
                onClick={() => guardar()}
              >
                Guardar
              </Boton>
              {inicial.id && inicial.activo && (
                <Boton variante="fantasma" onClick={() => setArchivando(true)}>
                  Archivar
                </Boton>
              )}
              {inicial.id && !inicial.activo && (
                <Boton disabled={ocupado} onClick={() => guardar({ activo: true })}>
                  Volver a usar
                </Boton>
              )}
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre</span>
          <input
            className={claseCampo}
            value={b.nombre}
            maxLength={60}
            placeholder="Cocina"
            onChange={(e) => cambiar({ nombre: e.target.value })}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Qué imprime</span>
          <Estaciones
            config={config}
            elegidas={b.estacion_ids}
            alCambiar={(ids) => cambiar({ estacion_ids: ids })}
          />
          {b.estacion_ids.length === 0 && (
            <span className="text-sm text-texto-suave">
              Sin cocina ni barra: solo imprime cuando otra impresora no responde.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Conexión</span>
          <Grupo etiqueta="Conexión" className="flex flex-wrap gap-2">
            <Opcion elegida={b.conexion === 'red'} alElegir={() => cambiar({ conexion: 'red' })}>
              Cable de red
            </Opcion>
          </Grupo>
          <span className="text-sm text-texto-suave">
            Por USB, próximamente (con el programa de instalación para Windows). Por ahora, conecta
            la impresora con su cable de red al router.
          </span>
        </div>

        {b.conexion === 'red' ? (
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="font-semibold">Dirección de red (IP)</span>
              <input
                className={`${claseCampo} cifras`}
                value={b.direccion}
                inputMode="decimal"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="192.168.1.50"
                onChange={(e) => cambiar({ direccion: e.target.value })}
              />
            </label>
            <label className="flex w-28 flex-col gap-1">
              <span className="font-semibold">Puerto</span>
              <input
                className={`${claseCampo} cifras`}
                value={b.puerto ?? ''}
                inputMode="numeric"
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ''))
                  cambiar({ puerto: n > 0 ? Math.min(n, 65535) : null })
                }}
              />
            </label>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Nombre de la impresora en Windows</span>
            <input
              className={claseCampo}
              value={b.direccion}
              onChange={(e) => cambiar({ direccion: e.target.value })}
            />
          </label>
        )}
        <p className="-mt-3 text-sm text-texto-suave">
          La IP sale al imprimir la hoja de configuración: con la impresora apagada, mantén
          presionado el botón de avance de papel y préndela.
        </p>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Ancho del papel</span>
          <Grupo etiqueta="Ancho del papel" className="flex flex-wrap gap-2">
            {([80, 58] as const).map((a) => (
              <Opcion key={a} elegida={b.ancho === a} alElegir={() => cambiar({ ancho: a })}>
                {`${a} mm`}
              </Opcion>
            ))}
          </Grupo>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Tildes y eñes</span>
          <Grupo etiqueta="Tabla de caracteres" className="flex flex-col gap-2">
            {PAGINAS.map((p) => (
              <Opcion
                key={p.valor}
                forma="tarjeta"
                detalle={p.detalle}
                elegida={b.pagina_codigos === p.valor}
                alElegir={() => cambiar({ pagina_codigos: p.valor })}
              >
                {p.nombre}
              </Opcion>
            ))}
          </Grupo>
          <span className="text-sm text-texto-suave">
            Guarda y toca «Imprimir prueba»: si la ñ y las tildes salen bien, queda así.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-semibold">Si no responde, imprimir en</span>
          <Grupo etiqueta="Impresora de respaldo" className="flex flex-wrap gap-2">
            <Opcion
              elegida={b.respaldo_id === null}
              alElegir={() => cambiar({ respaldo_id: null })}
            >
              Ninguna
            </Opcion>
            {otras.map((i) => (
              <Opcion
                key={i.id}
                elegida={b.respaldo_id === i.id}
                alElegir={() => cambiar({ respaldo_id: i.id })}
              >
                {i.nombre}
              </Opcion>
            ))}
          </Grupo>
          <span className="text-sm text-texto-suave">
            Tras 3 intentos fallidos, sus comandas salen por la de respaldo y todos ven la alerta.
          </span>
        </div>
      </div>
    </PanelLateral>
  )
}

function Pantallas({ config, alCambiar }: { config: ConfiguracionCocina; alCambiar: () => void }) {
  const avisar = useAvisar()
  const { equipo } = useSala()
  const [nombre, setNombre] = useState('Pantalla cocina')
  const [estaciones, setEstaciones] = useState<string[]>([])
  const [confirmando, setConfirmando] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cambiarEstaciones = async (dispositivoId: string, ids: string[]) => {
    if (ids.length === 0) return avisar('Una pantalla muestra al menos una estación')
    try {
      await sala.estacionesDePantalla(dispositivoId, ids)
      alCambiar()
    } catch (e) {
      avisar(mensaje(e))
    }
  }
  const convertir = async () => {
    setOcupado(true)
    try {
      await sala.convertirEnPantalla(nombre.trim(), estaciones)
      navegar('/')
    } catch (e) {
      setError(mensaje(e))
      setOcupado(false)
      setConfirmando(false)
    }
  }

  return (
    <section aria-labelledby="titulo-pantallas" className="flex flex-col gap-3">
      <h2 id="titulo-pantallas" className="text-xl font-bold tracking-tight">
        Pantallas de cocina
      </h2>
      <p className="text-texto-suave">
        Opcionales. Una tablet (o un televisor táctil) en la cocina o la barra muestra las comandas
        y el cocinero toca «Listo». Un televisor sin pantalla táctil solo sirve para mirar.
      </p>
      {config.pantallas.length > 0 && (
        <ul className="flex flex-col gap-3">
          {config.pantallas.map((p) => (
            <li
              key={p.dispositivo_id}
              className="flex flex-col gap-2 rounded-2xl border border-linea bg-superficie p-4"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg font-semibold">{p.nombre}</span>
                <span className="text-sm text-texto-suave">
                  {p.ultimo_uso
                    ? `Última señal: ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(p.ultimo_uso))}`
                    : 'Sin señal todavía'}
                </span>
              </span>
              <span className="text-sm font-semibold">Qué estaciones muestra</span>
              <Estaciones
                config={config}
                elegidas={p.estacion_ids}
                alCambiar={(ids) => cambiarEstaciones(p.dispositivo_id, ids)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-linea bg-superficie-2/60 p-4">
        <span className="text-lg font-semibold">Usar este equipo como pantalla de cocina</span>
        <p className="text-sm text-texto-suave">
          Hazlo desde la tablet de la cocina: entra con tu usuario en ella, ven aquí y conviértela.
          Ese equipo ya no servirá para tomar pedidos ni para la caja. Para deshacerlo, desde la
          caja ve a Personal y roles, Equipos, y toca «Retirar» en la pantalla; luego en la tablet
          toca «Entrar de nuevo».
          {equipo?.tipo === 'mesero' && ' Este es un celular de mesero.'}
        </p>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre de la pantalla</span>
          <input
            className={claseCampo}
            value={nombre}
            maxLength={60}
            onChange={(e) => setNombre(e.target.value)}
          />
        </label>
        <span className="font-semibold">Qué estaciones muestra</span>
        <Estaciones config={config} elegidas={estaciones} alCambiar={setEstaciones} />
        {estaciones.length === 0 && (
          <span className="text-sm text-texto-suave">Elige al menos una estación.</span>
        )}
        {error && (
          <p role="alert" className="text-alerta-texto">
            {error}
          </p>
        )}
        {confirmando ? (
          <Confirmar
            pregunta="Este equipo quedará siempre en la pantalla de cocina, sin pedir PIN, y tu sesión se cierra aquí. Para deshacerlo: desde la caja, Personal y roles, Equipos, «Retirar». ¿Seguimos?"
            si="Convertir"
            ocupado={ocupado}
            alConfirmar={convertir}
            alCancelar={() => setConfirmando(false)}
          />
        ) : (
          <Boton
            variante="principal"
            icono="check"
            disabled={estaciones.length === 0 || !nombre.trim()}
            onClick={() => {
              setError(null)
              setConfirmando(true)
            }}
          >
            Convertir este equipo
          </Boton>
        )}
      </div>
    </section>
  )
}

function Tiempos({ config, alCambiar }: { config: ConfiguracionCocina; alCambiar: () => void }) {
  const avisar = useAvisar()
  const [amarillo, setAmarillo] = useState(String(config.tiempos.amarillo))
  const [rojo, setRojo] = useState(String(config.tiempos.rojo))
  const a = Number(amarillo)
  const r = Number(rojo)
  const valido = Number.isInteger(a) && Number.isInteger(r) && a >= 1 && r > a && r <= 240
  const cambio = a !== config.tiempos.amarillo || r !== config.tiempos.rojo
  const guardar = async () => {
    try {
      await sala.tiemposCocina(a, r)
      avisar('Guardaste los tiempos de cocina')
      alCambiar()
    } catch (e) {
      avisar(mensaje(e))
    }
  }
  return (
    <section aria-labelledby="titulo-tiempos" className="flex flex-col gap-3">
      <h2 id="titulo-tiempos" className="text-xl font-bold tracking-tight">
        Cuándo se ve demorado
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-36 flex-col gap-1">
          <span className="font-semibold">Demorada desde</span>
          <span className="flex items-center gap-2">
            <input
              className={`${claseCampo} cifras`}
              inputMode="numeric"
              value={amarillo}
              onChange={(e) => setAmarillo(e.target.value.replace(/\D/g, ''))}
            />
            min
          </span>
        </label>
        <label className="flex w-36 flex-col gap-1">
          <span className="font-semibold">Muy demorada desde</span>
          <span className="flex items-center gap-2">
            <input
              className={`${claseCampo} cifras`}
              inputMode="numeric"
              value={rojo}
              onChange={(e) => setRojo(e.target.value.replace(/\D/g, ''))}
            />
            min
          </span>
        </label>
        <Boton variante="principal" disabled={!valido || !cambio} onClick={guardar}>
          Guardar
        </Boton>
      </div>
      {!valido && (
        <p className="text-sm text-alerta-texto">
          Escribe minutos enteros: «muy demorada» debe llegar después de «demorada», hasta 240.
        </p>
      )}
    </section>
  )
}
