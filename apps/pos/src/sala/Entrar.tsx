import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Boton } from '../ui/Boton'
import { TecladoPin } from '../ui/TecladoPin'
import { ErrorApi } from './api'
import { sala, useSala } from './contexto'
import { MarcoSala } from './MarcoSala'

// Entrar (ADR-013). Desde cualquier navegador de la red, sin emparejarlo: los meseros con su PIN;
// administración, caja y reportes con usuario y contraseña. Lo comprueba el hub: hace falta
// conexión para entrar, no para trabajar después (lo hecho sin conexión con la sesión abierta vale).

export const claseCampo =
  'min-h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-lg disabled:opacity-60 focus-visible:outline-3 focus-visible:outline-foco'

type Modo = 'pin' | 'contrasena'

/** Cómo se entró la última vez en este equipo: la próxima vez abre igual. */
const CLAVE_MODO = 'pos:entrar-con'
function modoRecordado(): Modo | null {
  try {
    const m = localStorage.getItem(CLAVE_MODO)
    return m === 'pin' || m === 'contrasena' ? m : null
  } catch {
    return null
  }
}
function recordarModo(m: Modo) {
  try {
    localStorage.setItem(CLAVE_MODO, m)
  } catch {
    // Sin almacenamiento se sigue sin recordarlo.
  }
}

export function Entrar() {
  const { equipo, sesionCerradaPor, catalogo } = useSala()
  // Como la última vez en este equipo; si no hay, en la caja con contraseña y en un celular con PIN.
  const [modo, setModo] = useState<Modo>(
    () => modoRecordado() ?? (equipo?.tipo === 'caja' ? 'contrasena' : 'pin'),
  )
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)
  const [esperaMs, setEsperaMs] = useState(0)
  const [ocupado, setOcupado] = useState(false)

  const intentar = async (datos: string | { usuario: string; contrasena: string }) => {
    setOcupado(true)
    try {
      await sala.entrar(datos)
      recordarModo(typeof datos === 'string' ? 'pin' : 'contrasena')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo falló. Intenta de nuevo.')
      setEsperaMs(e instanceof ErrorApi ? e.esperaMs : 0)
      setIntento((i) => i + 1)
      setOcupado(false)
    }
  }
  const cambiarModo = (m: Modo) => {
    setModo(m)
    setError(null)
    setEsperaMs(0)
  }

  const porInactividad = sesionCerradaPor === 'inactividad'
  return (
    <MarcoSala titulo={catalogo?.restaurante.nombre ?? equipo?.nombre ?? 'Entrar'}>
      <div className="mx-auto flex max-w-sm flex-col gap-6 p-4">
        {modo === 'pin' ? (
          <>
            <TecladoPin
              titulo={
                porInactividad
                  ? 'Se cerró tu sesión por no usarla un rato. Escribe tu PIN'
                  : 'Escribe tu PIN'
              }
              error={error}
              intento={intento}
              esperaMs={esperaMs}
              ocupado={ocupado}
              alCompletar={(pin) => void intentar(pin)}
            />
            <Boton variante="fantasma" onClick={() => cambiarModo('contrasena')}>
              Caja, administración o reportes: entrar con usuario y contraseña
            </Boton>
          </>
        ) : (
          <>
            <ConContrasena
              titulo={porInactividad ? 'Se cerró tu sesión por no usarla un rato' : 'Entrar'}
              error={error}
              intento={intento}
              esperaMs={esperaMs}
              ocupado={ocupado}
              alEnviar={(usuario, contrasena) => void intentar({ usuario, contrasena })}
            />
            <Boton variante="fantasma" onClick={() => cambiarModo('pin')}>
              Mesero: entrar con PIN
            </Boton>
            <p className="text-sm text-texto-suave">
              ¿Olvidaste tu contraseña? Pídele a otra persona que administre el personal que te
              ponga una nueva. Si no hay nadie, quien instaló el sistema te la cambia desde el
              computador de la caja.
            </p>
          </>
        )}
      </div>
    </MarcoSala>
  )
}

function ConContrasena({
  titulo,
  error,
  intento,
  esperaMs,
  ocupado,
  alEnviar,
}: {
  titulo: string
  error: string | null
  intento: number
  esperaMs: number
  ocupado: boolean
  alEnviar: (usuario: string, contrasena: string) => void
}) {
  const [usuario, setUsuario] = useState('')
  const [contrasena, setContrasena] = useState('')
  const [restante, setRestante] = useState(0)
  const campoContrasena = useRef<HTMLInputElement>(null)
  const [falta, setFalta] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `intento` reinicia la espera aunque dure lo mismo
  useEffect(() => {
    setRestante(esperaMs)
    if (esperaMs <= 0) return
    const fin = Date.now() + esperaMs
    const reloj = setInterval(() => {
      const queda = Math.max(0, fin - Date.now())
      setRestante(queda)
      if (queda === 0) clearInterval(reloj)
    }, 250)
    return () => clearInterval(reloj)
  }, [esperaMs, intento])

  // Tras un error se vuelve a escribir la contraseña; el usuario se conserva.
  useEffect(() => {
    if (intento === 0) return
    setContrasena('')
    campoContrasena.current?.focus()
  }, [intento])

  const bloqueado = ocupado || restante > 0
  const enviar = (e: FormEvent) => {
    e.preventDefault()
    if (bloqueado) return
    if (!usuario.trim() || !contrasena) {
      setFalta(!usuario.trim() ? 'Escribe tu usuario' : 'Escribe tu contraseña')
      return
    }
    setFalta(null)
    alEnviar(usuario, contrasena)
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={enviar} aria-labelledby="titulo-entrar">
      <h2 id="titulo-entrar" className="text-center text-xl font-semibold">
        {titulo}
      </h2>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Usuario</span>
        <input
          className={claseCampo}
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
          autoComplete="username"
          // biome-ignore lint/a11y/noAutofocus: es lo único que hay que hacer en esta pantalla
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-semibold">Contraseña</span>
        <input
          className={claseCampo}
          ref={campoContrasena}
          type="password"
          value={contrasena}
          onChange={(e) => setContrasena(e.target.value)}
          autoComplete="current-password"
          enterKeyHint="go"
          maxLength={200}
        />
      </label>
      {/* Solo se anuncia el cambio de mensaje, no cada segundo de la cuenta atrás. */}
      <p key={intento} className="min-h-6 text-center text-alerta-texto" role="alert">
        {restante > 0 ? 'Demasiados intentos.' : ocupado ? 'Comprobando…' : (falta ?? error ?? '')}
      </p>
      {restante > 0 && (
        <p className="cifras text-center text-texto-suave" aria-hidden="true">
          {`Espera ${Math.ceil(restante / 1000)} s`}
        </p>
      )}
      <Boton type="submit" variante="principal" grande disabled={bloqueado}>
        {ocupado ? 'Entrando…' : 'Entrar'}
      </Boton>
    </form>
  )
}
