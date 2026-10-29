import { METHOD_NAME, type PaymentMethod } from '@pos/core'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { pesos } from '../ui/format'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { SidePanel } from '../ui/SidePanel'
import { useNotify } from '../ui/toasts'
import { floor } from './context'
import type {
  CardTerminal,
  CardTerminalProvider,
  CustomMethod,
  KitchenConfig,
  RegisterConfig,
} from './engine'
import { FloorFrame } from './FloorFrame'
import { fieldClass } from './SignIn'

// «Caja y pagos» (task 1.6): which payment methods the restaurant accepts, where the pre-bill
// prints and its card terminals. For whoever manages the devices; each restaurant decides its own.

const METHODS: PaymentMethod[] = [
  'cash',
  'card',
  'nequi',
  'daviplata',
  'breb',
  'transfer',
  'voucher',
]

const PROVIDERS: { value: CardTerminalProvider; name: string }[] = [
  { value: 'bold', name: 'Bold' },
  { value: 'redeban', name: 'Redeban' },
  { value: 'credibanco', name: 'Credibanco' },
  { value: 'other', name: 'Otro' },
]

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function RegisterSettings() {
  const notify = useNotify()
  const [register, setRegister] = useState<RegisterConfig | null>(null)
  const [kitchen, setKitchen] = useState<KitchenConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<CardTerminal | null>(null)
  const [editingMethod, setEditingMethod] = useState<CustomMethod | null>(null)

  const load = useCallback(() => {
    Promise.all([floor.registerConfig(), floor.kitchenConfig()])
      .then(([c, k]) => {
        setRegister(c)
        setKitchen(k)
        setError(null)
      })
      .catch((e) => setError(message(e)))
  }, [])
  useEffect(load, [load])

  if (error && !register)
    return (
      <FloorFrame title="Caja y pagos">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 p-6">
          <p className="text-alert-text">{error}</p>
          <Button onClick={load}>Intentar de nuevo</Button>
        </div>
      </FloorFrame>
    )
  if (!register || !kitchen)
    return (
      <FloorFrame title="Caja y pagos">
        <p className="p-6 text-muted">Leyendo la configuración de la caja…</p>
      </FloorFrame>
    )

  const changeMethod = async (m: PaymentMethod) => {
    const methods = register.payment_methods.includes(m)
      ? register.payment_methods.filter((x) => x !== m)
      : METHODS.filter((x) => x === m || register.payment_methods.includes(x))
    try {
      await floor.savePaymentMethods(methods)
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const changeThreshold = async (v: number) => {
    try {
      await floor.varianceThreshold(v)
      notify(v === 0 ? 'Toda diferencia se justifica' : `Se justifica desde ${pesos(v)}`)
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const changeTip = async (points: number) => {
    try {
      await floor.suggestedTip(points)
      notify(points === 0 ? 'Sin propina sugerida' : `Propina sugerida: ${points / 100} %`)
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const printers = kitchen.printers.filter((i) => i.active)
  const selected = kitchen.pre_bill_printer_id ?? null
  const selectPrinter = async (id: string | null) => {
    try {
      await floor.preBillPrinter(id)
      notify(id ? 'La precuenta saldrá impresa' : 'La precuenta solo se verá en pantalla')
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const saveMethod = async (m: CustomMethod) => {
    try {
      const custom_methods = await floor.saveCustomMethod(m)
      setRegister({ ...register, custom_methods })
      setEditingMethod(null)
      notify(m.active ? `Guardaste ${m.name}` : `Archivaste ${m.name}`)
    } catch (e) {
      notify(message(e))
    }
  }

  const saveCardTerminal = async (d: CardTerminal) => {
    try {
      const cardTerminals = await floor.saveCardTerminal(d)
      setRegister({ ...register, cardTerminals })
      setEditing(null)
      notify(d.active ? `Guardaste ${d.name}` : `Archivaste ${d.name}`)
    } catch (e) {
      notify(message(e))
    }
  }

  return (
    <FloorFrame title="Caja y pagos">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 p-3 md:p-5">
        <section aria-labelledby="title-methods" className="flex flex-col gap-3">
          <h2 id="title-methods" className="text-xl font-bold tracking-tight">
            Medios de pago
          </h2>
          <p className="text-muted">Los que salen al cobrar. El efectivo siempre está.</p>
          <Group label="Medios de pago" className="flex flex-wrap gap-2">
            {METHODS.map((m) => (
              <Option
                key={m}
                selected={register.payment_methods.includes(m)}
                onChoose={() => m !== 'cash' && changeMethod(m)}
                label={m === 'cash' ? 'Efectivo: siempre se recibe' : undefined}
              >
                {m === 'cash'
                  ? 'Efectivo (siempre)'
                  : m === 'card'
                    ? 'Tarjeta crédito y débito'
                    : METHOD_NAME[m]}
              </Option>
            ))}
          </Group>
          <div className="mt-2 flex items-center justify-between gap-2">
            <h3 className="font-semibold">Medios propios</h3>
            <Button icon="more" onClick={() => setEditingMethod({ name: '', active: true })}>
              Agregar
            </Button>
          </div>
          <p className="text-sm text-muted">
            Los que recibe este restaurante con su nombre: Sodexo, QR Bancolombia, Rappi…
          </p>
          <ul className="flex flex-col gap-2">
            {register.custom_methods.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setEditingMethod(m)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-divider bg-surface px-4 text-left hover:border-border focus-visible:outline-3 focus-visible:outline-focus"
                >
                  <span className="flex-1 font-semibold">{m.name}</span>
                  {!m.active && <Label tone="neutral">Archivado</Label>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="title-tip" className="flex flex-col gap-3">
          <h2 id="title-tip" className="text-xl font-bold tracking-tight">
            Propina sugerida
          </h2>
          <p className="text-muted">
            La que sale en la precuenta y aparece marcada al cobrar, sobre la base sin impuestos. Es
            voluntaria: el cajero la quita o la cambia en cada cobro.
          </p>
          <Group label="Propina sugerida" className="flex flex-wrap gap-2">
            {[0, 500, 800, 1000].map((p) => (
              <Option key={p} selected={register.suggested_tip === p} onChoose={() => changeTip(p)}>
                {p === 0 ? 'Sin propina' : `${p / 100} %`}
              </Option>
            ))}
          </Group>
        </section>

        <section aria-labelledby="title-threshold" className="flex flex-col gap-3">
          <h2 id="title-threshold" className="text-xl font-bold tracking-tight">
            Cierre de caja
          </h2>
          <p className="text-muted">
            Desde qué diferencia (sobrante o faltante) el cajero debe explicar por qué no cuadra.
          </p>
          <Group label="Justificar desde" className="flex flex-wrap gap-2">
            {[0, 1000, 5000, 10_000].map((v) => (
              <Option
                key={v}
                selected={(register.register_variance_threshold ?? 1000) === v}
                onChoose={() => changeThreshold(v)}
              >
                {v === 0 ? 'Cualquier diferencia' : `Desde ${pesos(v)}`}
              </Option>
            ))}
          </Group>
        </section>

        <section aria-labelledby="title-pre-bill" className="flex flex-col gap-3">
          <h2 id="title-pre-bill" className="text-xl font-bold tracking-tight">
            Impresora de precuentas
          </h2>
          <p className="text-muted">
            Dónde sale la precuenta que pide el mesero o la caja. Sin impresora, se muestra en la
            pantalla.
          </p>
          <Group label="Impresora de precuentas" className="flex flex-col gap-2">
            <Option shape="card" selected={selected === null} onChoose={() => selectPrinter(null)}>
              Solo en pantalla
            </Option>
            {printers.map((i) => (
              <Option
                key={i.id}
                shape="card"
                selected={selected === i.id}
                onChoose={() => selectPrinter(i.id)}
                detail={i.connection === 'network' ? i.address : 'USB'}
              >
                {i.name}
              </Option>
            ))}
          </Group>
          {printers.length === 0 && (
            <p className="text-sm text-muted">
              Agrega la impresora en «Cocina e impresoras» y luego elígela aquí.
            </p>
          )}
        </section>

        <section aria-labelledby="title-card-terminals" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="title-card-terminals" className="text-xl font-bold tracking-tight">
              Datáfonos
            </h2>
            <Button
              icon="more"
              onClick={() => setEditing({ name: '', provider: 'bold', active: true })}
            >
              Agregar
            </Button>
          </div>
          <p className="text-muted">
            Los de un mismo proveedor entregan un solo cierre: al cobrar no se pregunta en cuál se
            pasó la tarjeta. Si hay de proveedores distintos (Bold y Redeban), se elige el
            proveedor.
          </p>
          <ul className="flex flex-col gap-2">
            {register.cardTerminals.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setEditing(d)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-divider bg-surface px-4 text-left hover:border-border focus-visible:outline-3 focus-visible:outline-focus"
                >
                  <span className="flex-1 font-semibold">{d.name}</span>
                  <span className="text-muted">
                    {PROVIDERS.find((p) => p.value === d.provider)?.name}
                  </span>
                  {!d.active && <Label tone="neutral">Archivado</Label>}
                </button>
              </li>
            ))}
            {register.cardTerminals.length === 0 && (
              <li className="text-muted">
                Sin datáfonos: no se puede cobrar con tarjeta hasta agregar uno.
              </li>
            )}
          </ul>
        </section>
      </div>

      <EditMethod
        key={editingMethod?.id ?? (editingMethod ? 'new' : 'closed')}
        method={editingMethod}
        onClose={() => setEditingMethod(null)}
        onSave={saveMethod}
      />
      <EditCardTerminal
        key={editing?.id ?? (editing ? 'new' : 'closed')}
        cardTerminal={editing}
        onClose={() => setEditing(null)}
        onSave={saveCardTerminal}
      />
    </FloorFrame>
  )
}

function EditCardTerminal({
  cardTerminal,
  onClose,
  onSave,
}: {
  cardTerminal: CardTerminal | null
  onClose: () => void
  onSave: (d: CardTerminal) => void
}) {
  const [name, setName] = useState(cardTerminal?.name ?? '')
  const [provider, setProvider] = useState<CardTerminalProvider>(cardTerminal?.provider ?? 'bold')
  const valid = name.trim().length > 0
  const save = (active: boolean) =>
    cardTerminal && onSave({ ...cardTerminal, name: name.trim(), provider, active })
  return (
    <SidePanel
      opened={cardTerminal !== null}
      title={cardTerminal?.id ? 'Datáfono' : 'Datáfono nuevo'}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="main" large disabled={!valid} onClick={() => save(true)}>
            {cardTerminal?.id && !cardTerminal.active ? 'Volver a usarlo' : 'Guardar'}
          </Button>
          {cardTerminal?.id && cardTerminal.active && (
            <Button variant="ghost" onClick={() => save(false)}>
              Archivar
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label>
          <span className="font-semibold">Nombre</span>
          <input
            className={`${fieldClass} mt-1`}
            maxLength={60}
            value={name}
            placeholder="Bold de la barra"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Group label="Proveedor" className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <Option
              key={p.value}
              selected={provider === p.value}
              onChoose={() => setProvider(p.value)}
            >
              {p.name}
            </Option>
          ))}
        </Group>
      </div>
    </SidePanel>
  )
}

function EditMethod({
  method,
  onClose,
  onSave,
}: {
  method: CustomMethod | null
  onClose: () => void
  onSave: (m: CustomMethod) => void
}) {
  const [name, setName] = useState(method?.name ?? '')
  const valid = name.trim().length > 0
  const save = (active: boolean) => method && onSave({ ...method, name: name.trim(), active })
  return (
    <SidePanel
      opened={method !== null}
      title={method?.id ? 'Medio de pago' : 'Medio de pago nuevo'}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="main" large disabled={!valid} onClick={() => save(true)}>
            {method?.id && !method.active ? 'Volver a usarlo' : 'Guardar'}
          </Button>
          {method?.id && method.active && (
            <Button variant="ghost" onClick={() => save(false)}>
              Archivar
            </Button>
          )}
        </div>
      }
    >
      <label>
        <span className="font-semibold">Nombre</span>
        <input
          className={`${fieldClass} mt-1`}
          maxLength={30}
          value={name}
          placeholder="Sodexo"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
    </SidePanel>
  )
}
