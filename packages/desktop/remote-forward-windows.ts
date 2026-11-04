/**
 * remote-forward-windows — the pure Windows process-identity adapter for the
 * remote-browser forward plane (design 28 §6.1, S1).
 *
 * The reaper must prove a persisted child is the SAME process before killing it:
 * pid + start time + the exact argv. On Windows, CIM exposes the command line as
 * one string, so this module owns the one parser between that string and the
 * argv the launcher actually spawned. The parser follows the CommandLineToArgvW
 * quoting rules (quotes toggle, backslashes before a quote follow the 2n/2n+1
 * rule); an unterminated quote is not an identity token and yields null.
 *
 * The query is a pure argv builder; the caller (remote-forward-service) runs
 * powershell.exe with shell:false. A machine without PowerShell/CIM fails the
 * probe closed, never fabricates a token.
 */

const BACKSLASH = String.fromCharCode(92)
const TAB = String.fromCharCode(9)

/** The PowerShell argv for one CIM process query; shell:false by construction. */
export function windowsProcessQueryArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('invalid pid for the windows process query')
  const script = "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + String(pid)
    + "' -ErrorAction SilentlyContinue; if ($null -ne $p) { [pscustomobject]@{ startTime = $p.CreationDate.ToUniversalTime().ToString('o'); commandLine = $p.CommandLine } | ConvertTo-Json -Compress }"
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

/**
 * Tokenize a Windows CommandLine exactly as CommandLineToArgvW would.
 * Returns null for an unterminated quote (an unprovable identity, never a
 * best-effort guess).
 */
export function parseWindowsCommandLine(commandLine: string): string[] | null {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return null
  const argv: string[] = []
  let current = ''
  let inQuotes = false
  let backslashes = 0
  let tokenStarted = false

  const flush = (): void => {
    if (!tokenStarted) return
    argv.push(current)
    current = ''
    tokenStarted = false
  }

  for (const ch of commandLine) {
    if (ch === BACKSLASH) {
      backslashes += 1
      tokenStarted = true
      continue
    }
    if (ch === '"') {
      tokenStarted = true
      if (backslashes > 0) {
        current += BACKSLASH.repeat(Math.floor(backslashes / 2))
        if (backslashes % 2 === 1) current += '"'
        else inQuotes = !inQuotes
        backslashes = 0
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (backslashes > 0) {
      current += BACKSLASH.repeat(backslashes)
      backslashes = 0
    }
    if (!inQuotes && (ch === ' ' || ch === TAB)) {
      flush()
      continue
    }
    current += ch
    tokenStarted = true
  }

  if (inQuotes) return null
  if (backslashes > 0) {
    current += BACKSLASH.repeat(backslashes)
    tokenStarted = true
  }
  flush()
  return argv.length === 0 ? null : argv
}

/** The parsed identity of one Windows process; null = no provable identity. */
export interface WindowsProcessIdentity {
  /** The normalized creation token ('cim:<ISO>'), shared by ledger and probe. */
  readonly startTime: string
  /** The command line exactly as CIM returned it (diagnostic only). */
  readonly commandLine: string
  /** The tokenized argv compared with the spawn argv. */
  readonly argv: readonly string[]
}

/** Parse the compact JSON emitted by windowsProcessQueryArgs; null = unprovable. */
export function parseWindowsProcessJson(text: string): WindowsProcessIdentity | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as { startTime?: unknown; commandLine?: unknown }
  if (typeof record.startTime !== 'string' || record.startTime === '') return null
  if (typeof record.commandLine !== 'string' || record.commandLine.trim() === '') return null
  const argv = parseWindowsCommandLine(record.commandLine)
  if (argv === null) return null
  return { startTime: 'cim:' + record.startTime, commandLine: record.commandLine, argv }
}
