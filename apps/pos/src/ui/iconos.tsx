import type { SVGProps } from 'react'

// Íconos de trazo simple, dibujados aquí (sin fuentes ni librerías: la app funciona sin internet).
// Siempre acompañan a un texto; los lectores de pantalla los ignoran.

const trazos = {
  check: 'M5 12l5 5L20 7',
  circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  serve: 'M4 17h16M6 17a6 6 0 0 1 12 0M12 8v3M3 20h18',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  warning:
    'M12 8v5m0 3.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zm3 5h6m-6 4h6m-6 4h3',
  broom: 'M14 4l6 6m-3-3-7 7m-1.5 1.5L4 21h6l3.5-3.5L9 13l-1.5 1.5z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4m8-4v4',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5v.5',
  noWifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M3 3l18 18',
  local: 'M3 12h3m12 0h3M12 3v3m0 12v3M7 7h10v10H7z',
  printer: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  close: 'M6 6l12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4-4',
  more: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  erase: 'M9 5h11v14H9l-6-7 6-7zm3 4 5 6m0-6-5 6',
  send: 'M4 12 20 4l-6 16-3-7-7-1z',
  people:
    'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-6 9a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6m2 15a6 6 0 0 0-3-5',
  fire: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 1 1 2 2 3 3 0-2 0-4 0-6z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  bill: 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v.5M18 13.5v.5',
  back: 'M15 5l-7 7 7 7',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5',
  floorPlan: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  table: 'M4 10h16M6 10v9M18 10v9M8 6h8M12 6v4',
  menu: 'M6 3h10l3 3v15H6zM9 8h6M9 12h6M9 16h4',
  orders: 'M8 4h8l1 2h3v15H4V6h3zM8 11h8M8 15h5',
  persona: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  llave: 'M15 9a4 4 0 1 1-1.2-2.8L21 3M17 5l2 2M12.2 12.2 4 20.5V21h3l1-1v-2h2v-2h2l.2-.2',
  exit: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  hamburger: 'M4 7h16M4 12h16M4 17h16',
  photo: 'M4 7h3l2-3h6l2 3h3v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  bag: 'M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2',
  motorcycle:
    'M5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm14 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 15h6l3-6h-4M15 6h3',
  glass: 'M7 3h10c0 5-2 8-5 8s-5-3-5-8zM12 11v8M8 21h8',
  dish: 'M3 14h18M5 14a7 7 0 0 1 14 0M12 5v2M2 18h20',
  brand:
    'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 12h.01M10 7.5h.01M15 7.5h.01',
  seat: 'M7 3v9h10V3M7 12v9m10-9v9M7 16h10',
  chart: 'M4 20h16M7 16v-4M12 16V6M17 16V9',
} as const

export type NombreIcono = keyof typeof trazos

export function Icono({ name, ...props }: { name: NombreIcono } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      width="1.25em"
      height="1.25em"
      {...props}
    >
      <path d={trazos[name]} />
    </svg>
  )
}
