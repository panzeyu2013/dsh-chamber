/**
 * Keyed title seat for the chamber Browser tab (`sidebar.right.pane.tab.title`).
 *
 * The chip copy comes from this plugin's locale namespace, so a language switch
 * updates the tab title without reopening it. The body/title registrations share
 * the same key (the tab-type id) as required by ui-sidebar-right's keyed slot
 * dispatch.
 */
import type { BrowserTranslate } from '../locales.ts'

export interface BrowserTitleInjected {
  t: BrowserTranslate
}

export interface BrowserTitleProps extends BrowserTitleInjected {}

export function BrowserTitle({ t }: BrowserTitleProps) {
  return <span data-chamber-browser-title="">{t('title')}</span>
}
