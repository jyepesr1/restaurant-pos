import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validWindowsName } from './routes'
import { PrinterError, sendToPrinter } from './transport'
import {
  EXIT,
  LIST_TIMEOUT_MS,
  listWindowsPrinters,
  NOW_OR_NEVER_VARIABLE,
  PRINT_TIMEOUT_MS,
  PRINTER_NAME_VARIABLE,
  parsePrinterList,
  type Spawn,
  sendOverUsb,
} from './windows-print'

// Task 1.13, the USB path under attack and under load: hostile printer names, big and binary
// payloads through real pipes, every way PowerShell can end, and the listing's odd outputs.
// "Real pipes" means a Node process stands in for PowerShell (same stdin, same environment, same
// exit code contract); the PowerShell script itself only runs on the register PC.

const script = (args: readonly string[]) =>
  Buffer.from(String(args[args.indexOf('-EncodedCommand') + 1]), 'base64').toString('utf16le')

interface Seen {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv | undefined
  input: string
}

/** A fake PowerShell that records what it was given and ends with `code`. */
function recording(code: number = EXIT.ok) {
  const seen: Seen[] = []
  const spawn: Spawn = (command, args, options) => {
    const child = new EventEmitter() as ChildProcess
    const stdin = new PassThrough()
    const entry: Seen = { command, args, env: options.env, input: '' }
    seen.push(entry)
    stdin.on('data', (c) => {
      entry.input += String(c)
    })
    stdin.on('finish', () => setImmediate(() => child.emit('close', code)))
    Object.assign(child, {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    })
    return child
  }
  return { seen, spawn }
}

describe('hostile printer names', () => {
  const NAMES = [
    '"; Remove-Item -Recurse C:\\ #',
    "'; Remove-Item -Recurse C:\\ ; '",
    '$(calc.exe)',
    '`$(calc.exe)`',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a hostile name on purpose
    '${env:USERNAME}',
    '$env:FARO_PRINTER_NAME',
    '"a" `r`n Start-Process cmd',
    "O'Brien's POS-80",
    'POS 80 (copia 1) ñandú — Térmica',
    '😀 Impresora 🧾',
    '日本語プリンター',
    'a\u202eb',
    'a\u2028b',
    '  spaced name  ',
    '-EncodedCommand AAAA',
    '--help',
    '%PATH%',
    '^&|<>',
    "@'\n'@",
    'x'.repeat(220),
  ]

  it.each(NAMES)(
    '%s travels only in the environment: the script and the arguments never change',
    async (name) => {
      const baseline = recording()
      await sendOverUsb('POS-80', new Uint8Array([1, 2, 3]), {
        platform: 'win32',
        spawn: baseline.spawn,
      })
      const ps = recording()
      await sendOverUsb(name, new Uint8Array([1, 2, 3]), { platform: 'win32', spawn: ps.spawn })
      const [seen] = ps.seen as [Seen]
      expect(seen.args).toEqual(baseline.seen[0]?.args)
      expect(script(seen.args)).toBe(script(baseline.seen[0]?.args ?? []))
      expect(seen.env?.[PRINTER_NAME_VARIABLE]).toBe(name)
      expect(seen.args.some((a) => a.includes(name) && name.length > 3)).toBe(false)
      // Unless the name happens to be a piece of the script itself, it is not in the script.
      if (!script(baseline.seen[0]?.args ?? []).includes(name))
        expect(script(seen.args)).not.toContain(name)
    },
  )

  it('a name can not override the other variable the script reads (now or never stays off)', async () => {
    const ps = recording()
    await sendOverUsb(`x\n${NOW_OR_NEVER_VARIABLE}=1`, new Uint8Array(), {
      platform: 'win32',
      spawn: ps.spawn,
    })
    expect(ps.seen[0]?.env?.[NOW_OR_NEVER_VARIABLE]).toBeUndefined()
  })

  it('the environment of the hub is not lost and the name does not leak into the arguments of the next call', async () => {
    const ps = recording()
    await sendOverUsb('Primera', new Uint8Array(), { platform: 'win32', spawn: ps.spawn })
    await sendOverUsb('Segunda', new Uint8Array(), { platform: 'win32', spawn: ps.spawn })
    expect(ps.seen.map((s) => s.env?.[PRINTER_NAME_VARIABLE])).toEqual(['Primera', 'Segunda'])
    expect(ps.seen[1]?.env?.SystemRoot).toBe(process.env.SystemRoot)
    expect(ps.seen[1]?.env?.PATH).toBe(process.env.PATH)
  })

  it('error messages quote the name but cannot be turned into markup for the log (only text)', async () => {
    const ps = recording(EXIT.notFound)
    const error = await sendOverUsb('<b>x</b>\r\nPOS', new Uint8Array(), {
      platform: 'win32',
      spawn: ps.spawn,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toContain('«<b>x</b>\r\nPOS»')
  })

  it('a name with a NUL (only possible by writing the database by hand) rejects instead of hanging', async () => {
    // Node refuses it when building the environment; the queue and the drawer treat any error as
    // a failed attempt, so the register shows it and the rest keeps going.
    const outcome = await Promise.race([
      sendOverUsb('a\0b', new Uint8Array([1]), { platform: 'win32' }).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ])
    expect(outcome).toBe('rejected')
  })

  it('a spawn that throws synchronously rejects the promise', async () => {
    await expect(
      sendOverUsb('x', new Uint8Array(), {
        platform: 'win32',
        spawn: () => {
          throw new Error('EPERM')
        },
      }),
    ).rejects.toThrow('EPERM')
  })

  describe('what the route accepts (validWindowsName)', () => {
    it.each([
      ['plain', 'POS-80', null],
      ['quotes and shell characters are only text', `A "b" 'c' $(d) \`e\` ;|&<>`, null],
      ['accents, emoji and CJK', 'Térmica ñandú 😀 日本', null],
      ['220 characters', 'x'.repeat(220), null],
      ['a trailing dot or spaces inside', 'POS. 80  Caja', null],
    ])('%s is a name', (_n, name, expected) => {
      expect(validWindowsName(name)).toBe(expected)
    })

    it.each([
      ['221 characters', 'x'.repeat(221)],
      ['a line break', 'a\nb'],
      ['a carriage return', 'a\rb'],
      ['a tab', 'a\tb'],
      ['a NUL', 'a\0b'],
      ['DEL', 'a\u007fb'],
      ['an escape', 'a\u001bb'],
      ['a share \\\\PC\\name', '\\\\CAJA\\POS-80'],
      ['a backslash anywhere', 'CAJA\\POS-80'],
      ['a comma (port monitor), ,XcvPort', 'Local Port,XcvPort'],
      ['a comma at the start', ',XcvMonitor Local Port'],
    ])('%s is not', (_n, name) => {
      expect(validWindowsName(name)).toEqual(expect.any(String))
    })

    it('the message for a share or a comma tells the owner what to choose', () => {
      expect(validWindowsName('\\\\PC\\x')).toBe(
        'Elige la impresora conectada por USB a este PC: no una compartida por otro equipo',
      )
      expect(validWindowsName('a,b')).toBe(
        'Elige la impresora conectada por USB a este PC: no una compartida por otro equipo',
      )
    })
  })
})

describe('the payload through real pipes', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'faro-ps-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /**
   * A Node process in place of PowerShell: it reads the name from the environment and the bytes
   * from stdin as base64 (like the real script), writes what it got to a file and exits with the
   * code in `FAKE_EXIT`.
   */
  const STAND_IN = `
    const fs = require('node:fs')
    const crypto = require('node:crypto')
    const name = process.env.${PRINTER_NAME_VARIABLE}
    if (process.env.FAKE_EXIT_EARLY) process.exit(Number(process.env.FAKE_EXIT_EARLY))
    if (process.env.FAKE_HANG) setInterval(() => {}, 1000)
    else {
      let text = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (c) => { text += c })
      process.stdin.on('end', () => {
        const bytes = Buffer.from(text.trim(), 'base64')
        fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({
          name,
          length: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          nowOrNever: process.env.${NOW_OR_NEVER_VARIABLE} ?? null,
        }))
        process.exit(Number(process.env.FAKE_EXIT ?? 0))
      })
    }
  `
  let lastChild: ChildProcess | null = null
  const standIn =
    (extra: Record<string, string>): Spawn =>
    (_command, _args, options) => {
      lastChild = nodeSpawn(process.execPath, ['-e', STAND_IN], {
        ...options,
        env: { ...options.env, ...extra },
      })
      return lastChild
    }
  const out = (name: string) => join(dir, `${name}.json`)

  /** A deterministic pseudo-random byte string (no `Math.random`). */
  function bytesOf(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    let x = 123456789
    for (let i = 0; i < length; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0
      bytes[i] = x >>> 24
    }
    return bytes
  }
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

  it.each([
    ['empty', 0],
    ['one byte', 1],
    ['a typical receipt', 1500],
    ['exactly a pipe buffer (64 KiB)', 65_536],
    ['just over a pipe buffer', 65_537],
    ['a long report (1 MiB)', 1_048_576],
    ['an enormous job (8 MiB)', 8 * 1_048_576],
  ])('%s: every byte arrives, in order', async (label, length) => {
    const bytes = bytesOf(length)
    const file = out(`payload-${length}`)
    await sendOverUsb('Térmica "80" $(x)', bytes, {
      platform: 'win32',
      spawn: standIn({ FAKE_OUT: file }),
    })
    const got = JSON.parse(readFileSync(file, 'utf8'))
    expect(got, label).toEqual({
      name: 'Térmica "80" $(x)',
      length,
      sha256: sha(bytes),
      nowOrNever: null,
    })
  })

  it('binary with every byte value, NULs, ESC/POS cut and a UTF-8 look-alike, is not altered', async () => {
    const all = Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256)
    const file = out('all-bytes')
    await sendOverUsb('POS', all, { platform: 'win32', spawn: standIn({ FAKE_OUT: file }) })
    expect(JSON.parse(readFileSync(file, 'utf8')).sha256).toBe(sha(all))
  })

  it('the payload is not modified by the call (the caller can reuse the array)', async () => {
    const bytes = bytesOf(1000)
    const copy = Uint8Array.from(bytes)
    await sendOverUsb('POS', bytes, {
      platform: 'win32',
      spawn: standIn({ FAKE_OUT: out('unchanged') }),
    })
    expect(bytes).toEqual(copy)
  })

  it('a subarray view of a bigger buffer sends only its own bytes', async () => {
    const big = bytesOf(5000)
    const view = big.subarray(100, 900)
    await sendOverUsb('POS', view, { platform: 'win32', spawn: standIn({ FAKE_OUT: out('view') }) })
    const got = JSON.parse(readFileSync(out('view'), 'utf8'))
    expect(got.length).toBe(800)
    expect(got.sha256).toBe(sha(view))
  })

  it('the drawer asks Windows for "now or never" through the environment, and only then', async () => {
    await sendOverUsb('POS', new Uint8Array([27, 112, 0, 25, 250]), {
      platform: 'win32',
      nowOrNever: true,
      spawn: standIn({ FAKE_OUT: out('now') }),
    })
    expect(JSON.parse(readFileSync(out('now'), 'utf8')).nowOrNever).toBe('1')
    await sendOverUsb('POS', new Uint8Array([1]), {
      platform: 'win32',
      nowOrNever: false,
      spawn: standIn({ FAKE_OUT: out('not-now') }),
    })
    expect(JSON.parse(readFileSync(out('not-now'), 'utf8')).nowOrNever).toBeNull()
  })

  it('PowerShell dying before reading a big job (broken pipe) is a clean failure with its exit code', async () => {
    const error = await sendOverUsb('POS', bytesOf(8 * 1_048_576), {
      platform: 'win32',
      spawn: standIn({ FAKE_EXIT_EARLY: String(EXIT.notWritten), FAKE_OUT: out('early') }),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/no recibió todo/)
  })

  it('a stuck PowerShell is killed at the time limit and the process is really gone', async () => {
    const error = await sendOverUsb('POS', bytesOf(10), {
      platform: 'win32',
      timeoutMs: 150,
      spawn: standIn({ FAKE_HANG: '1', FAKE_OUT: out('hang') }),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/Windows no terminó de imprimir/)
    const child = lastChild as unknown as ChildProcess
    await new Promise<void>((resolve) =>
      child.exitCode !== null || child.signalCode !== null
        ? resolve()
        : child.once('exit', () => resolve()),
    )
    expect(child.signalCode ?? child.exitCode).not.toBeNull()
  })

  it.each([
    [EXIT.ok, 'resolved'],
    [EXIT.notFound, 'Windows no tiene una impresora llamada'],
    [EXIT.notOpened, 'no dejó usar la impresora'],
    [EXIT.notStarted, 'no aceptó el trabajo'],
    [EXIT.notWritten, 'no recibió todo'],
    [EXIT.notTaken, undefined],
    [1, '(código 1)'],
    [255, '(código 255)'],
    [127, '(código 127)'],
  ])('real exit code %s', async (code, text) => {
    const result = await sendOverUsb('POS', bytesOf(10), {
      platform: 'win32',
      spawn: standIn({ FAKE_EXIT: String(code), FAKE_OUT: out(`exit-${code}`) }),
    }).then(
      () => 'resolved',
      (e) => e,
    )
    if (text === 'resolved') return expect(result).toBe('resolved')
    expect(result).toBeInstanceOf(PrinterError)
    // Every code the script uses says something a person can act on: never a bare number.
    if (text) expect(result.message).toContain(text)
    expect(result.message).toMatch(/[a-záéíóú]{4}/i)
  })
})

describe('every way PowerShell can end (fake process)', () => {
  const ending =
    (how: (child: ChildProcess) => void): Spawn =>
    () => {
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      })
      setImmediate(() => how(child))
      return child
    }

  it('killed by a signal (no exit code) is a failure that says so', async () => {
    const error = await sendOverUsb('POS', new Uint8Array(), {
      platform: 'win32',
      spawn: ending((c) => c.emit('close', null, 'SIGKILL')),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toContain('sin código')
  })

  it.each([259, 3221225477, -1, 4294967295])(
    'a Windows exit code of %s is reported with its number',
    async (code) => {
      const error = await sendOverUsb('POS', new Uint8Array(), {
        platform: 'win32',
        spawn: ending((c) => c.emit('close', code)),
      }).catch((e) => e)
      expect(error).toBeInstanceOf(PrinterError)
      expect(error.message).toContain(`(código ${code})`)
    },
  )

  it('"error" and then "close" settle once with the first', async () => {
    const error = await sendOverUsb('POS', new Uint8Array(), {
      platform: 'win32',
      spawn: ending((c) => {
        c.emit('error', Object.assign(new Error('spawn'), { code: 'EACCES' }))
        c.emit('close', 0)
      }),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/cola de impresión de Windows/)
  })

  it('"close" with 0 and then a late "error" is still a success', async () => {
    await expect(
      sendOverUsb('POS', new Uint8Array(), {
        platform: 'win32',
        spawn: ending((c) => {
          c.emit('close', 0)
          c.emit('error', new Error('late'))
        }),
      }),
    ).resolves.toBeUndefined()
  })

  it('a late "close" after the timeout does not turn the failure into a success', async () => {
    let child: ChildProcess | undefined
    const error = await sendOverUsb('POS', new Uint8Array(), {
      platform: 'win32',
      timeoutMs: 10,
      spawn: () => {
        child = new EventEmitter() as ChildProcess
        Object.assign(child, {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => {
            // The process ends (successfully!) only after the hub gave up on it.
            setImmediate(() => child?.emit('close', 0))
            return true
          },
        })
        return child
      },
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/no terminó de imprimir/)
  })

  it('the stderr of PowerShell is kept as the cause but never in the message', async () => {
    const spawn: Spawn = () => {
      const child = new EventEmitter() as ChildProcess
      const stderr = new PassThrough()
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        kill: () => true,
      })
      stderr.write('Add-Type : C:\\Users\\caja\\secret.cs(3) error CS1002')
      setImmediate(() => child.emit('close', 1))
      return child
    }
    const error = await sendOverUsb('POS', new Uint8Array(), { platform: 'win32', spawn }).catch(
      (e) => e,
    )
    expect(error.cause).toContain('CS1002')
    expect(error.message).not.toContain('Users')
  })

  it('the limits keep their promises: a listing answers before the device gives up (8 s)', () => {
    expect(LIST_TIMEOUT_MS).toBeLessThan(8000)
    expect(PRINT_TIMEOUT_MS).toBeGreaterThan(LIST_TIMEOUT_MS)
  })
})

describe('sendToPrinter routing', () => {
  it.skipIf(process.platform === 'win32')(
    'a USB target with nowOrNever still stops with the Windows message off Windows',
    async () => {
      const error = await sendToPrinter(
        { connection: 'usb', address: '$(calc)', port: null, nowOrNever: true },
        new Uint8Array([1]),
      ).catch((e) => e)
      expect(error).toBeInstanceOf(PrinterError)
      expect(error.message).toContain('Windows')
    },
  )
})

describe('the printers Windows lists', () => {
  const row = (Name: unknown, PortName: unknown = 'USB001', DriverName: unknown = 'Generic') => ({
    Name,
    PortName,
    DriverName,
  })
  const parse = (rows: unknown) => parsePrinterList(JSON.stringify(rows))

  it.each([
    'PORTPROMPT:',
    'portprompt:',
    'NUL:',
    'FILE:',
    'XPSPORT:',
    'SHRFAX:',
    'ONENOTE',
    'ONENOTE:',
    'Microsoft.Office.OneNote_16001',
    'MICROSOFT.OFFICE.ONENOTE_x',
  ])('a virtual printer on port %s is not offered', (port) => {
    expect(parse([row('Virtual', port)])).toEqual([])
  })

  it.each([
    'USB001',
    'usb002',
    'LPT1:',
    'COM3:',
    'IP_192.168.1.50',
    'WSD-1234-abcd',
    'FILESERVER',
    'NULL1',
    'XPSPORTAL',
    'Microsoft Print',
    null,
  ])('a printer on port %s stays', (port) => {
    expect(parse([row('Real', port)])).toHaveLength(1)
  })

  it('a thermal printer on a port that only looks virtual by name stays', () => {
    expect(parse([row('PORTPROMPT térmica', 'USB003')])).toHaveLength(1)
  })

  it('USB first (any case), then alphabetical the Spanish way', () => {
    const names = (rows: unknown) => parse(rows).map((p) => p.name)
    expect(
      names([
        row('Zeta', 'LPT1:'),
        row('Ñandú', 'LPT1:'),
        row('Oso', 'LPT1:'),
        row('Nube', 'LPT1:'),
        row('Beta', 'usb001'),
        row('Alfa', 'USB002'),
      ]),
    ).toEqual(['Alfa', 'Beta', 'Nube', 'Ñandú', 'Oso', 'Zeta'])
  })

  it('JSON values that are not a list of objects are ignored, not crashes', () => {
    expect(parsePrinterList('null')).toEqual([])
    expect(parsePrinterList('7')).toEqual([])
    expect(parsePrinterList('"text"')).toEqual([])
    expect(parsePrinterList('true')).toEqual([])
    expect(parse([[row('anidada')]])).toEqual([])
    expect(parse([row(7), row(null), row(['x']), row({})])).toEqual([])
  })

  it('fields of the wrong type become null instead of failing', () => {
    expect(parse([row('Caja', 5, { a: 1 })])).toEqual([{ name: 'Caja', port: null, driver: null }])
    expect(parse([row('Caja', '   ', '')])).toEqual([{ name: 'Caja', port: null, driver: null }])
  })

  it('names are kept exactly as Windows writes them (the same text the print uses)', () => {
    expect(parse([row(' Caja  1 ', 'USB001')])[0]?.name).toBe(' Caja  1 ')
  })

  it('the same name twice is listed twice (Windows does not allow it, but nothing breaks)', () => {
    expect(parse([row('Caja'), row('Caja')])).toHaveLength(2)
  })

  it('500 printers (a print server’s worth) parse and sort', () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      row(`Impresora ${String(i).padStart(3, '0')}`, i % 7 === 0 ? 'USB001' : 'LPT1:'),
    )
    const list = parse(rows)
    expect(list).toHaveLength(500)
    expect(list.slice(0, 72).every((p) => p.port === 'USB001')).toBe(true)
    expect(list[72]?.port).toBe('LPT1:')
  })

  it('text before the JSON (a PowerShell warning) makes it fail, so the screen offers to type the name', () => {
    expect(() => parsePrinterList('WARNING: algo\n[{"Name":"x"}]')).toThrow()
  })

  it('a BOM, CRLF and trailing spaces around the JSON are fine', () => {
    expect(parsePrinterList('\uFEFF  [{"Name":"Caja","PortName":"USB001"}]  \r\n\r\n')).toEqual([
      { name: 'Caja', port: 'USB001', driver: null },
    ])
  })
})

describe('listing through a fake PowerShell', () => {
  const answering =
    (chunks: Buffer[], code = 0, stderr = ''): Spawn =>
    () => {
      const child = new EventEmitter() as ChildProcess
      const stdout = new PassThrough()
      const err = new PassThrough()
      Object.assign(child, { stdin: new PassThrough(), stdout, stderr: err, kill: () => true })
      if (stderr) err.write(stderr)
      const next = (i: number) => {
        if (i === chunks.length) return child.emit('close', code)
        stdout.write(chunks[i])
        setImmediate(() => next(i + 1))
      }
      setImmediate(() => next(0))
      return child
    }

  const JSON_TEXT = '[{"Name":"Térmica ñandú","PortName":"USB001","DriverName":"Genérica"}]'

  it('reads accents when the output arrives in one piece', async () => {
    expect(
      await listWindowsPrinters({
        platform: 'win32',
        spawn: answering([Buffer.from(JSON_TEXT)]),
      }),
    ).toEqual([{ name: 'Térmica ñandú', port: 'USB001', driver: 'Genérica' }])
  })

  it('reads accents when a pipe chunk ends in the middle of a character', async () => {
    const bytes = Buffer.from(JSON_TEXT)
    // Every possible cut, including between the two bytes of «é», «ñ» and «ú».
    for (let cut = 1; cut < bytes.length; cut++) {
      const list = await listWindowsPrinters({
        platform: 'win32',
        spawn: answering([bytes.subarray(0, cut), bytes.subarray(cut)]),
      })
      expect(list, `cut at byte ${cut}`).toEqual([
        { name: 'Térmica ñandú', port: 'USB001', driver: 'Genérica' },
      ])
    }
  })

  it('reads 3-byte and 4-byte characters (CJK, emoji) cut at every byte', async () => {
    const bytes = Buffer.from('[{"Name":"日本 😀","PortName":"USB001","DriverName":null}]')
    for (let cut = 1; cut < bytes.length; cut++) {
      const list = await listWindowsPrinters({
        platform: 'win32',
        spawn: answering([bytes.subarray(0, cut), bytes.subarray(cut)]),
      })
      expect(list?.[0]?.name, `cut at byte ${cut}`).toBe('日本 😀')
    }
  })

  it('a megabyte of output in small pieces', async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => ({
      Name: `Impresora ñ ${i}`,
      PortName: 'LPT1:',
      DriverName: 'Genérica',
    }))
    const bytes = Buffer.from(JSON.stringify(rows))
    const pieces: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 4093) pieces.push(bytes.subarray(i, i + 4093))
    const list = await listWindowsPrinters({ platform: 'win32', spawn: answering(pieces) })
    expect(list).toHaveLength(6000)
    expect(list?.every((p) => /^Impresora ñ \d+$/.test(p.name))).toBe(true)
  })

  it('stderr noise with exit 0 is ignored; exit 1 puts it in the error', async () => {
    expect(
      await listWindowsPrinters({
        platform: 'win32',
        spawn: answering([Buffer.from('[]')], 0, 'WARNING: slow spooler'),
      }),
    ).toEqual([])
    await expect(
      listWindowsPrinters({
        platform: 'win32',
        spawn: answering([], 1, 'Get-Printer : The Spooler service is not running'),
      }),
    ).rejects.toThrow('Spooler')
  })

  it('output that is not JSON throws (the route turns it into «type the name»)', async () => {
    await expect(
      listWindowsPrinters({ platform: 'win32', spawn: answering([Buffer.from('<html>')]) }),
    ).rejects.toThrow()
  })

  it('the listing script asks for UTF-8 output and never takes a name from the outside', async () => {
    const seen: string[] = []
    await listWindowsPrinters({
      platform: 'win32',
      spawn: (command, args, options) => {
        seen.push(script(args), String(options.env?.[PRINTER_NAME_VARIABLE]))
        return answering([Buffer.from('[]')])(command, args, options)
      },
    })
    expect(seen[0]).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    expect(seen[1]).toBe('undefined')
  })
})
