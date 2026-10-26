import { useEffect, useState } from 'react'
import { Boton } from '../ui/Boton'
import { aplicarMarca, esMarca } from '../ui/marca'
import { Caja } from './Caja'
import { CajaAjustes } from './CajaAjustes'
import { Carta } from './Carta'
import { AvisoListos, PantallaCocina, PedidosEnCocina } from './Cocina'
import { CocinaAjustes } from './CocinaAjustes'
import { Cuenta } from './Cuenta'
import { sala, useSala } from './contexto'
import { Entrar } from './Entrar'
import { Marca } from './Marca'
import { MarcoSala } from './MarcoSala'
import { Mesas } from './Mesas'
import { Personal } from './Personal'
import { PlanoEditor } from './PlanoEditor'
import { Reportes } from './Reportes'
import { TomaPedido } from './TomaPedido'

// La app de operación: entrar (con PIN o con usuario y contraseña, ADR-013) y trabajar (mesas,
// pedido, carta, plano y personal). Abre la sala al arrancar y le avisa cuando la pantalla se
// oculta o vuelve (ADR-001).

const REVISAR_SESION_MS = 30_000

export function Operacion({ ruta, parametros }: { ruta: string; parametros: URLSearchParams }) {
  const estado = useSala()
  // La marca del restaurante llega con la carta: cuando cambia, todo el equipo se ve con ella.
  // Sin carta todavía (se está leyendo, o el equipo recién entra) se deja la que pintó index.html.
  const conCarta = estado.catalogo !== null
  const marca = estado.catalogo?.restaurante.marca
  useEffect(() => {
    if (conCarta) aplicarMarca(esMarca(marca) ? marca : 'faro')
  }, [conCarta, marca])

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
  // Sin equipo todavía, entrar lo registra en el hub (ya no se empareja antes).
  if (!estado.equipo || !estado.sesion) return <Entrar />
  if (!estado.catalogo) return <SinCatalogo />
  // Una pantalla de cocina no ve nada más (ADR-015).
  if (estado.equipo.tipo === 'kds') return <PantallaCocina />
  return (
    <>
      <AvisoListos />
      <Pantalla ruta={ruta} parametros={parametros} permisos={estado.sesion.permisos} />
    </>
  )
}

function Pantalla({
  ruta,
  parametros,
  permisos,
}: {
  ruta: string
  parametros: URLSearchParams
  permisos: string[]
}) {
  if (ruta === '/cocina/ajustes' && permisos.includes('administrar_dispositivos'))
    return <CocinaAjustes />
  if (ruta === '/caja/ajustes' && permisos.includes('administrar_dispositivos'))
    return <CajaAjustes />
  if (ruta === '/caja') return <Caja />
  if (ruta === '/reportes' && permisos.includes('ver_reportes')) return <Reportes />
  if (ruta === '/cuenta') return <Cuenta key={parametros.get('pedido')} />
  if (ruta === '/cocina') return <PedidosEnCocina />
  if (ruta === '/personal' && permisos.includes('administrar_usuarios')) return <Personal />
  if (ruta === '/marca' && permisos.includes('administrar_usuarios')) return <Marca />
  if (ruta === '/carta') return <Carta />
  if (ruta === '/plano') return <PlanoEditor />
  if (ruta === '/pedido') return <TomaPedido key={parametros.get('mesa')} />
  return <Mesas />
}

function EquipoRechazado({ codigo, mensaje }: { codigo: string; mensaje: string }) {
  const { pendientes } = useSala()
  const [confirmando, setConfirmando] = useState(false)
  useEffect(() => {
    document.title = 'Equipo rechazado · Faro'
  }, [])
  const olvidar = () => void sala.olvidarEquipo()
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="font-titulo text-3xl font-semibold">
        Este equipo no puede entrar al POS del restaurante
      </h1>
      <p role="alert">{mensaje}</p>
      {codigo === 'app_vieja' ? (
        <Boton variante="principal" grande onClick={() => location.reload()}>
          Recargar la app
        </Boton>
      ) : pendientes === 0 ? (
        <Boton variante="principal" grande onClick={olvidar}>
          Entrar de nuevo
        </Boton>
      ) : (
        <>
          {/* Lo pendiente lleva el equipo viejo: entrar de nuevo registra otro y el hub lo rechaza. */}
          <p>
            {`Hay ${pendientes === 1 ? 'un cambio' : `${pendientes} cambios`} de este equipo (pedidos, cobros) que la caja todavía no recibe. `}
            {codigo === 'token_revocado'
              ? 'Si hay Wi-Fi, se siguen enviando para que un administrador los revise: espera a que el número llegue a 0.'
              : 'Si entras de nuevo, no llegarán a la caja. Avisa a un administrador antes.'}
          </p>
          {confirmando ? (
            <Boton variante="peligro" grande onClick={olvidar}>
              {`Entrar de nuevo sin ${pendientes === 1 ? 'ese cambio' : `esos ${pendientes}`}`}
            </Boton>
          ) : (
            <Boton variante="secundario" grande onClick={() => setConfirmando(true)}>
              Entrar de nuevo de todas formas
            </Boton>
          )}
        </>
      )}
    </main>
  )
}

/** Recién se entró pero no llegó la carta (se cortó justo): reintentar. */
function SinCatalogo() {
  const [error, setError] = useState<string | null>(null)
  return (
    <MarcoSala titulo="Salón">
      <div className="flex flex-col items-start gap-3 p-6">
        <p>Falta traer la carta y las mesas del restaurante.</p>
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
