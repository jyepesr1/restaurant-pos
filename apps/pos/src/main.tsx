import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts (the app works without internet): Figtree, Faro's own, and the ones from
// La Spritzzería's brand, only the Latin subset, which covers Spanish.
import '@fontsource-variable/figtree'
import '@fontsource/alegreya-sans/latin-400.css'
import '@fontsource/alegreya-sans/latin-500.css'
import '@fontsource/alegreya-sans/latin-700.css'
import '@fontsource/alegreya-sans/latin-800.css'
import '@fontsource/league-gothic/latin-400.css'
import { App } from './App'
import './styles.css'
import { applyBrand } from './ui/brand'
import { applyTheme } from './ui/theme'
import { ToastProvider } from './ui/toasts'

// index.html already did this before painting; this covers the case where the script did not run.
applyBrand()
applyTheme()

const root = document.getElementById('root')
if (!root) throw new Error('No se encontró el elemento #raiz')

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)
