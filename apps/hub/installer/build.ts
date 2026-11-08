import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleHub } from './bundle'

// `pnpm --filter @pos/hub installer`: builds `Faro-PC-de-caja-<version>.exe`, the Windows installer
// of the hub (task 1.13, ADR-003). It runs on macOS or Linux with `makensis` (NSIS) installed:
// compiles the app, bundles the hub, downloads Node for Windows and WinSW (checked against the
// pinned hashes below) and packs everything with `faro.nsi`.

const here = (path = '') => fileURLToPath(new URL(`./${path}`, import.meta.url))
const root = fileURLToPath(new URL('../../../', import.meta.url))

/** Pinned downloads: changing a version means updating its hash. */
export const DOWNLOADS = {
  node: {
    version: '24.22.2',
    url: 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip',
    // From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
    sha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
  },
  winsw: {
    version: '2.12.0',
    url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe',
    sha256: 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f',
  },
} as const

/** The app version (`VERSION_APP`), which is also the installer's. */
export function appVersion(engineSource: string): string {
  const match = /export const VERSION_APP = '(\d+\.\d+)'/.exec(engineSource)
  if (!match?.[1]) throw new Error('VERSION_APP not found in apps/pos/src/floor/engine.ts')
  return match[1]
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A pinned file from the cache, downloading it the first time. Fails if the hash differs. */
async function pinned(file: string, item: { url: string; sha256: string }): Promise<string> {
  const route = here(`.cache/${file}`)
  if (!existsSync(route)) {
    console.log(`Downloading ${item.url}`)
    const response = await fetch(item.url)
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${item.url}`)
    mkdirSync(here('.cache'), { recursive: true })
    writeFileSync(route, new Uint8Array(await response.arrayBuffer()))
  }
  const actual = sha256(readFileSync(route))
  if (actual !== item.sha256) {
    rmSync(route)
    throw new Error(`${file} does not match its pinned hash (got ${actual}); it was deleted.`)
  }
  return route
}

const run = (command: string, args: string[], cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env })

/** Windows reads batch files line by line with CRLF; git may have checked them out with LF. */
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n')

async function main() {
  const version = appVersion(readFileSync(join(root, 'apps/pos/src/floor/engine.ts'), 'utf8'))
  const stage = here('dist/stage')
  const output = here(`dist/Faro-PC-de-caja-${version}.exe`)
  rmSync(here('dist'), { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  console.log(`Building the app ${version}`)
  run('pnpm', ['--filter', '@pos/app', 'build'])
  cpSync(join(root, 'apps/pos/dist'), join(stage, 'app'), { recursive: true })

  console.log('Bundling the hub')
  await bundleHub(join(stage, 'hub'))

  const nodeZip = await pinned(`node-v${DOWNLOADS.node.version}-win-x64.zip`, DOWNLOADS.node)
  const inside = `node-v${DOWNLOADS.node.version}-win-x64`
  mkdirSync(join(stage, 'node'), { recursive: true })
  for (const file of ['node.exe', 'LICENSE'])
    writeFileSync(
      join(stage, 'node', file),
      execFileSync('unzip', ['-p', nodeZip, `${inside}/${file}`], { maxBuffer: 512 * 1024 ** 2 }),
    )

  cpSync(await pinned('WinSW.NET461.exe', DOWNLOADS.winsw), join(stage, 'faro-hub.exe'))
  cpSync(here('faro-hub.xml'), join(stage, 'faro-hub.xml'))
  cpSync(here('faro.ico'), join(stage, 'faro.ico'))
  mkdirSync(join(stage, 'tools'), { recursive: true })
  writeFileSync(
    join(stage, 'tools/reset-admin.cmd'),
    crlf(readFileSync(here('tools/reset-admin.cmd'), 'utf8')),
  )

  console.log('Packing the installer')
  // -WX: a warning (an unknown variable, say) stops the build. makensis on macOS crashes without
  // a UTF-8 locale.
  run(
    'makensis',
    [
      '-V2',
      '-WX',
      '-INPUTCHARSET',
      'UTF8',
      `-DVERSION=${version}`,
      `-DSTAGE=${stage}`,
      `-DOUT=${output}`,
      'faro.nsi',
    ],
    here(),
    { ...process.env, LC_ALL: 'en_US.UTF-8' },
  )
  console.log(`\nInstaller: ${output}\nSHA-256: ${sha256(readFileSync(output))}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
