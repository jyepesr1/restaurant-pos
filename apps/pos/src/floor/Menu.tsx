import { newId } from '@pos/core'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { pesos } from '../ui/format'
import { Icon } from '../ui/icons'
import { Label } from '../ui/Label'
import { Group, Option } from '../ui/Options'
import { shrinkPhoto } from '../ui/photo'
import { SidePanel } from '../ui/SidePanel'
import { search } from '../ui/search'
import { useNotify } from '../ui/toasts'
import { floor, useFloor } from './context'
import {
  type GroupDraft,
  groupChanges,
  groupDraft,
  groupIssues,
  groupProducts,
  newGroup,
  newProduct,
  type ProductDraft,
  productChanges,
  productDraft,
  productIssues,
  productsWithGroup,
  readPesos,
} from './drafts'
import type { CatalogChange, EditableCatalog } from './engine'
import { FloorFrame } from './FloorFrame'

// Menu editor (task 1.1), at the register: products with their sizes (glass or bottle) and their
// option groups (doneness, flavor, add-ons with a price), categories and stations. On
// save, the hub notifies every device and they receive the new menu. Nothing is deleted: what is
// removed is archived and can be restored.
//
// With only the `edit_prices` permission all fields are visible but only prices can be changed.

type Tab = 'products' | 'options' | 'categories'
const ARCHIVED = 'archived'

const field =
  'min-h-12 w-full rounded-xl border border-border bg-surface px-3 text-lg disabled:opacity-60 focus-visible:outline-3 focus-visible:outline-focus'

export function Menu() {
  const { session } = useFloor()
  const notify = useNotify()
  const [c, setC] = useState<EditableCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('products')
  const [product, setProduct] = useState<ProductDraft | null>(null)
  const [group, setGroup] = useState<GroupDraft | null>(null)
  const canDoAll = session?.permissions.includes('edit_catalog') ?? false

  const load = useCallback(
    () =>
      floor
        .catalogForEditing()
        .then((x) => {
          setC(x)
          setError(null)
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo traer la carta')),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  /** Saves to the hub; returns the error message, or `null` if it was saved. */
  const save = async (changes: CatalogChange[], done: string) => {
    try {
      await floor.editCatalog(changes)
      await load()
      notify(done)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'No se pudo guardar'
    }
  }

  return (
    <FloorFrame title="Carta" back="/">
      <div className="mx-auto max-w-4xl p-3">
        <Group label="Qué editar" className="mb-4 flex flex-wrap gap-2">
          <Option selected={tab === 'products'} onChoose={() => setTab('products')}>
            Productos
          </Option>
          <Option selected={tab === 'options'} onChoose={() => setTab('options')}>
            Grupos de opciones
          </Option>
          <Option selected={tab === 'categories'} onChoose={() => setTab('categories')}>
            Categorías y estaciones
          </Option>
        </Group>
        {!canDoAll && (
          <p className="mb-3 rounded-xl bg-neutral-soft p-3 text-neutral-text">
            Tu rol solo puede cambiar precios.
          </p>
        )}
        {error && (
          <div className="mb-3 flex flex-wrap items-center gap-3" role="alert">
            <span className="text-alert-text">{error}</span>
            <Button onClick={() => void load()}>Intentar de nuevo</Button>
          </div>
        )}
        {!c ? (
          !error && <p className="text-muted">Cargando la carta…</p>
        ) : tab === 'products' ? (
          <ProductList
            c={c}
            canDoAll={canDoAll}
            onOpen={(id) => setProduct(productDraft(c, id))}
            onCreate={(categoryId) => setProduct(newProduct(c, categoryId))}
          />
        ) : tab === 'options' ? (
          <GroupList
            c={c}
            canDoAll={canDoAll}
            onOpen={(id) => setGroup(groupDraft(c, id))}
            onCreate={() => setGroup(newGroup())}
          />
        ) : (
          <Categories c={c} canDoAll={canDoAll} save={save} />
        )}
      </div>
      {c && product && (
        <ProductPanel
          c={c}
          initial={product}
          canDoAll={canDoAll}
          onPhotoChange={() => void load()}
          onClose={() => setProduct(null)}
          onSave={async (b) => {
            const r = await save(productChanges(c, b), `Guardaste ${b.name.trim()}`)
            if (!r) setProduct(null)
            return r
          }}
        />
      )}
      {c && group && (
        <GroupPanel
          c={c}
          initial={group}
          canDoAll={canDoAll}
          onClose={() => setGroup(null)}
          onSave={async (g) => {
            const r = await save(groupChanges(c, g), `Guardaste ${g.name.trim()}`)
            if (!r) setGroup(null)
            return r
          }}
        />
      )}
    </FloorFrame>
  )
}

// ── Lists ──────────────────────────────────────────────────────────────

function Row({
  title,
  detail,
  trailing,
  archived,
  onTap,
}: {
  title: string
  detail?: string
  trailing?: string
  archived: boolean
  onTap: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onTap}
        className="flex min-h-14 w-full items-center gap-3 border-b border-border px-3 py-2 text-left hover:bg-surface-2 focus-visible:outline-3 focus-visible:outline-focus"
      >
        <span className="flex-1">
          <span className="font-semibold">{title}</span>
          {detail && <span className="block text-sm text-muted">{detail}</span>}
        </span>
        {archived && <Label tone="neutral">Archivado</Label>}
        {trailing && <span className="figures">{trailing}</span>}
      </button>
    </li>
  )
}

function ProductList({
  c,
  canDoAll,
  onOpen,
  onCreate,
}: {
  c: EditableCatalog
  canDoAll: boolean
  onOpen: (id: string) => void
  onCreate: (categoryId: string) => void
}) {
  const categories = c.categories.filter((x) => x.active)
  const [category, setCategory] = useState(categories[0]?.id ?? ARCHIVED)
  const [searchQuery, setSearchQuery] = useState('')
  const variantsOf = (id: string) => c.variants.filter((v) => v.product_id === id && v.active)
  const list = searchQuery.trim()
    ? search(c.products, searchQuery, (p) => p.name)
    : category === ARCHIVED
      ? // Also the active ones of an archived category: they do not show on the devices' menu.
        c.products.filter((p) => !p.active || !categories.some((x) => x.id === p.category_id))
      : c.products.filter((p) => p.category_id === category && p.active)

  return (
    <section aria-label="Productos">
      <div className="mb-3 flex flex-wrap gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Buscar un producto</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar un producto"
            className={field}
          />
        </label>
        {canDoAll && (
          <Button
            variant="main"
            icon="more"
            disabled={categories.length === 0}
            onClick={() => onCreate(category === ARCHIVED ? (categories[0]?.id ?? '') : category)}
          >
            Nuevo producto
          </Button>
        )}
      </div>
      {!searchQuery.trim() && (
        <Group label="Categorías" className="-mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {categories.map((x) => (
            <Option key={x.id} selected={x.id === category} onChoose={() => setCategory(x.id)}>
              {x.name}
            </Option>
          ))}
          <Option selected={category === ARCHIVED} onChoose={() => setCategory(ARCHIVED)}>
            Archivados
          </Option>
        </Group>
      )}
      <ul className="rounded-2xl border border-border bg-surface">
        {list.length === 0 && (
          <li className="p-6 text-center text-muted">No hay productos aquí.</li>
        )}
        {list.map((p) => {
          const variants = variantsOf(p.id)
          return (
            <Row
              key={p.id}
              title={p.name}
              detail={
                [
                  variants.map((v) => v.name).join(' · '),
                  p.active && !categories.some((x) => x.id === p.category_id)
                    ? 'Su categoría está archivada'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' — ') || undefined
              }
              trailing={variants.length > 0 ? `desde ${pesos(p.price)}` : pesos(p.price)}
              archived={!p.active}
              onTap={() => onOpen(p.id)}
            />
          )
        })}
      </ul>
    </section>
  )
}

function GroupList({
  c,
  canDoAll,
  onOpen,
  onCreate,
}: {
  c: EditableCatalog
  canDoAll: boolean
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  const rules = (minimum: number, maximum: number) =>
    minimum === 0
      ? `Opcional, hasta ${maximum}`
      : minimum === maximum
        ? `Obligatorio: elige ${minimum}`
        : `Elige de ${minimum} a ${maximum}`
  const groups = [...c.groups].sort((a, b) => Number(b.active) - Number(a.active))
  return (
    <section aria-label="Grupos de opciones">
      <p className="mb-3 text-muted">
        Un grupo de opciones se pide al tomar el producto: el término de la carne, el sabor o
        adicionales con precio. Un mismo grupo sirve para varios productos.
      </p>
      {canDoAll && (
        <Button variant="main" icon="more" className="mb-3" onClick={onCreate}>
          Nuevo grupo de opciones
        </Button>
      )}
      <ul className="rounded-2xl border border-border bg-surface">
        {groups.length === 0 && (
          <li className="p-6 text-center text-muted">Todavía no hay grupos de opciones.</li>
        )}
        {groups.map((g) => {
          // Product names tell apart two groups with the same name ("Sabor").
          const usage = groupProducts(c, g.id).map((p) => p.name)
          const whoCan =
            usage.length === 0
              ? 'ningún producto'
              : usage.length <= 2
                ? usage.join(' y ')
                : `${usage.slice(0, 2).join(', ')} y ${usage.length - 2} más`
          return (
            <Row
              key={g.id}
              title={g.name}
              detail={`${rules(g.minimum, g.maximum)} · ${whoCan}`}
              archived={!g.active}
              onTap={() => onOpen(g.id)}
            />
          )
        })}
      </ul>
    </section>
  )
}

// ── Fields ─────────────────────────────────────────────────────────────

function Field({ label: labelText, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in `children`
    <label className="mb-4 flex flex-col gap-1">
      <span className="font-semibold">{labelText}</span>
      {children}
    </label>
  )
}

/** Amount in pesos: accepts "40.900" or "40900" and shows it with dots when leaving the field. */
function PesosField({
  value,
  onChange,
  onValidate,
  label: labelText,
  disabled,
}: {
  value: number
  onChange: (pesos: number) => void
  /** Tells whether the input is a valid amount: with a mistyped one it cannot be saved. */
  onValidate: (valid: boolean) => void
  label: string
  disabled?: boolean
}) {
  const format = (n: number) => n.toLocaleString('es-CO')
  const [text, setText] = useState(format(value))
  const id = useId()
  const valid = readPesos(text) !== null
  return (
    <span className="flex flex-col gap-1">
      <input
        aria-label={labelText}
        aria-invalid={!valid}
        aria-describedby={valid ? undefined : id}
        inputMode="numeric"
        disabled={disabled}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setText(e.target.value)
          const n = readPesos(e.target.value)
          onValidate(n !== null)
          if (n !== null) onChange(n)
        }}
        onBlur={() => {
          const n = readPesos(text)
          if (n !== null) setText(format(n))
        }}
        className={`${field} figures text-right ${valid ? '' : 'border-alert-strong'}`}
      />
      {!valid && (
        <span id={id} className="text-sm text-alert-text">
          Escribe el valor en pesos, sin centavos
        </span>
      )}
    </span>
  )
}

/** Panel footer: save (says what is missing or the hub's error) or, when trying to close with
 * changes, confirm they are discarded. */
function SaveFooter({
  issues,
  noChanges,
  error,
  onSave,
  confirmingClose,
  onContinue,
  onDiscard,
}: {
  issues: string[]
  noChanges: boolean
  error: string | null
  onSave: () => Promise<void>
  confirmingClose: boolean
  onContinue: () => void
  onDiscard: () => void
}) {
  const [saving, setSaving] = useState(false)
  if (confirmingClose)
    return (
      <div className="flex flex-col gap-2">
        <p className="font-semibold" role="alert">
          Tienes cambios sin guardar.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" large className="flex-1" onClick={onDiscard}>
            Descartar
          </Button>
          {/* Focus goes to the safe option. */}
          <Button variant="main" large className="flex-1" autoFocus onClick={onContinue}>
            Seguir editando
          </Button>
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p className="min-h-6 text-alert-text" role="alert">
          {error}
        </p>
      ) : (
        <p className="min-h-6 text-alert-text" aria-live="polite">
          {issues[0] ?? ''}
        </p>
      )}
      <Button
        variant="main"
        large
        className="w-full"
        disabled={saving || issues.length > 0 || noChanges}
        onClick={async () => {
          setSaving(true)
          await onSave()
          setSaving(false)
        }}
      >
        {saving ? 'Guardando…' : noChanges ? 'Sin cambios' : 'Guardar'}
      </Button>
    </div>
  )
}

/** What the panels share: mistyped prices and the confirmation when closing with changes. */
function usePanel(noChanges: boolean, onClose: () => void) {
  const [badOnes, setBadOnes] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const validate = (key: string) => (valid: boolean) =>
    setBadOnes((m) => {
      const fresh = new Set(m)
      if (valid) fresh.delete(key)
      else fresh.add(key)
      return fresh
    })
  return {
    badPrice: badOnes.size > 0 ? ['Hay un precio mal escrito'] : [],
    validate,
    confirming,
    close: () => (noChanges ? onClose() : setConfirming(true)),
    proceed: () => setConfirming(false),
  }
}

// ── Product ────────────────────────────────────────────────────────────

function ProductPanel({
  c,
  initial,
  canDoAll,
  onPhotoChange,
  onClose,
  onSave,
}: {
  c: EditableCatalog
  initial: ProductDraft
  canDoAll: boolean
  /** The photo is saved separately: the editor's menu is read again so it does not go stale. */
  onPhotoChange: () => void
  onClose: () => void
  onSave: (b: ProductDraft) => Promise<string | null>
}) {
  const [b, setB] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<ProductDraft>) => setB((x) => ({ ...x, ...partial }))
  const variants = b.variants.filter((v) => v.active)
  const changeVariant = (id: string, partial: Partial<ProductDraft['variants'][number]>) =>
    patch({ variants: b.variants.map((v) => (v.id === id ? { ...v, ...partial } : v)) })
  const groups = c.groups.filter((g) => g.active || b.groups.includes(g.id))
  const noChanges = productChanges(c, b).length === 0
  const panel = usePanel(noChanges, onClose)

  return (
    <SidePanel
      opened
      title={initial.fresh ? 'Nuevo producto' : initial.name}
      onClose={panel.close}
      footer={
        <SaveFooter
          issues={[...panel.badPrice, ...productIssues(b)]}
          noChanges={noChanges}
          error={error}
          onSave={async () => setError(await onSave(b))}
          confirmingClose={panel.confirming}
          onContinue={panel.proceed}
          onDiscard={onClose}
        />
      }
    >
      {!canDoAll && (
        <p className="mb-4 rounded-xl bg-neutral-soft p-3 text-neutral-text">
          Tu rol solo puede cambiar precios.
        </p>
      )}
      {!b.active && (
        <p className="mb-4 rounded-xl bg-neutral-soft p-3 text-neutral-text">
          Archivado: no aparece en la carta de los equipos.
        </p>
      )}
      <Field label="Nombre">
        <input
          className={field}
          value={b.name}
          maxLength={80}
          disabled={!canDoAll}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>
      <Field label="Descripción (opcional)">
        <textarea
          className={`${field} py-2`}
          rows={2}
          maxLength={300}
          value={b.description}
          disabled={!canDoAll}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Field>
      <Field label="Categoría">
        <select
          className={field}
          value={b.categoryId}
          disabled={!canDoAll}
          onChange={(e) => patch({ categoryId: e.target.value })}
        >
          {c.categories
            .filter((x) => x.active || x.id === b.categoryId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Impuesto">
        <select
          className={field}
          value={b.taxId}
          disabled={!canDoAll}
          onChange={(e) => patch({ taxId: e.target.value })}
        >
          {c.taxes
            .filter((x) => x.active || x.id === b.taxId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </Field>
      {variants.length === 0 && (
        <Field label="Precio (con impuesto incluido)">
          <PesosField
            label={`Precio de ${b.name || 'el producto'}`}
            value={b.price}
            onChange={(price) => patch({ price })}
            onValidate={panel.validate('product')}
          />
        </Field>
      )}

      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">Tamaños (copa, botella…)</legend>
        <p className="mb-2 text-sm text-muted">
          Si el producto tiene tamaños, el mesero debe elegir uno y cada uno tiene su precio.
        </p>
        {variants.map((v) => (
          <div key={v.id} className="mb-2 flex items-start gap-2">
            <input
              aria-label="Nombre del tamaño"
              className={`${field} flex-1`}
              value={v.name}
              placeholder="Copa"
              maxLength={80}
              disabled={!canDoAll}
              onChange={(e) => changeVariant(v.id, { name: e.target.value })}
            />
            <span className="w-36">
              <PesosField
                label={`Precio de ${v.name || 'este tamaño'}`}
                value={v.price}
                onChange={(price) => changeVariant(v.id, { price })}
                onValidate={panel.validate(v.id)}
              />
            </span>
            {canDoAll && (
              <Button
                variant="ghost"
                icon="close"
                aria-label={`Quitar ${v.name || 'este tamaño'}`}
                onClick={() => {
                  panel.validate(v.id)(true)
                  changeVariant(v.id, { active: false })
                }}
              />
            )}
          </div>
        ))}
        {canDoAll && (
          <Button
            icon="more"
            onClick={() =>
              patch({
                variants: [
                  ...b.variants,
                  { id: newId(), fresh: true, name: '', price: b.price, active: true },
                ],
              })
            }
          >
            Agregar tamaño
          </Button>
        )}
      </fieldset>

      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">Grupos de opciones que se piden</legend>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">
            Crea grupos (término, sabor, adicionales) en la pestaña Grupos de opciones.
          </p>
        ) : !canDoAll ? (
          <p>
            {b.groups.map((id) => c.groups.find((g) => g.id === id)?.name).join(', ') || 'Ninguno'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => {
              const selectedProduct = b.groups.includes(g.id)
              return (
                <Option
                  key={g.id}
                  selected={selectedProduct}
                  onChoose={() =>
                    patch({
                      groups: selectedProduct
                        ? b.groups.filter((x) => x !== g.id)
                        : [...b.groups, g.id],
                    })
                  }
                >
                  {g.name}
                </Option>
              )
            })}
          </div>
        )}
      </fieldset>

      {canDoAll && !initial.fresh && (
        <ProductPhoto
          productId={initial.id}
          photo={c.products.find((p) => p.id === initial.id)?.photo ?? null}
          onChange={onPhotoChange}
        />
      )}

      {canDoAll && (
        <label className="mb-4 flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={b.favorite}
            onChange={(e) => patch({ favorite: e.target.checked })}
          />
          <span>
            <span className="font-semibold">Favorito</span>
            <span className="block text-muted">
              Aparece en «Favoritos», lo primero que se ve al tomar el pedido.
            </span>
          </span>
        </label>
      )}

      {canDoAll && !initial.fresh && (
        <Button variant="secondary" onClick={() => patch({ active: !b.active })}>
          {b.active ? 'Archivar (sacar de la carta)' : 'Volver a ponerlo en la carta'}
        </Button>
      )}
    </SidePanel>
  )
}

// ── Option group ───────────────────────────────────────────────────────

function Accountant({
  label: labelText,
  value,
  minimum,
  maximum,
  onChange,
  disabled,
}: {
  label: string
  value: number
  minimum: number
  maximum: number
  onChange: (n: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 font-semibold">{labelText}</span>
      <Button
        icon="minus"
        aria-label={`${labelText}: uno menos`}
        disabled={disabled || value <= minimum}
        onClick={() => onChange(value - 1)}
      />
      <output className="figures w-8 text-center text-xl font-semibold">{value}</output>
      <Button
        icon="more"
        aria-label={`${labelText}: uno más`}
        disabled={disabled || value >= maximum}
        onClick={() => onChange(value + 1)}
      />
    </div>
  )
}

function GroupPanel({
  c,
  initial,
  canDoAll,
  onClose,
  onSave,
}: {
  c: EditableCatalog
  initial: GroupDraft
  canDoAll: boolean
  onClose: () => void
  onSave: (g: GroupDraft) => Promise<string | null>
}) {
  const [g, setG] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<GroupDraft>) => setG((x) => ({ ...x, ...partial }))
  const options = g.options.filter((o) => o.active)
  const changeOption = (id: string, partial: Partial<GroupDraft['options'][number]>) =>
    patch({ options: g.options.map((o) => (o.id === id ? { ...o, ...partial } : o)) })
  const usage = productsWithGroup(c, g.id)
  const noChanges = groupChanges(c, g).length === 0
  const panel = usePanel(noChanges, onClose)

  return (
    <SidePanel
      opened
      title={initial.fresh ? 'Nuevo grupo de opciones' : initial.name}
      onClose={panel.close}
      footer={
        <SaveFooter
          issues={[...panel.badPrice, ...groupIssues(g)]}
          noChanges={noChanges}
          error={error}
          onSave={async () => setError(await onSave(g))}
          confirmingClose={panel.confirming}
          onContinue={panel.proceed}
          onDiscard={onClose}
        />
      }
    >
      {usage > 0 && (
        <p className="mb-4 rounded-xl bg-progress-soft p-3 text-progress-text">
          {`Lo usan ${usage === 1 ? '1 producto' : `${usage} productos`}: un cambio aquí cambia en todos.`}
        </p>
      )}
      <Field label="Nombre">
        <input
          className={field}
          value={g.name}
          placeholder="Término de la carne"
          maxLength={80}
          disabled={!canDoAll}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>
      <div className="mb-4 flex flex-col gap-2">
        <Accountant
          label="Mínimo a elegir"
          value={g.minimum}
          minimum={0}
          maximum={g.maximum}
          disabled={!canDoAll}
          onChange={(minimum) => patch({ minimum })}
        />
        <Accountant
          label="Máximo a elegir"
          value={g.maximum}
          minimum={Math.max(1, g.minimum)}
          maximum={20}
          disabled={!canDoAll}
          onChange={(maximum) => patch({ maximum })}
        />
        <p className="text-sm text-muted">
          {g.minimum === 0
            ? 'Opcional: el mesero puede no elegir nada.'
            : 'Obligatorio: el mesero no puede agregar el producto sin elegir.'}
        </p>
      </div>
      <fieldset className="mb-4">
        <legend className="mb-2 font-semibold">Opciones y su precio extra</legend>
        {options.map((o) => (
          <div key={o.id} className="mb-2 flex items-start gap-2">
            <input
              aria-label="Nombre de la opción"
              className={`${field} flex-1`}
              value={o.name}
              placeholder="Tocineta"
              maxLength={80}
              disabled={!canDoAll}
              onChange={(e) => changeOption(o.id, { name: e.target.value })}
            />
            <span className="w-32">
              <PesosField
                label={`Precio extra de ${o.name || 'esta opción'}`}
                value={o.extraPrice}
                onChange={(extraPrice) => changeOption(o.id, { extraPrice })}
                onValidate={panel.validate(o.id)}
              />
            </span>
            {canDoAll && (
              <Button
                variant="ghost"
                icon="close"
                aria-label={`Quitar ${o.name || 'esta opción'}`}
                onClick={() => {
                  panel.validate(o.id)(true)
                  changeOption(o.id, { active: false })
                }}
              />
            )}
          </div>
        ))}
        {canDoAll && (
          <Button
            icon="more"
            onClick={() =>
              patch({
                options: [
                  ...g.options,
                  { id: newId(), fresh: true, name: '', extraPrice: 0, active: true },
                ],
              })
            }
          >
            Agregar opción
          </Button>
        )}
      </fieldset>
      {canDoAll && !initial.fresh && (
        <Button variant="secondary" onClick={() => patch({ active: !g.active })}>
          {g.active ? 'Archivar el grupo' : 'Volver a usarlo'}
        </Button>
      )}
    </SidePanel>
  )
}

// ── Categories and stations ────────────────────────────────────────────

/** An editable row with a name and, for a category, its station. Saves itself on Guardar. */
function EditableRow({
  name,
  stationId,
  stations,
  active,
  fresh,
  canDoAll,
  onSave,
}: {
  name: string
  stationId?: string | null
  stations?: EditableCatalog['stations']
  active: boolean
  fresh?: boolean
  canDoAll: boolean
  onSave: (d: { name: string; stationId: string | null; active: boolean }) => Promise<string | null>
}) {
  const [n, setN] = useState(name)
  const [e, setE] = useState(stationId ?? null)
  const [error, setError] = useState<string | null>(null)
  const change = n.trim() !== name || e !== (stationId ?? null)
  const save = async (a: boolean) => {
    const r = await onSave({ name: n.trim(), stationId: e, active: a })
    setError(r)
    if (!r && fresh) setN('')
  }
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-border p-2">
      <input
        aria-label={fresh ? 'Nombre' : `Nombre de ${name}`}
        className={`${field} min-w-40 flex-1`}
        value={n}
        placeholder={fresh ? (stations ? 'Nueva categoría' : 'Nueva estación') : undefined}
        maxLength={80}
        disabled={!canDoAll}
        onChange={(x) => setN(x.target.value)}
      />
      {stations && (
        <select
          aria-label="Estación a la que va"
          className={`${field} w-auto`}
          value={e ?? ''}
          disabled={!canDoAll}
          onChange={(x) => setE(x.target.value || null)}
        >
          <option value="">Sin estación</option>
          {stations
            .filter((x) => x.active || x.id === e)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      )}
      {canDoAll && (
        <>
          <Button
            variant="main"
            disabled={!n.trim() || (!change && !fresh)}
            onClick={() => void save(active)}
          >
            {fresh ? 'Agregar' : 'Guardar'}
          </Button>
          {!fresh && (
            <Button variant={active ? 'ghost' : 'secondary'} onClick={() => void save(!active)}>
              {active ? 'Archivar' : 'Volver a usar'}
            </Button>
          )}
        </>
      )}
      {error && (
        <p className="w-full text-alert-text" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

function Categories({
  c,
  canDoAll,
  save,
}: {
  c: EditableCatalog
  canDoAll: boolean
  save: (changes: CatalogChange[], done: string) => Promise<string | null>
}) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="title-categories">
        <h2 id="title-categories" className="mb-1 text-lg font-semibold">
          Categorías
        </h2>
        <p className="mb-2 text-muted">
          La estación dice a dónde va la comanda de sus productos (cocina o barra).
        </p>
        <ul className="rounded-2xl border border-border bg-surface">
          {c.categories.map((x) => (
            <EditableRow
              key={`${x.id}-${x.version}`}
              name={x.name}
              stationId={x.station_id}
              stations={c.stations}
              active={x.active}
              canDoAll={canDoAll}
              onSave={(d) =>
                save(
                  [
                    {
                      entity: 'categories',
                      id: x.id,
                      data: { name: d.name, station_id: d.stationId, active: d.active },
                    },
                  ],
                  `Guardaste ${d.name}`,
                )
              }
            />
          ))}
          {canDoAll && (
            <EditableRow
              key={`new-${c.version}`}
              name=""
              stationId={c.stations.find((x) => x.active)?.id ?? null}
              stations={c.stations}
              active
              fresh
              canDoAll
              onSave={(d) =>
                save(
                  [
                    {
                      entity: 'categories',
                      id: newId(),
                      data: {
                        name: d.name,
                        position: c.categories.length,
                        station_id: d.stationId,
                        active: true,
                      },
                    },
                  ],
                  `Agregaste ${d.name}`,
                )
              }
            />
          )}
        </ul>
      </section>
      <section aria-labelledby="title-stations">
        <h2 id="title-stations" className="mb-2 text-lg font-semibold">
          Estaciones
        </h2>
        <ul className="rounded-2xl border border-border bg-surface">
          {c.stations.map((x) => (
            <EditableRow
              key={`${x.id}-${x.version}`}
              name={x.name}
              active={x.active}
              canDoAll={canDoAll}
              onSave={(d) =>
                save(
                  [
                    {
                      entity: 'stations',
                      id: x.id,
                      data: { name: d.name, active: d.active },
                    },
                  ],
                  `Guardaste ${d.name}`,
                )
              }
            />
          ))}
          {canDoAll && (
            <EditableRow
              key={`new-station-${c.version}`}
              name=""
              active
              fresh
              canDoAll
              onSave={(d) =>
                save(
                  [
                    {
                      entity: 'stations',
                      id: newId(),
                      data: { name: d.name, position: c.stations.length, active: true },
                    },
                  ],
                  `Agregaste ${d.name}`,
                )
              }
            />
          )}
        </ul>
      </section>
    </div>
  )
}

/**
 * The product photo (task 1.3c): optional. Saved as soon as it is picked, apart from the rest of
 * the product, and shrunk on the device before uploading. Without a photo, the menu shows an icon.
 */
function ProductPhoto({
  productId,
  photo,
  onChange,
}: {
  productId: string
  photo: string | null
  onChange: () => void
}) {
  const [current, setCurrent] = useState(photo ? `/photos/${photo}` : null)
  const [taken, setTaken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entry = useRef<HTMLInputElement>(null)
  const upload = async (image: string | null) => {
    setTaken(true)
    setError(null)
    try {
      setCurrent(await floor.uploadPhoto(productId, image))
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la foto')
    }
    setTaken(false)
  }
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="font-semibold">Foto (opcional)</p>
      <div className="flex items-center gap-3">
        <span className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-divider bg-surface-2">
          {current ? (
            <img src={current} alt="Foto del producto" className="size-full object-cover" />
          ) : (
            <Icon name="photo" className="size-8 text-muted" />
          )}
        </span>
        <span className="flex flex-col gap-2">
          <Button icon="photo" disabled={taken} onClick={() => entry.current?.click()}>
            {taken ? 'Guardando…' : current ? 'Cambiar foto' : 'Subir foto'}
          </Button>
          {current && (
            <Button variant="ghost" disabled={taken} onClick={() => void upload(null)}>
              Quitar foto
            </Button>
          )}
        </span>
      </div>
      <input
        ref={entry}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          try {
            await upload(await shrinkPhoto(file))
          } catch (x) {
            setError(x instanceof Error ? x.message : 'No se pudo leer la foto')
          }
        }}
      />
      <p className="text-sm text-muted">
        Se guarda apenas la eliges y la ven todos los equipos. Mejor de cerca y con buena luz.
      </p>
      {error && (
        <p className="text-sm text-alert-text" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
