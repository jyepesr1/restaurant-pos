// El logo de Faro: el faro en su cuadro verde azulado, con su haz de luz. Se dibuja aquí (no es una
// imagen) para tomar los colores del tema; con la marca de un restaurante, su logo lo reemplaza.

export function MarcaFaro({ className = 'size-9' }: { className?: string }) {
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

/** Logo con nombre: el de Faro o, con su marca puesta, el del restaurante. */
export function Logo({
  nombre,
  marca,
  soloMarca = false,
}: {
  nombre?: string
  marca?: string | null
  /** Solo el dibujo, sin nombre (la barra lateral angosta de la tablet). */
  soloMarca?: boolean
}) {
  const conMarca = marca === 'la-spritzzeria'
  return (
    <span className="flex items-center gap-2.5">
      {conMarca ? (
        // La insignia de La Spritzzería: su logo en el círculo crema, como en la carta.
        <img
          src="/marca/la-spritzzeria.svg"
          alt=""
          className="size-10 rounded-full border-2 border-marca bg-[#fff8ec] p-0.5"
        />
      ) : (
        <MarcaFaro />
      )}
      <span className={`flex flex-col leading-tight ${soloMarca ? 'sr-only' : ''}`}>
        <span className="font-titulo text-xl font-bold tracking-tight">{nombre ?? 'Faro'}</span>
        {nombre && !conMarca && (
          <span className="text-sm font-medium text-texto-suave">con Faro</span>
        )}
      </span>
    </span>
  )
}
