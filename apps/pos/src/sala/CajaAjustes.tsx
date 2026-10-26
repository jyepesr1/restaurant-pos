import type { MedioPago } from '@pos/core'
import { useCallback, useEffect, useState } from 'react'
import { useAvisar } from '../ui/avisos'
import { Boton } from '../ui/Boton'
import { Etiqueta } from '../ui/Etiqueta'
import { Grupo, Opcion } from '../ui/Opciones'
import { PanelLateral } from '../ui/PanelLateral'
import { sala } from './contexto'
import { NOMBRE_MEDIO } from './cuentas'
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

const MEDIOS: MedioPago[] = [
  'efectivo',
  'tarjeta',
  'nequi',
  'daviplata',
  'breb',
  'transferencia',
  'bono',
]

const PROVEEDORES: { valor: ProveedorDatafono; nombre: string }[] = [
  { valor: 'bold', nombre: 'Bold' },
  { valor: 'redeban', nombre: 'Redeban' },
  { valor: 'credibanco', nombre: 'Credibanco' },
  { valor: 'otro', nombre: 'Otro' },
]

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function CajaAjustes() {
  const avisar = useAvisar()
  const [caja, setCaja] = useState<ConfiguracionCaja | null>(null)
  const [cocina, setCocina] = useState<ConfiguracionCocina | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editando, setEditando] = useState<Datafono | null>(null)
  const [editandoMedio, setEditandoMedio] = useState<MedioPropio | null>(null)

  const cargar = useCallback(() => {
    Promise.all([sala.configuracionCaja(), sala.configuracionCocina()])
      .then(([c, k]) => {
        setCaja(c)
        setCocina(k)
        setError(null)
      })
      .catch((e) => setError(mensaje(e)))
  }, [])
  useEffect(cargar, [cargar])

  if (error && !caja)
    return (
      <MarcoSala titulo="Caja y pagos">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 p-6">
          <p className="text-alerta-texto">{error}</p>
          <Boton onClick={cargar}>Intentar de nuevo</Boton>
        </div>
      </MarcoSala>
    )
  if (!caja || !cocina)
    return (
      <MarcoSala titulo="Caja y pagos">
        <p className="p-6 text-texto-suave">Leyendo la configuración de la caja…</p>
      </MarcoSala>
    )

  const cambiarMedio = async (m: MedioPago) => {
    const medios = caja.medios_pago.includes(m)
      ? caja.medios_pago.filter((x) => x !== m)
      : MEDIOS.filter((x) => x === m || caja.medios_pago.includes(x))
    try {
      await sala.mediosDePago(medios)
      cargar()
    } catch (e) {
      avisar(mensaje(e))
    }
  }

  const cambiarPropina = async (puntos: number) => {
    try {
      await sala.propinaSugerida(puntos)
      avisar(puntos === 0 ? 'Sin propina sugerida' : `Propina sugerida: ${puntos / 100} %`)
      cargar()
    } catch (e) {
      avisar(mensaje(e))
    }
  }

  const impresoras = cocina.impresoras.filter((i) => i.activo)
  const elegida = cocina.impresora_precuenta_id ?? null
  const elegirImpresora = async (id: string | null) => {
    try {
      await sala.impresoraPrecuenta(id)
      avisar(id ? 'La precuenta saldrá impresa' : 'La precuenta solo se verá en pantalla')
      cargar()
    } catch (e) {
      avisar(mensaje(e))
    }
  }

  const guardarMedio = async (m: MedioPropio) => {
    try {
      const medios_propios = await sala.guardarMedioPropio(m)
      setCaja({ ...caja, medios_propios })
      setEditandoMedio(null)
      avisar(m.activo ? `Guardaste ${m.nombre}` : `Archivaste ${m.nombre}`)
    } catch (e) {
      avisar(mensaje(e))
    }
  }

  const guardarDatafono = async (d: Datafono) => {
    try {
      const datafonos = await sala.guardarDatafono(d)
      setCaja({ ...caja, datafonos })
      setEditando(null)
      avisar(d.activo ? `Guardaste ${d.nombre}` : `Archivaste ${d.nombre}`)
    } catch (e) {
      avisar(mensaje(e))
    }
  }

  return (
    <MarcoSala titulo="Caja y pagos">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 p-3 md:p-5">
        <section aria-labelledby="titulo-medios" className="flex flex-col gap-3">
          <h2 id="titulo-medios" className="text-xl font-bold tracking-tight">
            Medios de pago
          </h2>
          <p className="text-texto-suave">Los que salen al cobrar. El efectivo siempre está.</p>
          <Grupo etiqueta="Medios de pago" className="flex flex-wrap gap-2">
            {MEDIOS.map((m) => (
              <Opcion
                key={m}
                elegida={caja.medios_pago.includes(m)}
                alElegir={() => m !== 'efectivo' && cambiarMedio(m)}
                etiqueta={m === 'efectivo' ? 'Efectivo: siempre se recibe' : undefined}
              >
                {m === 'efectivo'
                  ? 'Efectivo (siempre)'
                  : m === 'tarjeta'
                    ? 'Tarjeta crédito y débito'
                    : NOMBRE_MEDIO[m]}
              </Opcion>
            ))}
          </Grupo>
          <div className="mt-2 flex items-center justify-between gap-2">
            <h3 className="font-semibold">Medios propios</h3>
            <Boton icono="mas" onClick={() => setEditandoMedio({ nombre: '', activo: true })}>
              Agregar
            </Boton>
          </div>
          <p className="text-sm text-texto-suave">
            Los que recibe este restaurante con su nombre: Sodexo, QR Bancolombia, Rappi…
          </p>
          <ul className="flex flex-col gap-2">
            {caja.medios_propios.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setEditandoMedio(m)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-linea bg-superficie px-4 text-left hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
                >
                  <span className="flex-1 font-semibold">{m.nombre}</span>
                  {!m.activo && <Etiqueta tono="neutro">Archivado</Etiqueta>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="titulo-propina" className="flex flex-col gap-3">
          <h2 id="titulo-propina" className="text-xl font-bold tracking-tight">
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
                elegida={caja.propina_sugerida === p}
                alElegir={() => cambiarPropina(p)}
              >
                {p === 0 ? 'Sin propina' : `${p / 100} %`}
              </Opcion>
            ))}
          </Grupo>
        </section>

        <section aria-labelledby="titulo-precuenta" className="flex flex-col gap-3">
          <h2 id="titulo-precuenta" className="text-xl font-bold tracking-tight">
            Impresora de precuentas
          </h2>
          <p className="text-texto-suave">
            Dónde sale la precuenta que pide el mesero o la caja. Sin impresora, se muestra en la
            pantalla.
          </p>
          <Grupo etiqueta="Impresora de precuentas" className="flex flex-col gap-2">
            <Opcion
              forma="tarjeta"
              elegida={elegida === null}
              alElegir={() => elegirImpresora(null)}
            >
              Solo en pantalla
            </Opcion>
            {impresoras.map((i) => (
              <Opcion
                key={i.id}
                forma="tarjeta"
                elegida={elegida === i.id}
                alElegir={() => elegirImpresora(i.id)}
                detalle={i.conexion === 'red' ? i.direccion : 'USB'}
              >
                {i.nombre}
              </Opcion>
            ))}
          </Grupo>
          {impresoras.length === 0 && (
            <p className="text-sm text-texto-suave">
              Agrega la impresora en «Cocina e impresoras» y luego elígela aquí.
            </p>
          )}
        </section>

        <section aria-labelledby="titulo-datafonos" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="titulo-datafonos" className="text-xl font-bold tracking-tight">
              Datáfonos
            </h2>
            <Boton
              icono="mas"
              onClick={() => setEditando({ nombre: '', proveedor: 'bold', activo: true })}
            >
              Agregar
            </Boton>
          </div>
          <p className="text-texto-suave">
            Al cobrar con tarjeta se elige en cuál se pasó; la caja recuerda el último.
          </p>
          <ul className="flex flex-col gap-2">
            {caja.datafonos.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setEditando(d)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-linea bg-superficie px-4 text-left hover:border-borde focus-visible:outline-3 focus-visible:outline-foco"
                >
                  <span className="flex-1 font-semibold">{d.nombre}</span>
                  <span className="text-texto-suave">
                    {PROVEEDORES.find((p) => p.valor === d.proveedor)?.nombre}
                  </span>
                  {!d.activo && <Etiqueta tono="neutro">Archivado</Etiqueta>}
                </button>
              </li>
            ))}
            {caja.datafonos.length === 0 && (
              <li className="text-texto-suave">
                Sin datáfonos: no se puede cobrar con tarjeta hasta agregar uno.
              </li>
            )}
          </ul>
        </section>
      </div>

      <EditarMedio
        key={editandoMedio?.id ?? (editandoMedio ? 'nuevo' : 'cerrado')}
        medio={editandoMedio}
        alCerrar={() => setEditandoMedio(null)}
        alGuardar={guardarMedio}
      />
      <EditarDatafono
        key={editando?.id ?? (editando ? 'nuevo' : 'cerrado')}
        datafono={editando}
        alCerrar={() => setEditando(null)}
        alGuardar={guardarDatafono}
      />
    </MarcoSala>
  )
}

function EditarDatafono({
  datafono,
  alCerrar,
  alGuardar,
}: {
  datafono: Datafono | null
  alCerrar: () => void
  alGuardar: (d: Datafono) => void
}) {
  const [nombre, setNombre] = useState(datafono?.nombre ?? '')
  const [proveedor, setProveedor] = useState<ProveedorDatafono>(datafono?.proveedor ?? 'bold')
  const valido = nombre.trim().length > 0
  const guardar = (activo: boolean) =>
    datafono && alGuardar({ ...datafono, nombre: nombre.trim(), proveedor, activo })
  return (
    <PanelLateral
      abierto={datafono !== null}
      titulo={datafono?.id ? 'Datáfono' : 'Datáfono nuevo'}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          <Boton variante="principal" grande disabled={!valido} onClick={() => guardar(true)}>
            {datafono?.id && !datafono.activo ? 'Volver a usarlo' : 'Guardar'}
          </Boton>
          {datafono?.id && datafono.activo && (
            <Boton variante="fantasma" onClick={() => guardar(false)}>
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
            value={nombre}
            placeholder="Bold de la barra"
            onChange={(e) => setNombre(e.target.value)}
          />
        </label>
        <Grupo etiqueta="Proveedor" className="flex flex-wrap gap-2">
          {PROVEEDORES.map((p) => (
            <Opcion
              key={p.valor}
              elegida={proveedor === p.valor}
              alElegir={() => setProveedor(p.valor)}
            >
              {p.nombre}
            </Opcion>
          ))}
        </Grupo>
      </div>
    </PanelLateral>
  )
}

function EditarMedio({
  medio,
  alCerrar,
  alGuardar,
}: {
  medio: MedioPropio | null
  alCerrar: () => void
  alGuardar: (m: MedioPropio) => void
}) {
  const [nombre, setNombre] = useState(medio?.nombre ?? '')
  const valido = nombre.trim().length > 0
  const guardar = (activo: boolean) =>
    medio && alGuardar({ ...medio, nombre: nombre.trim(), activo })
  return (
    <PanelLateral
      abierto={medio !== null}
      titulo={medio?.id ? 'Medio de pago' : 'Medio de pago nuevo'}
      alCerrar={alCerrar}
      pie={
        <div className="flex flex-col gap-2">
          <Boton variante="principal" grande disabled={!valido} onClick={() => guardar(true)}>
            {medio?.id && !medio.activo ? 'Volver a usarlo' : 'Guardar'}
          </Boton>
          {medio?.id && medio.activo && (
            <Boton variante="fantasma" onClick={() => guardar(false)}>
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
          value={nombre}
          placeholder="Sodexo"
          onChange={(e) => setNombre(e.target.value)}
        />
      </label>
    </PanelLateral>
  )
}
