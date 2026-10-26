import { PERMISSION_DESCRIPTIONS } from '@pos/core'
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

type Pestana = 'people' | 'roles' | 'devices'
const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : 'No se pudo guardar')

const TIPO_EQUIPO: Record<string, string> = {
  waiter: 'Celular',
  register: 'Caja',
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
  const { session, device } = useSala()
  const avisar = useAvisar()
  const [data, setDatos] = useState<DatosPersonal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pestana, setPestana] = useState<Pestana>('people')
  const [persona, setPersona] = useState<PersonaPersonal | 'new' | null>(null)
  const [role, setRol] = useState<RolPersonal | 'new' | null>(null)
  const [pinNuevo, setPinNuevo] = useState<{
    name: string
    pin: string
    authorizes: boolean
  } | null>(null)
  const [verArchivados, setVerArchivados] = useState(false)
  const idPin = useId()
  const verEquipos = session?.permissions.includes('manage_devices') ?? false

  const leer = useCallback(
    () =>
      sala
        .staff()
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

  const roles = data?.roles ?? []
  const nombreRol = (id: string) => roles.find((r) => r.id === id)?.name ?? 'Sin rol'
  const activas = (data?.people ?? []).filter((p) => p.active)
  const archivadas = (data?.people ?? []).filter((p) => !p.active)
  const soloUnaAdministra = data !== null && administradoras(data).length === 1

  const guardarPersona = async (
    b: BorradorPersona,
    extras: Parameters<typeof datosPersona>[1] = {},
  ) => {
    const r = await sala.guardarPersona(datosPersona(b, extras))
    await leer()
    if (r.pin) setPinNuevo({ name: b.name.trim(), pin: r.pin, authorizes: b.entra === 'password' })
    else
      avisar(
        extras.active === false ? `Archivaste a ${b.name.trim()}` : `Guardaste a ${b.name.trim()}`,
      )
  }

  return (
    <MarcoSala titulo="Personal y roles" back="/">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <Grupo etiqueta="Qué ver" className="flex flex-wrap gap-2">
          <Opcion elegida={pestana === 'people'} alElegir={() => setPestana('people')}>
            Personas
          </Opcion>
          <Opcion elegida={pestana === 'roles'} alElegir={() => setPestana('roles')}>
            Roles
          </Opcion>
          {verEquipos && (
            <Opcion elegida={pestana === 'devices'} alElegir={() => setPestana('devices')}>
              Equipos
            </Opcion>
          )}
        </Grupo>

        {error && (
          <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p className="text-texto-suave">Cargando…</p>}
        {soloUnaAdministra && (
          <p className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
            Solo una persona puede administrar el personal. Si olvida su contraseña, nadie más podrá
            entrar aquí: crea otra persona con el rol Administrador.
          </p>
        )}

        {data && pestana === 'people' && (
          <section aria-label="Personas" className="flex flex-col gap-2">
            <Boton variant="main" icono="more" onClick={() => setPersona('new')}>
              Persona nueva
            </Boton>
            <ul className="flex flex-col gap-2">
              {activas.map((p) => (
                <FilaPersona
                  key={p.id}
                  persona={p}
                  role={nombreRol(p.rolId)}
                  esUsted={p.id === session?.user.id}
                  sinAcceso={p.user === null && pideContrasena(roles.find((r) => r.id === p.rolId))}
                  alTocar={() => setPersona(p)}
                />
              ))}
            </ul>
            {archivadas.length > 0 && (
              <>
                <Boton variant="ghost" onClick={() => setVerArchivados(!verArchivados)}>
                  {verArchivados ? 'Ocultar archivadas' : `Ver archivadas (${archivadas.length})`}
                </Boton>
                {verArchivados && (
                  <ul className="flex flex-col gap-2 opacity-80">
                    {archivadas.map((p) => (
                      <FilaPersona
                        key={p.id}
                        persona={p}
                        role={nombreRol(p.rolId)}
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

        {data && pestana === 'roles' && (
          <section aria-label="Roles" className="flex flex-col gap-2">
            <Boton variant="main" icono="more" onClick={() => setRol('new')}>
              Rol nuevo
            </Boton>
            <ul className="flex flex-col gap-2">
              {roles.map((r) => (
                <li key={r.id}>
                  <Fila alTocar={() => setRol(r)} apagada={!r.active}>
                    <span className="font-semibold">
                      {r.name}
                      {r.system && (
                        <span className="font-normal text-texto-suave"> · de fábrica</span>
                      )}
                      {!r.active && (
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

        {data && pestana === 'devices' && (
          <Equipos
            devices={data.devices}
            own={device?.dispositivoId ?? null}
            alRetirar={async (e) => {
              await sala.retirarEquipo(e.id)
              await leer()
              avisar(`Retiraste ${e.name}: ya no sincroniza ni se puede entrar en él`)
            }}
          />
        )}
      </div>

      {persona && data && (
        <PanelPersona
          persona={persona === 'new' ? null : persona}
          data={data}
          esUsted={persona !== 'new' && persona.id === session?.user.id}
          alCerrar={() => setPersona(null)}
          onSave={async (b, extras) => {
            await guardarPersona(b, extras)
            setPersona(null)
          }}
        />
      )}

      {role && data && (
        <PanelRol
          role={role === 'new' ? null : role}
          esElSuyo={
            role !== 'new' && activas.some((p) => p.id === session?.user.id && p.rolId === role.id)
          }
          alCerrar={() => setRol(null)}
          onSave={async (r) => {
            await sala.guardarRol(r)
            await leer()
            avisar(
              r.active === false ? `Archivaste el rol ${r.name}` : `Guardaste el rol ${r.name}`,
            )
            setRol(null)
          }}
        />
      )}

      {/* El PIN se ve una sola vez: el panel solo se cierra con «Ya lo anoté». */}
      <PanelLateral
        opened={pinNuevo !== null}
        titulo={pinNuevo ? `PIN de ${pinNuevo.name}` : 'PIN'}
        alCerrar={() => setPinNuevo(null)}
        soloConBoton
        idDescripcion={idPin}
        pie={
          <Boton variant="main" large className="w-full" onClick={() => setPinNuevo(null)}>
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
                {pinNuevo.authorizes
                  ? `Con este PIN, ${pinNuevo.name} aprueba anulaciones y descuentos desde el celular de un mesero. Para entrar usa su usuario y contraseña.`
                  : `Con este PIN, ${pinNuevo.name} entra desde su celular.`}
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
  role,
  esUsted,
  sinAcceso,
  alTocar,
}: {
  persona: PersonaPersonal
  role: string
  esUsted: boolean
  /** Entra con PIN pero su rol pide contraseña: hoy no puede entrar (una base de antes). */
  sinAcceso: boolean
  alTocar: () => void
}) {
  return (
    <li>
      <Fila alTocar={alTocar}>
        <span className="font-semibold">
          {p.name}
          {esUsted && <span className="font-normal text-texto-suave"> · tú</span>}
        </span>
        <span className="text-sm text-texto-suave">
          {[
            role,
            p.user ? `usuario ${p.user}` : 'entra con PIN',
            ...(p.active ? [] : ['archivada']),
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
export function Confirmar({
  pregunta,
  yes,
  alConfirmar,
  alCancelar,
  ocupado,
}: {
  pregunta: string
  yes: string
  alConfirmar: () => void
  alCancelar: () => void
  ocupado: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-alerta-suave p-3" role="alertdialog">
      <p className="text-alerta-texto">{pregunta}</p>
      <div className="flex gap-2">
        <Boton variant="danger" className="flex-1" disabled={ocupado} onClick={alConfirmar}>
          {yes}
        </Boton>
        <Boton className="flex-1" onClick={alCancelar}>
          No
        </Boton>
      </div>
    </div>
  )
}

function Equipos({
  devices,
  own,
  alRetirar,
}: {
  devices: EquipoPersonal[]
  own: string | null
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
        {devices.map((e) => (
          <li
            key={e.id}
            className={`flex flex-col gap-2 rounded-xl border border-borde bg-superficie px-4 py-3 ${e.revocadoEn ? 'opacity-70' : ''}`}
          >
            <span className="font-semibold">
              {e.name}
              <span className="font-normal text-texto-suave">{` · ${TIPO_EQUIPO[e.type] ?? e.type}`}</span>
              {e.id === own && <span className="font-normal text-texto-suave"> · este</span>}
            </span>
            <span className="text-sm text-texto-suave">
              {e.revocadoEn
                ? `Retirado el ${cuando(e.revocadoEn)}`
                : e.ultimoUso
                  ? `Último uso: ${e.ultimaPersona ?? 'alguien'}, ${cuando(e.ultimoUso)}`
                  : 'Sin uso todavía'}
            </span>
            {!e.revocadoEn &&
              e.id !== own &&
              (retirando === e.id ? (
                <Confirmar
                  pregunta={`Retirar ${e.name}: deja de sincronizar y nadie puede entrar en él. Lo que no haya enviado lo revisa un administrador.`}
                  yes="Sí, retirar"
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
                <Boton variant="secondary" onClick={() => setRetirando(e.id)}>
                  Retirar
                </Boton>
              ))}
          </li>
        ))}
        {devices.length === 0 && <li className="text-texto-suave">Todavía no hay equipos.</li>}
      </ul>
    </section>
  )
}

function PanelPersona({
  persona,
  data,
  esUsted,
  alCerrar,
  onSave,
}: {
  persona: PersonaPersonal | null
  data: DatosPersonal
  esUsted: boolean
  alCerrar: () => void
  onSave: (
    b: BorradorPersona,
    extras?: { active?: boolean; regenerarPin?: boolean },
  ) => Promise<void>
}) {
  // El rol archivado de alguien también se ve, marcado: si no, no aparecería ninguno elegido.
  const opcionesRol = data.roles.filter((r) => r.active || r.id === persona?.rolId)
  const waiter = data.roles.find((r) => r.active && r.system && r.name === 'Mesero')
  const [initial] = useState<BorradorPersona>(() =>
    borradorDe(persona, waiter?.id ?? opcionesRol[0]?.id ?? ''),
  )
  const [b, setB] = useState<BorradorPersona>(initial)
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState<'archive' | 'exit' | 'lose' | null>(null)
  const idAyuda = useId()
  const patch = (partial: Partial<BorradorPersona>) => setB((x) => ({ ...x, ...partial }))
  const issues = problemasDe(b, persona, data.people, data.roles)
  const rolElegido = data.roles.find((r) => r.id === b.rolId)
  const exigeContrasena = pideContrasena(rolElegido)
  const sucio = JSON.stringify(b) !== JSON.stringify(initial)
  const pierdeAdministrar = esUsted && !rolElegido?.permissions.includes('manage_users')
  const cambiaComoEntra =
    persona !== null &&
    (b.rolId !== persona.rolId ||
      (b.entra === 'pin') !== (persona.user === null) ||
      b.password.length > 0)

  const hacer = async (extras?: { active?: boolean; regenerarPin?: boolean }) => {
    setOcupado(true)
    try {
      await onSave(b, extras)
    } catch (e) {
      setError(mensajeDe(e))
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }
  const guardar = () => {
    if (issues.length > 0) {
      setError(issues.join('. '))
      setIntento((i) => i + 1)
      return
    }
    if (pierdeAdministrar && confirmando !== 'lose') {
      setConfirmando('lose')
      return
    }
    void hacer(persona && !persona.active ? { active: true } : {})
  }
  const close = () => (sucio && confirmando !== 'exit' ? setConfirmando('exit') : alCerrar())
  const elegirRol = (r: RolPersonal) =>
    patch({
      rolId: r.id,
      ...(pideContrasena(r) && b.entra === 'pin'
        ? { entra: 'password', user: b.user || usuarioSugerido(b.name) }
        : {}),
    })

  return (
    <PanelLateral
      opened
      titulo={persona ? persona.name : 'Persona nueva'}
      alCerrar={close}
      pie={
        <div className="flex flex-col gap-2">
          <p key={intento} className="min-h-6 text-alerta-texto" role="alert">
            {error ?? ''}
          </p>
          {confirmando === 'exit' ? (
            <Confirmar
              pregunta="Hay cambios sin guardar. ¿Salir sin guardarlos?"
              yes="Salir sin guardar"
              ocupado={false}
              alConfirmar={alCerrar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'lose' ? (
            <Confirmar
              pregunta="Vas a perder el acceso a Personal y roles. Solo otra persona administradora te lo puede devolver."
              yes="Sí, guardar"
              ocupado={ocupado}
              alConfirmar={guardar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'archive' && persona ? (
            <Confirmar
              pregunta={`Archivar a ${persona.name}: no podrá entrar hasta que la actives de nuevo.`}
              yes="Sí, archivar"
              ocupado={ocupado}
              alConfirmar={() => void hacer({ active: false })}
              alCancelar={() => setConfirmando(null)}
            />
          ) : (
            <>
              <Boton variant="main" large disabled={ocupado} onClick={guardar}>
                {persona && !persona.active ? 'Volver a activar' : 'Guardar'}
              </Boton>
              {persona?.active && (
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
            value={b.name}
            maxLength={60}
            onChange={(e) => {
              const name = e.target.value
              // Mientras no se haya escrito un usuario propio, se sugiere uno a partir del nombre.
              const sugerido = usuarioSugerido(b.name)
              patch({
                name,
                ...(b.entra === 'password' &&
                (b.user === '' || b.user === sugerido) &&
                !persona?.user
                  ? { user: usuarioSugerido(name) }
                  : {}),
              })
            }}
          />
        </label>

        <Grupo etiqueta="Rol" className="flex flex-wrap items-center gap-2">
          <p className="w-full font-semibold">Rol</p>
          {opcionesRol.map((r) => (
            <Opcion key={r.id} elegida={b.rolId === r.id} alElegir={() => elegirRol(r)}>
              {r.active ? r.name : `${r.name} (archivado)`}
            </Opcion>
          ))}
        </Grupo>

        <Grupo etiqueta="Cómo entra" className="flex flex-col gap-2">
          <p className="font-semibold">Cómo entra</p>
          {!exigeContrasena && (
            <Opcion
              shape="card"
              elegida={b.entra === 'pin'}
              detalle="Meseros: desde su celular"
              alElegir={() => patch({ entra: 'pin' })}
            >
              Con su PIN
            </Opcion>
          )}
          <Opcion
            shape="card"
            elegida={b.entra === 'password'}
            detalle="Caja, administración y reportes"
            alElegir={() => patch({ entra: 'password', user: b.user || usuarioSugerido(b.name) })}
          >
            Con usuario y contraseña
          </Opcion>
          {exigeContrasena && (
            <p className="text-sm text-texto-suave">
              {`El rol ${rolElegido?.name} permite cobrar o administrar: se entra con usuario y contraseña.`}
            </p>
          )}
          {persona?.user && b.entra === 'pin' && (
            <p className="rounded-xl bg-alerta-suave p-3 text-alerta-texto">
              Al guardar se borran su usuario y su contraseña: desde entonces entra solo con su PIN.
            </p>
          )}
        </Grupo>

        {b.entra === 'password' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">Usuario</span>
              <input
                className={claseCampo}
                value={b.user}
                maxLength={40}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => patch({ user: e.target.value })}
                onBlur={() => patch({ user: normalizarUsuario(b.user) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">
                {persona?.user ? 'Contraseña nueva (opcional)' : 'Contraseña'}
              </span>
              <input
                className={claseCampo}
                type="password"
                value={b.password}
                maxLength={200}
                autoComplete="new-password"
                enterKeyHint="done"
                aria-describedby={idAyuda}
                onChange={(e) => patch({ password: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') guardar()
                }}
              />
              <span id={idAyuda} className="text-sm text-texto-suave">
                {persona?.user
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

        {persona?.active && !esUsted && confirmando === null && (
          <Boton variant="danger" className="mt-4" onClick={() => setConfirmando('archive')}>
            Archivar
          </Boton>
        )}
      </div>
    </PanelLateral>
  )
}

function PanelRol({
  role,
  esElSuyo,
  alCerrar,
  onSave,
}: {
  role: RolPersonal | null
  /** Si quien edita tiene este rol. */
  esElSuyo: boolean
  alCerrar: () => void
  onSave: (r: {
    id?: string
    name: string
    permissions: string[]
    active?: boolean
  }) => Promise<void>
}) {
  const [name, setNombre] = useState(role?.name ?? '')
  const [permissions, setPermisos] = useState<Set<string>>(() => new Set(role?.permissions ?? []))
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState<'archive' | 'exit' | 'lose' | null>(null)
  const sucio =
    name !== (role?.name ?? '') ||
    [...permissions].sort().join() !== [...(role?.permissions ?? [])].sort().join()

  const alternar = (p: string) =>
    setPermisos((current) => {
      const fresh = new Set(current)
      if (fresh.has(p)) fresh.delete(p)
      else fresh.add(p)
      return fresh
    })
  const hacer = async (active?: boolean) => {
    setOcupado(true)
    try {
      await onSave({
        ...(role ? { id: role.id } : {}),
        name: name.trim(),
        permissions: [...permissions],
        ...(active === undefined ? {} : { active }),
      })
    } catch (e) {
      setError(mensajeDe(e))
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }
  const guardar = () => {
    if (!name.trim()) {
      setError('Escribe el nombre del rol')
      setIntento((i) => i + 1)
      return
    }
    if (esElSuyo && !permissions.has('manage_users') && confirmando !== 'lose') {
      setConfirmando('lose')
      return
    }
    void hacer(role && !role.active ? true : undefined)
  }
  const close = () => (sucio && confirmando !== 'exit' ? setConfirmando('exit') : alCerrar())

  return (
    <PanelLateral
      opened
      titulo={role ? `Rol ${role.name}` : 'Rol nuevo'}
      alCerrar={close}
      pie={
        <div className="flex flex-col gap-2">
          <p key={intento} className="min-h-6 text-alerta-texto" role="alert">
            {error ?? ''}
          </p>
          {confirmando === 'exit' ? (
            <Confirmar
              pregunta="Hay cambios sin guardar. ¿Salir sin guardarlos?"
              yes="Salir sin guardar"
              ocupado={false}
              alConfirmar={alCerrar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'lose' ? (
            <Confirmar
              pregunta="Es tu rol: vas a perder el acceso a Personal y roles. Solo otra persona administradora te lo puede devolver."
              yes="Sí, guardar"
              ocupado={ocupado}
              alConfirmar={guardar}
              alCancelar={() => setConfirmando(null)}
            />
          ) : confirmando === 'archive' && role ? (
            <Confirmar
              pregunta={`Archivar el rol ${role.name}: ya no se podrá elegir para nadie.`}
              yes="Sí, archivar"
              ocupado={ocupado}
              alConfirmar={() => void hacer(false)}
              alCancelar={() => setConfirmando(null)}
            />
          ) : (
            <Boton variant="main" large disabled={ocupado} onClick={guardar}>
              {role && !role.active ? 'Volver a activar' : 'Guardar'}
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
            value={name}
            maxLength={60}
            disabled={role?.system}
            onChange={(e) => setNombre(e.target.value)}
          />
          {role?.system && (
            <span className="text-sm text-texto-suave">
              Es de fábrica: no se renombra ni se archiva, pero sus permisos sí se cambian.
            </span>
          )}
        </label>
        {role && role.people > 0 && (
          <p className="text-sm text-texto-suave">
            {`Los cambios valen para ${role.people === 1 ? 'la persona' : `las ${role.people} personas`} con este rol. Si ya están trabajando, deben volver a entrar para ver los botones nuevos.`}
          </p>
        )}
        <p className="text-sm text-texto-suave">
          Quien entra con PIN no puede tener permisos para cobrar, manejar la caja, editar la carta,
          ver reportes ni administrar. «Personal y roles» deja dar cualquier permiso: dáselo solo a
          alguien de toda confianza.
        </p>
        {PERMISSION_DESCRIPTIONS.map((g) => (
          <fieldset key={g.group} className="flex flex-col gap-1">
            <legend className="mb-1 font-semibold">{g.group}</legend>
            {g.permissions.map((p) => (
              <label key={p.permission} className="flex min-h-12 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-6"
                  checked={permissions.has(p.permission)}
                  onChange={() => alternar(p.permission)}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </fieldset>
        ))}
        {role && !role.system && role.active && confirmando === null && (
          <Boton variant="danger" className="mt-2" onClick={() => setConfirmando('archive')}>
            Archivar el rol
          </Boton>
        )}
      </div>
    </PanelLateral>
  )
}
