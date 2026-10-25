import { useEffect, useState } from 'react'
import { Boton } from '../ui/Boton'
import { Carta } from './Carta'
import { sala, useSala } from './contexto'
import { Emparejar } from './Emparejar'
import { Entrar } from './Entrar'
import { Equipos } from './Equipos'
import { MarcoSala } from './MarcoSala'
import { Mesas } from './Mesas'
import { TomaPedido } from './TomaPedido'

// La app de operación: emparejar el equipo, entrar con el PIN y trabajar (mesas y pedido). Abre
// la sala al arrancar y le avisa cuando la pantalla se oculta o vuelve (ADR-001).

const REVISAR_SESION_MS = 30_000

export function Operacion({ ruta, parametros }: { ruta: string; parametros: URLSearchParams }) {
  const estado = useSala()

  useEffect(() => {
    sala.cargar().catch((e) => console.error('No se pudo abrir la base del equipo:', e))
    const alCambiarVisibilidad = () => sala.cambiarVisibilidad(!document.hidden)
    const alTocar = () => sala.usar()
    const revisar = setInterval(() => sala.vencerSesionSiToca(), REVISAR_SESION_MS)
    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    window.addEventListener('pointerdown', alTocar, { passive: true })
    return () => {
      clearInterval(revisar)
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      window.removeEventListener('pointerdown', alTocar)
    }
  }, [])

  if (!estado.cargado) return <p className="p-6 text-texto-suave">Cargando…</p>
  if (estado.errorHub && estado.errorHub.codigo !== 'mensaje_invalido')
    return <EquipoRechazado mensaje={estado.errorHub.mensaje} codigo={estado.errorHub.codigo} />
  if (!estado.equipo) return <Emparejar codigoInicial={parametros.get('codigo') ?? ''} />
  if (!estado.sesion) return <Entrar />
  if (!estado.catalogo) return <SinCatalogo />
  if (ruta === '/equipos') return <Equipos />
  if (ruta === '/carta') return <Carta />
  if (ruta === '/pedido') return <TomaPedido key={parametros.get('mesa')} />
  return <Mesas />
}

function EquipoRechazado({ codigo, mensaje }: { codigo: string; mensaje: string }) {
  const { pendientes } = useSala()
  const [confirmando, setConfirmando] = useState(false)
  useEffect(() => {
    document.title = 'Equipo rechazado · POS'
  }, [])
  const olvidar = () => void sala.olvidarEquipo()
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="font-titulo text-3xl font-semibold">El hub no acepta este equipo</h1>
      <p role="alert">{mensaje}</p>
      {codigo === 'app_vieja' ? (
        <Boton variante="principal" grande onClick={() => location.reload()}>
          Recargar la app
        </Boton>
      ) : pendientes === 0 ? (
        <Boton variante="principal" grande onClick={olvidar}>
          Emparejar de nuevo
        </Boton>
      ) : (
        <>
          {/* Lo pendiente lleva el equipo viejo: con un emparejamiento nuevo el hub lo rechaza. */}
          <p>
            {`Hay ${pendientes === 1 ? 'una acción' : `${pendientes} acciones`} de este equipo que el hub no ha recibido. `}
            {codigo === 'token_revocado'
              ? 'Mientras haya conexión se siguen entregando al hub para que un administrador las revise: espera a que el número llegue a 0.'
              : 'Si emparejas de nuevo, no llegarán al hub. Avisa a un administrador antes.'}
          </p>
          {confirmando ? (
            <Boton variante="peligro" grande onClick={olvidar}>
              {`Emparejar de nuevo sin ${pendientes === 1 ? 'esa acción' : `esas ${pendientes}`}`}
            </Boton>
          ) : (
            <Boton variante="secundario" grande onClick={() => setConfirmando(true)}>
              Emparejar de nuevo de todas formas
            </Boton>
          )}
        </>
      )}
    </main>
  )
}

/** Recién se entró con el PIN pero no llegó la carta (se cortó justo): reintentar. */
function SinCatalogo() {
  const [error, setError] = useState<string | null>(null)
  return (
    <MarcoSala titulo="Salón">
      <div className="flex flex-col items-start gap-3 p-6">
        <p>Falta traer la carta y las mesas del hub.</p>
        <p className="text-alerta-texto" role="alert">
          {error ?? ''}
        </p>
        <Boton
          variante="principal"
          onClick={() =>
            sala
              .actualizarCatalogo()
              .then(() => setError(null))
              .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo'))
          }
        >
          Traer la carta
        </Boton>
      </div>
    </MarcoSala>
  )
}
