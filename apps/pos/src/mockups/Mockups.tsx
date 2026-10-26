import { Checkout } from './Checkout'
import { Components } from './Components'
import { FloorPlan } from './FloorPlan'
import { Index } from './Index'
import { Kds } from './Kds'
import { Order } from './Order'
import { PreBill } from './PreBill'

/** The mockup screens by route (`/mockups/...`). Loaded separately: no weight added to the app. */
export default function Mockups({ route }: { route: string }) {
  switch (route) {
    case '/mockups/floor-plan':
      return <FloorPlan />
    case '/mockups/order':
      return <Order />
    case '/mockups/kds':
      return <Kds />
    case '/mockups/pre-bill':
      return <PreBill />
    case '/mockups/checkout':
      return <Checkout />
    case '/mockups/components':
      return <Components />
    default:
      return <Index />
  }
}
