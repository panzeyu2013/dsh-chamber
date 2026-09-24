/**
 * ~/.ssh/config host discovery for the connections settings section: the
 * Electron main process projects NON-SECRET metadata only — alias, hostname,
 * user, ssh port. IdentityFile, ProxyCommand, passwords and every other
 * keyword are ignored outright; the renderer never sees keys or credentials.
 *
 * Parser (line-based, no dependencies): case-insensitive keywords, `#`
 * comments, double-quoted arguments, backslash continuations; wildcard Host
 * patterns (`* ? !`) and `Match` blocks are skipped; a leading global section
 * supplies default User/Port; `Include` is not expanded. A missing file is an
 * empty set, an unreadable one a loud `{error}` — never a silent empty success.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One discovered host entry — non-secret projection only. */
export interface SshConfigHost {
  /** The Host alias as written in the config. */
  alias: string
  /** HostName value, else the alias itself when the entry has none. */
  hostName: string
  /** User value (entry, else global default); null = ssh default. */
  user: string | null
  /** Port value (entry, else global default); null = ssh default (22). */
  port: number | null
}

/** The discovery result: the entry list, or a loud error (never empty). */
export type SshConfigDiscovery =
  | { hosts: SshConfigHost[] }
  | { error: string }

/** The config path the manager probes (overridable in tests). */
export const DEFAULT_SSH_CONFIG_PATH = join(homedir(), '.ssh', 'config')

/** Port range guard (mirrors transport-manager/provider validation). */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/** True for Host patterns that contain wildcard characters (`* ? !`). */
function isWildcardAlias(alias: string): boolean {
  return /[*?!]/.test(alias)
}

/** Strip one level of surrounding double quotes (ssh_config argument syntax). */
function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/** Parse a port that must be plain decimal (OpenSSH rejects 0x.. / 1e3). */
function parseDecimalPort(value: string): number | null {
  const unquoted = stripQuotes(value)
  if (!/^\d+$/.test(unquoted)) return null
  const parsed = Number(unquoted)
  return isValidPort(parsed) ? parsed : null
}

/** Parse ssh config text into non-secret host projections. A trailing backslash
 *  folds the line (inner spacing kept), comments (`#`, outside double quotes)
 *  are stripped on the assembled logical line, `Host` may carry several aliases
 *  (one entry each), and a global-section User/Port becomes the default for
 *  entries that do not set their own (first-obtained-wins). */
export function parseSshConfig(text: string): SshConfigHost[] {
  // Assemble logical lines: folding only; whitespace is kept for the keyword/value split.
  const logicalLines: string[] = []
  let pending = ''
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trimEnd().endsWith('\\')) {
      pending += rawLine.trimEnd().slice(0, -1)
      continue
    }
    const line = stripComment(`${pending}${rawLine}`).trim()
    pending = ''
    if (line !== '') logicalLines.push(line)
  }
  if (pending !== '') {
    const line = stripComment(pending).trim()
    if (line !== '') logicalLines.push(line)
  }

  const hosts: SshConfigHost[] = []
  let defaults: { user: string | null; port: number | null } = { user: null, port: null }
  let current: { aliases: string[]; hostName: string | null; user: string | null; port: number | null } | null = null
  let inMatchBlock = false

  const flush = () => {
    if (current === null) return
    const entry = current
    current = null
    const user = entry.user ?? defaults.user
    const port = entry.port ?? defaults.port
    const seen = new Set<string>()
    for (const alias of entry.aliases) {
      if (alias === '' || isWildcardAlias(alias) || seen.has(alias)) continue
      seen.add(alias)
      hosts.push({
        alias,
        hostName: entry.hostName ?? alias,
        user,
        port,
      })
    }
  }

  for (const line of logicalLines) {
    const spaceIndex = line.search(/\s/)
    const keyword = spaceIndex === -1 ? line.toLowerCase() : line.slice(0, spaceIndex).toLowerCase()
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim()
    if (keyword === 'host') {
      flush()
      inMatchBlock = false
      current = {
        aliases: value.split(/\s+/).filter(Boolean).map(stripQuotes),
        hostName: null,
        user: null,
        port: null,
      }
      continue
    }
    if (keyword === 'match') {
      flush()
      inMatchBlock = true
      continue
    }
    if (inMatchBlock) continue
    if (current === null) {
      // Global section (before any Host): User/Port become entry defaults.
      if (keyword === 'user' && value !== '') defaults.user = defaults.user ?? stripQuotes(value)
      if (keyword === 'port') {
        const parsed = parseDecimalPort(value)
        if (parsed !== null) defaults.port = defaults.port ?? parsed
      }
      continue
    }
    switch (keyword) {
      case 'hostname':
        if (value !== '') current.hostName = current.hostName ?? stripQuotes(value)
        break
      case 'user':
        if (value !== '') current.user = current.user ?? stripQuotes(value)
        break
      case 'port': {
        const parsed = parseDecimalPort(value)
        if (parsed !== null) current.port = current.port ?? parsed
        break
      }
      default:
        break
    }
  }
  flush()

  return hosts
}

/** Strip an unquoted `#` comment from a config line (OpenSSH treats `#` as a
 *  comment start only outside double quotes). */
function stripComment(line: string): string {
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && char === '#') return line.slice(0, index)
  }
  return line
}

/** Discover hosts from ~/.ssh/config: a missing file is an empty set, an
 *  unreadable one a loud `{error}` (corrupt is never a fake-empty). */
export function discoverSshConfigHosts(filePath: string = DEFAULT_SSH_CONFIG_PATH): SshConfigDiscovery {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { hosts: [] }
    return { error: `could not read ssh config: ${String(error)}` }
  }
  return { hosts: parseSshConfig(text) }
}
