// biome-ignore-all lint/suspicious/noTemplateCurlyInString: NSIS writes ${Variable} in plain text
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRINT_TIMEOUT_MS } from '../src/printing/windows-print'
import { bundleHub, ENTRIES } from './bundle'

// Checks on the files of the Windows installer that cannot run on this machine (task 1.13):
// `faro.nsi`, `faro-hub.xml` and `tools/reset-admin.cmd`. They catch the mistakes that only show
// on a customer's PC: a folder resolved for the wrong user, the sign-in files of another PC
// copied, the firewall opened to the internet, the data deleted by the uninstaller.

const here = (path: string) => fileURLToPath(new URL(`./${path}`, import.meta.url))
const read = (path: string) => readFileSync(here(path), 'utf8')

const nsi = read('faro.nsi')
const service = read('faro-hub.xml')
const reset = read('tools/reset-admin.cmd')
const build = read('build.ts')

/** The script without comments or blank lines, with the line number each one had. */
const code = (text: string) =>
  text
    .split(/\r?\n/)
    .map((raw, index) => ({ text: raw.replace(/^\s*;.*$/, '').trimEnd(), line: index + 1 }))
    .filter((l) => l.text.trim() !== '')

const lines = code(nsi)
const at = (pattern: RegExp, from = 0) =>
  lines.findIndex((l, i) => i >= from && pattern.test(l.text))

/** The lines between `Function name` / `Section …` and its closing line. */
function block(opening: RegExp, closing: RegExp) {
  const start = at(opening)
  expect(start, `block ${opening}`).toBeGreaterThanOrEqual(0)
  const end = at(closing, start + 1)
  expect(end, `end of ${opening}`).toBeGreaterThan(start)
  return lines.slice(start, end + 1)
}
const installSection = () => block(/^Section "Faro" SecFaro/, /^SectionEnd/)
const uninstallSection = () => block(/^Section "Uninstall"/, /^SectionEnd/)
const onInit = () => block(/^Function \.onInit/, /^FunctionEnd/)
const unOnInit = () => block(/^Function un\.onInit/, /^FunctionEnd/)

describe('faro.nsi: folders and permissions', () => {
  it('sets the all-users context before any folder that depends on it is read', () => {
    // Without "all", $APPDATA is the profile of whoever installs and the service (which runs as
    // SYSTEM) would look for the data somewhere else.
    for (const part of [onInit(), unOnInit()]) {
      const context = part.findIndex((l) => /^\s*SetShellVarContext all\s*$/.test(l.text))
      expect(context).toBeGreaterThanOrEqual(0)
      const firstFolder = part.findIndex((l) =>
        /\$(APPDATA|SMPROGRAMS|DESKTOP|SMSTARTUP)/.test(l.text),
      )
      if (firstFolder >= 0) expect(context).toBeLessThan(firstFolder)
    }
    expect(nsi).not.toMatch(/SetShellVarContext\s+current/)
    expect(lines.filter((l) => /SetShellVarContext/.test(l.text))).toHaveLength(2)
  })

  it('every use of $APPDATA, $SMPROGRAMS, $DESKTOP and $SMSTARTUP comes after the context is set', () => {
    const contexts = lines.flatMap((l, i) => (/SetShellVarContext all/.test(l.text) ? [i] : []))
    const firstContext = Math.min(...contexts)
    // Before the first `SetShellVarContext all` in the file there may be only declarations.
    for (const [i, l] of lines.entries()) {
      if (!/\$(APPDATA|SMPROGRAMS|DESKTOP|SMSTARTUP)/.test(l.text)) continue
      if (i < firstContext) throw new Error(`line ${l.line} uses a user folder before the context`)
    }
    // And the callbacks that run before the sections are the ones that set it.
    expect(firstContext).toBeLessThan(at(/^Section /))
  })

  it('the data folder is ProgramData\\Faro\\data, the same the service and reset-admin.cmd use', () => {
    expect(nsi).toContain('StrCpy $Data "$APPDATA\\Faro\\data"')
    expect(service).toContain('%ProgramData%\\Faro\\data')
    expect(reset).toContain('%ProgramData%\\Faro\\data')
    expect(service).toContain('<logpath>%ProgramData%\\Faro\\logs</logpath>')
    expect(nsi).toContain('$APPDATA\\Faro\\logs')
  })

  it('restricts the data folder to SYSTEM and administrators by SID, before copying data in', () => {
    const icacls = at(/icacls "\$Data"/)
    expect(icacls).toBeGreaterThanOrEqual(0)
    const text = lines[icacls]?.text ?? ''
    expect(text).toContain('/inheritance:r')
    // By SID, not by name: «Administrators» is «Administradores» on a Spanish Windows.
    expect(text).toContain('*S-1-5-18')
    expect(text).toContain('*S-1-5-32-544')
    expect(text).not.toMatch(/Administrators|Everyone|Users|Authenticated/i)
    expect(text).not.toMatch(/\/grant(?!:r)/)
    const firstCopy = at(/CopyFiles/)
    expect(icacls).toBeLessThan(firstCopy)
    // The folder exists before the permissions are applied to it.
    expect(at(/CreateDirectory "\$Data"/)).toBeLessThan(icacls)
  })

  it('requires administrator rights and 64-bit Windows', () => {
    expect(nsi).toContain('RequestExecutionLevel admin')
    expect(nsi).toContain('${IfNot} ${RunningX64}')
    expect(nsi).toContain('InstallDir "$PROGRAMFILES64\\Faro"')
    expect(nsi).toContain('SetRegView 64')
  })
})

describe('faro.nsi: the data of another PC', () => {
  const copies = lines.filter((l) => /CopyFiles/.test(l.text))

  it('copies only an allow-list of files, never the sign-in files or the shared-memory file', () => {
    const copied = copies.map((l) => /"\$ImportDir\\([^"]+)"/.exec(l.text)?.[1])
    expect(copied.every(Boolean), 'every copy names one file or folder of $ImportDir').toBe(true)
    expect([...new Set(copied)].sort()).toEqual(
      [
        'cloud-link.json',
        'cloud-snapshots.json',
        'hub-instance',
        'photos\\*.*',
        'pin-key',
        'pos.sqlite',
        'pos.sqlite-wal',
      ].sort(),
    )
    for (const l of copies) {
      expect(l.text).not.toMatch(/pines|admin-pin|reset-|-shm/)
      // The destination is the data folder, never somewhere else.
      expect(l.text).toMatch(/"\$Data(\\photos)?"\s*$/)
      expect(l.text).toContain('/SILENT')
    }
    expect(nsi).not.toMatch(/\$ImportDir\\\*/)
  })

  it('only copies on a PC with no database yet, and only when a folder was chosen', () => {
    const guard = at(/\$ImportDir != ""/)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(lines[guard + 1]?.text).toMatch(/\$\{AndIf\} \$FreshData == 1/)
    expect(guard).toBeLessThan(at(/CopyFiles/))
    // FreshData is decided before the program is copied and before anything creates the database.
    const fresh = at(/StrCpy \$FreshData 1/)
    expect(fresh).toBeGreaterThanOrEqual(0)
    expect(fresh).toBeLessThan(at(/File \/r/))
    expect(fresh).toBeLessThan(guard)
    expect(lines[fresh - 1]?.text).toContain('FileExists} "$Data\\pos.sqlite"')
  })

  it('refuses a folder without pos.sqlite and skips the question when there is a database', () => {
    const page = block(/^Function ImportPage$/, /^FunctionEnd/)
    expect(page[1]?.text).toContain('FileExists} "$Data\\pos.sqlite"')
    expect(page[2]?.text.trim()).toBe('Abort')
    const leave = block(/^Function ImportPageLeave/, /^FunctionEnd/)
    expect(leave.some((l) => l.text.includes('FileExists} "$1\\pos.sqlite"'))).toBe(true)
  })

  it('shows the new admin only on a fresh PC that did not import data, and deletes the file after', () => {
    const show = at(/Call ShowAdmin/)
    expect(lines[show - 1]?.text).toMatch(/AndIf\} \$ImportDir == ""/)
    expect(lines[show - 2]?.text).toMatch(/\$FreshData == 1/)
    const fn = block(/^Function ShowAdmin/, /^FunctionEnd/)
    const shown = fn.findIndex((l) => l.text.includes('MessageBox'))
    const deleted = fn.findIndex((l) => l.text.includes('Delete "$Data\\admin-pin.txt"'))
    expect(shown).toBeGreaterThanOrEqual(0)
    expect(deleted).toBeGreaterThan(shown)
    expect(fn.some((l) => l.text.includes('FileOpen $0 "$Data\\admin-pin.txt" r'))).toBe(true)
  })
})

describe('faro.nsi: the admin sign-in details and the copy check', () => {
  it('a silent install keeps admin-pin.txt: it returns before reading or deleting the file', () => {
    const fn = block(/^Function ShowAdmin/, /^FunctionEnd/)
    const silent = fn.findIndex((l) => l.text.includes('${Silent}'))
    expect(silent).toBe(1)
    expect(fn[silent + 1]?.text.trim()).toBe('Return')
    expect(silent).toBeLessThan(fn.findIndex((l) => l.text.includes('FileOpen')))
    expect(silent).toBeLessThan(fn.findIndex((l) => l.text.includes('Delete ')))
  })

  it('never deletes the file if it could not show it (it gives up with a message instead)', () => {
    const fn = block(/^Function ShowAdmin/, /^FunctionEnd/)
    const giveUp = fn.findIndex((l) => l.text.includes('No apareció la contraseña'))
    expect(giveUp).toBeGreaterThanOrEqual(0)
    expect(fn[giveUp + 1]?.text.trim()).toBe('Return')
    const deletes = fn.filter((l) => l.text.includes('Delete '))
    expect(deletes).toHaveLength(1)
    expect(fn.findIndex((l) => l.text.includes('Delete '))).toBeGreaterThan(
      fn.findIndex((l) => l.text.includes('MessageBox MB_ICONINFORMATION')),
    )
  })

  it('translates exactly the labels the hub writes, and includes WordFunc to do it', () => {
    expect(nsi).toContain('!include "WordFunc.nsh"')
    const labels = [...nsi.matchAll(/\$\{WordReplace\} "\$3" "([^"]+)" "([^"]+)"/g)].map(
      (m) => m[1] as string,
    )
    expect(labels.sort()).toEqual(['PIN to authorize:', 'Password:', 'Username:'])
    const startup = read('../src/startup.ts')
    for (const label of labels) expect(startup, label).toContain(label)
    // The message does not leave a English label behind for the user to read.
    for (const m of nsi.matchAll(/\$\{WordReplace\} "\$3" "[^"]+" "([^"]+)"/g))
      expect(m[1]).toMatch(/^(Usuario|Contraseña|PIN para autorizar):$/)
  })

  it('still shows the admin when the hub was slow to answer (a separate check after the wait)', () => {
    const section = installSection()
    const wait = section.findIndex((l) => l.text.includes('Call WaitForHub'))
    const warn = section.findIndex((l, i) => i > wait && l.text.includes('${EndIf}'))
    const show = section.findIndex((l) => l.text.includes('Call ShowAdmin'))
    expect(warn).toBeGreaterThan(wait)
    expect(show).toBeGreaterThan(warn)
  })

  it('after copying data it aborts if there is still no pos.sqlite (the hub would start empty)', () => {
    const section = installSection()
    const lastCopy = section.map((l) => /CopyFiles/.test(l.text)).lastIndexOf(true)
    const check = section.findIndex(
      (l, i) => i > lastCopy && l.text.includes('${IfNot} ${FileExists} "$Data\\pos.sqlite"'),
    )
    expect(check).toBeGreaterThan(lastCopy)
    const after = section.slice(check, check + 5).map((l) => l.text.trim())
    expect(after.some((t) => t === 'Abort')).toBe(true)
    expect(check).toBeLessThan(section.findIndex((l) => l.text.includes('faro-hub.exe" install')))
  })

  it('shows the installation details and the shortcut without Edge opens the browser through Explorer', () => {
    expect(nsi).toContain('ShowInstDetails show')
    expect(nsi).toContain('"$WINDIR\\explorer.exe" "${URL}"')
    expect(nsi).toContain('"$Edge" "--app=${URL}"')
  })
})

describe('faro.nsi: the service and the firewall', () => {
  it('stops and removes the old service before replacing files, and starts the new one last', () => {
    const section = installSection()
    const idx = (pattern: RegExp) => section.findIndex((l) => pattern.test(l.text))
    const stop = idx(/Call StopService/)
    const wipe = idx(/RMDir \/r "\$INSTDIR\\app"/)
    const files = idx(/File \/r/)
    const install = idx(/faro-hub\.exe" install/)
    const start = idx(/faro-hub\.exe" start/)
    const wait = idx(/Call WaitForHub/)
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(stop).toBeLessThan(wipe)
    expect(wipe).toBeLessThan(files)
    expect(files).toBeLessThan(install)
    expect(install).toBeLessThan(start)
    expect(start).toBeLessThan(wait)
    const stopFn = block(/^Function StopService/, /^FunctionEnd/)
    const stopAt = stopFn.findIndex((l) => /faro-hub\.exe" stop/.test(l.text))
    const uninstallAt = stopFn.findIndex((l) => /faro-hub\.exe" uninstall/.test(l.text))
    expect(stopAt).toBeGreaterThanOrEqual(0)
    expect(uninstallAt).toBeGreaterThan(stopAt)
  })

  it('a failed `install` aborts the installation with the exit code in the message', () => {
    const section = installSection()
    const install = section.findIndex((l) => /faro-hub\.exe" install/.test(l.text))
    const after = section.slice(install, install + 8).map((l) => l.text)
    expect(after.join('\n')).toMatch(/\$\{If\} \$0 != 0[\s\S]*MessageBox[\s\S]*Abort/)
  })

  it('opens only the hub port, to the local subnet, for node.exe, in every network profile', () => {
    const rules = lines.filter((l) => /add rule/.test(l.text))
    expect(rules).toHaveLength(1)
    const rule = rules[0]?.text ?? ''
    expect(rule).toContain('dir=in')
    expect(rule).toContain('action=allow')
    expect(rule).toContain('protocol=TCP')
    expect(rule).toContain('localport=${PORT}')
    expect(rule).toContain('remoteip=localsubnet')
    expect(rule).toContain('profile=any')
    expect(rule).toContain('program="$INSTDIR\\node\\node.exe"')
    expect(rule).not.toMatch(/remoteip=(any|0\.0\.0\.0)/i)
    expect(rule).not.toMatch(/protocol=(any|UDP)/i)
    expect(rule).not.toMatch(/localport=(any|\*|\d{1,3}-)/i)
    expect(rule).not.toMatch(/remoteport/)
    expect(rule).not.toMatch(/enable=no/)
    // The program in the rule is the one the service runs.
    expect(service).toContain('<executable>%BASE%\\node\\node.exe</executable>')
  })

  it('replaces the rule on every install (no duplicates) and removes it when uninstalling', () => {
    const del = at(/delete rule name=/)
    const add = at(/add rule name=/)
    expect(del).toBeGreaterThanOrEqual(0)
    expect(del).toBeLessThan(add)
    expect(
      uninstallSection().some((l) => /delete rule name="\$\{FIREWALL_RULE\}"/.test(l.text)),
    ).toBe(true)
    // The same name in both.
    expect(lines[del]?.text).toContain('name="${FIREWALL_RULE}"')
    expect(lines[add]?.text).toContain('name="${FIREWALL_RULE}"')
  })

  it('the port is one value used by the rule, the health check, the shortcut and the hub', () => {
    expect(nsi).toContain('!define PORT "4000"')
    expect(nsi).toContain('!define URL "http://localhost:${PORT}"')
    expect(nsi.match(/\b400\d\b/g)?.length).toBe(1)
    expect(service).not.toMatch(/name="PORT"/)
    expect(read('../src/main.ts')).toContain('const DEFAULT_PORT = 4000')
    expect(nsi).toContain('${URL}/api/health')
  })
})

describe('faro.nsi: uninstalling and updating never delete the restaurant data', () => {
  it('nothing deletes the data folder, ProgramData or the PC-wide folders', () => {
    for (const l of lines) {
      if (/(RMDir|Delete)\b/.test(l.text)) {
        // The only thing deleted in the data folder is the sign-in file the installer just showed.
        const target = l.text.replace(/Delete "(\$Data|\$APPDATA\\Faro\\data)\\admin-pin\.txt"/, '')
        expect(target, `line ${l.line}`).not.toMatch(/\$Data\b|\$APPDATA\\Faro\\data|\\data\b/)
        if (/RMDir \/r/.test(l.text))
          expect(l.text, `line ${l.line}`).toMatch(
            /\$INSTDIR\\(app|hub|node|tools)"|\$SMPROGRAMS\\Faro"/,
          )
      }
    }
    expect(nsi).not.toMatch(/RMDir \/r "\$INSTDIR"/)
    expect(nsi).not.toMatch(/RMDir \/r "\$APPDATA/)
    expect(nsi).not.toMatch(/RMDir \/r "\$PROGRAMFILES/)
  })

  it('the uninstaller uses no variable that only exists while installing', () => {
    const text = uninstallSection()
      .map((l) => l.text)
      .join('\n')
    // $Data, $Edge… are set by the installer's callbacks: in the uninstaller they are empty.
    for (const v of ['$Data', '$Edge', '$ImportDir', '$FreshData', '$RadioNew', '$DirField'])
      expect(text, v).not.toContain(v)
    const fns = lines.filter((l) => /^Function un\./.test(l.text))
    expect(fns.map((l) => l.text)).toEqual(['Function un.onInit'])
  })

  it('the uninstaller removes every top-level item the installer unpacks, and the folder only if it is empty', () => {
    const staged = [
      ...new Set([...build.matchAll(/join\(stage, '([^'/]+)/g)].map((m) => m[1] as string)),
    ]
    expect(staged.sort()).toEqual(
      ['app', 'faro-hub.exe', 'faro-hub.xml', 'faro.ico', 'hub', 'node', 'tools'].sort(),
    )
    const text = uninstallSection()
      .map((l) => l.text)
      .join('\n')
    for (const dir of ['app', 'hub', 'node', 'tools'])
      expect(text).toContain(`RMDir /r "$INSTDIR\\${dir}"`)
    expect(text).toContain('Delete "$INSTDIR\\faro-hub.*"')
    expect(text).toContain('Delete "$INSTDIR\\faro.ico"')
    expect(text).toContain('Delete "$INSTDIR\\uninstall.exe"')
    // Not recursive: if the restaurant left something in it, it stays.
    expect(text).toMatch(/^\s*RMDir "\$INSTDIR"$/m)
    expect(text).toContain('DeleteRegKey HKLM "${UNINSTALL_KEY}"')
  })

  it('on update only the old app and hub are replaced (their file names change each version)', () => {
    const section = installSection().map((l) => l.text)
    const removed = section.filter((t) => /RMDir/.test(t))
    expect(removed).toEqual(['  RMDir /r "$INSTDIR\\app"', '  RMDir /r "$INSTDIR\\hub"'])
    expect(section.filter((t) => /File /.test(t))).toEqual(['  File /r "${STAGE}/*"'])
  })

  it('stops the service before deleting anything when uninstalling', () => {
    const text = uninstallSection().map((l) => l.text)
    const stop = text.findIndex((t) => /faro-hub\.exe" stop/.test(t))
    const remove = text.findIndex((t) => /faro-hub\.exe" uninstall/.test(t))
    const firstDelete = text.findIndex((t) => /RMDir|Delete /.test(t))
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(remove).toBeGreaterThan(stop)
    expect(firstDelete).toBeGreaterThan(remove)
  })
})

describe('faro-hub.xml (WinSW)', () => {
  /** A tag-balance check: enough to catch a broken edit without an XML library. */
  function balanced(xml: string): boolean {
    const stack: string[] = []
    const body = xml.replace(/<!--[\s\S]*?-->/g, '')
    for (const m of body.matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g)) {
      const [, closing, name, , selfClosing] = m
      if (selfClosing) continue
      if (closing) {
        if (stack.pop() !== name) return false
      } else stack.push(name as string)
    }
    return stack.length === 0
  }

  it('is well formed, with one service', () => {
    expect(balanced(service)).toBe(true)
    expect(service.match(/<service>/g)).toHaveLength(1)
    expect(service.match(/<id>/g)).toHaveLength(1)
  })

  it('starts with Windows, restarts after a crash and gives the hub time to close', () => {
    expect(service).toContain('<startmode>Automatic</startmode>')
    expect(service.match(/<onfailure action="restart"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(service).not.toMatch(/<onfailure action="(none|reboot)"/)
    const timeout = /<stoptimeout>(\d+) sec<\/stoptimeout>/.exec(service)
    // Longer than a stuck USB print (it is killed after PRINT_TIMEOUT_MS), so the hub can still
    // finish that job and close the database before WinSW kills it.
    expect(Number(timeout?.[1]) * 1000).toBeGreaterThan(PRINT_TIMEOUT_MS)
  })

  it('runs the bundled hub with the bundled Node, from the install folder, with quoted paths', () => {
    expect(service).toContain('<executable>%BASE%\\node\\node.exe</executable>')
    const args = /<arguments>(.*)<\/arguments>/.exec(service)?.[1] ?? ''
    expect(args).toContain('"%BASE%\\hub\\hub.mjs"')
    expect(args).toContain('--disable-warning=ExperimentalWarning')
    // The flag only helps if the bundle ships its sourcemap (`bundle.ts`: sourcemap: 'linked').
    expect(args).toContain('--enable-source-maps')
    expect(service).toContain('<env name="APP_DIR" value="%BASE%\\app"/>')
    expect(service).toContain('<env name="NODE_ENV" value="production"/>')
    expect(service).not.toMatch(/name="(TEST_PRINTER|CLOUD_URL|PORT)"/)
  })

  it('keeps a bounded rolling log', () => {
    expect(service).toContain('<log mode="roll-by-size">')
    expect(Number(/<keepFiles>(\d+)</.exec(service)?.[1])).toBeLessThanOrEqual(20)
    expect(Number(/<sizeThreshold>(\d+)</.exec(service)?.[1])).toBeGreaterThan(0)
  })

  it('has a description and a name in Spanish, and nothing that needs a password', () => {
    expect(service).toMatch(/<name>Faro \(PC de caja\)<\/name>/)
    expect(service).not.toMatch(/<serviceaccount>|<password>/)
  })
})

describe('tools/reset-admin.cmd', () => {
  it('is plain ASCII: cmd reads it in the console code page', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is what is checked
    expect(reset).toMatch(/^[\x00-\x7f]*$/)
  })

  it('asks for administrator rights before touching the service', () => {
    // `net session` or `fltmc`: both fail unless the console is elevated.
    const checkAt = Math.max(reset.indexOf('net session'), reset.indexOf('fltmc'))
    const stopAt = reset.indexOf('faro-hub.exe" stop')
    expect(checkAt).toBeGreaterThanOrEqual(0)
    expect(checkAt).toBeLessThan(stopAt)
    expect(reset).toContain('-Verb RunAs')
    expect(reset).toMatch(/exit \/b/)
  })

  it('stops the service, runs reset.mjs with the same data folder, and starts the service again', () => {
    const order = ['faro-hub.exe" stop', 'hub\\reset.mjs', 'faro-hub.exe" start'].map((s) =>
      reset.indexOf(s),
    )
    expect(order.every((n) => n >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(reset).toContain('set "DATA_DIR=%ProgramData%\\Faro\\data"')
    expect(reset).toContain('"%BASE%\\node\\node.exe"')
    expect(reset).toContain('set "BASE=%~dp0.."')
    expect(reset).toContain('pause')
  })

  it('every use of BASE is quoted (Program Files has a space)', () => {
    for (const m of reset.matchAll(/%BASE%[^\s"]*/g)) {
      const before = reset.slice(0, m.index).split('\n').pop() ?? ''
      expect(before.split('"').length % 2, `unquoted: ${m[0]}`).toBe(0)
    }
  })

  it('the build converts it to CRLF when staging it', () => {
    expect(build).toContain("const crlf = (text: string) => text.replace(/\\r?\\n/g, '\\r\\n')")
    expect(build).toMatch(/tools\/reset-admin\.cmd[\s\S]{0,80}crlf\(readFileSync/)
  })

  it('the installer shortcut points at it', () => {
    expect(nsi).toContain('"$INSTDIR\\tools\\reset-admin.cmd"')
  })
})

describe('the bundle', () => {
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faro-bundle-static-'))
    await bundleHub(join(dir, 'hub'))
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('produces the two scripts the service and reset-admin.cmd run, and the sourcemap the service asks for', () => {
    expect(Object.keys(ENTRIES).sort()).toEqual(['hub', 'reset'])
    const files = readdirSync(join(dir, 'hub'))
    expect(files).toEqual(expect.arrayContaining(['hub.mjs', 'reset.mjs', 'hub.mjs.map']))
    expect(statSync(join(dir, 'hub/hub.mjs')).size).toBeGreaterThan(100_000)
  })

  it('imports nothing outside Node itself: the installed PC has no node_modules', () => {
    const optional = new Set(['bufferutil', 'utf-8-validate'])
    // Fastify's schema compilers keep `require('…')` in text they generate for standalone code
    // (templates over several lines); esbuild bundles the real ones, and nothing runs this text.
    const GENERATED = /^(ajv|ajv-formats|fast-json-stringify)\//
    const builtin = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
    for (const file of ['hub.mjs', 'reset.mjs']) {
      const text = readFileSync(join(dir, 'hub', file), 'utf8')
      const specifiers = new Set<string>()
      /** Whether the match sits inside a string literal (code a library writes to generate more code). */
      const inString = (index: number) => {
        const prefix = text.slice(text.lastIndexOf('\n', index) + 1, index)
        return ['"', "'", '`'].some((q) => prefix.split(q).length % 2 === 0)
      }
      for (const pattern of [
        /^import\s[^;]*?from\s*["']([^"']+)["']/gm,
        /(?<![\w])require\(\s*["']([^"']+)["']\s*\)/g,
        /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      ])
        for (const m of text.matchAll(pattern))
          if (!/^[./]/.test(m[1] as string) && !inString(m.index)) specifiers.add(m[1] as string)
      for (const s of specifiers)
        expect(
          builtin.has(s) || optional.has(s) || GENERATED.test(s),
          `${file} imports "${s}"`,
        ).toBe(true)
      expect(text).not.toMatch(/from\s*["']@pos\//)
      expect(text).not.toMatch(/["']tsx["']/)
    }
  })

  it('does not embed this machine’s secrets or data folder', () => {
    const text = readFileSync(join(dir, 'hub/hub.mjs'), 'utf8')
    expect(text).not.toContain(process.env.HOME ?? '/nonexistent-home/')
    expect(text).not.toMatch(/pos\.sqlite['"]\s*\)?\s*;?\s*\/\/.*\/Users\//)
  })
})

describe('faro.nsi compiles', () => {
  const available = spawnSync('makensis', ['-VERSION']).status === 0
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'faro-nsis-'))
    // A stage with the layout `build.ts` makes, with placeholder files.
    for (const folder of ['app/assets', 'hub', 'node', 'tools'])
      mkdirSync(join(dir, 'stage', folder), { recursive: true })
    for (const file of [
      'app/index.html',
      'hub/hub.mjs',
      'hub/reset.mjs',
      'node/node.exe',
      'tools/reset-admin.cmd',
      'faro-hub.exe',
      'faro-hub.xml',
    ])
      writeFileSync(join(dir, 'stage', file), 'x')
    writeFileSync(join(dir, 'stage/faro.ico'), readFileSync(here('faro.ico')))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const compile = (extra: string[] = []) =>
    spawnSync(
      'makensis',
      [
        '-V2',
        '-WX',
        '-INPUTCHARSET',
        'UTF8',
        '-DVERSION=9.9',
        `-DSTAGE=${join(dir, 'stage')}`,
        `-DOUT=${join(dir, 'Faro-test.exe')}`,
        ...extra,
        'faro.nsi',
      ],
      { cwd: here('.'), encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } },
    )

  it.skipIf(!available)(
    'builds with warnings as errors and produces an executable',
    () => {
      const r = compile()
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
      expect(existsSync(join(dir, 'Faro-test.exe'))).toBe(true)
      const bytes = readFileSync(join(dir, 'Faro-test.exe'))
      expect(bytes.subarray(0, 2).toString()).toBe('MZ')
      expect(bytes.length).toBeGreaterThan(30_000)
    },
    120_000,
  )

  it.skipIf(!available)(
    'refuses to build when the build script did not pass its definitions',
    () => {
      const r = spawnSync('makensis', ['-V2', '-INPUTCHARSET', 'UTF8', 'faro.nsi'], {
        cwd: here('.'),
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
      })
      expect(r.status).not.toBe(0)
      expect(`${r.stdout}${r.stderr}`).toContain('Run build.ts')
    },
  )

  it.skipIf(!available)(
    'a misspelled variable is caught as a warning (the -WX in build.ts matters)',
    () => {
      const broken = nsi.replace(
        'StrCpy $Data "$APPDATA\\Faro\\data"',
        'StrCpy $Data "$Zzz\\Faro\\data"',
      )
      expect(broken).not.toBe(nsi)
      writeFileSync(join(dir, 'broken.nsi'), broken)
      const r = spawnSync(
        'makensis',
        [
          '-V2',
          '-WX',
          '-INPUTCHARSET',
          'UTF8',
          '-DVERSION=9.9',
          `-DSTAGE=${join(dir, 'stage')}`,
          `-DOUT=${join(dir, 'Broken.exe')}`,
          join(dir, 'broken.nsi'),
        ],
        { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } },
      )
      expect(r.status).not.toBe(0)
    },
  )

  it('build.ts passes -WX and the UTF-8 flags the compile test relies on', () => {
    expect(build).toContain("'-WX'")
    expect(build).toContain("'UTF8'")
  })
})
