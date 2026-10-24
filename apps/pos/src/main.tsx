import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './estilos.css'
import { ProveedorAvisos } from './ui/avisos'
import { aplicarTema } from './ui/tema'

// Antes de pintar: así la pantalla no parpadea en blanco en el bar de noche.
aplicarTema()

const raiz = document.getElementById('raiz')
if (!raiz) throw new Error('No se encontró el elemento #raiz')

createRoot(raiz).render(
  <StrictMode>
    <ProveedorAvisos>
      <App />
    </ProveedorAvisos>
  </StrictMode>,
)
