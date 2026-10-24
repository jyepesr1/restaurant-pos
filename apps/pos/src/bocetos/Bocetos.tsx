import { Cobro } from './Cobro'
import { Componentes } from './Componentes'
import { Indice } from './Indice'
import { Kds } from './Kds'
import { Pedido } from './Pedido'
import { Plano } from './Plano'
import { Precuenta } from './Precuenta'

/** Las pantallas de los bocetos por ruta (`/bocetos/...`). Se cargan aparte: no pesan en la app. */
export default function Bocetos({ ruta }: { ruta: string }) {
  switch (ruta) {
    case '/bocetos/plano':
      return <Plano />
    case '/bocetos/pedido':
      return <Pedido />
    case '/bocetos/kds':
      return <Kds />
    case '/bocetos/precuenta':
      return <Precuenta />
    case '/bocetos/cobro':
      return <Cobro />
    case '/bocetos/componentes':
      return <Componentes />
    default:
      return <Indice />
  }
}
