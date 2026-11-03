import type { Tone } from '../ui/Label'

// What the dashboard says, without drawing it (task 1.11c-1): the comparison with the same weekday
// last week and the state of the data (from when, whether the restaurant is in touch, and whether
// something is still to come).

/** How often the dashboard asks the cloud while it is visible. */
export const EVERY_MS = 15_000

/** «9:41 p. m.» in the restaurant's time zone. */
export const timeOf = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(iso),
  )

/** «jueves» for a business day (YYYY-MM-DD, without time zone). */
export const weekdayOf = (day: string) =>
  new Intl.DateTimeFormat('es-CO', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  )

export interface Comparison {
  direction: 'up' | 'down' | 'same' | 'new'
  /** «+12,5 %», «-3 %»; null when there is nothing to compare against. */
  percent: string | null
  /** Up is good news (green); down is said plainly, without alarm (neutral), with its arrow. */
  tone: Tone
}

/**
 * Today against the same weekday last week up to the same time. Without sales back then there is
 * no percentage (it would divide by zero): today's are «new». The size is rounded and the sign goes
 * apart, so a rise and a fall of the same size read the same (half away from zero).
 */
export function compare(now: number, before: number): Comparison {
  if (now === before) return { direction: 'same', percent: '0 %', tone: 'neutral' }
  if (before === 0) return { direction: 'new', percent: null, tone: 'neutral' }
  const tenths = Math.round((Math.abs(now - before) * 1000) / Math.abs(before))
  const value = (tenths / 10).toLocaleString('es-CO')
  const up = now > before
  // A change that rounds to 0 % still says which way it went.
  return {
    direction: up ? 'up' : 'down',
    percent: `${up ? '+' : '-'}${value} %`,
    tone: up ? 'free' : 'neutral',
  }
}

/** The answer of the last request and whether the latest one failed. */
export interface Polled<T> {
  data: T | null
  /** The time of the last good answer (ISO, by the device's clock). */
  receivedAt: string | null
  failed: boolean
  error: string | null
  /** What kind of failure (`PanelError.kind`: 'offline', 'unauthorized'…), if known. */
  errorKind?: string | null
  /** Asks again now («Intentar ahora»), where the screen has one. */
  retry?: () => void
}

/**
 * Without news from the hub for longer than this, the restaurant has no internet (or the register
 * PC is off): it asks every 30 s while it is up to date (docs/PANEL.md#latido).
 */
export const NO_NEWS_MS = 2 * 60_000

export interface DataState {
  kind: 'up_to_date' | 'no_news' | 'offline' | 'failed' | 'nothing_yet'
  /** The main line: «Actualizado 9:41 p. m.», «Sin noticias del restaurante desde…». */
  text: string
  /** A second line that explains it: «Puede que la caja esté apagada…». */
  detail: string | null
  tone: Tone
  icon: 'cloud' | 'cloudOff' | 'warning'
  /** «Faltan 3 datos del local por llegar», if the hub still has some (and is in touch). */
  pending: string | null
  /** The time the figures are from, when they are not current; null if they are. */
  figuresAt: string | null
  /**
   * What a screen reader announces: it changes only when the state does, not with every
   * refresh of the time.
   */
  announcement: string
}

const pendingText = (n: number | null) =>
  n !== null && n > 0
    ? `${n === 1 ? 'Falta 1 dato' : `Faltan ${n} datos`} del local por llegar`
    : null

/** From when the panel's data is, and whether the hub still has changes to upload. */
export function dataState(
  local: {
    last_seen_at: string | null
    last_event_at: string | null
    pending: number | null
  } | null,
  {
    failed,
    receivedAt,
    now,
    cause = 'offline',
  }: {
    failed: boolean
    /** Why the last request failed: no internet, or something else (session, server). */
    cause?: 'offline' | 'other'
    receivedAt: string | null
    /** The cloud's time in its answer (`server_now`): the phone's clock may be off. */
    now: string | null
  },
  timeZone: string,
): DataState {
  /** «Las cifras son de las 9:38 p. m.» */
  const figuresOf = (at: string | null) =>
    // «p. m.» already ends the sentence: never «p. m..».
    at ? `Las cifras son de las ${at}${at.endsWith('.') ? '' : '.'}` : null
  if (failed && cause === 'other') {
    // Internet works but the figures did not come (the session closed, an error of the server).
    const at = receivedAt ? timeOf(receivedAt, timeZone) : null
    return {
      kind: 'failed',
      text: 'No se pudo actualizar',
      detail: figuresOf(at),
      tone: 'warning',
      icon: 'warning',
      pending: null,
      figuresAt: at,
      announcement: 'No se pudo actualizar',
    }
  }
  if (failed) {
    const at = receivedAt ? timeOf(receivedAt, timeZone) : null
    return {
      kind: 'offline',
      text: 'Sin conexión a internet: no llegan datos del restaurante',
      detail: figuresOf(at),
      tone: 'warning',
      icon: 'cloudOff',
      pending: null,
      figuresAt: at,
      announcement: 'Sin conexión a internet',
    }
  }
  const pending = local ? pendingText(local.pending) : null
  const since = local?.last_seen_at ?? local?.last_event_at ?? null
  if (!since)
    return {
      kind: 'nothing_yet',
      text: 'El restaurante todavía no ha enviado datos',
      detail: null,
      tone: 'neutral',
      icon: 'cloud',
      pending,
      figuresAt: null,
      announcement: 'El restaurante todavía no ha enviado datos',
    }
  const at = timeOf(since, timeZone)
  // Only the heartbeat says the restaurant is in touch: a quiet one sends no events for a while.
  const seen = local?.last_seen_at ?? null
  if (now && seen && Date.parse(now) - Date.parse(seen) > NO_NEWS_MS)
    return {
      kind: 'no_news',
      text: `Sin noticias del restaurante desde las ${at}`,
      detail: `Puede que la caja esté apagada o sin internet. ${figuresOf(at)}`,
      tone: 'warning',
      icon: 'cloudOff',
      // What it had to upload is not known any more: it is not shown.
      pending: null,
      figuresAt: at,
      announcement: 'Sin noticias del restaurante',
    }
  return {
    kind: 'up_to_date',
    text: `Actualizado ${at}`,
    detail: null,
    // What is still to come has its own amber line.
    tone: 'neutral',
    icon: 'cloud',
    pending,
    figuresAt: null,
    announcement: 'Cifras al día',
  }
}
