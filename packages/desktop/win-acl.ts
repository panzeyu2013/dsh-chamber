/**
 * Windows ACL privacy tightening: win32 privacy cannot use a POSIX mode bit,
 * so owner-private state directories and secret files are tightened with
 * `icacls <target> /inheritance:r /grant:r "<user>:(OI)(CI)F|F"` and then
 * verified by a second `icacls <target>` pass: ONLY the current user may hold
 * full control — inherited, deny and foreign-principal ACEs all fail the
 * allowlist, so a target that cannot be proven private is reported {ok:false},
 * never silently trusted.
 *
 * Argument builders and output verifiers are pure; the exec helper is
 * win32-gated and throws off-platform. No POSIX behavior change.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'

const ICACLS_TIMEOUT_MS = 10_000

export type WindowsAclTightenResult = { ok: true } | { ok: false; error: string }

/** One startup tightening target: directory grants propagate (OI)(CI) to
 *  children created later; file targets cover pre-existing loose files. */
export interface WindowsAclTarget {
  path: string
  kind: 'directory' | 'file'
}

/** Tighten every existing target and collect failures loudly. Never throws and
 *  never blocks startup — the caller (main) decides whether a failure is fatal
 *  for secrets. Injectable exec/exists seams; off-win32 callers passing a real
 *  executor get the executor's own platform refusal. */
export function applyWindowsAclTightening(
  targets: WindowsAclTarget[],
  deps: { tighten?: typeof tightenWindowsAcl; exists?: (path: string) => boolean } = {},
): string[] {
  const tighten = deps.tighten ?? tightenWindowsAcl
  const exists = deps.exists ?? existsSync
  const errors: string[] = []
  for (const target of targets) {
    if (!exists(target.path)) continue
    const result = tighten(target.path, target.kind)
    if (!result.ok) errors.push(`${target.path} (${target.kind}): ${result.error}`)
  }
  return errors
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('windows ACL tightening is only available on win32')
  }
}

/** os.userInfo().username, or null when the lookup fails; unlike USERNAME it
 *  cannot be steered by a parent process. */
function osProcessUserName(): string | null {
  try {
    const name = userInfo().username
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}

/** The icacls grant/verify principal. The process token (os.userInfo) wins
 *  because USERNAME can be absent or spoofed by the launching environment; the
 *  environment is only the fallback when the OS lookup is unavailable. An
 *  absent/blank name on BOTH sources is fail-closed (never guess a principal). */
export function currentWindowsUserName(
  env: NodeJS.ProcessEnv = process.env,
  osUserName: string | null = osProcessUserName(),
): string | null {
  const fromOs = typeof osUserName === 'string' ? osUserName.trim() : ''
  if (fromOs !== '') return fromOs
  const name = env.USERNAME
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
}

/** icacls argv removing inherited ACEs: directories get (OI)(CI)F (propagating
 *  to children), files get F. */
export function buildIcaclsTightenArgs(
  target: string,
  kind: 'directory' | 'file',
  userName: string,
): string[] {
  const principal = `${userName}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`
  return [target, '/inheritance:r', '/grant:r', principal]
}

/** Split an icacls flag tail into its token set: parenthesized groups
 *  (`(OI)(CI)(F)`, `(I)`), bare letter runs and advanced-rights lists
 *  (`(GR,GE)`, split on commas) normalize to lowercase tokens, so both icacls
 *  renderings of one mask yield the same set. */
function icaclsFlagTokens(flagsText: string): Set<string> {
  const tokens = new Set<string>()
  for (const group of flagsText.matchAll(/\(([^)]*)\)/g)) {
    for (const token of group[1]!.split(',')) {
      const normalized = token.trim().toLowerCase()
      if (normalized !== '') tokens.add(normalized)
    }
  }
  for (const bare of flagsText.replace(/\([^)]*\)/g, ' ').split(/[\s,]+/)) {
    const normalized = bare.trim().toLowerCase()
    if (normalized !== '') tokens.add(normalized)
  }
  return tokens
}

/**
 * Verify `icacls <target>` output proves privacy by ALLOWLIST: the current user
 * must hold full control and EVERY remaining ACE's principal must be that same
 * user (exact name or DOMAIN\user). Inherited (I) and DENY ACEs fail outright;
 * any other principal fails and is named. This subsumes any name blacklist — an
 * unlisted well-known group (Authenticated Users / INTERACTIVE / CREATOR OWNER)
 * cannot pass, whatever language icacls rendered it in.
 *
 * Each ACE line is `<path> <principal>:<flags>`, and paths may contain spaces
 * and drive-letter colons, so the tail is anchored on the LAST colon; an
 * object-kind marker (`DIRECTORY:`/`FILE:`) or a path-only line is skipped and
 * can never satisfy the user-grant check.
 */
export function verifyIcaclsOutput(
  text: string,
  userName: string,
  kind: 'directory' | 'file',
): { ok: true } | { ok: false; reason: string } {
  const principal = userName.toLowerCase()
  let sawUserGrant = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const colon = trimmed.lastIndexOf(':')
    if (colon === -1) continue
    const principalTail = /(\S+)$/.exec(trimmed.slice(0, colon))
    if (principalTail === null) continue
    const acePrincipalRaw = principalTail[1]!
    const acePrincipal = acePrincipalRaw.toLowerCase()
    const flagsText = trimmed.slice(colon + 1).trim()
    if (flagsText === '') continue
    // Reason/diagnostic text stays path-free: the ACE from its principal on.
    const aceText = trimmed.slice(colon - acePrincipalRaw.length)
    const tokens = icaclsFlagTokens(flagsText)
    if (tokens.has('i')) {
      return { ok: false, reason: `inherited ACE remains after tightening: ${aceText}` }
    }
    if (tokens.has('deny')) {
      return { ok: false, reason: `deny ACE remains after tightening: ${aceText}` }
    }
    if (acePrincipal === 'directory' || acePrincipal === 'file') continue
    // ALLOWLIST: equality, or the same user under a domain prefix
    // (DESKTOP-XX\\alice), is the ONLY accepted principal; a bare substring match
    // is never used ("bobalice" must not satisfy "alice"). icacls localizes
    // principals and flags, which fails CLOSED — a localized foreign principal
    // is not the current user and is rejected, and a non-ASCII name returned as
    // mojibake fails loudly. Boundary: a localized rendering equal to the
    // current user's own name needs a SID query (Get-Acl) to distinguish.
    const principalMatch = acePrincipal === principal
      || acePrincipal.endsWith(`\\${principal}`)
    if (!principalMatch) {
      return { ok: false, reason: `foreign principal ACE remains (${acePrincipalRaw}): ${aceText}` }
    }
    // Full control as a token set so both renderings work: directories need
    // (OI)+(CI)+F; files need F and must NOT carry the directory-only groups.
    const fullControl = kind === 'directory'
      ? tokens.has('oi') && tokens.has('ci') && tokens.has('f')
      : tokens.has('f') && !tokens.has('oi') && !tokens.has('ci')
    // Only the current user's ACEs reach here, so this mask is a user grant.
    if (fullControl) sawUserGrant = true
  }
  if (!sawUserGrant) return { ok: false, reason: `no full-control grant for ${userName}` }
  return { ok: true }
}

/** Tighten one target with icacls and verify the result (second icacls pass).
 *  win32-only; throws off-platform. Loud failure — the caller decides whether a
 *  failed tightening is fatal (secret files) or logged (best-effort dirs). */
export function tightenWindowsAcl(
  target: string,
  kind: 'directory' | 'file',
  deps: { userName?: string | null; env?: NodeJS.ProcessEnv } = {},
): WindowsAclTightenResult {
  assertWindows()
  const userName = deps.userName !== undefined ? deps.userName : currentWindowsUserName(deps.env)
  if (userName === null) {
    return { ok: false, error: 'cannot tighten ACL: current user name unavailable (os.userInfo and USERNAME are both empty)' }
  }
  // Verify-first: this runs per target every launch, so an already-private
  // target skips the rewrite churn (and up to two icacls spawns); a probe exec
  // failure falls through to the apply path so its loud error surfaces.
  const probe = spawnSync('icacls.exe', [target], {
    encoding: 'utf8',
    timeout: ICACLS_TIMEOUT_MS,
    windowsHide: true,
  })
  if (probe.error === undefined && probe.status === 0) {
    const already = verifyIcaclsOutput(probe.stdout ?? '', userName, kind)
    if (already.ok) return { ok: true }
  }
  const apply = spawnSync('icacls.exe', buildIcaclsTightenArgs(target, kind, userName), {
    encoding: 'utf8',
    timeout: ICACLS_TIMEOUT_MS,
    windowsHide: true,
  })
  if (apply.error !== undefined) return { ok: false, error: `icacls apply failed: ${apply.error.message}` }
  if (apply.status !== 0) {
    return { ok: false, error: `icacls apply exited ${String(apply.status)}: ${(apply.stderr || apply.stdout).trim().slice(0, 512)}` }
  }
  const verify = spawnSync('icacls.exe', [target], {
    encoding: 'utf8',
    timeout: ICACLS_TIMEOUT_MS,
    windowsHide: true,
  })
  if (verify.error !== undefined) return { ok: false, error: `icacls verify failed: ${verify.error.message}` }
  const verdict = verifyIcaclsOutput(verify.stdout ?? '', userName, kind)
  if (!verdict.ok) return { ok: false, error: `ACL verification failed for ${target}: ${verdict.reason}` }
  return { ok: true }
}
