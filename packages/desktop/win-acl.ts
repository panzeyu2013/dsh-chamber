/**
 * Windows ACL privacy tightening (design 21 M2a; replaces the "inherit the
 * profile ACL and hope" posture on win32 — the standard Windows practice for
 * "private to the current user" is an explicit ACL, not a POSIX mode bit).
 *
 * POSIX hosts get 0700/0600 through chmod (private-file.ts); Windows cannot
 * express that with mode bits, so owner-private state directories and secret
 * files are tightened with the system `icacls.exe`:
 *
 *   icacls <target> /inheritance:r /grant:r "<user>:(OI)(CI)F"   (directory)
 *   icacls <target> /inheritance:r /grant:r "<user>:F"           (file)
 *
 * followed by a verification pass over `icacls <target>` output (ONLY the
 * current user holds full control; inherited, deny and foreign-principal ACEs
 * all fail — the check is a user allowlist, see verifyIcaclsOutput). Every
 * failure is loud: a target that cannot be proven private is reported as
 * {ok:false}, never silently trusted.
 *
 * Pure argument builders + output verifiers are unit-tested on every CI leg;
 * the exec helper is win32-gated and throws off-platform. No behavior change
 * on POSIX hosts.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'

const ICACLS_TIMEOUT_MS = 10_000

export type WindowsAclTightenResult = { ok: true } | { ok: false; error: string }

/** One startup tightening target. Directory grants propagate (OI)(CI) to
 *  children created later, so tightening the state root once covers future
 *  secret leaves; file targets only matter for pre-existing loose files. */
export interface WindowsAclTarget {
  path: string
  kind: 'directory' | 'file'
}

/**
 * Startup composite (design 21 M2a wiring): tighten every existing target and
 * collect failures loudly. Never throws and never blocks startup — a target
 * that cannot be proven private is REPORTED, because the caller (main) must
 * decide whether a failure is fatal for secrets. Pure orchestration with
 * injectable exec/exists seams; off-win32 callers that pass a real executor
 * get the executor's own platform refusal.
 */
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

/** os.userInfo().username (the process-token name), or null when the lookup
 *  itself fails. Unlike USERNAME it cannot be steered by a parent process. */
function osProcessUserName(): string | null {
  try {
    const name = userInfo().username
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}

/** The current user name (icacls grant/verify principal). The process token
 *  (os.userInfo) is the primary identity source because USERNAME can be absent
 *  or spoofed by the launching environment; the environment is only the
 *  fallback for hosts where the OS lookup is unavailable. An absent/blank name
 *  on BOTH sources is a fail-closed condition (never guess a principal). */
export function currentWindowsUserName(
  env: NodeJS.ProcessEnv = process.env,
  osUserName: string | null = osProcessUserName(),
): string | null {
  const fromOs = typeof osUserName === 'string' ? osUserName.trim() : ''
  if (fromOs !== '') return fromOs
  const name = env.USERNAME
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
}

/**
 * icacls argv that removes inherited ACEs and grants the current user full
 * control: directories get (OI)(CI)F (propagating to children), files get F.
 */
export function buildIcaclsTightenArgs(
  target: string,
  kind: 'directory' | 'file',
  userName: string,
): string[] {
  const principal = `${userName}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`
  return [target, '/inheritance:r', '/grant:r', principal]
}

/**
 * Split an icacls flag tail into its token set. icacls renders rights as
 * parenthesized groups (`(OI)(CI)(F)`, `(I)`, `(RX)`) while the `/grant`
 * syntax the tightening pass applies spells the same mask as `(OI)(CI)F` /
 * `F`; both shapes must yield the same tokens. Bare letter runs outside
 * parentheses are tokens too, and an advanced-rights list (`(GR,GE)`)
 * splits on its commas.
 */
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
 * Verify `icacls <target>` output proves privacy by ALLOWLIST: the current
 * user holds full control and EVERY remaining ACE's principal is that same
 * user (exact name or DOMAIN\user). Inherited (I) and DENY ACEs fail outright;
 * any other principal fails and is named in the reason. The old
 * Everyone/Users/SYSTEM name blacklist is subsumed by this rule — an unlisted
 * well-known group (Authenticated Users / INTERACTIVE / CREATOR OWNER) can no
 * longer pass, whatever language icacls rendered it in. Each ACE line is
 * `<path> <principal>:<flags>`. The path may itself contain spaces and
 * drive-letter colons, so the ACE tail is anchored on the LAST colon:
 * everything after it is the flag text, and the whitespace-delimited token
 * immediately before it is the principal. (An object-kind marker like
 * `DIRECTORY:`/`FILE:`, or a path-only line, is not an ACE and is skipped; it
 * can never satisfy the user-grant check either.)
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
    // A DENY ACE is not a grant, whichever principal it names.
    if (tokens.has('deny')) {
      return { ok: false, reason: `deny ACE remains after tightening: ${aceText}` }
    }
    // The object's own header line (`<path> DIRECTORY:(OI)(CI)(F)` /
    // `<path> FILE:(F)`) carries the object-kind marker where a principal
    // would be; it is not an ACE, so skip it (a marker alone still never
    // satisfies the user-grant check below).
    if (acePrincipal === 'directory' || acePrincipal === 'file') continue
    // USER ALLOWLIST (2026-12 audit P1, fail-open fix): equality, or the same
    // user under a domain prefix (DESKTOP-XX\\alice), is the ONLY accepted
    // principal. Anything else — Everyone, BUILTIN\\Users, NT AUTHORITY\\SYSTEM,
    // Authenticated Users, INTERACTIVE, CREATOR OWNER, an unrelated user —
    // fails the verification and is named. A bare substring match is never
    // used: a principal named "bobalice" must not satisfy a check for "alice".
    // Localization caveat (documented boundary, design 21 M0.5 实证项): icacls
    // renders principals and deny/inheritance flags in the OS language (zh-CN
    // shows "所有人:" / "BUILTIN\\用户:" instead of Everyone/BUILTIN\\Users).
    // The allowlist makes that fail CLOSED — a localized foreign principal is
    // not the current user and is rejected, and a non-ASCII account name that
    // icacls returns as mojibake fails verification loudly instead of being
    // silently trusted. The residual boundary is that a localized rendering
    // which happens to equal the current user's name cannot be distinguished
    // without a SID query (Get-Acl); real-machine verification must confirm
    // the rendering — never claim more than checked.
    const principalMatch = acePrincipal === principal
      || acePrincipal.endsWith(`\\${principal}`)
    if (!principalMatch) {
      return { ok: false, reason: `foreign principal ACE remains (${acePrincipalRaw}): ${aceText}` }
    }
    // Full control, spelled as a token set so both icacls renderings work:
    // directories need (OI) and (CI) plus F, files need F and must not carry
    // the directory-only inheritance groups (a wrong-kind grant never
    // satisfies the expectation in either direction).
    const fullControl = kind === 'directory'
      ? tokens.has('oi') && tokens.has('ci') && tokens.has('f')
      : tokens.has('f') && !tokens.has('oi') && !tokens.has('ci')
    // The principal already passed the allowlist above, so a full-control
    // mask here is a full-control grant for the current user.
    if (fullControl) sawUserGrant = true
  }
  if (!sawUserGrant) return { ok: false, reason: `no full-control grant for ${userName}` }
  return { ok: true }
}

/**
 * Tighten one target with icacls and verify the result (second icacls pass).
 * win32-only; throws off-platform. Loud failure — the caller decides whether
 * a failed tightening is fatal (secret files) or logged (best-effort dirs).
 */
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
  // Verify-first (round-2 audit): startup runs this per target every launch —
  // an already-private target is the common case, and rewriting its ACL each
  // boot is needless churn (and up to two icacls spawns per target). Only when
  // the current ACL does NOT already satisfy the private shape do we apply
  // /inheritance:r + /grant:r and re-verify. Exec failure on the probe falls
  // through to the apply path so its own loud error surfaces unchanged.
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
