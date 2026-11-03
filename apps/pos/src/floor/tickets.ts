// What is in the kitchen (ADR-015). The projection lives in `@pos/sync/views` (task 1.11c-2: the
// owner's panel computes it in the cloud with the same code); it is re-exported here so nothing
// else changes.

export {
  type Delay,
  delay,
  type KitchenTicket,
  kitchenTickets,
  timersOf,
} from '@pos/sync/views'
