import { DESCRIPCION_PERMISOS } from '@pos/core'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { sala, useSala } from './contexto'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import type { Personal as DatosPersonal } from './motor'
import {
  administradoras,
  type BorradorPersona,
  borradorDe,
  datosPersona,
  type EquipoPersonal,
  normalizarUsuario,
  type PersonaPersonal,
  pideContrasena,
  problemasDe,
  type RolPersonal,
  resumenRol,
  usuarioSugerido,
} from './personas'

// Personal y roles (tarea 1.3b, ADR-013): el administrador da de alta a cada persona, decide cómo
// entra (PIN o usuario y contraseña), qué puede hacer cada rol y qué equipos siguen teniendo
// acceso. Todo lo comprueba el hub; aquí se avisa antes de lo que no tiene vuelta atrás.

type Pestana = 'personas' | 'roles' | 'equipos'
const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : 'No se pudo guardar')

const TIPO_EQUIPO: Record<string, string> = {
  mesero: 'Celular',
  caja: 'Caja',
  kds: 'Pantalla de cocina',
}

const cuando = (iso: string) =>
  new Date(iso).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

export function Personal() {
  const { sesion, equipo } = useSala()
  const avisar = useAvisar()
  const [datos, setDatos] = useState<DatosPersonal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pestana, setPestana] = useState<Pestana>('personas')
  const [persona, setPersona] = useState<PersonaPersonal | 'nueva' | null>(null)
  const [rol, setRol] = useState<RolPersonal | 'nuevo' | null>(null)
  const [pinNuevo, setPinNuevo] = useState<{
    nombre: string
    pin: string
    autoriza: boolean
  } | null>(null)
  const [verArchivados, setVerArchivados] = useState(false)
  const idPin = useId()
  const verEquipos = sesion?.permisos.includes('administrar_dispositivos') ?? false

  const leer = useCallback(
    () =>
      sala
        .personal()
        .then((d) => {
          setDatos(d)
          setError(null)
        })
        .catch((e) => setError(mensajeDe(e))),
    [],
  )
  useEffect(() => {
    leer()
  }, [leer])

  const roles = datos?.roles ?? []
  const nombreRol = (id: string) => roles.find((r) => r.id === id)?.nombre ?? 'Sin rol'
  const activas = (datos?.personas ?? []).filter((p) => p.activo)
  const archivadas = (datos?.personas ?? []).filter((p) => !p.activo)
  const soloUnaAdministra = datos !== null && administradoras(datos).length === 1

  const guardarPersona = async (
    b: BorradorPersona,
    extras: Parameters<typeof datosPersona>[1] = {},
  ) => {
    const r = await sala.guardarPersona(datosPersona(b, extras))
    await leer()
    if (r.pin)
      setPinNuevo({ nombre: b.nombre.trim(), pin: r.pin, autoriza: b.entra === 'contrasena' })
    else
      avisar(
        extras.activo === false
          ? `Archivaste a ${b.nombre.trim()}`
          : `Guardaste a ${b.nombre.trim()}`,
      )
  }

  return (
    <MarcoSala titulo="Personal y roles" volver="/">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <Grupo etiqueta="Qué ver" className="flex flex-wrap gap-2">
          <Opcion elegida={pestana === 'personas'} alElegir={() => setPestana('personas')}>
            Personas
          </Opcion>
          <Opcion elegida={pestana === 'roles'} alElegir={() => setPestana('roles')}>
            Roles
          </Opcion>
          {verEquipos && (
            <Opcion elegida={pestana === 'equipos'} alElegir={() => setPestana('equipos')}>
              Equipos
            </Opcion>
          )}
        </Grupo>

        {error && (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto" role="alert">
            {error}
          </p>
        )}
        {!datos && !error && <p className="text-texto-suave">Cargando…</p>}
        {soloUnaAdministra && (
          <p className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
            Solo una persona puede administrar el personal. Si olvida su contraseña, nadie más podrá
            entrar aquí: crea otra persona con el rol Administrador.
          </p>
        )}

        {datos && pestana === 'personas' && (
          <section aria-label="Personas" className="flex flex-col gap-2">
            <Boton variante="principal" icono="mas" onClick={() => setPersona('nueva')}>
              Persona nueva
            </Boton>
            <ul className="flex flex-col gap-2">
              {activas.map((p) => (
                <FilaPersona
                  key={p.id}
                  persona={p}
                  rol={nombreRol(p.rolId)}
                  esUsted={p.id === sesion?.usuario.id}
                  sinAcceso={
                    p.usuario === null && pideContrasena(roles.find((r) => r.id === p.rolId))
                  }
                  alTocar={() => setPersona(p)}
                />
              ))}
            </ul>
            {archivadas.length > 0 && (
              <>
                <Boton variante="fantasma" onClick={() => setVerArchivados(!verArchivados)}>
                  {verArchivados ? 'Ocultar archivadas' : `Ver archivadas (${archivadas.length})`}
                </Boton>
                {verArchivados && (
                  <ul className="flex flex-col gap-2 opacity-80">
                    {archivadas.map((p) => (
                      <FilaPersona
                        key={p.id}
                        persona={p}
                        rol={nombreRol(p.rolId)}
                        esUsted={false}
                        sinAcceso={false}
                        alTocar={() => setPersona(p)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}

        {datos && pestana === 'roles' && (
          <section aria-label="Roles" className="flex flex-col gap-2">
            <Boton variante="principal" icono="mas" onClick={() => setRol('nuevo')}>
              Rol nuevo
            </Boton>
            <ul className="flex flex-col gap-2">
              {roles.map((r) => (
                <li key={r.id}>
                  <Fila alTocar={() => setRol(r)} apagada={!r.activo}>
                    <span className="font-semibold">
                      {r.nombre}
                      {r.sistema && (
                        <span className="font-normal text-texto-suave"> · de fábrica</span>
                      )}
                      {!r.activo && (
                        <span className="font-normal text-texto-suave"> · archivado</span>
                      )}
                    </span>
                    <span className="text-sm text-texto-suave">
                      {`${resumenRol(r)}${pideContrasena(r) ? ' · entra con contraseña' : ''}`}
                    </span>
                  </Fila>
                </li>
              ))}
            </ul>
          </section>
        )}

        {datos && pestana === 'equipos' && (
          <Equipos
            equipos={datos.equipos}
            propio={equipo?.dispositivoId ?? null}
            alRetirar={async (e) => {
              await sala.retirarEquipo(e.id)
              await leer()
              avisar(`Retiraste ${e.nombre}: ya no sincroniza ni se puede entrar en él`)
            }}
          />
        )}
      </div>

      {persona && datos && (
        <PanelPersona
          persona={persona === 'nueva' ? null : persona}
          datos={datos}
          esUsted={persona !== 'nueva' && persona.id === sesion?.usuario.id}
          alCerrar={() => setPersona(null)}
          alGuardar={async (b, extras) => {
            await guardarPersona(b, extras)
            setPersona(null)
          }}
        />
      )}

      {rol && datos && (
        <PanelRol
          rol={rol === 'nuevo' ? null : rol}
          esElSuyo={
            rol !== 'nuevo' &&
            activas.some((p) => p.id === sesion?.usuario.id && p.rolId === rol.id)
          }
          alCerrar={() => setRol(null)}
          alGuardar={async (r) => {
            await sala.guardarRol(r)
            await leer()
            avisar(
              r.activo === false ? `Archivaste el rol ${r.nombre}` : `Guardaste el rol ${r.nombre}`,
            )
            setRol(null)
          }}
        />
      )}

      {/* El PIN se ve una sola vez: el panel solo se cierra con «Ya lo anoté». */}
      <PanelLateral
        abierto={pinNuevo !== null}
        titulo={pinNuevo ? `PIN de ${pinNuevo.nombre}` : 'PIN'}
        alCerrar={() => setPinNuevo(null)}
        soloConBoton
        idDescripcion={idPin}
        pie={
          <Boton variante="principal" grande className="w-full" onClick={() => setPinNuevo(null)}>
            Ya lo anoté
          </Boton>
        }
      >
        {pinNuevo && (
          <div className="flex flex-col items-center gap-4 text-center">
            <p id={idPin} className="flex flex-col items-center gap-4">
              <span className="font-titulo rounded-2xl bg-superficie-2 px-6 py-4 text-5xl tracking-[0.3em]">
                {pinNuevo.pin}
              </span>
              <span>
                {pinNuevo.autoriza
                  ? `Con este PIN, ${pinNuevo.nombre} aprueba anulaciones y descuentos desde el celular de un mesero. Para entrar usa su usuario y contraseña.`
                  : `Con este PIN, ${pinNuevo.nombre} entra desde su celular.`}
              </span>
            </p>
            <p className="text-texto-suave">
              Dáselo en persona. No se vuelve a mostrar: si se pierde, toca «Nuevo PIN».
            </p>
          </div>
        )}
      </PanelLateral>
    </MarcoSala>
  )
}

function Fila({
  alTocar,
  apagada = false,
  children,
}: {
  alTocar: () => void
  apagada?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={alTocar}
      className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-borde bg-superficie px-4 py-2 text-left hover:bg-superficie-2 focus-visible:outline-3 focus-visible:outline-foco ${apagada ? 'opacity-70' : ''}`}
    >
      <span className="flex flex-col">{children}</span>
      <span className="text-texto-suave" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

function FilaPersona({
  persona: p,
  rol,
  esUsted,
  sinAcceso,
  alTocar,
}: {
  persona: PersonaPersonal
  rol: string
  esUsted: boolean
  /** Entra con PIN pero su rol pide contraseña: hoy no puede entrar (una base de antes). */
  sinAcceso: boolean
  alTocar: () => void
}) {
  return (
    <li>
      <Fila alTocar={alTocar}>
        <span className="font-semibold">
          {p.nombre}
          {esUsted && <span className="font-normal text-texto-suave"> · tú</span>}
        </span>
        <span className="text-sm text-texto-suave">
          {[
            rol,
            p.usuario ? `usuario ${p.usuario}` : 'entra con PIN',
            ...(p.activo ? [] : ['archivada']),
          ].join(' · ')}
        </span>
        {sinAcceso && (
          <span className="text-sm font-semibold text-alerta-texto">
            No puede entrar: su rol pide usuario y contraseña
          </span>
        )}
      </Fila>
    </li>
  )
}

/** Una pregunta antes de algo sin vuelta atrás, dentro del panel. */
function Confirmar({
  pregunta,
  si,
  alConfirmar,
  alCancelar,
  ocupado,
}: {
  pregunta: string
  si: string
  alConfirmar: () => void
  alCancelar: () => void
  ocupado: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-alerta-suave p-3" role="alertdialog">
      <p className="text-alerta-texto">{pregunta}</p>
      <div className="flex gap-2">
        <Boton variante="peligro" className="flex-1" disabled={ocupado} onClick={alConfirmar}>
          {si}
        </Boton>
        <Boton className="flex-1" onClick={alCancelar}>
          No
        </Boton>
      </div>
    </div>
  )
}

function Equipos({
  equipos,
  propio,
  alRetirar,
}: {
  equipos: EquipoPersonal[]
  propio: string | null
  alRetirar: (e: EquipoPersonal) => Promise<void>
}) {
  const [retirando, setRetirando] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <section aria-label="Equipos" className="flex flex-col gap-2">
      <p className="text-texto-suave">
        Cada celular, tablet o computador queda aquí la primera vez que alguien entra en él. Si se
        pierde o se lo roban, retíralo: deja de recibir el salón y nadie puede entrar en él.
      </p>
      {error && (
        <p className="text-alerta-texto" role="alert">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {equipos.map((e) => (
          <li
            key={e.id}
            className={`flex flex-col gap-2 rounded-xl border border-borde bg-superficie px-4 py-3 ${e.revocadoEn ? 'opacity-70' : ''}`}
          >
            <span className="font-semibold">
              {e.nombre}
              <span className="font-normal text-texto-suave">{` · ${TIPO_EQUIPO[e.tipo] ?? e.tipo}`}</span>
              {e.id === propio && <span className="font-normal text-texto-suave"> · este</span>}
            </span>
            <span className="text-sm text-texto-suave">
              {e.revocadoEn
                ? `Retirado el ${cuando(e.revocadoEn)}`
                : e.ultimoUso
                  ? `Último uso: ${e.ultimaPersona ?? 'alguien'}, ${cuando(e.ultimoUso)}`
                  : 'Sin uso todavía'}
            </span>
            {!e.revocadoEn &&
              e.id !== propio &&
              (retirando === e.id ? (
                <Confirmar
                  pregunta={`Retirar ${e.nombre}: deja de sincronizar y nadie puede entrar en él. Lo que no haya enviado lo revisa un administrador.`}
                  si="Sí, retirar"
                  ocupado={ocupado}
                  alCancelar={() => setRetirando(null)}
                  alConfirmar={async () => {
                    setOcupado(true)
                    try {
                      await alRetirar(e)
                      setRetirando(null)
                      setError(null)
                    } catch (x) {
                      setError(mensajeDe(x))
                    }
                    setOcupado(false)
                  }}
                />
              ) : (
                <Boton variante="secundario" onClick={() => setRetirando(e.id)}>
                  Retirar
                </Boton>
              ))}
          </li>
        ))}
        {equipos.length === 0 && <li className="text-texto-suave">Todavía no hay equipos.</li>}
      </ul>
    </section>
  )
}

function PanelPersona({
  persona,
  datos,
  esUsted,
  alCerrar,
  alGuardar,
}: {
  persona: PersonaPersonal | null
  datos: DatosPersonal
  esUsted: boolean
  alCerrar: () => void
  alGuardar: (
    b: BorradorPersona,
    extras?: { activo?: boolean; regenerarPin?: boolean },
  ) => Promise<void>
}) {
  // El rol archivado de alguien también se ve, marcado: si no, no aparecería ninguno elegido.
  const opcionesRol = datos.roles.filter((r) => r.activo || r.id === persona?.rolId)
  const mesero = datos.roles.find((r) => r.activo && r.sistema && r.nombre === 'Mesero')
  const [inicial] = useState<BorradorPersona>(() =>
    borradorDe(persona, mesero?.id ?? opcionesRol[0]?.id ?? ''),
  )
  const [b, setB] = useState<BorradorPersona>(inicial)
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState<'archivar' | 'salir' | 'perder' | null>(null)
  const idAyuda = useId()
  const cambiar = (parcial: Partial<BorradorPersona>) => setB((x) => ({ ...x, ...parcial }))
  const problemas = problemasDe(b, persona, datos.personas, datos.roles)
  const rolElegido = datos.roles.find((r) => r.id === b.rolId)
  const exigeContrasena = pideContrasena(rolElegido)
  const sucio = JSON.stringify(b) !== JSON.stringify(inicial)
  const pierdeAdministrar = esUsted && !rolElegido?.permisos.includes('administrar_usuarios')
  const cambiaComoEntra =
    persona !== null &&
    (b.rolId !== persona.rolId ||
      (b.entra === 'pin') !== (persona.usuario === null) ||
      b.contrasena.length > 0)

  const hacer = async (extras?: { activo?: boolean; regenerarPin?: boolean }) => {
    setOcupado(true)
    try {
      await alGuardar(b, extras)
    } catch (e) {
      setError(mensajeDe(e))
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }
  const guardar = () => {
    if (problemas.length > 0) {
      setError(problemas.join('. '))
      setIntento((i) => i + 1)
      return
    }
    if (pierdeAdministrar && confirmando !== 'perder') {
      setConfirmando('perder')
      return
    }
    void hacer(persona && !persona.activo ? { activo: true } : {})
  }
  const cerrar = () => (sucio && confirmando !== 'salir' ? setConfirmando('salir') : alCerrar())
  const elegirRol = (r: RolPersonal) =>
    cambiar({
      rolId: r.id,
      ...(pideContrasena(r) && b.entra === 'pin'
        ? { entra: 'contrasena', usuario: b.usuario || usuarioSugerido(b.nombre) }
        : {}),
    })

  return (
    <PanelLateral
      abierto
      titulo={persona ? persona.nombre : 'Persona nueva'}
      alCerrar={cerrar}
      pie={
        <div className="flex flex-col gap-2">
          <p key={intento} className="min-h-6 text-alerta-texto" role="alert">
            {error ?? ''}
          </p>
          {confirmando === 'salir' ? (
            <Confirmar
              pregunta="Hay cambios sin guardar. ¿Salir sin guardarlos?"
              si="Salir sin guardar"
              ocupado={false}
              alConfirmar={alCerrar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'perder' ? (
            <Confirmar
              pregunta="Vas a perder el acceso a Personal y roles. Solo otra persona administradora te lo puede devolver."
              si="Sí, guardar"
              ocupado={ocupado}
              alConfirmar={guardar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'archivar' && persona ? (
            <Confirmar
              pregunta={`Archivar a ${persona.nombre}: no podrá entrar hasta que la actives de nuevo.`}
              si="Sí, archivar"
              ocupado={ocupado}
              alConfirmar={() => void hacer({ activo: false })}
              alCancelar={() => setConfirmando(null)}
            />
          ) : (
            <>
              <Boton variante="principal" grande disabled={ocupado} onClick={guardar}>
                {persona && !persona.activo ? 'Volver a activar' : 'Guardar'}
              </Boton>
              {persona?.activo && (
                <Boton disabled={ocupado} onClick={() => void hacer({ regenerarPin: true })}>
                  Nuevo PIN
                </Boton>
              )}
            </>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre</span>
          <input
            className={claseCampo}
            value={b.nombre}
            maxLength={60}
            onChange={(e) => {
              const nombre = e.target.value
              // Mientras no se haya escrito un usuario propio, se sugiere uno a partir del nombre.
              const sugerido = usuarioSugerido(b.nombre)
              cambiar({
                nombre,
                ...(b.entra === 'contrasena' &&
                (b.usuario === '' || b.usuario === sugerido) &&
                !persona?.usuario
                  ? { usuario: usuarioSugerido(nombre) }
                  : {}),
              })
            }}
          />
        </label>

        <Grupo etiqueta="Rol" className="flex flex-wrap items-center gap-2">
          <p className="w-full font-semibold">Rol</p>
          {opcionesRol.map((r) => (
            <Opcion key={r.id} elegida={b.rolId === r.id} alElegir={() => elegirRol(r)}>
              {r.activo ? r.nombre : `${r.nombre} (archivado)`}
            </Opcion>
          ))}
        </Grupo>

        <Grupo etiqueta="Cómo entra" className="flex flex-col gap-2">
          <p className="font-semibold">Cómo entra</p>
          {!exigeContrasena && (
            <Opcion
              forma="tarjeta"
              elegida={b.entra === 'pin'}
              detalle="Meseros: desde su celular"
              alElegir={() => cambiar({ entra: 'pin' })}
            >
              Con su PIN
            </Opcion>
          )}
          <Opcion
            forma="tarjeta"
            elegida={b.entra === 'contrasena'}
            detalle="Caja, administración y reportes"
            alElegir={() =>
              cambiar({ entra: 'contrasena', usuario: b.usuario || usuarioSugerido(b.nombre) })
            }
          >
            Con usuario y contraseña
          </Opcion>
          {exigeContrasena && (
            <p className="text-sm text-texto-suave">
              {`El rol ${rolElegido?.nombre} permite cobrar o administrar: se entra con usuario y contraseña.`}
            </p>
          )}
          {persona?.usuario && b.entra === 'pin' && (
            <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
              Al guardar se borran su usuario y su contraseña: desde entonces entra solo con su PIN.
            </p>
          )}
        </Grupo>

        {b.entra === 'contrasena' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">Usuario</span>
              <input
                className={claseCampo}
                value={b.usuario}
                maxLength={40}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => cambiar({ usuario: e.target.value })}
                onBlur={() => cambiar({ usuario: normalizarUsuario(b.usuario) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">
                {persona?.usuario ? 'Contraseña nueva (opcional)' : 'Contraseña'}
              </span>
              <input
                className={claseCampo}
                type="password"
                value={b.contrasena}
                maxLength={200}
                autoComplete="new-password"
                enterKeyHint="done"
                aria-describedby={idAyuda}
                onChange={(e) => cambiar({ contrasena: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') guardar()
                }}
              />
              <span id={idAyuda} className="text-sm text-texto-suave">
                {persona?.usuario
                  ? 'Déjala vacía para no cambiarla. Si escribes una, al menos 8 caracteres.'
                  : 'Al menos 8 caracteres. Dásela en persona.'}
              </span>
            </label>
            <p className="text-sm text-texto-suave">
              Su PIN no le sirve para entrar: con él aprueba anulaciones y descuentos desde el
              celular de un mesero.
            </p>
          </>
        )}
        {cambiaComoEntra && (
          <p className="text-sm text-texto-suave">
            {esUsted
              ? 'Al guardar tendrás que volver a entrar.'
              : 'Si está trabajando, al guardar tendrá que volver a entrar.'}
          </p>
        )}

        {persona?.activo && !esUsted && confirmando === null && (
          <Boton variante="peligro" className="mt-4" onClick={() => setConfirmando('archivar')}>
            Archivar
          </Boton>
        )}
      </div>
    </PanelLateral>
  )
}

function PanelRol({
  rol,
  esElSuyo,
  alCerrar,
  alGuardar,
}: {
  rol: RolPersonal | null
  /** Si quien edita tiene este rol. */
  esElSuyo: boolean
  alCerrar: () => void
  alGuardar: (r: {
    id?: string
    nombre: string
    permisos: string[]
    activo?: boolean
  }) => Promise<void>
}) {
  const [nombre, setNombre] = useState(rol?.nombre ?? '')
  const [permisos, setPermisos] = useState<Set<string>>(() => new Set(rol?.permisos ?? []))
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState<'archivar' | 'salir' | 'perder' | null>(null)
  const sucio =
    nombre !== (rol?.nombre ?? '') ||
    [...permisos].sort().join() !== [...(rol?.permisos ?? [])].sort().join()

  const alternar = (p: string) =>
    setPermisos((actual) => {
      const nuevo = new Set(actual)
      if (nuevo.has(p)) nuevo.delete(p)
      else nuevo.add(p)
      return nuevo
    })
  const hacer = async (activo?: boolean) => {
    setOcupado(true)
    try {
      await alGuardar({
        ...(rol ? { id: rol.id } : {}),
        nombre: nombre.trim(),
        permisos: [...permisos],
        ...(activo === undefined ? {} : { activo }),
      })
    } catch (e) {
      setError(mensajeDe(e))
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }
  const guardar = () => {
    if (!nombre.trim()) {
      setError('Escribe el nombre del rol')
      setIntento((i) => i + 1)
      return
    }
    if (esElSuyo && !permisos.has('administrar_usuarios') && confirmando !== 'perder') {
      setConfirmando('perder')
      return
    }
    void hacer(rol && !rol.activo ? true : undefined)
  }
  const cerrar = () => (sucio && confirmando !== 'salir' ? setConfirmando('salir') : alCerrar())

  return (
    <PanelLateral
      abierto
      titulo={rol ? `Rol ${rol.nombre}` : 'Rol nuevo'}
      alCerrar={cerrar}
      pie={
        <div className="flex flex-col gap-2">
          <p key={intento} className="min-h-6 text-alerta-texto" role="alert">
            {error ?? ''}
          </p>
          {confirmando === 'salir' ? (
            <Confirmar
              pregunta="Hay cambios sin guardar. ¿Salir sin guardarlos?"
              si="Salir sin guardar"
              ocupado={false}
              alConfirmar={alCerrar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'perder' ? (
            <Confirmar
              pregunta="Es tu rol: vas a perder el acceso a Personal y roles. Solo otra persona administradora te lo puede devolver."
              si="Sí, guardar"
              ocupado={ocupado}
              alConfirmar={guardar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'archivar' && rol ? (
            <Confirmar
              pregunta={`Archivar el rol ${rol.nombre}: ya no se podrá elegir para nadie.`}
              si="Sí, archivar"
              ocupado={ocupado}
              alConfirmar={() => void hacer(false)}
              alCancelar={() => setConfirmando(null)}
            />
          ) : (
            <Boton variante="principal" grande disabled={ocupado} onClick={guardar}>
              {rol && !rol.activo ? 'Volver a activar' : 'Guardar'}
            </Boton>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre</span>
          <input
            className={claseCampo}
            value={nombre}
            maxLength={60}
            disabled={rol?.sistema}
            onChange={(e) => setNombre(e.target.value)}
          />
          {rol?.sistema && (
            <span className="text-sm text-texto-suave">
              Es de fábrica: no se renombra ni se archiva, pero sus permisos sí se cambian.
            </span>
          )}
        </label>
        {rol && rol.personas > 0 && (
          <p className="text-sm text-texto-suave">
            {`Los cambios valen para ${rol.personas === 1 ? 'la persona' : `las ${rol.personas} personas`} con este rol. Si ya están trabajando, deben volver a entrar para ver los botones nuevos.`}
          </p>
        )}
        <p className="text-sm text-texto-suave">
          Quien entra con PIN no puede tener permisos para cobrar, manejar la caja, editar la carta,
          ver reportes ni administrar. «Personal y roles» deja dar cualquier permiso: dáselo solo a
          alguien de toda confianza.
        </p>
        {DESCRIPCION_PERMISOS.map((g) => (
          <fieldset key={g.grupo} className="flex flex-col gap-1">
            <legend className="mb-1 font-semibold">{g.grupo}</legend>
            {g.permisos.map((p) => (
              <label key={p.permiso} className="flex min-h-12 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-6"
                  checked={permisos.has(p.permiso)}
                  onChange={() => alternar(p.permiso)}
                />
                <span>{p.nombre}</span>
              </label>
            ))}
          </fieldset>
        ))}
        {rol && !rol.sistema && rol.activo && confirmando === null && (
          <Boton variante="peligro" className="mt-2" onClick={() => setConfirmando('archivar')}>
            Archivar el rol
          </Boton>
        )}
      </div>
    </PanelLateral>
  )
}
