/**
 * The upstream plugin manager page, contained for a settings TAB body: the
 * chamber registers THIS wrapper (not the page itself) as the
 * settings.plugins.tab occupant, so the page's main-panel layout assumptions are
 * neutralized once, under one scope (./EmbeddedPluginManagerPage.module.css).
 * Everything else -- controller, config ledger, navigation store, child slots --
 * stays the upstream implementation; the wrapper only forwards the slot props.
 */
import type { ComponentType } from 'react'
import { PluginManagerPage } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/PluginManagerPage.tsx'
import css from './EmbeddedPluginManagerPage.module.css'

/**
 * The page's own prop type names the main runtime, which a settings tab does not
 * carry; the slot renderer hands every entry its injected face + standard seats,
 * so the page is consumed through the same loose face index.ts registers with
 * (as never) and the props are forwarded verbatim.
 */
const Page = PluginManagerPage as unknown as ComponentType<Record<string, unknown>>

export function EmbeddedPluginManagerPage(props: Record<string, unknown>) {
  return (
    <div className={css.embedded}>
      <Page {...props} />
    </div>
  )
}
