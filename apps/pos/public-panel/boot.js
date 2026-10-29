// Before painting (a file, not inline, so the CSP allows only 'self'): the restaurant's brand and
// dark mode, so there is no flash. The same keys as src/ui/brand.ts and src/ui/theme.ts.
try {
  const brand = localStorage.getItem('pos-brand') || 'faro'
  if (brand !== 'faro') document.documentElement.dataset.brand = brand
} catch {}
try {
  const theme = localStorage.getItem('pos-theme')
  if (theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark')
} catch {}
