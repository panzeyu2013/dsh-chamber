/**
 * Minimal `@deepseek-ai/dsh-subprocess` stand-in for this package's node unit
 * tests (see ../vendor-loader.mjs): the source-only vendor tree cannot be
 * imported from a plain `node test/…` run.
 *
 * Only `scrubbedParentEnv` is reachable from the forked resolver, and only from
 * `launchDetachedApp` — the detached-launch adapter this package's tests replace
 * with an injected `launch` seam. The scrub below mirrors upstream's contract
 * (children never inherit credential-looking variables) so that a future test
 * which DOES reach it observes honest behaviour rather than an empty object.
 */

/** Upstream's sensitive-name families (`packages/subprocess/subprocess/src/index.ts`). */
const SENSITIVE = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PASSWD)/iu

/**
 * The parent environment minus credential-looking entries.
 * @returns a fresh environment object safe to hand to a detached child.
 */
export function scrubbedParentEnv() {
  const out = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE.test(name)) continue
    out[name] = value
  }
  return out
}

/** Upstream's environment-name prefix for child-facing dsh variables. */
export const DSH_ENV_PREFIX = 'DSH_'
