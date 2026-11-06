/**
 * Application-owned SSH known_hosts + the failure-triggered "ssh self-proof" host-key probe
 * (remote-connection hardening plan v0.2 §4.3 / P0-3).
 *
 * WHY a second known_hosts: the app must never let ssh auto-accept an unknown host key, and it
 * must never mutate the user's ~/.ssh/known_hosts. The app therefore owns
 * <userData>/ssh/known_hosts (0600, atomic replace, module-level mutex). On first use the user
 * file is COPIED in, so hosts the user already trusts stay known; from then on the app file is
 * the only trust store the ssh children read
 * (-o StrictHostKeyChecking=yes -o UserKnownHostsFile="<app>" -o GlobalKnownHostsFile=/dev/null;
 * paths are quoted for ssh — see sshOptionValue).
 *
 * WHY the self-proof probe: with StrictHostKeyChecking=yes a new/changed host fails BEFORE the app
 * can show what it actually presented. ssh can prove a host key without authenticating:
 *   ssh -o UserKnownHostsFile="<fresh tmp 0600>" -o GlobalKnownHostsFile=/dev/null
 *       -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=8
 *       -o PreferredAuthentications=none <target> true
 * KEX runs first, ssh writes the presented key to the throwaway file, then auth fails (by design:
 * PreferredAuthentications=none is not a credential path) and the file is read and deleted.
 * Going through the real ssh binary means ProxyJump / ProxyCommand / HostName / HostKeyAlias in the
 * user's config are honored without the app parsing ssh_config.
 *
 * TRUST DISCIPLINE: the trust IPC only accepts the (type, blob) pair of the MOST RECENT probe for
 * that target within HOST_KEY_PROBE_TTL_MS. Nothing in the renderer can invent key material; a
 * stale tab cannot trust a key the server stopped presenting.
 *
 * Non-secret by construction: a host key is public key material. Fingerprints and the base64 blob
 * may cross IPC; no credential ever does.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from './control-plane-module.ts'
import type { HostKeyProjection, SpawnedProcess } from './transport-provider.ts'

/** Upper bound of a known_hosts file the app will read/import (a real file is a few KiB). */
export const KNOWN_HOSTS_MAX_BYTES = 4 * 1024 * 1024

/** The trust IPC accepts only a probe recorded within this window. */
export const HOST_KEY_PROBE_TTL_MS = 5 * 60_000

/** Whole self-proof budget: ConnectTimeout (8s) + KEX + one auth round trip, with margin. */
export const HOST_KEY_PROBE_TIMEOUT_MS = 20_000

/** The ssh ConnectTimeout the self-proof probe passes (same value as the tunnel's). */
export const HOST_KEY_CONNECT_TIMEOUT_SECONDS = 8

/** Host-key trust state for one target (non-secret projection). */
export type HostKeyState = 'unknown' | 'known' | 'changed' | 'unavailable'

/** The ssh destination a host key belongs to (user is part of argv, never of the pattern). */
export interface HostKeyTarget {
  host: string
  /** SSH daemon port; null/22 = the bare host pattern. */
  sshPort: number | null
  user?: string | null
}

/** One parsed known_hosts line (markers, host patterns, key type, base64 blob). */
export interface KnownHostEntry {
  markers: string[]
  patterns: string[]
  type: string
  blob: string
  /** The verbatim line (no trailing CR/newline). */
  raw: string
}

/** A host key as presented by the server (public material only). */
export interface PresentedHostKey {
  type: string
  blob: string
}

/** Outcome of one self-proof probe — everything needed to render + trust (non-secret). */
export interface HostKeyProbeOutcome {
  state: HostKeyState
  type: string | null
  blob: string | null
  /** SHA256:… fingerprint(s) of the key the host presented (empty when unavailable). */
  fingerprints: string[]
  /** Trusted fingerprints already on file for this target (changed state). */
  previousFingerprints: string[]
  changed: boolean
  probedAt: number
  /** Non-secret failure detail (unavailable state only). */
  reason?: string
}

/** The two ssh arguments that point every child at the app-owned trust store. */
export interface KnownHostsArgs {
  knownHostsFile: string
  globalKnownHostsFile: string
}

/** The injectable spawn seam (tests pass a fake; production uses node:child_process.spawn). */
export type HostKeySpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess

/** The store/guard consumed by the transport manager and the host-key IPC handlers. */
export interface HostKeyGuard {
  readonly knownHostsFile: string
  /** The -o values for every ssh child that must enforce the app trust store. */
  knownHostsArgs(): KnownHostsArgs
  /** Synchronous pre-spawn gate: does the app file hold ANY key for this target? */
  isKnown(target: HostKeyTarget): boolean
  /** Failure-triggered self-proof; records the outcome for the trust IPC. */
  probe(target: HostKeyTarget): Promise<HostKeyProbeOutcome>
  /** The last recorded probe projection for display (null = never probed). */
  projection(target: HostKeyTarget): HostKeyProjection | null
  /** Write the last-probed key into the app file (changed state replaces the target's rows). */
  trust(target: HostKeyTarget, candidate: PresentedHostKey): Promise<
    { ok: true; replaced: boolean; projection: HostKeyProjection } | { ok: false; error: string }
  >
}

/** <userData>/ssh/known_hosts — the app-owned store (never the user's ~/.ssh file). */
export function knownHostsPathFor(userDataDir: string): string {
  return join(userDataDir, 'ssh', 'known_hosts')
}

/** The import source: the user's own OpenSSH file (read-only; never written by the app). */
export function defaultUserKnownHostsPath(home: string = homedir()): string {
  return join(home, '.ssh', 'known_hosts')
}

/** GlobalKnownHostsFile per platform: /dev/null, or NUL on Win32-OpenSSH. */
export function globalKnownHostsFileFor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

/** The known_hosts host token this app records. Every ssh child is pinned with
 *  `-o HostKeyAlias=<this token>`, so OpenSSH hashes/looks up the ALIAS verbatim
 *  (literal, never rewritten to [host]:port); the trust file must use the same
 *  token or the strict child reports "No ... host key is known" (B1). */
export function hostPatternFor(target: HostKeyTarget): string {
  return hostKeyAliasFor(target)
}

/** The value passed to `-o HostKeyAlias=`. It is the known_hosts token itself:
 *  the bare host on 22/null, `host:port` otherwise, so two servers on one host
 *  keep separate trust entries (OpenSSH hashes the alias verbatim). */
export function hostKeyAliasFor(target: HostKeyTarget): string {
  const bare = bareHost(target.host)
  return target.sshPort === null || target.sshPort === 22 ? bare : bare + ':' + String(target.sshPort)
}

function bareHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Candidate names a stored pattern is matched against: the alias token first
 *  (what current ssh children look up), plus the legacy [host]:port forms so an
 *  app file written before HostKeyAlias still recognizes its target. */
function hostCandidatesFor(target: HostKeyTarget): string[] {
  const bare = bareHost(target.host)
  if (target.sshPort === null || target.sshPort === 22) return [bare, '[' + bare + ']:22']
  // Alias form first; the legacy bracketed form keeps pre-HostKeyAlias files
  // recognizable without letting a default-port entry authorize another port.
  return [hostKeyAliasFor(target), '[' + bare + ']:' + String(target.sshPort)]
}

/** The ssh argv target (user@host); the port travels in its own -p flag. */
export function sshTargetArgFor(target: HostKeyTarget): string {
  return target.user !== undefined && target.user !== null && target.user !== ''
    ? target.user + '@' + target.host
    : target.host
}

const KNOWN_HOST_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9@._+-]*$/
const KNOWN_HOST_BLOB_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/** Parse ONE known_hosts line; null for comments/blanks/malformed lines (tolerated, never fatal). */
export function parseKnownHostsLine(line: string): KnownHostEntry | null {
  const raw = line.replace(/\r$/, '')
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const fields = trimmed.split(/\s+/)
  const markers: string[] = []
  let index = 0
  while (index < fields.length && (fields[index] as string).startsWith('@')) {
    markers.push(fields[index] as string)
    index += 1
  }
  if (index + 2 >= fields.length) return null
  const patterns = (fields[index] as string).split(',').filter(pattern => pattern !== '')
  const type = fields[index + 1] as string
  const blob = fields[index + 2] as string
  if (patterns.length === 0) return null
  if (!KNOWN_HOST_TYPE_PATTERN.test(type) || !KNOWN_HOST_BLOB_PATTERN.test(blob)) return null
  return { markers, patterns, type, blob, raw }
}

/** Parse a whole known_hosts text; unparsable lines are skipped (a copy of a user file may hold
 *  shapes OpenSSH tolerates but this parser does not need to understand). */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []
  for (const line of text.split('\n')) {
    const entry = parseKnownHostsLine(line)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/** Render one known_hosts line (markers first, comma-joined patterns). */
export function formatKnownHostsLine(entry: Pick<KnownHostEntry, 'patterns' | 'type' | 'blob'> & { markers?: string[] }): string {
  const markers = entry.markers ?? []
  return markers.concat([entry.patterns.join(','), entry.type, entry.blob]).join(' ')
}

/** SHA256:… of a base64 key blob, in the ssh-keygen -E sha256 shape (no padding). Null for an
 *  invalid blob. */
export function fingerprintSha256(blobBase64: string): string | null {
  if (!KNOWN_HOST_BLOB_PATTERN.test(blobBase64)) return null
  const raw = Buffer.from(blobBase64, 'base64')
  if (raw.length === 0) return null
  return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
}

function wildcardMatch(pattern: string, candidates: readonly string[]): boolean {
  let source = ''
  for (const ch of pattern) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else if ('.+^$()|[]{}'.includes(ch)) source += '\\' + ch
    else source += ch
  }
  const matcher = new RegExp('^' + source + '$')
  return candidates.some(candidate => matcher.test(candidate))
}

/** OpenSSH hashed pattern: |1|<base64 salt>|<base64 HMAC-SHA1(salt, hostname)>. */
function hashedPatternMatches(pattern: string, candidates: readonly string[]): boolean {
  const parts = pattern.split('|')
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== '1') return false
  const salt = Buffer.from(parts[2] as string, 'base64')
  const expected = Buffer.from(parts[3] as string, 'base64')
  if (salt.length === 0 || expected.length !== 20) return false
  for (const candidate of candidates) {
    const digest = createHmac('sha1', salt).update(candidate).digest()
    if (digest.length === expected.length && timingSafeEqual(digest, expected)) return true
  }
  return false
}

/** Does this stored line cover the target? Honored forms: wildcard/negation patterns, hashed
 *  entries and the plain host / [host]:port shape. */
export function entryMatchesTarget(entry: KnownHostEntry, target: HostKeyTarget, match: 'any' | 'current' = 'any'): boolean {
  const candidates = match === 'current' ? [hostKeyAliasFor(target)] : hostCandidatesFor(target)
  let matched = false
  for (const pattern of entry.patterns) {
    const negative = pattern.startsWith('!')
    const name = negative ? pattern.slice(1) : pattern
    if (name === '') continue
    const hit = name.startsWith('|1|') ? hashedPatternMatches(name, candidates) : wildcardMatch(name, candidates)
    if (!hit) continue
    if (negative) return false
    matched = true
  }
  return matched
}

/** Three-state comparison of a presented key against the app store text. */
export function classifyPresentedHostKey(
  knownHostsText: string,
  target: HostKeyTarget,
  presented: PresentedHostKey,
): { state: 'unknown' | 'known' | 'changed'; previousFingerprints: string[] } {
  // @revoked is a denial marker, not a trust: never report a revoked key as
  // known (the spawn gate also refuses it; trust() rejects overriding it).
  if (hasRevokedKey(knownHostsText, target, presented)) return { state: 'unknown', previousFingerprints: [] }
  // @cert-authority certifies a CA key, not a host key: never let it prove trust.
  // @revoked rows for OTHER keys are denials too, but not evidence about this key.
  const matching = parseKnownHosts(knownHostsText)
    .filter(entry => !entry.markers.includes('@cert-authority') && !entry.markers.includes('@revoked'))
    .filter(entry => entryMatchesTarget(entry, target))
  if (matching.length === 0) return { state: 'unknown', previousFingerprints: [] }
  const previous = [...new Set(matching
    .map(entry => fingerprintSha256(entry.blob))
    .filter((value): value is string => value !== null))]
  if (matching.some(entry => entry.type === presented.type && entry.blob === presented.blob)) {
    return { state: 'known', previousFingerprints: previous }
  }
  return { state: 'changed', previousFingerprints: previous }
}

/** Validate caller-supplied key material before it can reach the file. */
export function isPresentedHostKey(value: unknown): value is PresentedHostKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.type === 'string' && KNOWN_HOST_TYPE_PATTERN.test(record.type)
    && typeof record.blob === 'string' && KNOWN_HOST_BLOB_PATTERN.test(record.blob)
}

function legacyPatternFor(target: HostKeyTarget): string | null {
  if (target.sshPort === null || target.sshPort === 22) return null
  return '[' + bareHost(target.host) + ']:' + String(target.sshPort)
}

function isExactTargetPattern(pattern: string, target: HostKeyTarget): boolean {
  return pattern === hostPatternFor(target) || pattern === legacyPatternFor(target)
}

function patternMatchesTarget(pattern: string, target: HostKeyTarget): boolean {
  if (pattern.startsWith('!')) return false
  const name = pattern
  const candidates = hostCandidatesFor(target)
  return name.startsWith('|1|') ? hashedPatternMatches(name, candidates) : wildcardMatch(name, candidates)
}

/**
 * Trust one key: drop the target's identical rows first (replace = drop every row for the target,
 * the changed-key case), then append the canonical line. Comments and unrelated lines survive
 * verbatim; a trailing newline is guaranteed.
 */
/** True when this exact key is revoked for the target (OpenSSH @revoked is per key,
 *  not per host). Both the alias token and the legacy [host]:port form count. */
export function hasRevokedKey(
  knownHostsText: string,
  target: HostKeyTarget,
  key: PresentedHostKey,
): boolean {
  return parseKnownHosts(knownHostsText).some(entry => entry.markers.includes('@revoked')
    && entryMatchesTarget(entry, target, 'any')
    && entry.type === key.type && entry.blob === key.blob)
}

export function applyTrustedHostKey(
  knownHostsText: string,
  target: HostKeyTarget,
  key: PresentedHostKey,
  options: { replace?: boolean } = {},
): { text: string; replaced: boolean } {
  const replace = options.replace === true
  const kept: string[] = []
  let replaced = false
  for (const rawLine of knownHostsText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const entry = parseKnownHostsLine(line)
    if (entry === null) {
      kept.push(line)
      continue
    }
    const sameTarget = entryMatchesTarget(entry, target)
    const sameKey = entry.type === key.type && entry.blob === key.blob
    // A revocation is a standing denial; a trust write must never erase it.
    if (sameTarget && (entry.markers.includes('@revoked') || entry.markers.includes('@cert-authority'))) {
      kept.push(line)
      continue
    }
    if (sameTarget && (replace || sameKey)) {
      const exact = entry.patterns.length === 1 && isExactTargetPattern(entry.patterns[0]!, target)
      if (exact) { replaced = true; continue }
      if (replace) {
        // Do not erase a wildcard/multi-pattern row that covers OTHER hosts.
        // Remove the target's exact patterns; if a wildcard/hashed pattern still
        // matches it, prepend a negation so the old key stays valid only for the
        // other hosts (merge review B-M2).
        const remaining = entry.patterns.filter(pattern => !isExactTargetPattern(pattern, target))
        if (remaining.some(pattern => patternMatchesTarget(pattern, target))) {
          remaining.unshift('!' + hostPatternFor(target))
        }
        if (remaining.length > 0) {
          kept.push(formatKnownHostsLine({ markers: entry.markers, patterns: remaining, type: entry.type, blob: entry.blob }))
        }
        replaced = true
        continue
      }
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  kept.push(formatKnownHostsLine({ patterns: [hostPatternFor(target)], type: key.type, blob: key.blob }))
  return { text: kept.join('\n') + '\n', replaced }
}

/**
 * Module-level mutex: every read-modify-write of the app file serializes through ONE promise chain
 * (a rejected task must not poison the chain). Concurrent trust calls can therefore never lose a
 * row to a lost update.
 */
let knownHostsMutex: Promise<unknown> = Promise.resolve()
export function withKnownHostsMutex<T>(task: () => T | Promise<T>): Promise<T> {
  const run = knownHostsMutex.then(task, task)
  knownHostsMutex = run.then(() => undefined, () => undefined)
  return run
}

export interface KnownHostsStoreOptions {
  knownHostsFile: string
  /** First-use import source; null/absent = no import (tests). */
  userKnownHostsFile?: string | null
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

function logLine(options: KnownHostsStoreOptions, level: 'info' | 'warn' | 'error', message: string): void {
  options.log?.(level, message)
}

/** Read the app file (0600 tightened on read, bounded, no symlink following). Missing = ''. */
function readKnownHostsText(options: KnownHostsStoreOptions): string {
  try {
    return readPrivateFileNoFollow(options.knownHostsFile, {
      maxBytes: KNOWN_HOSTS_MAX_BYTES,
      tightenMode: 0o600,
    }).value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Ensure the app file exists: create <userData>/ssh (0700) and, on FIRST use, copy the user's
 * ~/.ssh/known_hosts in (read-only source) so already-trusted hosts stay known. Synchronous on
 * purpose: it runs on the pre-spawn path and can never interleave with another synchronous writer.
 */
export function ensureKnownHostsFile(options: KnownHostsStoreOptions): void {
  if (existsSync(options.knownHostsFile)) return
  ensurePrivateDirectoryNoFollow(dirname(options.knownHostsFile), 0o700)
  let imported = ''
  const source = options.userKnownHostsFile ?? null
  if (source !== null) {
    try {
      const stat = statSync(source)
      if (stat.isFile() && stat.size <= KNOWN_HOSTS_MAX_BYTES) imported = readFileSync(source, 'utf8')
    } catch {
      // A missing/unreadable user file is not an error: the app starts empty and every host goes
      // through the explicit trust flow.
    }
  }
  atomicWritePrivateFileNoFollow(options.knownHostsFile, imported, { mode: 0o600 })
  logLine(options, 'info', 'initialized ' + options.knownHostsFile + (imported === '' ? ' (empty)' : ' (imported from the user known_hosts)'))
}

/** Synchronous pre-spawn gate: any stored key for the target = known. Read failures fail CLOSED. */
export function isHostKeyKnown(options: KnownHostsStoreOptions, target: HostKeyTarget): boolean {
  try {
    ensureKnownHostsFile(options)
    const text = readKnownHostsText(options)
    // Only the token ssh ACTUALLY looks up proves the spawn gate; a legacy
    // [host]:port row is not seen by a HostKeyAlias child (review R2-A minor 1).
    return parseKnownHosts(text)
      .filter(entry => !entry.markers.includes('@cert-authority') && !entry.markers.includes('@revoked'))
      .some(entry => entryMatchesTarget(entry, target, 'current'))
  } catch (error) {
    logLine(options, 'warn', 'cannot read ' + options.knownHostsFile + ': ' + String(error))
    return false
  }
}

const probeRegistry = new Map<string, Map<string, HostKeyProbeOutcome>>()

function probeKeyFor(target: HostKeyTarget): string {
  return target.host + '\u0000' + String(target.sshPort ?? '')
}

/** Remember the latest probe for one app file + target (the trust IPC's only source of truth). */
export function recordHostKeyProbe(knownHostsFile: string, target: HostKeyTarget, outcome: HostKeyProbeOutcome): void {
  let byTarget = probeRegistry.get(knownHostsFile)
  if (byTarget === undefined) {
    byTarget = new Map()
    probeRegistry.set(knownHostsFile, byTarget)
  }
  byTarget.set(probeKeyFor(target), outcome)
}

/** The most recent probe within TTL, or null (expired/absent). */
export function lastHostKeyProbe(
  knownHostsFile: string,
  target: HostKeyTarget,
  now: number = Date.now(),
): HostKeyProbeOutcome | null {
  const outcome = probeRegistry.get(knownHostsFile)?.get(probeKeyFor(target)) ?? null
  if (outcome === null) return null
  return now - outcome.probedAt <= HOST_KEY_PROBE_TTL_MS ? outcome : null
}

/** Project a probe outcome onto the non-secret status field. */
export function toHostKeyProjection(outcome: HostKeyProbeOutcome): HostKeyProjection {
  return {
    state: outcome.state,
    fingerprints: [...outcome.fingerprints],
    ...(outcome.changed ? { changed: true } : {}),
    // previousFingerprints is a CHANGED-state field (see HostKeyProjection): projecting it for a
    // known key rendered「原指纹」and「主机指纹」with the SAME value, which reads like a rotation
    // when nothing rotated.
    ...(outcome.changed && outcome.previousFingerprints.length > 0
      ? { previousFingerprints: [...outcome.previousFingerprints] }
      : {}),
  }
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
  return spawn(command, args, options)
}

let knownHostsCommandSupported: boolean | undefined

/** `KnownHostsCommand=none` was added in OpenSSH 8.5; older ssh treats the option
 *  as a fatal config error. Probe once and only pin it when the local client
 *  understands it, so an old Linux/Win32 ssh keeps working. */
export function sshSupportsKnownHostsCommand(): boolean {
  if (knownHostsCommandSupported !== undefined) return knownHostsCommandSupported
  try {
    const result = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 2_000 })
    const text = String(result.stderr ?? '') + String(result.stdout ?? '')
    const match = /OpenSSH_(\d+)\.(\d+)/.exec(text)
    knownHostsCommandSupported = match !== null
      && (Number(match[1]) > 8 || (Number(match[1]) === 8 && Number(match[2]) >= 5))
  } catch {
    knownHostsCommandSupported = false
  }
  return knownHostsCommandSupported
}

/** Trust pins shared by the self-proof, tunnel and exec argv. */
export function sshTrustPins(): string[] {
  const pins = ['-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no']
  if (sshSupportsKnownHostsCommand()) pins.push('-o', 'KnownHostsCommand=none')
  return pins
}

/**
 * Quote one ssh-config option VALUE for `-o`.
 *
 * ssh splits a `-o` argument on whitespace and honours double quotes only INSIDE the argument
 * (ssh_config syntax: "Arguments may optionally be enclosed in double quotes in order to
 * represent arguments containing spaces"). An unquoted path with a space is silently truncated,
 * so the option points somewhere else — for a file it does not exist and ssh reports
 * "No <type> host key is known for <alias>" / "Host key verification failed.".
 *
 * This matters on every macOS install: userData lives under
 * `~/Library/Application Support/<app>/…`, so the app-owned known_hosts path ALWAYS contains a
 * space. Without quoting, no strict child could ever read the store, and trusting a key could
 * never make a tunnel succeed (the trust UI kept re-offering the same key forever).
 */
export function sshOptionValue(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** The exact self-proof argv (exported for the argv pin test). */
export function buildSelfProofArgs(
  target: HostKeyTarget,
  knownHostsFile: string,
  globalKnownHostsFile: string = globalKnownHostsFileFor(),
): string[] {
  return [
    '-o', 'UserKnownHostsFile=' + sshOptionValue(knownHostsFile),
    '-o', 'GlobalKnownHostsFile=' + sshOptionValue(globalKnownHostsFile),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=' + String(HOST_KEY_CONNECT_TIMEOUT_SECONDS),
    '-o', 'PreferredAuthentications=none',
    // A user ControlMaster would serve KEX from an existing connection and the
    // throwaway known_hosts would stay empty (review R2-A MAJOR-1).
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    ...sshTrustPins(),
    '-o', 'HostKeyAlias=' + hostKeyAliasFor(target),
    ...(target.sshPort === null ? [] : ['-p', String(target.sshPort)]),
    sshTargetArgFor(target),
    'true',
  ]
}

/** One bounded ssh invocation for the self-proof; resolves on exit/error/timeout, never rejects. */
function runSelfProof(
  target: HostKeyTarget,
  knownHostsFile: string,
  spawnFn: HostKeySpawnFn,
  timeoutMs: number,
  globalKnownHostsFile: string,
): Promise<{ stderr: string; timedOut: boolean }> {
  const args = buildSelfProofArgs(target, knownHostsFile, globalKnownHostsFile)
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let stderr = ''
    const done = (timedOut: boolean) => {
      if (settled) return
      settled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      resolve({ stderr, timedOut })
    }
    let child: SpawnedProcess
    try {
      child = spawnFn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      stderr = String(error)
      done(false)
      return
    }
    child.stderr?.on('data', chunk => {
      if (stderr.length < 2048) stderr += String(chunk)
    })
    child.on('error', error => { stderr += String(error); done(false) })
    child.on('exit', () => done(false))
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done(true)
    }, timeoutMs)
    timer.unref?.()
  })
}

export interface ProbeHostKeyOptions extends KnownHostsStoreOptions {
  target: HostKeyTarget
  spawnFn?: HostKeySpawnFn
  timeoutMs?: number
  now?: () => number
}

/**
 * The failure-triggered ssh self-proof: run ssh against the target with a THROWAWAY known_hosts,
 * read the key ssh recorded there, compare it with the app store and classify unknown/known/
 * changed/unavailable. Never throws; the throwaway file is always deleted.
 */
export async function probeHostKey(options: ProbeHostKeyOptions): Promise<HostKeyProbeOutcome> {
  const now = options.now ?? Date.now
  const probedAt = now()
  const unavailable = (reason: string): HostKeyProbeOutcome => ({
    state: 'unavailable', type: null, blob: null, fingerprints: [], previousFingerprints: [],
    changed: false, probedAt, reason,
  })
  try {
    ensureKnownHostsFile(options)
  } catch (error) {
    return unavailable('cannot initialize ' + options.knownHostsFile + ': ' + String(error))
  }
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-chamber-hostkey-'))
    chmodSync(dir, 0o700)
    const probeFile = join(dir, 'known_hosts')
    const fd = openSync(probeFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    closeSync(fd)
    const proof = await runSelfProof(
      options.target,
      probeFile,
      options.spawnFn ?? defaultSpawn,
      options.timeoutMs ?? HOST_KEY_PROBE_TIMEOUT_MS,
      globalKnownHostsFileFor(),
    )
    let probeText = ''
    try { probeText = readFileSync(probeFile, 'utf8') } catch { probeText = '' }
    const entries = parseKnownHosts(probeText)
    if (entries.length === 0) {
      const detail = proof.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''
      return unavailable(proof.timedOut
        ? 'ssh self-proof timed out'
        : 'ssh self-proof wrote no host key' + (detail === '' ? '' : ': ' + detail))
    }
    const matching = entries.filter(entry => entryMatchesTarget(entry, options.target))
    if (matching.length === 0) {
      // A ProxyJump hop or a failed target can leave only OTHER hosts in the
      // throwaway file; never present an unrelated key as this target's key.
      return unavailable('ssh self-proof wrote no host key for the target')
    }
    const presentedEntry = matching[matching.length - 1] as KnownHostEntry
    const presented: PresentedHostKey = { type: presentedEntry.type, blob: presentedEntry.blob }
    const fingerprint = fingerprintSha256(presented.blob)
    let classified: { state: 'unknown' | 'known' | 'changed'; previousFingerprints: string[] }
    try {
      classified = classifyPresentedHostKey(readKnownHostsText(options), options.target, presented)
    } catch (error) {
      logLine(options, 'warn', 'cannot compare against ' + options.knownHostsFile + ': ' + String(error))
      classified = { state: 'unknown', previousFingerprints: [] }
    }
    return {
      state: classified.state,
      type: presented.type,
      blob: presented.blob,
      fingerprints: fingerprint === null ? [] : [fingerprint],
      previousFingerprints: classified.previousFingerprints,
      changed: classified.state === 'changed',
      probedAt,
    }
  } catch (error) {
    return unavailable('host-key probe failed: ' + String(error))
  } finally {
    if (dir !== null) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** Trust one key in the app store (mutex + atomic replace). The caller has already validated it
 *  against the most recent probe. */
export async function writeTrustedHostKey(
  options: KnownHostsStoreOptions,
  target: HostKeyTarget,
  candidate: PresentedHostKey,
  replace: boolean,
): Promise<{ replaced: boolean }> {
  return withKnownHostsMutex(() => {
    ensureKnownHostsFile(options)
    const next = applyTrustedHostKey(readKnownHostsText(options), target, candidate, { replace })
    atomicWritePrivateFileNoFollow(options.knownHostsFile, next.text, { mode: 0o600 })
    return { replaced: next.replaced }
  })
}

export interface CreateHostKeyGuardOptions extends KnownHostsStoreOptions {
  spawnFn?: HostKeySpawnFn
  timeoutMs?: number
  now?: () => number
}

/** Build the store/guard used by the transport manager and the host-key IPC handlers. Two guards
 *  over the same file are safe: the file is the state and the probe registry is module-level. */
export function createHostKeyGuard(options: CreateHostKeyGuardOptions): HostKeyGuard {
  const storeOptions: KnownHostsStoreOptions = {
    knownHostsFile: options.knownHostsFile,
    ...(options.userKnownHostsFile === undefined ? {} : { userKnownHostsFile: options.userKnownHostsFile }),
    ...(options.log === undefined ? {} : { log: options.log }),
  }
  return {
    knownHostsFile: options.knownHostsFile,
    knownHostsArgs(): KnownHostsArgs {
      return {
        knownHostsFile: options.knownHostsFile,
        globalKnownHostsFile: globalKnownHostsFileFor(),
      }
    },
    isKnown(target) {
      return isHostKeyKnown(storeOptions, target)
    },
    async probe(target) {
      const outcome = await probeHostKey({
        ...storeOptions,
        target,
        ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      recordHostKeyProbe(options.knownHostsFile, target, outcome)
      return outcome
    },
    projection(target) {
      const outcome = probeRegistry.get(options.knownHostsFile)?.get(probeKeyFor(target)) ?? null
      return outcome === null ? null : toHostKeyProjection(outcome)
    },
    async trust(target, candidate) {
      if (!isPresentedHostKey(candidate)) return { ok: false, error: 'invalid host key payload' }
      const now = options.now ?? Date.now
      const record = lastHostKeyProbe(options.knownHostsFile, target, now())
      if (record === null) {
        return { ok: false, error: 'no recent host-key probe — probe again before trusting' }
      }
      if (record.state === 'unavailable' || record.type === null || record.blob === null) {
        return { ok: false, error: 'the last host-key probe did not observe a key' }
      }
      if (record.type !== candidate.type || record.blob !== candidate.blob) {
        return { ok: false, error: 'the offered host key does not match the most recent probe' }
      }
      const replace = record.state === 'changed'
      try {
        ensureKnownHostsFile(storeOptions)
        if (hasRevokedKey(readKnownHostsText(storeOptions), target, candidate)) {
          return { ok: false, error: 'the offered host key is @revoked; refusing to override revocation' }
        }
        const written = await writeTrustedHostKey(storeOptions, target, candidate, replace)
        recordHostKeyProbe(options.knownHostsFile, target, {
          ...record,
          state: 'known',
          changed: false,
          previousFingerprints: [],
        })
        return {
          ok: true,
          replaced: written.replaced,
          projection: {
            state: 'known',
            fingerprints: record.fingerprints.length > 0 ? [...record.fingerprints] : [],
          },
        }
      } catch (error) {
        return { ok: false, error: 'cannot write ' + options.knownHostsFile + ': ' + String(error) }
      }
    },
  }
}
