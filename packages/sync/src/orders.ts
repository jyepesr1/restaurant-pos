// Which orders an event touches. It lives apart from the hub so the views (`./views`) can use it
// without bringing in the hub's code.

/** Orders an event touches: its aggregate, the related ones and those the hub put in `affects`. */
export const ordersOf = (e: {
  aggregate_id: string
  related: readonly string[]
  affects?: readonly string[]
}) => [...new Set([e.aggregate_id, ...e.related, ...(e.affects ?? [])])]
