import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PrinterError, sendToPrinter } from './transport'
import {
  EXIT,
  listWindowsPrinters,
  PRINTER_NAME_VARIABLE,
  parsePrinterList,
  powershellArgs,
  type Spawn,
  sendOverUsb,
} from './windows-print'

// USB printers through the Windows queue (task 1.13), with a fake PowerShell: what is run, how the
// name and the bytes reach it, and what the register reads for each way it can fail. The real
// script only runs on the register PC (see docs/PUESTA_EN_MARCHA.md).

interface Call {
  command: string
  args: readonly string[]
  options: SpawnOptions
  input: string
  killed: boolean
}

/**
 * A PowerShell that, once it has read stdin, answers with `exit` (code and stdout), never answers
 * (`'hang'`) or cannot start (`'missing'`).
 */
function fakePowerShell(
  answer: { code: number; stdout?: string; stderr?: string } | 'hang' | 'missing',
) {
  const calls: Call[] = []
  const spawn: Spawn = (command, args, options) => {
    const child = new EventEmitter() as ChildProcess
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const call: Call = { command, args, options, input: '', killed: false }
    calls.push(call)
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill: () => {
        call.killed = true
        return true
      },
    })
    if (answer === 'missing') {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' })))
      return child
    }
    stdin.on('data', (c) => {
      call.input += String(c)
    })
    stdin.on('finish', () => {
      if (answer === 'hang') return
      if (answer.stdout) stdout.write(answer.stdout)
      if (answer.stderr) stderr.write(answer.stderr)
      setImmediate(() => child.emit('close', answer.code))
    })
    return child
  }
  return { calls, spawn }
}

const decode = (args: readonly string[]) =>
  Buffer.from(String(args[args.indexOf('-EncodedCommand') + 1]), 'base64').toString('utf16le')
const BYTES = Uint8Array.from([0x1b, 0x40, 0x48, 0x6f, 0x6c, 0x61, 0x0a, 0x1d, 0x56, 0x42, 0])
const NAME = 'POS-80 "Caja" ñandú; $(rm -rf) `x`'

describe('sendOverUsb', () => {
  it('runs Windows PowerShell with the script encoded, the name in the environment and the bytes on stdin', async () => {
    const ps = fakePowerShell({ code: EXIT.ok })
    await sendOverUsb(NAME, BYTES, { platform: 'win32', spawn: ps.spawn })
    expect(ps.calls).toHaveLength(1)
    const [call] = ps.calls as [Call]
    expect(call.command).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    expect(call.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ])
    expect(call.args).toHaveLength(6)
    expect(call.options).toMatchObject({ windowsHide: true })
    expect(call.options.env?.[PRINTER_NAME_VARIABLE]).toBe(NAME)
    // The rest of the environment goes along (PowerShell needs SystemRoot, PATH…).
    expect(call.options.env?.PATH).toBe(process.env.PATH)
    expect(Buffer.from(call.input, 'base64')).toEqual(Buffer.from(BYTES))
    // The name never goes inside the script or the arguments: nothing to escape.
    expect(call.args.join(' ')).not.toContain('POS-80')
    expect(decode(call.args)).not.toContain('POS-80')
  })

  it('the script prints RAW through winspool and falls back to XPS_PASS for v4 drivers', async () => {
    const ps = fakePowerShell({ code: EXIT.ok })
    await sendOverUsb('POS-80', BYTES, { platform: 'win32', spawn: ps.spawn })
    const script = decode(ps.calls[0]?.args ?? [])
    for (const piece of [
      'winspool.drv',
      'OpenPrinterW',
      'StartDocPrinterW',
      'StartPagePrinter',
      'WritePrinter',
      'EndPagePrinter',
      'EndDocPrinter',
      'ClosePrinter',
      '"RAW"',
      '"XPS_PASS"',
      '1804',
      `$env:${PRINTER_NAME_VARIABLE}`,
      '[Console]::In.ReadToEnd()',
    ])
      expect(script).toContain(piece)
    expect(script.indexOf('"RAW"')).toBeLessThan(script.indexOf('"XPS_PASS"'))
  })

  it('an empty document is still handed over (empty stdin)', async () => {
    const ps = fakePowerShell({ code: EXIT.ok })
    await sendOverUsb('POS-80', new Uint8Array(), { platform: 'win32', spawn: ps.spawn })
    expect(ps.calls[0]?.input).toBe('')
  })

  it.each([
    [
      EXIT.notFound,
      /Windows no tiene una impresora llamada «POS-80».*Configuración → Impresoras y escáneres/,
    ],
    [EXIT.notOpened, /no dejó usar la impresora «POS-80»/],
    [EXIT.notStarted, /no aceptó el trabajo para «POS-80».*pausa/],
    [EXIT.notWritten, /no recibió todo: revisa el cable USB/],
    [1, /No se pudo imprimir por USB en «POS-80» \(código 1\)/],
  ])('exit code %s → a message for the register', async (code, message) => {
    const ps = fakePowerShell({ code, stderr: 'detalle técnico' })
    const error = await sendOverUsb('POS-80', BYTES, { platform: 'win32', spawn: ps.spawn }).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(message)
    // What PowerShell said goes to the log, not to the screen.
    expect(error.message).not.toContain('detalle técnico')
    expect(error.cause).toBe('detalle técnico')
  })

  it('if Windows does not answer within the time limit, PowerShell is killed and it fails', async () => {
    const ps = fakePowerShell('hang')
    const error = await sendOverUsb('POS-80', BYTES, {
      platform: 'win32',
      spawn: ps.spawn,
      timeoutMs: 20,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/Windows no terminó de imprimir en «POS-80»/)
    expect(ps.calls[0]?.killed).toBe(true)
  })

  it('if PowerShell cannot start, it fails with a message (it does not hang)', async () => {
    const ps = fakePowerShell('missing')
    const error = await sendOverUsb('POS-80', BYTES, { platform: 'win32', spawn: ps.spawn }).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(PrinterError)
    expect(error.message).toMatch(/cola de impresión de Windows/)
  })

  it.each(['darwin', 'linux'] as const)(
    'on %s it fails without running anything',
    async (platform) => {
      const ps = fakePowerShell({ code: EXIT.ok })
      const error = await sendOverUsb('POS-80', BYTES, { platform, spawn: ps.spawn }).catch(
        (e) => e,
      )
      expect(error).toBeInstanceOf(PrinterError)
      expect(error.message).toMatch(
        /solo funcionan con Faro instalado en el PC de la caja con Windows/,
      )
      expect(ps.calls).toEqual([])
    },
  )

  it('an empty name fails without running anything', async () => {
    const ps = fakePowerShell({ code: EXIT.ok })
    const error = await sendOverUsb('  ', BYTES, { platform: 'win32', spawn: ps.spawn }).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(PrinterError)
    expect(ps.calls).toEqual([])
  })
})

describe('sendToPrinter', () => {
  it.skipIf(process.platform === 'win32')(
    'a USB printer goes through Windows (here, not Windows: it says so)',
    async () => {
      const error = await sendToPrinter(
        { connection: 'usb', address: 'POS-80', port: null },
        BYTES,
      ).catch((e) => e)
      expect(error).toBeInstanceOf(PrinterError)
      expect(error.message).toMatch(/Windows/)
    },
  )
})

describe('parsePrinterList', () => {
  it('no output or an empty list: no printers', () => {
    expect(parsePrinterList('')).toEqual([])
    expect(parsePrinterList('  \r\n')).toEqual([])
    expect(parsePrinterList('[]')).toEqual([])
  })

  it('a single printer comes as one object', () => {
    expect(
      parsePrinterList('{"Name":"POS-80","PortName":"USB001","DriverName":"POS-80C"}\r\n'),
    ).toEqual([{ name: 'POS-80', port: 'USB001', driver: 'POS-80C' }])
  })

  it('several come as a list: USB first, then by name; with a BOM and accents', () => {
    const out = `﻿${JSON.stringify([
      {
        Name: 'Microsoft Print to PDF',
        PortName: 'PORTPROMPT:',
        DriverName: 'Microsoft Print To PDF',
      },
      { Name: 'Térmica Barra', PortName: 'USB002', DriverName: 'Generic / Text Only' },
      { Name: 'Caja ñ', PortName: 'usb001', DriverName: null },
      { Name: 'Fax', PortName: 'SHRFAX:', DriverName: 'Microsoft Shared Fax Driver' },
    ])}`
    // The virtual ones (PDF, fax) are not offered: they are not a printer with a drawer.
    expect(parsePrinterList(out)).toEqual([
      { name: 'Caja ñ', port: 'usb001', driver: null },
      { name: 'Térmica Barra', port: 'USB002', driver: 'Generic / Text Only' },
    ])
  })

  it('rows without a name, or that are not objects, are dropped', () => {
    expect(
      parsePrinterList(
        JSON.stringify([
          null,
          3,
          'x',
          { Name: '' },
          { Name: '  ' },
          { PortName: 'USB001' },
          { Name: 'Ok' },
        ]),
      ),
    ).toEqual([{ name: 'Ok', port: null, driver: null }])
  })

  it('output that is not JSON fails (the route then offers to type the name)', () => {
    expect(() => parsePrinterList('Get-Printer : error')).toThrow()
  })
})

describe('listWindowsPrinters', () => {
  it('off Windows it answers null without running anything', async () => {
    const ps = fakePowerShell({ code: 0 })
    expect(await listWindowsPrinters({ platform: 'darwin', spawn: ps.spawn })).toBeNull()
    expect(ps.calls).toEqual([])
  })

  it('on Windows it runs Get-Printer as UTF-8 JSON and reads its answer', async () => {
    const ps = fakePowerShell({
      code: 0,
      stdout: '[{"Name":"POS-80","PortName":"USB001","DriverName":"POS-80C"}]',
    })
    expect(await listWindowsPrinters({ platform: 'win32', spawn: ps.spawn })).toEqual([
      { name: 'POS-80', port: 'USB001', driver: 'POS-80C' },
    ])
    const script = decode(ps.calls[0]?.args ?? [])
    expect(script).toContain('Get-Printer')
    expect(script).toContain('ConvertTo-Json')
    expect(script).toContain('UTF8')
    expect(ps.calls[0]?.args.slice(0, 5)).toEqual(powershellArgs('x').slice(0, 5))
  })

  it('if PowerShell fails, takes too long or cannot start, it throws', async () => {
    await expect(
      listWindowsPrinters({ platform: 'win32', spawn: fakePowerShell({ code: 1 }).spawn }),
    ).rejects.toThrow()
    const hung = fakePowerShell('hang')
    await expect(
      listWindowsPrinters({ platform: 'win32', spawn: hung.spawn, timeoutMs: 20 }),
    ).rejects.toThrow()
    expect(hung.calls[0]?.killed).toBe(true)
    await expect(
      listWindowsPrinters({ platform: 'win32', spawn: fakePowerShell('missing').spawn }),
    ).rejects.toThrow()
  })
})

describe('powershellArgs', () => {
  it('encodes the script as UTF-16LE in base64, so it survives quotes and accents', () => {
    const script = `Write-Output "ñ 'x' $env:A"`
    expect(decode(powershellArgs(script))).toBe(script)
  })
})
