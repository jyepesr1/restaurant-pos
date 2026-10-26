import { Cobro } from './Cobro'
import { Componentes } from './Componentes'
import { Indice } from './Indice'
import { Kds } from './Kds'
import { Order } from './Pedido'
import { Plano } from './Plano'
import { PreBill } from './Precuenta'

/** Las pantallas de los bocetos por ruta (`/bocetos/...`). Se cargan aparte: no pesan en la app. */
export default function Bocetos({ ruta }: { ruta: string }) {
  switch (ruta) {
    case '/mockups/floor-plan':
      return <Plano />
    case '/mockups/order':
      return <Order />
    case '/mockups/kds':
      return <Kds />
    case '/mockups/pre-bill':
      return <PreBill />
    case '/mockups/checkout':
      return <Cobro />
    case '/mockups/components':
      return <Componentes />
    default:
      return <Indice />
  }
}
