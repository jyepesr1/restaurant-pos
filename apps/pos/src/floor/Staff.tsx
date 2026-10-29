import { PERMISSION_DESCRIPTIONS } from '@pos/core'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../ui/Button'
import { Group, Option } from '../ui/Options'
import { SidePanel } from '../ui/SidePanel'
import { useNotify } from '../ui/toasts'
import { floor, useFloor } from './context'
import type { Staff as StaffData } from './engine'
import { FloorFrame } from './FloorFrame'
import {
  adminStaff,
  asksPassword,
  draftOf,
  issuesOf,
  normalizeUsername,
  roleSummary,
  type StaffDevice,
  type StaffMember,
  type StaffMemberDraft,
  type StaffRole,
  staffMemberData,
  suggestedUsername,
} from './people'
import { fieldClass } from './SignIn'

// Staff and roles (task 1.3b, ADR-013): the admin adds each person, decides how they sign in
// (PIN or username and password), what each role can do and which devices keep their
// access. The hub checks everything; here we warn before anything that cannot be undone.

type Tab = 'people' | 'roles' | 'devices'
const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'No se pudo guardar')

const DEVICE_TYPE: Record<string, string> = {
  waiter: 'Celular',
  register: 'Caja',
  kds: 'Pantalla de cocina',
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

export function Staff() {
  const { session, device } = useFloor()
  const notify = useNotify()
  const [data, setData] = useState<StaffData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('people')
  const [person, setPerson] = useState<StaffMember | 'new' | null>(null)
  const [role, setRole] = useState<StaffRole | 'new' | null>(null)
  const [newPin, setNewPin] = useState<{
    name: string
    pin: string
    authorizes: boolean
  } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const idPin = useId()
  const viewDevices = session?.permissions.includes('manage_devices') ?? false

  const read = useCallback(
    () =>
      floor
        .staff()
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e) => setError(messageOf(e))),
    [],
  )
  useEffect(() => {
    read()
  }, [read])

  const roles = data?.roles ?? []
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? 'Sin rol'
  const activePrinters = (data?.people ?? []).filter((p) => p.active)
  const archivedStaff = (data?.people ?? []).filter((p) => !p.active)
  const onlyOneManages = data !== null && adminStaff(data).length === 1

  const saveStaffMember = async (
    b: StaffMemberDraft,
    extras: Parameters<typeof staffMemberData>[1] = {},
  ) => {
    const r = await floor.saveStaffMember(staffMemberData(b, extras))
    await read()
    if (r.pin)
      setNewPin({ name: b.name.trim(), pin: r.pin, authorizes: b.signInMethod === 'password' })
    else
      notify(
        extras.active === false ? `Archivaste a ${b.name.trim()}` : `Guardaste a ${b.name.trim()}`,
      )
  }

  return (
    <FloorFrame title="Personal y roles" back="/">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <Group label="Qué ver" className="flex flex-wrap gap-2">
          <Option selected={tab === 'people'} onChoose={() => setTab('people')}>
            Personas
          </Option>
          <Option selected={tab === 'roles'} onChoose={() => setTab('roles')}>
            Roles
          </Option>
          {viewDevices && (
            <Option selected={tab === 'devices'} onChoose={() => setTab('devices')}>
              Equipos
            </Option>
          )}
        </Group>

        {error && (
          <p className="rounded-xl bg-alert-soft p-3 text-alert-text" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p className="text-muted">Cargando…</p>}
        {onlyOneManages && (
          <p className="rounded-xl bg-progress-soft p-3 text-progress-text">
            Solo una persona puede administrar el personal. Si olvida su contraseña, nadie más podrá
            entrar aquí: crea otra persona con el rol Administrador.
          </p>
        )}

        {data && tab === 'people' && (
          <section aria-label="Personas" className="flex flex-col gap-2">
            <Button variant="main" icon="more" onClick={() => setPerson('new')}>
              Persona nueva
            </Button>
            <ul className="flex flex-col gap-2">
              {activePrinters.map((p) => (
                <StaffMemberRow
                  key={p.id}
                  person={p}
                  role={roleName(p.roleId)}
                  isYou={p.id === session?.user.id}
                  noAccess={p.user === null && asksPassword(roles.find((r) => r.id === p.roleId))}
                  onTap={() => setPerson(p)}
                />
              ))}
            </ul>
            {archivedStaff.length > 0 && (
              <>
                <Button variant="ghost" onClick={() => setShowArchived(!showArchived)}>
                  {showArchived ? 'Ocultar archivadas' : `Ver archivadas (${archivedStaff.length})`}
                </Button>
                {showArchived && (
                  <ul className="flex flex-col gap-2 opacity-80">
                    {archivedStaff.map((p) => (
                      <StaffMemberRow
                        key={p.id}
                        person={p}
                        role={roleName(p.roleId)}
                        isYou={false}
                        noAccess={false}
                        onTap={() => setPerson(p)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}

        {data && tab === 'roles' && (
          <section aria-label="Roles" className="flex flex-col gap-2">
            <Button variant="main" icon="more" onClick={() => setRole('new')}>
              Rol nuevo
            </Button>
            <ul className="flex flex-col gap-2">
              {roles.map((r) => (
                <li key={r.id}>
                  <Row onTap={() => setRole(r)} off={!r.active}>
                    <span className="font-semibold">
                      {r.name}
                      {r.system && <span className="font-normal text-muted"> · de fábrica</span>}
                      {!r.active && <span className="font-normal text-muted"> · archivado</span>}
                    </span>
                    <span className="text-sm text-muted">
                      {`${roleSummary(r)}${asksPassword(r) ? ' · entra con contraseña' : ''}`}
                    </span>
                  </Row>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && tab === 'devices' && (
          <Devices
            devices={data.devices}
            own={device?.deviceId ?? null}
            onRemoveDevice={async (e) => {
              await floor.removeDevice(e.id)
              await read()
              notify(`Retiraste ${e.name}: ya no sincroniza ni se puede entrar en él`)
            }}
          />
        )}
      </div>

      {person && data && (
        <StaffMemberPanel
          person={person === 'new' ? null : person}
          data={data}
          isYou={person !== 'new' && person.id === session?.user.id}
          onClose={() => setPerson(null)}
          onSave={async (b, extras) => {
            await saveStaffMember(b, extras)
            setPerson(null)
          }}
        />
      )}

      {role && data && (
        <RolePanel
          role={role === 'new' ? null : role}
          isTheirs={
            role !== 'new' &&
            activePrinters.some((p) => p.id === session?.user.id && p.roleId === role.id)
          }
          onClose={() => setRole(null)}
          onSave={async (r) => {
            await floor.saveRole(r)
            await read()
            notify(
              r.active === false ? `Archivaste el rol ${r.name}` : `Guardaste el rol ${r.name}`,
            )
            setRole(null)
          }}
        />
      )}

      {/* The PIN is shown only once: the panel only closes with «Ya lo anoté». */}
      <SidePanel
        opened={newPin !== null}
        title={newPin ? `PIN de ${newPin.name}` : 'PIN'}
        onClose={() => setNewPin(null)}
        onlyWithButton
        descriptionId={idPin}
        footer={
          <Button variant="main" large className="w-full" onClick={() => setNewPin(null)}>
            Ya lo anoté
          </Button>
        }
      >
        {newPin && (
          <div className="flex flex-col items-center gap-4 text-center">
            <p id={idPin} className="flex flex-col items-center gap-4">
              <span className="font-heading rounded-2xl bg-surface-2 px-6 py-4 text-5xl tracking-[0.3em]">
                {newPin.pin}
              </span>
              <span>
                {newPin.authorizes
                  ? `Con este PIN, ${newPin.name} aprueba anulaciones y descuentos desde el celular de un mesero. Para entrar usa su usuario y contraseña.`
                  : `Con este PIN, ${newPin.name} entra desde su celular.`}
              </span>
            </p>
            <p className="text-muted">
              Dáselo en persona. No se vuelve a mostrar: si se pierde, toca «Nuevo PIN».
            </p>
          </div>
        )}
      </SidePanel>
    </FloorFrame>
  )
}

function Row({
  onTap,
  off = false,
  children,
}: {
  onTap: () => void
  off?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-2 text-left hover:bg-surface-2 focus-visible:outline-3 focus-visible:outline-focus ${off ? 'opacity-70' : ''}`}
    >
      <span className="flex flex-col">{children}</span>
      <span className="text-muted" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

function StaffMemberRow({
  person: p,
  role,
  isYou,
  noAccess,
  onTap,
}: {
  person: StaffMember
  role: string
  isYou: boolean
  /** Signs in with a PIN but the role requires a password: cannot sign in today (an older database). */
  noAccess: boolean
  onTap: () => void
}) {
  return (
    <li>
      <Row onTap={onTap}>
        <span className="font-semibold">
          {p.name}
          {isYou && <span className="font-normal text-muted"> · tú</span>}
        </span>
        <span className="text-sm text-muted">
          {[
            role,
            p.user ? `usuario ${p.user}` : 'entra con PIN',
            ...(p.active ? [] : ['archivada']),
          ].join(' · ')}
        </span>
        {noAccess && (
          <span className="text-sm font-semibold text-alert-text">
            No puede entrar: su rol pide usuario y contraseña
          </span>
        )}
      </Row>
    </li>
  )
}

/** A question before something that cannot be undone, inside the panel. */
export function Confirm({
  question,
  yes,
  onConfirm,
  onCancel,
  taken,
}: {
  question: string
  yes: string
  onConfirm: () => void
  onCancel: () => void
  taken: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-alert-soft p-3" role="alertdialog">
      <p className="text-alert-text">{question}</p>
      <div className="flex gap-2">
        <Button variant="danger" className="flex-1" disabled={taken} onClick={onConfirm}>
          {yes}
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          No
        </Button>
      </div>
    </div>
  )
}

function Devices({
  devices,
  own,
  onRemoveDevice,
}: {
  devices: StaffDevice[]
  own: string | null
  onRemoveDevice: (e: StaffDevice) => Promise<void>
}) {
  const [removing, setRemoving] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <section aria-label="Equipos" className="flex flex-col gap-2">
      <p className="text-muted">
        Cada celular, tablet o computador queda aquí la primera vez que alguien entra en él. Si se
        pierde o se lo roban, retíralo: deja de recibir el salón y nadie puede entrar en él.
      </p>
      {error && (
        <p className="text-alert-text" role="alert">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {devices.map((e) => (
          <li
            key={e.id}
            className={`flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3 ${e.revokedAt ? 'opacity-70' : ''}`}
          >
            <span className="font-semibold">
              {e.name}
              <span className="font-normal text-muted">{` · ${DEVICE_TYPE[e.type] ?? e.type}`}</span>
              {e.id === own && <span className="font-normal text-muted"> · este</span>}
            </span>
            <span className="text-sm text-muted">
              {e.revokedAt
                ? `Retirado el ${when(e.revokedAt)}`
                : e.lastUsed
                  ? `Último uso: ${e.lastPerson ?? 'alguien'}, ${when(e.lastUsed)}`
                  : 'Sin uso todavía'}
            </span>
            {!e.revokedAt &&
              e.id !== own &&
              (removing === e.id ? (
                <Confirm
                  question={`Retirar ${e.name}: deja de sincronizar y nadie puede entrar en él. Lo que no haya enviado lo revisa un administrador.`}
                  yes="Sí, retirar"
                  taken={taken}
                  onCancel={() => setRemoving(null)}
                  onConfirm={async () => {
                    setTaken(true)
                    try {
                      await onRemoveDevice(e)
                      setRemoving(null)
                      setError(null)
                    } catch (x) {
                      setError(messageOf(x))
                    }
                    setTaken(false)
                  }}
                />
              ) : (
                <Button variant="secondary" onClick={() => setRemoving(e.id)}>
                  Retirar
                </Button>
              ))}
          </li>
        ))}
        {devices.length === 0 && <li className="text-muted">Todavía no hay equipos.</li>}
      </ul>
    </section>
  )
}

function StaffMemberPanel({
  person,
  data,
  isYou,
  onClose,
  onSave,
}: {
  person: StaffMember | null
  data: StaffData
  isYou: boolean
  onClose: () => void
  onSave: (
    b: StaffMemberDraft,
    extras?: { active?: boolean; regeneratePin?: boolean },
  ) => Promise<void>
}) {
  // Someone's archived role is shown too, marked: otherwise none would appear selected.
  const roleOptions = data.roles.filter((r) => r.active || r.id === person?.roleId)
  const waiter = data.roles.find((r) => r.active && r.system && r.name === 'Mesero')
  const [initial] = useState<StaffMemberDraft>(() =>
    draftOf(person, waiter?.id ?? roleOptions[0]?.id ?? ''),
  )
  const [b, setB] = useState<StaffMemberDraft>(initial)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [taken, setTaken] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'exit' | 'lose' | null>(null)
  const helpId = useId()
  const patch = (partial: Partial<StaffMemberDraft>) => setB((x) => ({ ...x, ...partial }))
  const issues = issuesOf(b, person, data.people, data.roles)
  const selectedRole = data.roles.find((r) => r.id === b.roleId)
  const requiresPassword = asksPassword(selectedRole)
  const dirty = JSON.stringify(b) !== JSON.stringify(initial)
  const losesManage = isYou && !selectedRole?.permissions.includes('manage_users')
  const changesSignInMethod =
    person !== null &&
    (b.roleId !== person.roleId ||
      (b.signInMethod === 'pin') !== (person.user === null) ||
      b.password.length > 0)

  const act = async (extras?: { active?: boolean; regeneratePin?: boolean }) => {
    setTaken(true)
    try {
      await onSave(b, extras)
    } catch (e) {
      setError(messageOf(e))
      setAttempt((i) => i + 1)
      setTaken(false)
    }
  }
  const save = () => {
    if (issues.length > 0) {
      setError(issues.join('. '))
      setAttempt((i) => i + 1)
      return
    }
    if (losesManage && confirming !== 'lose') {
      setConfirming('lose')
      return
    }
    void act(person && !person.active ? { active: true } : {})
  }
  const close = () => (dirty && confirming !== 'exit' ? setConfirming('exit') : onClose())
  const selectRole = (r: StaffRole) =>
    patch({
      roleId: r.id,
      ...(asksPassword(r) && b.signInMethod === 'pin'
        ? { signInMethod: 'password', user: b.user || suggestedUsername(b.name) }
        : {}),
    })

  return (
    <SidePanel
      opened
      title={person ? person.name : 'Persona nueva'}
      onClose={close}
      footer={
        <div className="flex flex-col gap-2">
          <p key={attempt} className="min-h-6 text-alert-text" role="alert">
            {error ?? ''}
          </p>
          {confirming === 'exit' ? (
            <Confirm
              question="Hay cambios sin guardar. ¿Salir sin guardarlos?"
              yes="Salir sin guardar"
              taken={false}
              onConfirm={onClose}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === 'lose' ? (
            <Confirm
              question="Vas a perder el acceso a Personal y roles. Solo otra persona administradora te lo puede devolver."
              yes="Sí, guardar"
              taken={taken}
              onConfirm={save}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === 'archive' && person ? (
            <Confirm
              question={`Archivar a ${person.name}: no podrá entrar hasta que la actives de nuevo.`}
              yes="Sí, archivar"
              taken={taken}
              onConfirm={() => void act({ active: false })}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <>
              <Button variant="main" large disabled={taken} onClick={save}>
                {person && !person.active ? 'Volver a activar' : 'Guardar'}
              </Button>
              {person?.active && (
                <Button disabled={taken} onClick={() => void act({ regeneratePin: true })}>
                  Nuevo PIN
                </Button>
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
            className={fieldClass}
            value={b.name}
            maxLength={60}
            onChange={(e) => {
              const name = e.target.value
              // Until a custom username has been typed, one is suggested from the name.
              const suggested = suggestedUsername(b.name)
              patch({
                name,
                ...(b.signInMethod === 'password' &&
                (b.user === '' || b.user === suggested) &&
                !person?.user
                  ? { user: suggestedUsername(name) }
                  : {}),
              })
            }}
          />
        </label>

        <Group label="Rol" className="flex flex-wrap items-center gap-2">
          <p className="w-full font-semibold">Rol</p>
          {roleOptions.map((r) => (
            <Option key={r.id} selected={b.roleId === r.id} onChoose={() => selectRole(r)}>
              {r.active ? r.name : `${r.name} (archivado)`}
            </Option>
          ))}
        </Group>

        <Group label="Cómo entra" className="flex flex-col gap-2">
          <p className="font-semibold">Cómo entra</p>
          {!requiresPassword && (
            <Option
              shape="card"
              selected={b.signInMethod === 'pin'}
              detail="Meseros: desde su celular"
              onChoose={() => patch({ signInMethod: 'pin' })}
            >
              Con su PIN
            </Option>
          )}
          <Option
            shape="card"
            selected={b.signInMethod === 'password'}
            detail="Caja, administración y reportes"
            onChoose={() =>
              patch({ signInMethod: 'password', user: b.user || suggestedUsername(b.name) })
            }
          >
            Con usuario y contraseña
          </Option>
          {requiresPassword && (
            <p className="text-sm text-muted">
              {`El rol ${selectedRole?.name} permite cobrar o administrar: se entra con usuario y contraseña.`}
            </p>
          )}
          {person?.user && b.signInMethod === 'pin' && (
            <p className="rounded-xl bg-alert-soft p-3 text-alert-text">
              Al guardar se borran su usuario y su contraseña: desde entonces entra solo con su PIN.
            </p>
          )}
        </Group>

        {b.signInMethod === 'password' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">Usuario</span>
              <input
                className={fieldClass}
                value={b.user}
                maxLength={40}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => patch({ user: e.target.value })}
                onBlur={() => patch({ user: normalizeUsername(b.user) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">
                {person?.user ? 'Contraseña nueva (opcional)' : 'Contraseña'}
              </span>
              <input
                className={fieldClass}
                type="password"
                value={b.password}
                maxLength={200}
                autoComplete="new-password"
                enterKeyHint="done"
                aria-describedby={helpId}
                onChange={(e) => patch({ password: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save()
                }}
              />
              <span id={helpId} className="text-sm text-muted">
                {person?.user
                  ? 'Déjala vacía para no cambiarla. Si escribes una, al menos 8 caracteres.'
                  : 'Al menos 8 caracteres. Dásela en persona.'}
              </span>
            </label>
            <p className="text-sm text-muted">
              Su PIN no le sirve para entrar: con él aprueba anulaciones y descuentos desde el
              celular de un mesero.
            </p>
          </>
        )}
        {changesSignInMethod && (
          <p className="text-sm text-muted">
            {isYou
              ? 'Al guardar tendrás que volver a entrar.'
              : 'Si está trabajando, al guardar tendrá que volver a entrar.'}
          </p>
        )}

        {person?.active && !isYou && confirming === null && (
          <Button variant="danger" className="mt-4" onClick={() => setConfirming('archive')}>
            Archivar
          </Button>
        )}
      </div>
    </SidePanel>
  )
}

function RolePanel({
  role,
  isTheirs,
  onClose,
  onSave,
}: {
  role: StaffRole | null
  /** Whether the editor has this role. */
  isTheirs: boolean
  onClose: () => void
  onSave: (r: {
    id?: string
    name: string
    permissions: string[]
    active?: boolean
  }) => Promise<void>
}) {
  const [name, setName] = useState(role?.name ?? '')
  const [permissions, setPermissions] = useState<Set<string>>(
    () => new Set(role?.permissions ?? []),
  )
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [taken, setTaken] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'exit' | 'lose' | null>(null)
  const dirty =
    name !== (role?.name ?? '') ||
    [...permissions].sort().join() !== [...(role?.permissions ?? [])].sort().join()

  const toggle = (p: string) =>
    setPermissions((current) => {
      const fresh = new Set(current)
      if (fresh.has(p)) fresh.delete(p)
      else fresh.add(p)
      return fresh
    })
  const act = async (active?: boolean) => {
    setTaken(true)
    try {
      await onSave({
        ...(role ? { id: role.id } : {}),
        name: name.trim(),
        permissions: [...permissions],
        ...(active === undefined ? {} : { active }),
      })
    } catch (e) {
      setError(messageOf(e))
      setAttempt((i) => i + 1)
      setTaken(false)
    }
  }
  const save = () => {
    if (!name.trim()) {
      setError('Escribe el nombre del rol')
      setAttempt((i) => i + 1)
      return
    }
    if (isTheirs && !permissions.has('manage_users') && confirming !== 'lose') {
      setConfirming('lose')
      return
    }
    void act(role && !role.active ? true : undefined)
  }
  const close = () => (dirty && confirming !== 'exit' ? setConfirming('exit') : onClose())

  return (
    <SidePanel
      opened
      title={role ? `Rol ${role.name}` : 'Rol nuevo'}
      onClose={close}
      footer={
        <div className="flex flex-col gap-2">
          <p key={attempt} className="min-h-6 text-alert-text" role="alert">
            {error ?? ''}
          </p>
          {confirming === 'exit' ? (
            <Confirm
              question="Hay cambios sin guardar. ¿Salir sin guardarlos?"
              yes="Salir sin guardar"
              taken={false}
              onConfirm={onClose}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === 'lose' ? (
            <Confirm
              question="Es tu rol: vas a perder el acceso a Personal y roles. Solo otra persona administradora te lo puede devolver."
              yes="Sí, guardar"
              taken={taken}
              onConfirm={save}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === 'archive' && role ? (
            <Confirm
              question={`Archivar el rol ${role.name}: ya no se podrá elegir para nadie.`}
              yes="Sí, archivar"
              taken={taken}
              onConfirm={() => void act(false)}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <Button variant="main" large disabled={taken} onClick={save}>
              {role && !role.active ? 'Volver a activar' : 'Guardar'}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Nombre</span>
          <input
            className={fieldClass}
            value={name}
            maxLength={60}
            disabled={role?.system}
            onChange={(e) => setName(e.target.value)}
          />
          {role?.system && (
            <span className="text-sm text-muted">
              Es de fábrica: no se renombra ni se archiva, pero sus permisos sí se cambian.
            </span>
          )}
        </label>
        {role && role.people > 0 && (
          <p className="text-sm text-muted">
            {`Los cambios valen para ${role.people === 1 ? 'la persona' : `las ${role.people} personas`} con este rol. Si ya están trabajando, deben volver a entrar para ver los botones nuevos.`}
          </p>
        )}
        <p className="text-sm text-muted">
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
                  onChange={() => toggle(p.permission)}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </fieldset>
        ))}
        {role && !role.system && role.active && confirming === null && (
          <Button variant="danger" className="mt-2" onClick={() => setConfirming('archive')}>
            Archivar el rol
          </Button>
        )}
      </div>
    </SidePanel>
  )
}
