/**
 * Per-source open-in view-model (design 20 §2 呈现矩阵; Batch 3 Phase 0,
 * 2026-09): the single pure decision surface over the TWO app pools the
 * unified open-in entry draws from —
 *
 *  - `official` — the instance's own host catalog (`@deepseek-ai/
 *    dsh-client-ui-open-in-app` / host `open-in-app`): the full local
 *    application picker (Finder/Explorer/VS Code/…) served over the
 *    per-instance proxy;
 *  - `main` — the desktop main-process provider projection (trusted IPC):
 *    the VS Code override used for every source, and the remote deeplink
 *    carrier for SSH targets.
 *
 * The matrix is fail-closed and every rejected candidate is REPORTED with an
 * explicit reason (never silently dropped), so the button can render exactly
 * the reachable set and diagnostics/tests can pin why an app is absent:
 *
 * | source                          | official pool        | main pool            |
 * |---------------------------------|----------------------|----------------------|
 * | `local` (transport local)       | all available apps   | all available apps   |
 * | `dsh-*`/`gateway-*` + ssh       | none (source-not-local) | remote-capable only |
 * | http / malformed / inconsistent | none                 | none                 |
 *
 * Dedup is channel-priority: the official entry wins a shared id, the main
 * duplicate is suppressed (`duplicate-app-id`) — the official catalog is the
 * host's own truth, the main provider is the override.
 */
import type { OpenInApp, OpenInSource } from './capabilities.ts'

/** Which carrier an entry launches through. */
export type OpenInChannel = 'official' | 'main'

/** Why a candidate app is not part of the rendered set. */
export type OpenInSuppressionReason =
  /** The source id/transport pair is malformed or inconsistent. */
  | 'unknown-source'
  /** A non-local source whose transport cannot carry remote launches. */
  | 'transport-not-ssh'
  /** The official (host catalog) channel exists for LOCAL sources only. */
  | 'source-not-local'
  /** The app is not installed/available right now. */
  | 'app-unavailable'
  /** A remote source can only use apps with a remote carrier. */
  | 'app-not-remote-capable'
  /** A lower-priority channel re-declared an id the higher channel already won. */
  | 'duplicate-app-id'

export interface OpenInViewEntry {
  readonly id: string
  readonly channel: OpenInChannel
  readonly displayKind: string
  readonly remoteCapable: boolean
  /** Position in the flattened, channel-ordered entry list. */
  readonly order: number
}

export interface OpenInSuppressedApp {
  readonly id: string
  readonly channel: OpenInChannel
  readonly reason: OpenInSuppressionReason
}

export interface OpenInViewModel {
  readonly entries: readonly OpenInViewEntry[]
  readonly suppressed: readonly OpenInSuppressedApp[]
  /** Main-button default selection: the first VS Code entry, else the first entry. */
  readonly defaultEntryId: string | undefined
  /** True when the entry should render at all (≥1 usable app). */
  readonly visible: boolean
}

export interface OpenInViewModelInput {
  readonly source: OpenInSource
  /** Host catalog projection; null = unknown/unread (fail-closed). */
  readonly official: readonly OpenInApp[] | null
  /** Desktop main-process projection; null = unknown/unread (fail-closed). */
  readonly main: readonly OpenInApp[] | null
}

type SourceClass = 'local' | 'remote-ssh' | 'unsupported'

const SOURCE_PREFIXES = ['dsh-', 'gateway-', 'ssh-'] as const
// Mirrors shared/capabilities.ts INSTANCE_ID (same grammar as the desktop
// transport-provider and renderer transport-source authorities).
const RAW_INSTANCE_ID = /^(?!local$)[A-Za-z0-9_-]{1,64}$/

/** Classify the source against the presentation matrix, fail-closed. */
function classifySource(source: OpenInSource): SourceClass {
  if (source.local) {
    return source.sourceId === 'local' && source.transport === 'local' ? 'local' : 'unsupported'
  }
  if (source.transport !== 'ssh') return 'unsupported'
  const prefix = SOURCE_PREFIXES.find(candidate => source.sourceId.startsWith(candidate))
  if (prefix === undefined) return 'unsupported'
  const raw = source.sourceId.slice(prefix.length)
  return RAW_INSTANCE_ID.test(raw) && raw === source.instanceId ? 'remote-ssh' : 'unsupported'
}

function unsupportedReason(source: OpenInSource): OpenInSuppressionReason {
  if (source.local) return 'unknown-source'
  return source.transport === 'ssh' ? 'unknown-source' : 'transport-not-ssh'
}

/**
 * Build the per-source view-model. Pure over plain data: the caller supplies
 * both pool projections (or null when unknown) and gets the rendered set plus
 * the explicit suppression record.
 */
export function buildOpenInViewModel(input: OpenInViewModelInput): OpenInViewModel {
  const sourceClass = classifySource(input.source)
  const entries: OpenInViewEntry[] = []
  const suppressed: OpenInSuppressedApp[] = []
  const accepted = new Set<string>()
  const consider = (app: OpenInApp, channel: OpenInChannel): void => {
    if (sourceClass === 'unsupported') {
      suppressed.push({ id: app.id, channel, reason: unsupportedReason(input.source) })
      return
    }
    if (channel === 'official' && sourceClass === 'remote-ssh') {
      suppressed.push({ id: app.id, channel, reason: 'source-not-local' })
      return
    }
    if (accepted.has(app.id)) {
      suppressed.push({ id: app.id, channel, reason: 'duplicate-app-id' })
      return
    }
    if (!app.available) {
      suppressed.push({ id: app.id, channel, reason: 'app-unavailable' })
      return
    }
    if (sourceClass === 'remote-ssh' && !app.remoteCapable) {
      suppressed.push({ id: app.id, channel, reason: 'app-not-remote-capable' })
      return
    }
    accepted.add(app.id)
    entries.push({
      id: app.id,
      channel,
      displayKind: app.displayKind,
      remoteCapable: app.remoteCapable,
      order: entries.length,
    })
  }
  for (const app of input.official ?? []) consider(app, 'official')
  for (const app of input.main ?? []) consider(app, 'main')
  const defaultEntryId = (entries.find(entry => entry.displayKind === 'vscode') ?? entries[0])?.id
  return { entries, suppressed, defaultEntryId, visible: entries.length > 0 }
}
