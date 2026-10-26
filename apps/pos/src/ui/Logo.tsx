// The Faro logo: the lighthouse in its teal square, with its light beam. It is drawn here (not an
// image) to take the theme colors; with a restaurant's brand, its logo replaces it.

export function FaroMark({ className = 'size-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <rect width="48" height="48" rx="13" className="fill-accion-fuerte" />
      <path d="M27 17 44 10v17l-17-5z" fill="#fff" fillOpacity=".34" />
      <path d="M20 16h8l2.5 23h-13z" fill="#fff" />
      <rect x="19.5" y="10" width="9" height="5" rx="1.5" fill="#fff" />
      <path d="M18.2 27.5h11.6M17.6 33.2h12.8" strokeWidth="2.2" className="stroke-accion-fuerte" />
    </svg>
  )
}

/** Logo with name: Faro's or, with its brand set, the restaurant's. */
export function Logo({
  name,
  brand,
  brandOnly = false,
}: {
  name?: string
  brand?: string | null
  /** Just the drawing, without name (the tablet's narrow sidebar). */
  brandOnly?: boolean
}) {
  const withBrand = brand === 'la-spritzzeria'
  return (
    <span className="flex items-center gap-2.5">
      {withBrand ? (
        // La Spritzzería's badge: its logo in the cream circle, as on the menu.
        <img
          src="/marca/la-spritzzeria.svg"
          alt=""
          className="size-10 rounded-full border-2 border-marca bg-[#fff8ec] p-0.5"
        />
      ) : (
        <FaroMark />
      )}
      <span className={`flex flex-col leading-tight ${brandOnly ? 'sr-only' : ''}`}>
        <span className="font-titulo text-xl font-bold tracking-tight">{name ?? 'Faro'}</span>
        {name && !withBrand && (
          <span className="text-sm font-medium text-texto-suave">con Faro</span>
        )}
      </span>
    </span>
  )
}
