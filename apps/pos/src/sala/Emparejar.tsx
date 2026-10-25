import type { TipoDispositivo } from '@pos/sync'
import { useState } from 'react'
import { Boton } from '../ui/Boton'
import { Grupo, Opcion } from '../ui/Opciones'
import { TecladoPin } from '../ui/TecladoPin'
import { ErrorApi } from './api'
import { sala } from './contexto'

// Emparejar este equipo con el hub (ADR-008). Lo normal: la caja muestra un código y aquí se
// escribe. El primer equipo de un hub recién instalado (la caja) se aprueba con el PIN del
// administrador que imprimió el hub al arrancar.

export const TIPOS: { tipo: TipoDispositivo; nombre: string }[] = [
  { tipo: 'mesero', nombre: 'Celular o tablet de mesero' },
  { tipo: 'caja', nombre: 'Caja' },
  { tipo: 'kds', nombre: 'Pantalla de cocina' },
]

const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')

export function Emparejar({ codigoInicial = '' }: { codigoInicial?: string }) {
  const [modo, setModo] = useState<'codigo' | 'primero'>('codigo')
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-4 pt-10">
      <div className="flex items-center gap-3">
        <img
          src="/marca/la-spritzzeria.svg"
          alt=""
          className="logo-marca size-14 rounded-full border-2 border-marca bg-[#fff8ec] p-0.5"
        />
        <h1 className="font-titulo text-3xl font-semibold">Emparejar este equipo</h1>
      </div>
      <Grupo etiqueta="Cómo emparejar" className="flex flex-wrap gap-2">
        <Opcion elegida={modo === 'codigo'} alElegir={() => setModo('codigo')}>
          Tengo un código
        </Opcion>
        <Opcion elegida={modo === 'primero'} alElegir={() => setModo('primero')}>
          Es el primer equipo
        </Opcion>
      </Grupo>
      {modo === 'codigo' ? <ConCodigo inicial={codigoInicial} /> : <Primero />}
      <nav className="mt-auto">
        <a
          href="/diagnostico"
          className="inline-flex min-h-12 items-center text-texto-suave underline"
        >
          Diagnóstico del equipo
        </a>
      </nav>
    </main>
  )
}

function ConCodigo({ inicial }: { inicial: string }) {
  const [codigo, setCodigo] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const enviar = async () => {
    setOcupado(true)
    setError(null)
    try {
      await sala.emparejar(codigo)
      // El código ya se usó: que no quede en la dirección.
      history.replaceState(null, '', '/')
    } catch (e) {
      setError(mensajeDe(e))
      setOcupado(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void enviar()
      }}
    >
      <p className="text-texto-suave">
        En la caja, abre <strong>Equipos</strong>, aprueba este equipo con el PIN del administrador
        y escribe aquí el código que aparece.
      </p>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Código</span>
        <input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.toUpperCase())}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          className="font-titulo min-h-14 rounded-xl border border-borde bg-superficie px-4 text-3xl tracking-[0.3em] uppercase focus-visible:outline-3 focus-visible:outline-foco"
        />
      </label>
      <p className="min-h-6 text-alerta-texto" role="alert">
        {error ?? ''}
      </p>
      <Boton
        type="submit"
        variante="principal"
        grande
        disabled={ocupado || codigo.trim().length < 4}
      >
        {ocupado ? 'Emparejando…' : 'Emparejar'}
      </Boton>
    </form>
  )
}

/** Nombre y tipo del equipo; los usan el primer equipo y la caja al aprobar otro. */
export function DatosEquipo({
  nombre,
  tipo,
  alCambiarNombre,
  alCambiarTipo,
}: {
  nombre: string
  tipo: TipoDispositivo
  alCambiarNombre: (n: string) => void
  alCambiarTipo: (t: TipoDispositivo) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Nombre del equipo</span>
        <input
          value={nombre}
          onChange={(e) => alCambiarNombre(e.target.value)}
          maxLength={60}
          placeholder="Celular de Ana"
          className="min-h-12 rounded-xl border border-borde bg-superficie px-4 text-lg focus-visible:outline-3 focus-visible:outline-foco"
        />
      </label>
      <Grupo etiqueta="Tipo de equipo" className="flex flex-col gap-2">
        {TIPOS.map((t) => (
          <Opcion
            key={t.tipo}
            forma="tarjeta"
            elegida={tipo === t.tipo}
            alElegir={() => alCambiarTipo(t.tipo)}
          >
            {t.nombre}
          </Opcion>
        ))}
      </Grupo>
    </div>
  )
}

function Primero() {
  const [nombre, setNombre] = useState('Caja')
  const [tipo, setTipo] = useState<TipoDispositivo>('caja')
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [esperaMs, setEsperaMs] = useState(0)
  const [ocupado, setOcupado] = useState(false)

  const enviar = async (pin: string) => {
    if (!nombre.trim()) {
      setError('Primero escribe el nombre del equipo')
      setIntento((i) => i + 1)
      return
    }
    setOcupado(true)
    try {
      await sala.emparejarPrimero(pin, nombre, tipo)
    } catch (e) {
      setError(mensajeDe(e))
      setEsperaMs(e instanceof ErrorApi ? e.esperaMs : 0)
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-texto-suave">
        Solo para el primer equipo de un hub nuevo, normalmente la caja. El PIN del administrador
        aparece en la ventana del hub al instalarlo; si el hub no tiene ventana, queda en el archivo
        pin-administrador.txt de su carpeta de datos.
      </p>
      <DatosEquipo
        nombre={nombre}
        tipo={tipo}
        alCambiarNombre={setNombre}
        alCambiarTipo={setTipo}
      />
      <TecladoPin
        titulo="PIN del administrador"
        error={error}
        intento={intento}
        esperaMs={esperaMs}
        ocupado={ocupado}
        alCompletar={(pin) => void enviar(pin)}
      />
    </div>
  )
}
