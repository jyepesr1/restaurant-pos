import { METHOD_NAME, type PaymentMethod } from '@pos/core'
import { useCallback, useEffect, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { pesos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { floor } from './contexto'
import { claseCampo } from './Entrar'
import { MarcoSala } from './MarcoSala'
import type {
  ConfiguracionCaja,
  ConfiguracionCocina,
  Datafono,
  MedioPropio,
  ProveedorDatafono,
} from './motor'

// «Caja y pagos» (tarea 1.6): qué medios de pago recibe el restaurante, dónde sale la precuenta
// y sus datáfonos. Para quien administra los equipos; cada restaurante decide lo suyo.

const MEDIOS: PaymentMethod[] = [
  'cash',
  'card',
  'nequi',
  'daviplata',
  'breb',
  'transfer',
  'voucher',
]

const PROVEEDORES: { value: ProveedorDatafono; name: string }[] = [
  { value: 'bold', name: 'Bold' },
  { value: 'redeban', name: 'Redeban' },
  { value: 'credibanco', name: 'Credibanco' },
  { value: 'other', name: 'Otro' },
]

const message = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function CajaAjustes() {
  const notify = useAvisar()
  const [register, setCaja] = useState<ConfiguracionCaja | null>(null)
  const [kitchen, setCocina] = useState<ConfiguracionCocina | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editando, setEditando] = useState<Datafono | null>(null)
  const [editandoMedio, setEditandoMedio] = useState<MedioPropio | null>(null)

  const load = useCallback(() => {
    Promise.all([floor.registerConfig(), floor.kitchenConfig()])
      .then(([c, k]) => {
        setCaja(c)
        setCocina(k)
        setError(null)
      })
      .catch((e) => setError(message(e)))
  }, [])
  useEffect(load, [load])

  if (error && !register)
    return (
      <MarcoSala title="Caja y pagos">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 p-6">
          <p className="text-alerta-texto">{error}</p>
          <Boton onClick={load}>Intentar de nuevo</Boton>
        </div>
      </MarcoSala>
    )
  if (!register || !kitchen)
    return (
      <MarcoSala title="Caja y pagos">
        <p className="p-6 text-texto-suave">Leyendo la configuración de la caja…</p>
      </MarcoSala>
    )

  const cambiarMedio = async (m: PaymentMethod) => {
    const methods = register.payment_methods.includes(m)
      ? register.payment_methods.filter((x) => x !== m)
      : MEDIOS.filter((x) => x === m || register.payment_methods.includes(x))
    try {
      await floor.savePaymentMethods(methods)
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const cambiarUmbral = async (v: number) => {
    try {
      await floor.varianceThreshold(v)
      notify(v === 0 ? 'Toda diferencia se justifica' : `Se justifica desde ${pesos(v)}`)
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const cambiarPropina = async (puntos: number) => {
    try {
      await floor.suggestedTip(puntos)
      notify(puntos === 0 ? 'Sin propina sugerida' : `Propina sugerida: ${puntos / 100} %`)
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const printers = kitchen.printers.filter((i) => i.active)
  const elegida = kitchen.pre_bill_printer_id ?? null
  const elegirImpresora = async (id: string | null) => {
    try {
      await floor.preBillPrinter(id)
      notify(id ? 'La precuenta saldrá impresa' : 'La precuenta solo se verá en pantalla')
      load()
    } catch (e) {
      notify(message(e))
    }
  }

  const guardarMedio = async (m: MedioPropio) => {
    try {
      const custom_methods = await floor.guardarMedioPropio(m)
      setCaja({ ...register, custom_methods })
      setEditandoMedio(null)
      notify(m.active ? `Guardaste ${m.name}` : `Archivaste ${m.name}`)
    } catch (e) {
      notify(message(e))
    }
  }

  const guardarDatafono = async (d: Datafono) => {
    try {
      const cardTerminals = await floor.guardarDatafono(d)
      setCaja({ ...register, cardTerminals })
      setEditando(null)
      notify(d.active ? `Guardaste ${d.name}` : `Archivaste ${d.name}`)
    } catch (e) {
      notify(message(e))
    }
  }

  return (
    <MarcoSala title="Caja y pagos">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 p-3 md:p-5">
        <section aria-labelledby="title-methods" className="flex flex-col gap-3">
          <h2 id="title-methods" className="text-xl font-bold tracking-tight">
            Medios de pago
          </h2>
          <p className="text-texto-suave">Los que salen al cobrar. El efectivo siempre está.</p>
          <Grupo etiqueta="Medios de pago" className="flex flex-wrap gap-2">
            {MEDIOS.map((m) => (
              <Opcion
                key={m}
                elegida={register.payment_methods.includes(m)}
                alElegir={() => m !== 'cash' && cambiarMedio(m)}
                etiqueta={m === 'cash' ? 'Efectivo: siempre se recibe' : undefined}
              >
                {m === 'cash'
                  ? 'Efectivo (siempre)'
                  : m === 'card'
                    ? 'Tarjeta crédito y débito'
                    : METHOD_NAME[m]}
              </Opcion>
            ))}
          </Grupo>
          <div className="mt-2 flex items-center justify-between gap-2">
            <h3 className="font-semibold">Medios propios</h3>
            <Boton icono="more" onClick={() => setEditandoMedio({ name: '', active: true })}>
              Agregar
            </Boton>
          </div>
          <p className="text-sm text-texto-suave">
            Los que recibe este restaurante con su nombre: Sodexo, QR Bancolombia, Rappi…
          </p>
          <ul className="flex flex-col gap-2">
            {register.custom_methods.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setEditandoMedio(m)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-linea bg-superficie px-4 text-left hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
                >
                  <span className="flex-1 font-semibold">{m.name}</span>
                  {!m.active && <Etiqueta tono="neutral">Archivado</Etiqueta>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="title-tip" className="flex flex-col gap-3">
          <h2 id="title-tip" className="text-xl font-bold tracking-tight">
            Propina sugerida
          </h2>
          <p className="text-texto-suave">
            La que sale en la precuenta y aparece marcada al cobrar, sobre la base sin impuestos. Es
            voluntaria: el cajero la quita o la cambia en cada cobro.
          </p>
          <Grupo etiqueta="Propina sugerida" className="flex flex-wrap gap-2">
            {[0, 500, 800, 1000].map((p) => (
              <Opcion
                key={p}
                elegida={register.suggested_tip === p}
                alElegir={() => cambiarPropina(p)}
              >
                {p === 0 ? 'Sin propina' : `${p / 100} %`}
              </Opcion>
            ))}
          </Grupo>
        </section>

        <section aria-labelledby="title-threshold" className="flex flex-col gap-3">
          <h2 id="title-threshold" className="text-xl font-bold tracking-tight">
            Cierre de caja
          </h2>
          <p className="text-texto-suave">
            Desde qué diferencia (sobrante o faltante) el cajero debe explicar por qué no cuadra.
          </p>
          <Grupo etiqueta="Justificar desde" className="flex flex-wrap gap-2">
            {[0, 1000, 5000, 10_000].map((v) => (
              <Opcion
                key={v}
                elegida={(register.register_variance_threshold ?? 1000) === v}
                alElegir={() => cambiarUmbral(v)}
              >
                {v === 0 ? 'Cualquier diferencia' : `Desde ${pesos(v)}`}
              </Opcion>
            ))}
          </Grupo>
        </section>

        <section aria-labelledby="title-pre-bill" className="flex flex-col gap-3">
          <h2 id="title-pre-bill" className="text-xl font-bold tracking-tight">
            Impresora de precuentas
          </h2>
          <p className="text-texto-suave">
            Dónde sale la precuenta que pide el mesero o la caja. Sin impresora, se muestra en la
            pantalla.
          </p>
          <Grupo etiqueta="Impresora de precuentas" className="flex flex-col gap-2">
            <Opcion shape="card" elegida={elegida === null} alElegir={() => elegirImpresora(null)}>
              Solo en pantalla
            </Opcion>
            {printers.map((i) => (
              <Opcion
                key={i.id}
                shape="card"
                elegida={elegida === i.id}
                alElegir={() => elegirImpresora(i.id)}
                detalle={i.connection === 'network' ? i.address : 'USB'}
              >
                {i.name}
              </Opcion>
            ))}
          </Grupo>
          {printers.length === 0 && (
            <p className="text-sm text-texto-suave">
              Agrega la impresora en «Cocina e impresoras» y luego elígela aquí.
            </p>
          )}
        </section>

        <section aria-labelledby="title-card-terminals" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="title-card-terminals" className="text-xl font-bold tracking-tight">
              Datáfonos
            </h2>
            <Boton
              icono="more"
              onClick={() => setEditando({ name: '', provider: 'bold', active: true })}
            >
              Agregar
            </Boton>
          </div>
          <p className="text-texto-suave">
            Los de un mismo proveedor entregan un solo cierre: al cobrar no se pregunta en cuál se
            pasó la tarjeta. Si hay de proveedores distintos (Bold y Redeban), se elige el
            proveedor.
          </p>
          <ul className="flex flex-col gap-2">
            {register.cardTerminals.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setEditando(d)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-linea bg-superficie px-4 text-left hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
                >
                  <span className="flex-1 font-semibold">{d.name}</span>
                  <span className="text-texto-suave">
                    {PROVEEDORES.find((p) => p.value === d.provider)?.name}
                  </span>
                  {!d.active && <Etiqueta tono="neutral">Archivado</Etiqueta>}
                </button>
              </li>
            ))}
            {register.cardTerminals.length === 0 && (
              <li className="text-texto-suave">
                Sin datáfonos: no se puede cobrar con tarjeta hasta agregar uno.
              </li>
            )}
          </ul>
        </section>
      </div>

      <EditarMedio
        key={editandoMedio?.id ?? (editandoMedio ? 'new' : 'closed')}
        method={editandoMedio}
        onClose={() => setEditandoMedio(null)}
        onSave={guardarMedio}
      />
      <EditarDatafono
        key={editando?.id ?? (editando ? 'new' : 'closed')}
        cardTerminal={editando}
        onClose={() => setEditando(null)}
        onSave={guardarDatafono}
      />
    </MarcoSala>
  )
}

function EditarDatafono({
  cardTerminal,
  onClose,
  onSave,
}: {
  cardTerminal: Datafono | null
  onClose: () => void
  onSave: (d: Datafono) => void
}) {
  const [name, setNombre] = useState(cardTerminal?.name ?? '')
  const [provider, setProveedor] = useState<ProveedorDatafono>(cardTerminal?.provider ?? 'bold')
  const valid = name.trim().length > 0
  const save = (active: boolean) =>
    cardTerminal && onSave({ ...cardTerminal, name: name.trim(), provider, active })
  return (
    <PanelLateral
      opened={cardTerminal !== null}
      title={cardTerminal?.id ? 'Datáfono' : 'Datáfono nuevo'}
      onClose={onClose}
      pie={
        <div className="flex flex-col gap-2">
          <Boton variant="main" large disabled={!valid} onClick={() => save(true)}>
            {cardTerminal?.id && !cardTerminal.active ? 'Volver a usarlo' : 'Guardar'}
          </Boton>
          {cardTerminal?.id && cardTerminal.active && (
            <Boton variant="ghost" onClick={() => save(false)}>
              Archivar
            </Boton>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label>
          <span className="font-semibold">Nombre</span>
          <input
            className={`${claseCampo} mt-1`}
            maxLength={60}
            value={name}
            placeholder="Bold de la barra"
            onChange={(e) => setNombre(e.target.value)}
          />
        </label>
        <Grupo etiqueta="Proveedor" className="flex flex-wrap gap-2">
          {PROVEEDORES.map((p) => (
            <Opcion
              key={p.value}
              elegida={provider === p.value}
              alElegir={() => setProveedor(p.value)}
            >
              {p.name}
            </Opcion>
          ))}
        </Grupo>
      </div>
    </PanelLateral>
  )
}

function EditarMedio({
  method,
  onClose,
  onSave,
}: {
  method: MedioPropio | null
  onClose: () => void
  onSave: (m: MedioPropio) => void
}) {
  const [name, setNombre] = useState(method?.name ?? '')
  const valid = name.trim().length > 0
  const save = (active: boolean) => method && onSave({ ...method, name: name.trim(), active })
  return (
    <PanelLateral
      opened={method !== null}
      title={method?.id ? 'Medio de pago' : 'Medio de pago nuevo'}
      onClose={onClose}
      pie={
        <div className="flex flex-col gap-2">
          <Boton variant="main" large disabled={!valid} onClick={() => save(true)}>
            {method?.id && !method.active ? 'Volver a usarlo' : 'Guardar'}
          </Boton>
          {method?.id && method.active && (
            <Boton variant="ghost" onClick={() => save(false)}>
              Archivar
            </Boton>
          )}
        </div>
      }
    >
      <label>
        <span className="font-semibold">Nombre</span>
        <input
          className={`${claseCampo} mt-1`}
          maxLength={30}
          value={name}
          placeholder="Sodexo"
          onChange={(e) => setNombre(e.target.value)}
        />
      </label>
    </PanelLateral>
  )
}
