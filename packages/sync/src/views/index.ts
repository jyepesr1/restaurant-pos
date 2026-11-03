// The views computed from the events (task 1.11c-2): the devices and the cloud share them. Also
// exported as `@pos/sync/views`, so the owner's panel takes only this and not the hub's code.

export {
  currentItems,
  isCurrent,
  occupiesTable,
  openOrders,
  type TableStatus,
  tableStatus,
  type VisibleOrder,
} from './floor'
export { type Delay, delay, type KitchenTicket, kitchenTickets, timersOf } from './kitchen'
