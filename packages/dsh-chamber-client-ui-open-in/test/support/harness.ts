/**
 * Shared open-in harness for this package's plain-node suites: the capability
 * rows the page renders, the label-builder translate stub, the settle tick the
 * service doubles yield on, and the comment-stripped source reader used by the
 * source-text locks (comments quote the pinned selectors, so a lock must read
 * CODE — the shared stripComments precedent).
 */
import type { OpenInApp } from '../../src/shared/capabilities.ts'
import type { Translate } from '../../src/shared/coordinator.ts'

export const FINDER: OpenInApp = { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true }
export const VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true }
export const TERMINAL: OpenInApp = { id: 'terminal', displayKind: 'terminal', remoteCapable: false, available: true }
export const GHOST: OpenInApp = { id: 'ghost', displayKind: 'ghost', remoteCapable: true, available: false }

/** The canonical [FINDER, VSCODE] projection the parsers accept. */
export const VALID_APPS: OpenInApp[] = [FINDER, VSCODE]

/** Label-builder stub: the key plus its params, never a rendered string. */
export const t: Translate = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

/** One macrotask tick: the service doubles settle their boot probe on it. */
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}
