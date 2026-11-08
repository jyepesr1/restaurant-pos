import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

// Test utilities for the installed hub (task 1.13): start the bundled `hub.mjs` / `reset.mjs`
// the way the Windows service does (DATA_DIR and APP_DIR, no window, output to pipes), wait for
// things to happen with a limit instead of sleeping, and talk to it over HTTP.

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  ms = 15_000,
) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`Never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export interface Proc {
  child: ChildProcess
  output: () => string
  /** Resolves with the exit code (null if it died by a signal). */
  exited: Promise<number | null>
  hasExited: () => boolean
  kill: (signal?: NodeJS.Signals) => void
}

const NODE_ARGS = ['--disable-warning=ExperimentalWarning']

/** Runs a bundled script as a process, without a terminal. */
export function run(
  script: string,
  env: Record<string, string>,
  extraArgs: string[] = [],
  cwd?: string,
): Proc {
  const child = spawn(process.execPath, [...NODE_ARGS, ...extraArgs, script], {
    env: { ...process.env, TEST_PRINTER: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  })
  let text = ''
  let done = false
  const collect = (chunk: Buffer) => {
    text += String(chunk)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      done = true
      resolve(code)
    }),
  )
  return {
    child,
    output: () => text,
    exited,
    hasExited: () => done,
    kill: (signal = 'SIGKILL') => {
      if (!done) child.kill(signal)
    },
  }
}

export interface Running extends Proc {
  port: number
  url: string
}

/** Starts `hub.mjs` and waits until it says it is running; fails if it exits first. */
export async function startHub(
  hubFile: string,
  env: Record<string, string>,
  port?: number,
): Promise<Running> {
  const chosen = port ?? (await freePort())
  const proc = run(hubFile, { CLOUD_URL: '', ...env, PORT: String(chosen) })
  const early = proc.exited.then((code) => {
    throw new Error(`The hub exited with ${code} before it was running:\n${proc.output()}`)
  })
  early.catch(() => {})
  await Promise.race([
    until(() => proc.output().includes('Hub running'), 'the hub running').catch((error) => {
      proc.kill()
      throw new Error(`${error.message}\n${proc.output()}`)
    }),
    early,
  ])
  return { ...proc, port: chosen, url: `http://127.0.0.1:${chosen}` }
}

/** The sign-in details from the file the hub leaves when it has no window. */
export function adminFrom(file: string): { user: string; password: string; pin: string } {
  const text = readFileSync(file, 'utf8')
  const datum = (label: string) => new RegExp(`${label}:\\s+(\\S+)`).exec(text)?.[1] as string
  return { user: datum('Username'), password: datum('Password'), pin: datum('PIN to authorize') }
}

export interface Person {
  url: string
  token: string
  deviceId: string
  userId: string
  sessionId: string
  secret: string
}

export async function signInRaw(url: string, user: string, password: string) {
  return fetch(`${url}/api/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password }),
  })
}

export async function signIn(url: string, user: string, password: string): Promise<Person> {
  const r = await signInRaw(url, user, password)
  if (r.status !== 201) throw new Error(`Sign-in failed (${r.status}): ${await r.text()}`)
  const j = (await r.json()) as {
    device: { token: string; device_id: string }
    session_id: string
    secret: string
    user: { id: string }
  }
  return {
    url,
    token: j.device.token,
    deviceId: j.device.device_id,
    userId: j.user.id,
    sessionId: j.session_id,
    secret: j.secret,
  }
}

export const call = (p: Person, route: string, body: object = {}) =>
  fetch(`${p.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
    body: JSON.stringify({ session_id: p.sessionId, secret: p.secret, ...body }),
  })

/** The files of the bundle's folder. */
export const bundled = (dir: string, file: string) => join(dir, 'hub', file)
