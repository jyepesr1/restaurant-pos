import type { MenuGroup, MenuProduct } from '@pos/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { pesos } from '../ui/format'
import { Icon } from '../ui/icons'
import { Group, Option } from '../ui/Options'
import { navigate } from '../ui/route'
import { SidePanel } from '../ui/SidePanel'
import { search } from '../ui/search'
import { useNotify } from '../ui/toasts'
import { lineNet } from './check'
import {
  menu,
  newItemId,
  type OrderItem,
  products,
  searchText,
  type Table,
  VOID_REASONS,
} from './data'
import { Frame } from './Frame'
import { changeTable, useRouteTable, useTables } from './state'
import { itemName, lineOf, tableTotal } from './totals'

// Order entry (brief §5, rule 2): tap products and "Enviar". What has no options goes in with
// one tap (and can be undone); the same product again adds to its line. What has a single
// choice (glass or bottle, flavor, doneness) opens the panel, and tapping the option adds it.

const MAX_RESULTS = 30

/** How many choices the product asks for: variant and required groups. */
const choiceCount = (p: MenuProduct) =>
  (p.variants.length > 0 ? 1 : 0) + p.groups.filter((g) => g.minimum > 0).length
const needsPanel = (p: MenuProduct) => p.variants.length > 0 || p.groups.length > 0

/** Two items are the same line if they are the identical product, for the same person, unsent. */
const sameLine = (a: OrderItem, b: OrderItem) =>
  a.sentAt === null &&
  !a.voided &&
  a.product.key === b.product.key &&
  a.variant === b.variant &&
  a.guest === b.guest &&
  a.notes === b.notes &&
  JSON.stringify(a.options) === JSON.stringify(b.options)

/** Open the table when adding the first product (not when tapping it on the floor plan). */
const occupy = (m: Table): Table =>
  m.status === 'free' || m.status === 'reserved'
    ? { ...m, status: 'taking', openedAt: Date.now(), guests: 2, waiter: 'Mesero 1' }
    : m

export function Order() {
  const number = useRouteTable(2)
  const table = useTables().find((m) => m.number === number)
  const notify = useNotify()
  const [searchQuery, setSearchQuery] = useState('')
  const [category, setCategory] = useState(menu[0]?.key ?? '')
  const [guest, setGuest] = useState<number | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<MenuProduct | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [viewOrder, setViewOrder] = useState(false)
  const searchField = useRef<HTMLInputElement>(null)

  // "/" goes to search (register shortcut, brief §5, rule 8).
  useEffect(() => {
    const onKeystroke = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement).closest('input, textarea')) return
      e.preventDefault()
      searchField.current?.focus()
    }
    window.addEventListener('keydown', onKeystroke)
    return () => window.removeEventListener('keydown', onKeystroke)
  }, [])

  const found = useMemo(
    () =>
      searchQuery.trim()
        ? search(products, searchQuery, (p) => searchText.get(p.key) ?? p.name)
        : (menu.find((c) => c.key === category)?.products ?? []),
    [searchQuery, category],
  )

  // If the number of people goes down, what was chosen for someone now gone goes back to "Mesa".
  const guests = table?.guests ?? 0
  useEffect(() => {
    if (guest !== null && guest > guests) setGuest(null)
  }, [guest, guests])

  if (!table) return null
  const items = table.items
  const pendingSend = items.filter((i) => i.sentAt === null && !i.voided)
  const quantityInOrder = (p: MenuProduct) =>
    pendingSend.filter((i) => i.product.key === p.key).reduce((s, i) => s + i.quantity, 0)

  const add = (fresh: OrderItem) => {
    const equal = items.find((i) => sameLine(i, fresh))
    if (equal) {
      changeTable(number, (m) => ({
        ...m,
        items: m.items.map((i) =>
          i.id === equal.id ? { ...i, quantity: i.quantity + fresh.quantity } : i,
        ),
      }))
      notify(`${itemName(fresh)}: ${equal.quantity + fresh.quantity}`, () =>
        changeTable(number, (m) => ({
          ...m,
          items: m.items.map((i) =>
            i.id === equal.id ? { ...i, quantity: i.quantity - fresh.quantity } : i,
          ),
        })),
      )
      return
    }
    const before = table
    changeTable(number, (m) => ({ ...occupy(m), items: [...m.items, fresh] }))
    notify(`Agregaste ${itemName(fresh)}`, () =>
      changeTable(number, (m) =>
        m.items.length === 1 && before.items.length === 0
          ? before
          : { ...m, items: m.items.filter((i) => i.id !== fresh.id) },
      ),
    )
  }

  const tapProduct = (p: MenuProduct) => {
    if (needsPanel(p)) setSelectedProduct(p)
    else add(fresh(p, null, [], guest))
  }

  const remove = (item: OrderItem) => {
    const placement = items.findIndex((i) => i.id === item.id)
    changeTable(number, (m) => ({ ...m, items: m.items.filter((i) => i.id !== item.id) }))
    notify(`Quitaste ${itemName(item)}`, () =>
      changeTable(number, (m) => {
        const copy = [...m.items]
        copy.splice(placement, 0, item)
        return { ...m, items: copy }
      }),
    )
  }

  const send = () => {
    if (pendingSend.length === 0) return
    const now = Date.now()
    changeTable(number, (m) => ({
      ...m,
      status: 'in_kitchen',
      items: m.items.map((i) => (i.sentAt === null ? { ...i, sentAt: now } : i)),
    }))
    navigator.vibrate?.(60)
    notify(`Enviado a cocina y barra (${pendingSend.length})`)
    setViewOrder(false)
    navigate('/mockups/floor-plan')
  }

  const requestCheck = () => navigate(`/mockups/pre-bill?table=${number}`)
  const editedItem = items.find((i) => i.id === editing) ?? null

  const ticket = (
    <Ticket
      table={table}
      guest={guest}
      onChooseGuest={setGuest}
      onGuestsChange={(n) => changeTable(number, (m) => ({ ...m, guests: n }))}
      onItemTap={(i) => setEditing(i.id)}
    />
  )
  const sendButton = (
    <Button
      variant="main"
      large
      icon="send"
      className="w-full"
      disabled={pendingSend.length === 0}
      onClick={send}
    >
      {pendingSend.length === 0 ? 'Enviar' : `Enviar ${pendingSend.length}`}
    </Button>
  )
  const checkButton = (
    <Button
      variant="secondary"
      large
      icon="receipt"
      disabled={items.length === 0}
      onClick={requestCheck}
    >
      Cuenta
    </Button>
  )

  return (
    <Frame title={`Mesa ${number}`} back="/mockups/floor-plan">
      <div className="mx-auto flex max-w-6xl gap-4 p-3 pb-28 md:pb-3">
        <section className="min-w-0 flex-1" aria-label="Carta">
          <label className="relative block">
            <span className="sr-only">Buscar en la carta</span>
            <Icon name="search" className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <input
              ref={searchField}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar: «hamburgesa», «aperol»…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-h-12 w-full rounded-xl border border-border bg-surface pr-3 pl-11 text-lg placeholder:text-muted focus-visible:outline-3 focus-visible:outline-focus"
            />
          </label>
          {!searchQuery.trim() && (
            <Group label="Categorías" className="-mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1">
              {menu.map((c) => (
                <Option
                  key={c.key}
                  selected={c.key === category}
                  onChoose={() => setCategory(c.key)}
                >
                  {c.name}
                </Option>
              ))}
            </Group>
          )}
          <ul className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
            {found.slice(0, MAX_RESULTS).map((p) => {
              const quantity = quantityInOrder(p)
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    onClick={() => tapProduct(p)}
                    className="relative flex min-h-20 w-full flex-col justify-between rounded-xl border border-border bg-surface p-3 text-left hover:bg-surface-2 active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-focus"
                  >
                    {quantity > 0 && (
                      <span className="figures absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-action-strong text-sm font-bold text-white">
                        {quantity}
                        <span className="sr-only"> en el pedido</span>
                      </span>
                    )}
                    <span className="font-semibold leading-snug">{p.name}</span>
                    <span className="figures mt-1 flex items-center justify-between text-muted">
                      <span className="font-heading text-lg">
                        {p.variants.length > 0 ? `desde ${pesos(p.price)}` : pesos(p.price)}
                      </span>
                      {needsPanel(p) && (
                        <span className="text-sm whitespace-nowrap">opciones ›</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
            {found.length === 0 && (
              <li className="col-span-full p-6 text-center text-muted">
                No hay nada con «{searchQuery}».
              </li>
            )}
            {found.length > MAX_RESULTS && (
              <li className="col-span-full p-3 text-center text-muted">
                {`Hay ${found.length - MAX_RESULTS} más: escribe un poco más.`}
              </li>
            )}
          </ul>
        </section>

        {/* Tablet and register: the order always visible. */}
        <aside className="sticky top-20 hidden h-[calc(100dvh-6rem)] w-96 shrink-0 flex-col rounded-2xl border border-border bg-surface md:flex">
          {ticket}
          <div className="flex gap-2 border-t border-border p-3">
            {checkButton}
            <div className="flex-1">{sendButton}</div>
          </div>
        </aside>
      </div>

      {/* Phone: fixed bar at the bottom, within reach of the thumb. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-border bg-surface p-3 md:hidden">
        <Button
          variant="secondary"
          large
          onClick={() => setViewOrder(true)}
          className="flex-1 flex-col gap-0! text-base! leading-tight"
        >
          <span>{`Pedido (${items.filter((i) => !i.voided).length})`}</span>
          <span className="figures font-heading text-lg">{pesos(tableTotal(table))}</span>
        </Button>
        <div className="flex-1">{sendButton}</div>
      </div>

      <SidePanel
        opened={viewOrder}
        title={`Pedido · Mesa ${number}`}
        onClose={() => setViewOrder(false)}
        footer={
          <div className="flex gap-2">
            {checkButton}
            <div className="flex-1">{sendButton}</div>
          </div>
        }
      >
        {ticket}
      </SidePanel>

      <ProductPanel
        product={selectedProduct}
        guest={guest}
        onClose={() => setSelectedProduct(null)}
        onAdd={(item) => {
          add(item)
          setSelectedProduct(null)
        }}
      />

      <PanelItem
        item={editedItem}
        guests={table.guests}
        onClose={() => setEditing(null)}
        onSave={(item) => {
          changeTable(number, (m) => ({
            ...m,
            items: m.items.map((i) => (i.id === item.id ? item : i)),
          }))
          setEditing(null)
        }}
        onRemove={(item) => {
          remove(item)
          setEditing(null)
        }}
        onVoid={(item, reason, alreadyPrepared) => {
          changeTable(number, (m) => ({
            ...m,
            items: m.items.map((i) =>
              i.id === item.id ? { ...i, voided: { reason, alreadyPrepared } } : i,
            ),
          }))
          notify(`Anulaste ${itemName(item)} (${reason.toLowerCase()})`)
          setEditing(null)
        }}
      />
    </Frame>
  )
}

function fresh(
  p: MenuProduct,
  variant: string | null,
  options: OrderItem['options'],
  guest: number | null,
  quantity = 1,
  notes = '',
): OrderItem {
  return {
    id: newItemId(),
    product: p,
    variant,
    options,
    unitPrice: p.variants.find((v) => v.name === variant)?.price ?? p.price,
    quantity,
    guest,
    notes,
    sentAt: null,
    dispatched: false,
    voided: null,
  }
}

function Ticket({
  table,
  guest,
  onChooseGuest,
  onGuestsChange,
  onItemTap,
}: {
  table: Table
  guest: number | null
  onChooseGuest: (c: number | null) => void
  onGuestsChange: (n: number) => void
  onItemTap: (i: OrderItem) => void
}) {
  const { items, guests } = table
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Icon name="people" />
        <span className="font-semibold">{`${guests} ${guests === 1 ? 'persona' : 'personas'}`}</span>
        <Button
          variant="ghost"
          icon="minus"
          aria-label="Una persona menos"
          disabled={guests <= 1}
          onClick={() => onGuestsChange(guests - 1)}
        />
        <Button
          variant="ghost"
          icon="more"
          aria-label="Una persona más"
          onClick={() => onGuestsChange(guests + 1)}
        />
      </div>
      <Group
        label="Para quién es lo próximo que agregues"
        className="flex gap-2 overflow-x-auto border-b border-border p-3"
      >
        {[null, ...Array.from({ length: guests }, (_, i) => i + 1)].map((c) => (
          <Option
            key={c ?? 'table'}
            selected={guest === c}
            onChoose={() => onChooseGuest(c)}
            label={c === null ? 'Para la mesa' : `Para la persona ${c}`}
          >
            {c === null ? 'Mesa' : `P${c}`}
          </Option>
        ))}
      </Group>
      <ul className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <li className="p-6 text-center text-muted">Toca un producto para agregarlo.</li>
        )}
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => !i.voided && onItemTap(i)}
              className={`flex min-h-14 w-full items-start gap-3 border-b border-border px-3 py-2 text-left hover:bg-surface-2 ${i.voided ? 'text-muted' : ''}`}
            >
              <span className="figures w-6 font-semibold">{i.quantity}</span>
              <span className="flex-1">
                <span className={`font-semibold ${i.voided ? 'line-through' : ''}`}>
                  {itemName(i)}
                </span>
                {i.options.length > 0 && (
                  <span className="block text-sm font-semibold text-progress-text">
                    {i.options.map((o) => o.name).join(' · ')}
                  </span>
                )}
                {i.notes && <span className="block text-sm text-muted">«{i.notes}»</span>}
                <span className="block text-sm text-muted">
                  {[
                    i.guest ? `P${i.guest}` : 'Mesa',
                    i.voided
                      ? `anulado: ${i.voided.reason.toLowerCase()}`
                      : i.sentAt !== null
                        ? 'enviado'
                        : 'sin enviar',
                  ].join(' · ')}
                </span>
              </span>
              <span className={`figures ${i.voided ? 'line-through' : ''}`}>
                {pesos(lineNet(lineOf(i)))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="figures flex justify-between p-3 text-lg font-semibold">
        <span>Total</span>
        <span>{pesos(tableTotal(table))}</span>
      </div>
    </div>
  )
}

/** Options for a product: variant, required groups, quantity and notes. */
function ProductPanel({
  product,
  guest,
  onClose,
  onAdd,
}: {
  product: MenuProduct | null
  guest: number | null
  onClose: () => void
  onAdd: (item: OrderItem) => void
}) {
  const [variant, setVariant] = useState<string | null>(null)
  const [options, setOptions] = useState<Record<string, string>>({})
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState('')
  const [openFor, setOpenFor] = useState<string | null>(null)

  // When opening with another product, everything starts from scratch.
  if (product && openFor !== product.key) {
    setOpenFor(product.key)
    setVariant(null)
    setOptions({})
    setQuantity(1)
    setNotes('')
  }
  if (!product) return null

  const addsOnTap = choiceCount(product) === 1
  const selectedOf = (o: Record<string, string>) =>
    product.groups.flatMap((g) => {
      const x = g.options.find((op) => op.name === o[g.key])
      return x ? [x] : []
    })
  const missingChoices = [
    ...(product.variants.length > 0 && !variant ? ['tamaño'] : []),
    ...product.groups
      .filter((g) => g.minimum > 0 && !options[g.key])
      .map((g) => g.name.toLowerCase()),
  ]
  const price = product.variants.find((v) => v.name === variant)?.price ?? product.price
  const net = lineNet({
    id: '',
    quantity,
    unitPrice: price,
    extras: selectedOf(options).map((o) => o.extraPrice),
  })

  const close = () => {
    setOpenFor(null)
    onClose()
  }
  const addWith = (v: string | null, o: Record<string, string>) => {
    setOpenFor(null)
    onAdd(fresh(product, v, selectedOf(o), guest, quantity, notes.trim()))
  }

  return (
    <SidePanel
      opened
      title={product.name}
      onClose={close}
      footer={
        <Button
          variant="main"
          large
          className="w-full"
          disabled={missingChoices.length > 0}
          onClick={() => addWith(variant, options)}
        >
          {missingChoices.length > 0 ? `Elige ${missingChoices[0]}` : `Agregar · ${pesos(net)}`}
        </Button>
      }
    >
      {product.description && <p className="mb-4 text-muted">{product.description}</p>}
      {addsOnTap && <p className="mb-3 text-sm text-muted">Toca una opción y queda agregada.</p>}
      {product.variants.length > 0 && (
        <OptionList
          title="Tamaño"
          options={product.variants.map((v) => ({ name: v.name, detail: pesos(v.price) }))}
          selected={variant}
          onChoose={(v) => (addsOnTap ? addWith(v, options) : setVariant(v))}
        />
      )}
      {product.groups.map((g: MenuGroup) => (
        <OptionList
          key={g.key}
          title={`${g.name}${g.minimum > 0 ? ' (obligatorio)' : ''}`}
          options={g.options.map((o) => ({
            name: o.name,
            detail: o.extraPrice ? `+${pesos(o.extraPrice)}` : '',
          }))}
          selected={options[g.key] ?? null}
          onChoose={(name) => {
            const nextOptions = { ...options, [g.key]: name }
            if (addsOnTap) addWith(variant, nextOptions)
            else setOptions(nextOptions)
          }}
        />
      ))}
      <Quantity value={quantity} onChange={setQuantity} />
      <label className="block">
        <span className="font-semibold">Notas para cocina</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Sin cebolla, bien caliente…"
          className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface px-3 focus-visible:outline-3 focus-visible:outline-focus"
        />
      </label>
    </SidePanel>
  )
}

function OptionList({
  title,
  options,
  selected,
  onChoose,
}: {
  title: string
  options: { name: string; detail: string }[]
  selected: string | null
  onChoose: (name: string) => void
}) {
  return (
    <fieldset className="mb-5 min-w-0 border-0 p-0">
      <legend className="mb-2 font-semibold">{title}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => (
          <Option
            key={o.name}
            shape="card"
            selected={selected === o.name}
            detail={o.detail}
            onChoose={() => onChoose(o.name)}
          >
            {o.name}
          </Option>
        ))}
      </div>
    </fieldset>
  )
}

function Quantity({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="font-semibold">Cantidad</span>
      <Button
        icon="minus"
        aria-label="Uno menos"
        disabled={value <= 1}
        onClick={() => onChange(value - 1)}
      />
      <span className="figures w-8 text-center text-xl font-semibold">{value}</span>
      <Button icon="more" aria-label="Uno más" onClick={() => onChange(value + 1)} />
    </div>
  )
}

/**
 * An order item. Unsent: change quantity, person or notes, or remove it (with Deshacer).
 * Sent: it can only be voided, with a reason and confirmation, because the kitchen already has it
 * (brief §4.3).
 */
function PanelItem({
  item,
  guests,
  onClose,
  onSave,
  onRemove,
  onVoid,
}: {
  item: OrderItem | null
  guests: number
  onClose: () => void
  onSave: (item: OrderItem) => void
  onRemove: (item: OrderItem) => void
  onVoid: (item: OrderItem, reason: string, alreadyPrepared: boolean) => void
}) {
  const [draft, setDraft] = useState<OrderItem | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [alreadyPrepared, setAlreadyPrepared] = useState(false)
  const [confirming, setConfirming] = useState(false)
  if (item && draft?.id !== item.id) {
    setDraft(item)
    setReason(null)
    setAlreadyPrepared(false)
    setConfirming(false)
  }
  if (!item || !draft) return null
  const close = () => {
    setDraft(null)
    onClose()
  }

  if (item.sentAt !== null) {
    return (
      <SidePanel
        opened
        title={`Anular ${itemName(item)}`}
        onClose={close}
        footer={
          confirming ? (
            <div className="flex flex-col gap-2">
              <p className="font-semibold">{`¿Anular ${itemName(item)}? Queda registrado con el motivo.`}</p>
              <div className="flex gap-2">
                <Button onClick={() => setConfirming(false)}>Volver</Button>
                <Button
                  variant="danger"
                  className="flex-1"
                  onClick={() => {
                    setDraft(null)
                    onVoid(item, reason as string, alreadyPrepared)
                  }}
                >
                  Sí, anular
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="danger"
              large
              className="w-full"
              disabled={!reason}
              onClick={() => setConfirming(true)}
            >
              {reason ? 'Anular' : 'Elige el motivo'}
            </Button>
          )
        }
      >
        <p className="mb-4 text-muted">
          Ya se envió a cocina o barra: no se puede quitar, solo anular. En la Fase 1 lo autoriza el
          gerente con su PIN y la cocina recibe una comanda de anulación.
        </p>
        <fieldset className="mb-5 min-w-0 border-0 p-0">
          <legend className="mb-2 font-semibold">Motivo</legend>
          <div className="grid grid-cols-2 gap-2">
            {VOID_REASONS.map((m) => (
              <Option key={m} shape="card" selected={reason === m} onChoose={() => setReason(m)}>
                {m}
              </Option>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={alreadyPrepared}
            onChange={(e) => setAlreadyPrepared(e.target.checked)}
          />
          Ya se había preparado (va como merma)
        </label>
      </SidePanel>
    )
  }

  return (
    <SidePanel
      opened
      title={itemName(item)}
      onClose={close}
      footer={
        <div className="flex gap-2">
          <Button
            variant="danger"
            icon="close"
            onClick={() => {
              setDraft(null)
              onRemove(item)
            }}
          >
            Quitar
          </Button>
          <Button
            variant="main"
            className="flex-1"
            onClick={() => {
              setDraft(null)
              onSave(draft)
            }}
          >
            Listo
          </Button>
        </div>
      }
    >
      <Quantity value={draft.quantity} onChange={(quantity) => setDraft({ ...draft, quantity })} />
      <OptionList
        title="Para"
        options={['Mesa', ...Array.from({ length: guests }, (_, i) => `P${i + 1}`)].map((name) => ({
          name,
          detail: '',
        }))}
        selected={draft.guest ? `P${draft.guest}` : 'Mesa'}
        onChoose={(n) => setDraft({ ...draft, guest: n === 'Mesa' ? null : Number(n.slice(1)) })}
      />
      <label className="block">
        <span className="font-semibold">Notas para cocina</span>
        <input
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface px-3 focus-visible:outline-3 focus-visible:outline-focus"
        />
      </label>
    </SidePanel>
  )
}
