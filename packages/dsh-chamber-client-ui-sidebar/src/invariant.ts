/** Package-owned invariant companion for `@dsh-chamber/dsh-chamber-client-ui-sidebar`.
 *  @module @dsh-chamber/dsh-chamber-client-ui-sidebar/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-chamber/dsh-chamber-client-ui-sidebar'

export const name = 'client-ui-sidebar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: a pure-consumer plugin deriving its rows in-component from
 *  the standard useSessions delivery — no cordis events, no cross-plugin mutable state. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
