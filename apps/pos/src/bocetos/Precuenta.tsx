import { useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { pesos } from '../ui/formato'
import { Grupo, Opcion } from '../ui/Opciones'
import { navegar } from '../ui/ruta'
import {
  enPartesIguales,
  netoLinea,
  porItems,
  propinaSobre,
  propinasDeCuentas,
  recortarAsignaciones,
} from './cuenta'
import { cambiarMesa, useMesaDeLaRuta, useMesas } from './estado'
import { Marco } from './Marco'
import { lineaDe, nombreItem, saldoMesa, totalMesa, vigentes } from './totales'

// Precuenta y división (brief §4.5, docs/DINERO.md#división-de-la-cuenta). Se divide el SALDO: lo
// ya pagado queda aparte. Los montos y la propina de cada cuenta los calcula `@pos/core`, y cada
// cuenta se cobra por separado.

type Modo = 'una' | 'iguales' | 'items'

export function Precuenta() {
  const numero = useMesaDeLaRuta(12)
  const mesa = useMesas().find((m) => m.numero === numero)
  const avisar = useAvisar()
  const [modo, setModo] = useState<Modo>('una')
  const [personas, setPersonas] = useState(2)
  const [cuentas, setCuentas] = useState(2)
  // Ítem → cuentas que lo pagan (más de una = compartido en partes iguales).
  const [asignadas, setAsignadas] = useState<Map<string, number[]>>(new Map())
  if (!mesa) return null

  const items = vigentes(mesa)
  const total = totalMesa(mesa)
  const saldo = saldoMesa(mesa)
  const pagado = total - saldo
  const propina = propinaSobre(saldo)
  // Por ítems solo antes de cobrar algo: después, lo que queda se divide por partes.
  const porItemsPosible = pagado === 0

  const tocarItem = (id: string, cuenta: number) =>
    setAsignadas((a) => {
      const b = new Map(a)
      const actuales = b.get(id) ?? []
      const nuevas = actuales.includes(cuenta)
        ? actuales.filter((c) => c !== cuenta)
        : [...actuales, cuenta].sort((x, y) => x - y)
      if (nuevas.length === 0) b.delete(id)
      else b.set(id, nuevas)
      return b
    })

  const cambiarCuentas = (n: number) => {
    setCuentas(n)
    setAsignadas((a) => recortarAsignaciones(a, n))
  }

  const montos =
    modo === 'iguales'
      ? enPartesIguales(saldo, personas)
      : modo === 'items' && porItemsPosible
        ? porItems(items.map(lineaDe), asignadas, cuentas).montos
        : [saldo]
  const sinAsignar =
    modo === 'items' && porItemsPosible
      ? porItems(items.map(lineaDe), asignadas, cuentas).sinAsignar
      : 0
  const propinas = propinasDeCuentas(montos)

  const cobrar = (monto: number, propinaCuenta: number) =>
    navegar(`/bocetos/cobro?mesa=${numero}&monto=${monto}&propina=${propinaCuenta}`)

  const acciones = (
    <>
      <Boton
        variante="secundario"
        grande
        icono="recibo"
        className="flex-1"
        onClick={() => {
          cambiarMesa(numero, (m) => ({ ...m, estado: 'precuenta' }))
          avisar('Precuenta enviada a la impresora')
        }}
      >
        Imprimir
      </Boton>
      {modo === 'una' && (
        <Boton
          variante="principal"
          grande
          icono="billete"
          className="flex-1"
          disabled={saldo === 0}
          onClick={() => cobrar(saldo, propina)}
        >
          {`Cobrar ${pesos(saldo)}`}
        </Boton>
      )}
    </>
  )

  return (
    <Marco titulo={`Precuenta · Mesa ${numero}`} usuario="Caja" volver="/bocetos/plano">
      <div className="mx-auto grid max-w-5xl gap-4 p-3 pb-28 md:grid-cols-[1fr_22rem] md:pb-3">
        <section className="rounded-2xl border border-borde bg-superficie" aria-label="Ítems">
          <ul>
            {items.map((i) => (
              <li key={i.id} className="border-b border-borde px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="cifras w-6 font-semibold">{i.cantidad}</span>
                  <span className="flex-1">
                    <span className="font-semibold">{nombreItem(i)}</span>
                    {i.opciones.length > 0 && (
                      <span className="block text-sm text-texto-suave">
                        {i.opciones.map((o) => o.nombre).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="cifras">{pesos(netoLinea(lineaDe(i)))}</span>
                </div>
                {modo === 'items' && porItemsPosible && (
                  <Grupo
                    etiqueta={`Quién paga ${nombreItem(i)}`}
                    className="mt-2 flex flex-wrap gap-2 pl-9"
                  >
                    {Array.from({ length: cuentas }, (_, c) => (
                      <Opcion
                        // biome-ignore lint/suspicious/noArrayIndexKey: las cuentas son posiciones
                        key={c}
                        elegida={asignadas.get(i.id)?.includes(c) ?? false}
                        alElegir={() => tocarItem(i.id, c)}
                      >
                        {`Cuenta ${c + 1}`}
                      </Opcion>
                    ))}
                  </Grupo>
                )}
              </li>
            ))}
          </ul>
          <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4">
            <dt>Total</dt>
            <dd className="text-right">{pesos(total)}</dd>
            {pagado > 0 && (
              <>
                <dt className="text-libre-texto">Ya pagado</dt>
                <dd className="text-right text-libre-texto">{`-${pesos(pagado)}`}</dd>
                <dt className="font-semibold">Saldo</dt>
                <dd className="text-right font-semibold">{pesos(saldo)}</dd>
              </>
            )}
            <dt className="text-texto-suave">Propina sugerida (10 %, voluntaria)</dt>
            <dd className="text-right text-texto-suave">{pesos(propina)}</dd>
            <dt className="font-titulo text-2xl font-bold">Con propina</dt>
            <dd className="font-titulo text-right text-2xl font-bold">{pesos(saldo + propina)}</dd>
          </dl>
          <p className="px-4 pb-4 text-sm text-texto-suave">Precios con INC incluido.</p>
        </section>

        <section className="flex flex-col gap-3" aria-label="Dividir">
          <Grupo etiqueta="Cómo se paga" className="grid grid-cols-3 gap-2">
            {(
              [
                ['una', 'Una cuenta'],
                ['iguales', 'Partes iguales'],
                ['items', 'Por ítems'],
              ] as const
            ).map(([m, texto]) => (
              <Opcion key={m} forma="tarjeta" elegida={modo === m} alElegir={() => setModo(m)}>
                {texto}
              </Opcion>
            ))}
          </Grupo>

          {modo === 'iguales' && (
            <Contador
              nombre="Personas"
              valor={personas}
              minimo={2}
              maximo={20}
              alCambiar={setPersonas}
            />
          )}
          {modo === 'items' &&
            (porItemsPosible ? (
              <>
                <Contador
                  nombre="Cuentas"
                  valor={cuentas}
                  minimo={2}
                  maximo={10}
                  alCambiar={cambiarCuentas}
                />
                <p className="text-sm text-texto-suave">
                  Toca en cada ítem quién lo paga. Si lo tocan dos o más, se reparte entre ellos.
                </p>
              </>
            ) : (
              <p className="rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                Ya hay pagos: divide el saldo en partes iguales.
              </p>
            ))}

          {modo !== 'una' && (
            <ul className="flex flex-col gap-2">
              {montos.map((monto, c) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: las cuentas son posiciones
                  key={c}
                  className="flex items-center gap-2 rounded-xl border border-borde bg-superficie p-2 pl-3"
                >
                  <span className="flex-1">
                    <span className="block font-semibold">{`Cuenta ${c + 1}`}</span>
                    <span className="cifras text-sm text-texto-suave">
                      {`${pesos(monto)} + propina ${pesos(propinas[c] ?? 0)}`}
                    </span>
                  </span>
                  <Boton
                    variante="principal"
                    disabled={monto === 0}
                    onClick={() => cobrar(monto, propinas[c] ?? 0)}
                  >
                    {`Cobrar ${pesos(monto)}`}
                  </Boton>
                </li>
              ))}
              {sinAsignar > 0 && (
                <li className="cifras flex justify-between rounded-xl bg-proceso-suave p-3 text-proceso-texto">
                  <span>Sin asignar</span>
                  <span className="font-semibold">{pesos(sinAsignar)}</span>
                </li>
              )}
            </ul>
          )}

          <div className="hidden gap-2 md:flex">{acciones}</div>
        </section>
      </div>

      {/* Celular: las acciones abajo, al alcance del pulgar. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-borde bg-superficie p-3 md:hidden">
        {acciones}
      </div>
    </Marco>
  )
}

function Contador({
  nombre,
  valor,
  minimo,
  maximo,
  alCambiar,
}: {
  nombre: string
  valor: number
  minimo: number
  maximo: number
  alCambiar: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-borde bg-superficie p-3">
      <span className="flex-1 font-semibold">{nombre}</span>
      <Boton
        icono="menos"
        aria-label={`Quitar ${nombre.toLowerCase()}: quedan ${valor - 1}`}
        disabled={valor <= minimo}
        onClick={() => alCambiar(valor - 1)}
      />
      <span className="cifras w-8 text-center text-xl font-semibold">{valor}</span>
      <Boton
        icono="mas"
        aria-label={`Agregar ${nombre.toLowerCase()}: quedan ${valor + 1}`}
        disabled={valor >= maximo}
        onClick={() => alCambiar(valor + 1)}
      />
    </div>
  )
}
