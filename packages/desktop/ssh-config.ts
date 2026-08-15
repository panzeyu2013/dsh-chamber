/**
 * ~/.ssh/config host discovery for the connections settings section
 * (design 05 §5): the Electron main process reads the user's ssh config and
 * projects NON-SECRET metadata only — alias, hostname, user, ssh port.
 *
 * Security discipline: IdentityFile, ProxyCommand, passwords, and every
 * other keyword are ignored outright; only Host / HostName / User / Port are
 * ever projected. The renderer never sees keys, proxies, or credentials.
 *
 * Parser scope (deliberately minimal, no dependencies):
 * - Line-based, case-insensitive keywords, `#` comments, double-quoted
 *   arguments, backslash line continuations (folding keeps inner spacing).
 * - Wildcard Host patterns (`*`, `?`, `!`) are skipped as entries, `Host`
 *   multi-alias lines expand to one entry per alias, `Match` blocks are
 *   skipped entirely, and a leading global section (settings before the
 *   first Host) contributes default User/Port to every entry, mirroring
 *   ssh's first-obtained-wins semantics for these fields.
 * - `Include` is not expanded (out of v1 scope).
 * - A missing config file is an empty set; an unreadable/corrupt file is a
 *   loud `{error}` result — never a silent empty success.
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

/**
 * Parse ssh config text into discovered hosts. Exposed for tests.
 *
 * Line folding follows ssh semantics: a trailing backslash drops the
 * backslash and the newline, everything else is kept (inner spacing
 * included); comments (`#`, outside double quotes) are stripped on the
 * assembled logical line. `Host` may carry several aliases on one line
 * (each becomes an entry); wildcard aliases (`* ? !`) are skipped as
 * entries; `Match` blocks are skipped entirely (their settings must not
 * leak into the previous/following entries); a global section (settings
 * before the first Host) contributes default User/Port to every entry.
 * `Include` is not expanded (out of v1 scope).
 * @param text - the raw config file content.
 * @returns the non-secret host projections.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  // Assemble logical lines (folding only; whitespace kept for the later
  // keyword/value split).
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

/**
 * Strip an unquoted `#` comment from a config line (OpenSSH only treats `#`
 * as a comment start, and only double quotes group arguments).
 */
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

/**
 * Discover hosts from ~/.ssh/config. A missing file is an empty set; an
 * unreadable file is a loud {error} (never a silent empty success — mirrors
 * the repo's "corrupt is never a fake-empty" invariant).
 * @param filePath - the config path (defaults to ~/.ssh/config).
 * @returns {hosts} or {error}.
 */
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
