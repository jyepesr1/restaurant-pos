import type { CashRoundingMode, PaymentMethod } from '@pos/core'

// What the hub serves at `GET /api/catalog`: the current catalog and dining room. In Phase 1 it
// syncs by version (docs/SYNC.md#catálogo-y-configuración); for now it goes whole.

export interface Catalog {
  /** Value of the global catalog counter: goes as `catalog_version` on each item. */
  version: number
  restaurant: {
    name: string
    /** Idle minutes after which the device asks for the PIN again. */
    sessionIdleMin: number
    /** The brand the POS shows (task 1.3c); without it, Faro. */
    brand?: string | null
    /** Minutes since sending after which kitchen items turn amber and red (ADR-015). */
    kitchenYellowMin?: number
    kitchenRedMin?: number
    /** Whether orders are taken by course (starter, main, dessert). Without the value, no. */
    coursesEnabled?: boolean
    /**
     * Checkout rules (task 1.6, docs/DINERO.md): accepted methods, suggested tip in basis
     * points, and rounding. A hub from before 1.6 does not send them: then there is no checkout.
     */
    checkout?: {
      paymentMethods: PaymentMethod[]
      /** The methods the restaurant created (Sodexo, bank QR), active ones. */
      customMethods?: { id: string; name: string }[]
      /** The archived ones: no longer offered at checkout, but their payments still name them. */
      archivedCustomMethods?: { id: string; name: string }[]
      suggestedTip: number
      roundingMode: 'half_up' | 'half_even'
      cashRounding: number
      cashRoundingMode: CashRoundingMode
      /** Whether the pre-bill is printed; if not, it is only shown on screen. */
      printsPreBill: boolean
      /** From what variance the register close asks for a justification (task 1.7). */
      varianceThreshold?: number
      /** To know the business day on the device (the tip payout says which day it comes from). */
      timeZone?: string
      businessDayStart?: string
    }
  }
  /** The restaurant's card terminals (task 1.6), to tell which one charged a card. */
  cardTerminals?: { id: string; name: string; provider?: string }[]
  /** Zones or floors of the dining room, in order. */
  zones: { id: string; name: string; level: number }[]
  /** Geometry in centimeters: top-left corner, size, and rotation in degrees. */
  tables: {
    id: string
    zoneId: string
    name: string
    x: number
    y: number
    width: number
    height: number
    rotation: number
    shape: 'round' | 'square' | 'rectangular' | 'bar'
    capacity: number
  }[]
  /** Walls, doors, plants, the bar, and floor plan labels, with the same geometry. */
  elements: {
    id: string
    zoneId: string
    type: 'wall' | 'door' | 'plant' | 'bar' | 'text'
    text: string | null
    x: number
    y: number
    width: number
    height: number
    rotation: number
  }[]
  /** Who serves (to show each table's waiter); name only, no credentials. */
  staff: { id: string; name: string }[]
  /**
   * Kitchen, bar… How each one receives (ADR-015): `prints` if it has an active printer,
   * `screen` if a kitchen screen shows it. A hub from before 1.4 does not send them.
   */
  stations: { id: string; name: string; prints?: boolean; screen?: boolean }[]
  /** The kitchen screens and what each one shows (so each screen knows its own). */
  screens?: { deviceId: string; name: string; stationIds: string[] }[]
  categories: {
    id: string
    name: string
    stationId: string | null
    products: {
      id: string
      name: string
      description: string | null
      /** Shows up in "Favoritos" during order entry. */
      favorite: boolean
      /** Path of its photo on the hub (task 1.3c), or nothing: then the icon is shown. */
      photo?: string | null
      price: number
      tax: { type: 'inc' | 'iva' | 'exempt'; rate: number }
      variants: { id: string; name: string; price: number }[]
      groups: {
        id: string
        name: string
        minimum: number
        maximum: number
        options: { id: string; name: string; extraPrice: number }[]
      }[]
    }[]
  }[]
}
