import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fuentes empaquetadas (la app funciona sin internet): Figtree, la de Faro, y las de la marca de
// La Spritzzería, solo el juego latino, que cubre el español.
import '@fontsource-variable/figtree'
import '@fontsource/alegreya-sans/latin-400.css'
import '@fontsource/alegreya-sans/latin-500.css'
import '@fontsource/alegreya-sans/latin-700.css'
import '@fontsource/alegreya-sans/latin-800.css'
import '@fontsource/league-gothic/latin-400.css'
import { App } from './App'
import './estilos.css'
import { ProveedorAvisos } from './ui/avisos'
import { aplicarMarca } from './ui/marca'
import { aplicarTema } from './ui/tema'

// index.html ya lo hizo antes de pintar; esto cubre el caso en que el script no corrió.
aplicarMarca()
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
