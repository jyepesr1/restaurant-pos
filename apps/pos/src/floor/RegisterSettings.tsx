import { METHOD_NAME, type PaymentMethod, type PrintLogo } from '@pos/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { pesos } from '../ui/format'
import { Icon } from '../ui/icons'
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
import { blackShare, logoFromFile, logoPreview } from './logo'
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
  const [testingDrawer, setTestingDrawer] = useState(false)

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

  // With its printer archived the hub does not open it: shown as no drawer.
  const drawer = printers.find((i) => i.id === kitchen.cash_drawer_printer_id)?.id ?? null
  const archivedDrawer =
    drawer === null && kitchen.cash_drawer_printer_id
      ? kitchen.printers.find((i) => i.id === kitchen.cash_drawer_printer_id)
      : undefined
  const selectDrawer = async (id: string | null) => {
    try {
      await floor.cashDrawerPrinter(id)
      notify(id ? 'El cajón se abrirá solo al mover efectivo' : 'Sin cajón monedero')
      load()
    } catch (e) {
      notify(message(e))
    }
  }
  const testDrawer = async () => {
    setTestingDrawer(true)
    try {
      await floor.testCashDrawer()
      notify('Se envió la señal. Si el cajón no se abre, revisa su cable a la impresora.')
    } catch (e) {
      notify(message(e))
    } finally {
      setTestingDrawer(false)
    }
  }
  const printerDetail = (i: (typeof printers)[number]) =>
    i.connection === 'network' ? i.address : `USB · ${i.address}`

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
                detail={printerDetail(i)}
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
          <PreBillHeader
            printed={selected !== null}
            header={kitchen.pre_bill_header ?? 'name'}
            logo={kitchen.print_logo ?? null}
            onSaved={load}
          />
        </section>

        <section aria-labelledby="title-drawer" className="flex flex-col gap-3">
          <h2 id="title-drawer" className="text-xl font-bold tracking-tight">
            Cajón monedero
          </h2>
          <p className="text-muted">
            A qué impresora va conectado con su cable. Se abre solo al cobrar o devolver en efectivo
            y al registrar una entrada o salida de caja.
          </p>
          {archivedDrawer && (
            <Label tone="progress" icon="warning">
              {`El cajón estaba conectado a «${archivedDrawer.name}», que está archivada: elige otra impresora o «Sin cajón»`}
            </Label>
          )}
          <Group label="Cajón monedero" className="flex flex-col gap-2">
            <Option shape="card" selected={drawer === null} onChoose={() => selectDrawer(null)}>
              Sin cajón
            </Option>
            {printers.map((i) => (
              <Option
                key={i.id}
                shape="card"
                selected={drawer === i.id}
                onChoose={() => selectDrawer(i.id)}
                detail={printerDetail(i)}
              >
                {`Conectado a ${i.name}`}
              </Option>
            ))}
          </Group>
          {printers.length === 0 && (
            <p className="text-sm text-muted">
              Agrega la impresora en «Cocina e impresoras» y luego elígela aquí.
            </p>
          )}
          {drawer !== null && (
            <Button className="self-start" disabled={testingDrawer} onClick={testDrawer}>
              {testingDrawer ? 'Probando…' : 'Probar el cajón'}
            </Button>
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

/**
 * The top of the printed pre-bill: the restaurant's name or its logo. The logo is converted to
 * black and white here, at the size it prints, and the preview is exactly what comes out. Without
 * a pre-bill printer it is shown but cannot be chosen: it only applies to paper.
 */
function PreBillHeader({
  printed,
  header,
  logo,
  onSaved,
}: {
  printed: boolean
  header: 'name' | 'logo'
  logo: PrintLogo | null
  onSaved: () => void
}) {
  const notify = useNotify()
  const entry = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'converting' | 'saving' | null>(null)
  const preview = useMemo(() => (logo ? logoPreview(logo) : null), [logo])
  const share = useMemo(() => (logo ? blackShare(logo) : null), [logo])
  const save = async (
    h: 'name' | 'logo',
    l: PrintLogo | null,
    text: string,
    undo?: () => Promise<void>,
  ) => {
    setBusy('saving')
    try {
      await floor.preBillHeader(h, l)
      notify(text, undo && (() => void undo()))
      onSaved()
    } catch (e) {
      notify(message(e))
    } finally {
      setBusy(null)
    }
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    setBusy('converting')
    let converted: PrintLogo
    try {
      converted = await logoFromFile(file)
    } catch {
      setBusy(null)
      notify('No pudimos leer esa imagen. Prueba con una foto en JPG o PNG.')
      return
    }
    await save('logo', converted, 'La precuenta saldrá con el logo')
  }
  const choose = (h: 'name' | 'logo') => {
    if (h === header || !logo) return
    const before = header
    void save(
      h,
      logo,
      h === 'logo' ? 'La precuenta saldrá con el logo' : 'La precuenta saldrá con el nombre',
      () => save(before, logo, 'Volvió como estaba'),
    )
  }
  const locked = busy !== null
  return (
    <div className="mt-2 flex flex-col gap-3">
      <h3 className="font-semibold">Qué sale arriba de la precuenta</h3>
      {!printed && (
        <p id="header-without-printer" className="text-sm text-muted">
          Solo se usa si la precuenta sale impresa. Elige una impresora arriba.
        </p>
      )}
      <Group label="Qué sale arriba de la precuenta" className="flex flex-wrap gap-2">
        <Option
          selected={header === 'name'}
          disabled={!printed || locked}
          describedBy={printed ? undefined : 'header-without-printer'}
          onChoose={() => choose('name')}
        >
          Nombre del restaurante
        </Option>
        <Option
          selected={header === 'logo'}
          disabled={!printed || !logo || locked}
          describedBy={
            !printed ? 'header-without-printer' : logo ? undefined : 'header-without-logo'
          }
          onChoose={() => choose('logo')}
        >
          Logo
        </Option>
      </Group>
      {printed && !logo && (
        <p id="header-without-logo" className="text-sm text-muted">
          Sube un logo para elegirlo.
        </p>
      )}
      {logo && preview && (
        <figure className="flex flex-col items-start gap-2">
          <div className="max-w-full rounded-lg border border-border bg-white p-3">
            <img
              src={preview}
              alt="Vista previa del logo en blanco y negro, como sale impreso"
              width={logo.width}
              height={logo.height}
              className="block h-auto max-w-full [image-rendering:pixelated]"
            />
          </div>
          <figcaption className="text-sm text-muted">
            Así sale en el papel: la impresora solo imprime negro.
          </figcaption>
        </figure>
      )}
      {share !== null && (share > 0.55 || share < 0.01) && (
        <p className="flex items-start gap-2 rounded-xl bg-progress-soft p-3 text-progress-text">
          <Icon name="warning" className="mt-0.5 size-5 shrink-0" />
          {share > 0.55
            ? 'Quedó casi todo negro. Si el logo tiene fondo oscuro, usa una versión con fondo claro.'
            : 'Casi no se ve nada: el logo es muy claro para el papel. Usa una versión de colores oscuros.'}
        </p>
      )}
      <p className="text-sm text-muted">
        Usa un logo de colores sólidos, con fondo claro o transparente. Lo pasamos a blanco y negro,
        como sale en el papel.
      </p>
      <p aria-live="polite" className="text-sm text-muted">
        {busy === 'converting' ? 'Preparando el logo…' : busy === 'saving' ? 'Guardando…' : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button icon="photo" disabled={locked} onClick={() => entry.current?.click()}>
          {logo ? 'Cambiar el logo' : 'Subir el logo'}
        </Button>
        {logo && (
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() =>
              void save('name', null, 'Quitaste el logo: la precuenta sale con el nombre', () =>
                save(header, logo, 'Recuperaste el logo'),
              )
            }
          >
            Quitar el logo
          </Button>
        )}
      </div>
      <input
        ref={entry}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
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
