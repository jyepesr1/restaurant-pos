import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts, as in the register: Faro's and the ones of La Spritzzería's brand (Latin subset).
// The restaurant's brand comes when signing in (`Me`).
import '@fontsource-variable/figtree'
import '@fontsource/alegreya-sans/latin-400.css'
import '@fontsource/alegreya-sans/latin-500.css'
import '@fontsource/alegreya-sans/latin-700.css'
import '@fontsource/alegreya-sans/latin-800.css'
import '@fontsource/league-gothic/latin-400.css'
import '../styles.css'
import { applyBrand } from '../ui/brand'
import { applyTheme } from '../ui/theme'
import { ToastProvider } from '../ui/toasts'
import { PanelApp } from './PanelApp'
import { rememberRestaurant, slugFromPath } from './restaurant'

// The owner's panel in the cloud (task 1.11c-1): a second entry of the app, `panel.html`.

// panel.html (boot.js) already did this before painting; this covers the case where it did not run.
applyBrand()
applyTheme()

// `/r/<slug>` leaves the restaurant written in on this phone and goes on to the panel.
const slug = slugFromPath(location.pathname)
if (slug) {
  rememberRestaurant(slug)
  history.replaceState(null, '', '/')
}

const root = document.getElementById('root')
if (!root) throw new Error('No se encontró el elemento #root')

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <PanelApp />
    </ToastProvider>
  </StrictMode>,
)
