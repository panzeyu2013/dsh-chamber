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
 * followed by a verification pass over `icacls <target>` output (the current
 * user holds full control, no inherited or Everyone-granted entries remain).
 * Every failure is loud: a target that cannot be proven private is reported
 * as {ok:false}, never silently trusted.
 *
 * Pure argument builders + output verifiers are unit-tested on every CI leg;
 * the exec helper is win32-gated and throws off-platform. No behavior change
 * on POSIX hosts.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

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

/** The current interactive user name (icacls grant principal). On Windows
 *  USERNAME is always set for an interactive session; its absence is a
 *  fail-closed condition (never guess a principal). */
export function currentWindowsUserName(env: NodeJS.ProcessEnv = process.env): string | null {
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
 * Verify `icacls <target>` output proves privacy: the current user holds full
 * control and no entry grants Everyone/Users/SYSTEM-family or inherited (I)
 * ACEs remain. Each ACE line is `<path> <Principal>:<flags>` (the path may
 * itself contain a drive-letter colon, so the line is split on whitespace
 * first and the principal/flags are parsed from the tail).
 */
export function verifyIcaclsOutput(
  text: string,
  userName: string,
  kind: 'directory' | 'file',
): { ok: true } | { ok: false; reason: string } {
  const principal = userName.toLowerCase()
  const userGrant = kind === 'directory' ? '(oi)(ci)f' : 'f'
  let sawUserGrant = false
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const aceText = parts.slice(1).join(' ')
    const colon = aceText.lastIndexOf(':')
    if (colon === -1) continue
    const acePrincipal = aceText.slice(0, colon).trim().toLowerCase()
    const flags = aceText.slice(colon + 1).trim().toLowerCase()
    if (flags === '') continue
    if (flags.includes('(i)')) {
      return { ok: false, reason: `inherited ACE remains after tightening: ${aceText.trim()}` }
    }
    // Localization approximation (documented boundary, design 21 M0.5 实证项):
    // icacls renders well-known principals in the OS language (zh-CN shows
    // "所有人:" / "BUILTIN\\用户:" instead of Everyone/BUILTIN\\Users), so an
    // English-only name check cannot prove the absence of a foreign Everyone
    // ACE. Real-machine verification must confirm the localized rendering or
    // switch this check to SID-based ACL queries (Get-Acl). Fail-closed intent
    // is preserved for the English rendering; never claim more than checked.
    if (/(everyone|^builtin\\users|^nt authority\\system)/.test(acePrincipal)) {
      return { ok: false, reason: `non-user ACE remains: ${aceText.trim()}` }
    }
    // Exact principal identity: equality, or the same user under a domain
    // prefix (DESKTOP-XX\\alice). A bare substring match is never used — a
    // principal named "bobalice" must not satisfy a check for "alice".
    const principalMatch = acePrincipal === principal
      || acePrincipal.endsWith(`\\${principal}`)
    // icacls renders grants canonically: files as `F`, directories as
    // `(OI)(CI)F`. Anything else (a file-style grant on a directory or
    // inheritance-flag variants) does not satisfy the expected shape.
    if (principalMatch && flags === userGrant) sawUserGrant = true
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
    return { ok: false, error: 'cannot tighten ACL: USERNAME environment is missing' }
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
