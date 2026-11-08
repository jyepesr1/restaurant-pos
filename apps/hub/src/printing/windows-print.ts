import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { PrinterError } from './printer-error'

// USB printers through the Windows print queue (task 1.13, ADR-003). The hub runs as a service on
// the register PC and the USB printer is installed in Windows with its driver: Faro hands the
// ESC/POS bytes to its queue in RAW mode and Windows passes them to the printer untouched.
// PowerShell does it with winspool.drv (P/Invoke), so there is no native module to compile.
//
// The contract with PowerShell: the script goes in `-EncodedCommand` (UTF-16LE in base64: nothing
// to quote), the printer name in the `FARO_PRINTER_NAME` environment variable and the bytes in
// base64 on stdin. The exit code says what failed (`EXIT`).
//
// Known limitation: if the USB printer is off or unplugged, Windows usually accepts the job and
// keeps it in its queue until the printer comes back. Faro counts it as printed: it neither
// retries nor sends it to the fallback printer (docs/MODELO_DATOS.md#impresión-fase-1). What must
// happen now or never (the cash drawer pulse) goes with `nowOrNever`: if Windows still holds the
// job after a few seconds, it is removed from the queue and the send fails.

/** The environment variable that carries the printer name to PowerShell. */
export const PRINTER_NAME_VARIABLE = 'FARO_PRINTER_NAME'
/** Set to `1`: a job still in the Windows queue after `NOW_OR_NEVER_MS` is removed (exit 14). */
export const NOW_OR_NEVER_VARIABLE = 'FARO_NOW_OR_NEVER'
export const NOW_OR_NEVER_MS = 3000
/** A print that takes longer is killed: Windows is stuck and the queue must keep going. */
export const PRINT_TIMEOUT_MS = 30_000
/** Listing must answer before the device gives up on the hub (8 s). */
export const LIST_TIMEOUT_MS = 7000

/** What the print script exits with. Anything else is an unexpected PowerShell failure. */
export const EXIT = {
  ok: 0,
  notFound: 10,
  notOpened: 11,
  notStarted: 12,
  notWritten: 13,
  notTaken: 14,
} as const

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface WindowsOptions {
  platform?: NodeJS.Platform
  spawn?: Spawn
  timeoutMs?: number
  /** The printer must take it now (the drawer pulse): never left waiting in the Windows queue. */
  nowOrNever?: boolean
}

/** A printer installed in Windows, as «Cocina e impresoras» offers it. */
export interface WindowsPrinter {
  name: string
  port: string | null
  driver: string | null
}

const NOT_WINDOWS =
  'Las impresoras USB solo funcionan con Faro instalado en el PC de la caja con Windows: aquí, conéctala con cable de red.'
const SETTINGS = 'Configuración → Impresoras y escáneres'

const PRINT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FaroRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo1 {
    public string pDocName;
    public string pOutputFile;
    public string pDatatype;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr printer, int level, [In] DocInfo1 info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

  public static int Print(string name, byte[] bytes, out int job) {
    job = 0;
    IntPtr printer;
    // 1801: ERROR_INVALID_PRINTER_NAME.
    if (!OpenPrinter(name, out printer, IntPtr.Zero))
      return Marshal.GetLastWin32Error() == 1801 ? 10 : 11;
    try {
      DocInfo1 info = new DocInfo1();
      info.pDocName = "Faro";
      info.pDatatype = "RAW";
      job = StartDocPrinter(printer, 1, info);
      if (job == 0) {
        // 1804: ERROR_INVALID_DATATYPE. A v4 driver refuses RAW; XPS_PASS also goes through untouched.
        if (Marshal.GetLastWin32Error() != 1804) return 12;
        info.pDatatype = "XPS_PASS";
        job = StartDocPrinter(printer, 1, info);
        if (job == 0) return 12;
      }
      try {
        if (!StartPagePrinter(printer)) return 12;
        int written = 0;
        bool ok = bytes.Length == 0 || WritePrinter(printer, bytes, bytes.Length, out written);
        EndPagePrinter(printer);
        return ok && (bytes.Length == 0 || written == bytes.Length) ? 0 : 13;
      } finally {
        EndDocPrinter(printer);
      }
    } finally {
      ClosePrinter(printer);
    }
  }
}
'@
$name = $env:${PRINTER_NAME_VARIABLE}
if (-not $name) { exit 10 }
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$job = 0
$code = [FaroRawPrint]::Print($name, $bytes, [ref]$job)
if ($code -ne 0 -or $env:${NOW_OR_NEVER_VARIABLE} -ne '1') { exit $code }
# Now or never: a printer that is off leaves the job waiting in the queue; it must not come out later.
$until = (Get-Date).AddMilliseconds(${NOW_OR_NEVER_MS})
while ((Get-Date) -lt $until) {
  $waiting = Get-PrintJob -PrinterName $name -ID $job -ErrorAction SilentlyContinue
  if (-not $waiting) { exit 0 }
  Start-Sleep -Milliseconds 250
}
Remove-PrintJob -PrinterName $name -ID $job -ErrorAction SilentlyContinue
exit 14
`

const LIST_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$list = @(Get-Printer | Select-Object Name, PortName, DriverName)
ConvertTo-Json -InputObject $list -Compress
`

/** Windows' own PowerShell, by its full path: a `powershell.exe` earlier in the PATH is not run. */
const powershell = () =>
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** The arguments for running `script`: profile-less, non-interactive, without quoting. */
export const powershellArgs = (script: string): string[] => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
]

interface Outcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** It could not even start (PowerShell missing or blocked). */
  failed: Error | null
}

function runPowerShell(
  script: string,
  { env = {}, input = '' }: { env?: Record<string, string>; input?: string },
  o: WindowsOptions,
  timeoutMs: number,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (outcome: Partial<Outcome>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut: false, failed: null, ...outcome })
    }
    const child = (o.spawn ?? nodeSpawn)(powershell(), powershellArgs(script), {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill()
      finish({ timedOut: true })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', (error) => finish({ failed: error }))
    child.once('close', (code) => finish({ code }))
    // If PowerShell dies before reading, writing fails with EPIPE: its exit code says why.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

/** Why a USB print failed, in words for the register. */
function printFailure(name: string, r: Outcome): PrinterError {
  const message = r.failed
    ? 'No se pudo usar la cola de impresión de Windows en este equipo: reinstala Faro en el PC de la caja.'
    : r.timedOut
      ? `Windows no terminó de imprimir en «${name}»: revisa la impresora en ${SETTINGS}.`
      : r.code === EXIT.notFound
        ? `Windows no tiene una impresora llamada «${name}»: revisa que el nombre sea igual al de ${SETTINGS}.`
        : r.code === EXIT.notOpened
          ? `Windows no dejó usar la impresora «${name}»: revisa que esté instalada en ${SETTINGS}.`
          : r.code === EXIT.notStarted
            ? `Windows no aceptó el trabajo para «${name}»: revisa en ${SETTINGS} que no esté en pausa ni con un error.`
            : r.code === EXIT.notWritten
              ? `La impresora «${name}» no recibió todo: revisa el cable USB y que esté encendida.`
              : r.code === EXIT.notTaken
                ? `La impresora «${name}» no respondió: revisa que esté encendida y con el cable USB.`
                : `No se pudo imprimir por USB en «${name}» (código ${r.code ?? 'sin código'}).`
  return new PrinterError(message, {
    cause: r.failed ?? (r.stderr.trim() || undefined),
  })
}

/**
 * Hands the bytes to the queue of the Windows printer named `name`, in RAW mode. Fails with
 * `PrinterError` if Windows does not take them, or if the hub is not on Windows.
 */
export async function sendOverUsb(
  name: string,
  bytes: Uint8Array,
  o: WindowsOptions = {},
): Promise<void> {
  if ((o.platform ?? process.platform) !== 'win32') throw new PrinterError(NOT_WINDOWS)
  if (!name.trim())
    throw new PrinterError(`Escribe el nombre de la impresora como aparece en ${SETTINGS}.`)
  const r = await runPowerShell(
    PRINT_SCRIPT,
    {
      env: {
        [PRINTER_NAME_VARIABLE]: name,
        ...(o.nowOrNever ? { [NOW_OR_NEVER_VARIABLE]: '1' } : {}),
      },
      input: Buffer.from(bytes).toString('base64'),
    },
    o,
    o.timeoutMs ?? PRINT_TIMEOUT_MS,
  )
  if (r.failed || r.timedOut || r.code !== EXIT.ok) throw printFailure(name, r)
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** Ports of printers that only exist in Windows (PDF, XPS, fax, OneNote): never a ticket printer. */
const VIRTUAL_PORT =
  /^(PORTPROMPT:|NUL:|FILE:|XPSPORT:|SHRFAX:|ONENOTE|MICROSOFT\.OFFICE\.ONENOTE)/i

/**
 * What `Get-Printer | ConvertTo-Json` prints: nothing (no printers), one object or a list.
 * Rows without a name and virtual printers (PDF, XPS, fax) are dropped; the USB ones go first, then
 * by name.
 */
export function parsePrinterList(stdout: string): WindowsPrinter[] {
  const json = stdout.replace(/^\uFEFF/, '').trim()
  if (!json) return []
  const data: unknown = JSON.parse(json)
  const rows = Array.isArray(data) ? data : [data]
  const usb = (p: WindowsPrinter) => (p.port?.toUpperCase().startsWith('USB') ? 0 : 1)
  return rows
    .flatMap((r): WindowsPrinter[] => {
      if (!r || typeof r !== 'object') return []
      const { Name, PortName, DriverName } = r as Record<string, unknown>
      const name = text(Name)
      const port = text(PortName)
      if (!name || (port && VIRTUAL_PORT.test(port))) return []
      return [{ name, port, driver: text(DriverName) }]
    })
    .sort((a, b) => usb(a) - usb(b) || a.name.localeCompare(b.name, 'es'))
}

/**
 * The printers installed in Windows, or `null` if the hub is not on Windows. Fails if PowerShell
 * does not answer.
 */
export async function listWindowsPrinters(
  o: WindowsOptions = {},
): Promise<WindowsPrinter[] | null> {
  if ((o.platform ?? process.platform) !== 'win32') return null
  const r = await runPowerShell(LIST_SCRIPT, {}, o, o.timeoutMs ?? LIST_TIMEOUT_MS)
  if (r.failed) throw r.failed
  if (r.timedOut) throw new Error('Get-Printer did not answer in time')
  if (r.code !== 0) throw new Error(`Get-Printer failed (${r.code}): ${r.stderr.trim()}`)
  return parsePrinterList(r.stdout)
}
