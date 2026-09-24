/**
 * Per-source open-in view-model: the single pure decision surface over the TWO
 * app pools the unified entry draws from — `local` (the INSTANCE-hosted catalog
 * served by the chamber host domain `openInApp/*`) and `main` (the desktop
 * main-process projection over trusted IPC: the VS Code override for every
 * source, the remote deeplink carrier for SSH targets).
 *
 * Fail-closed; every rejected candidate is REPORTED with an explicit reason
 * (never silently dropped), so the button renders exactly the reachable set:
 *
 * | source                          | local pool              | main pool           |
 * | `local` (transport local)       | all available apps      | all available apps  |
 * | `dsh-*`/`gateway-*` + ssh       | none (source-not-local) | remote-capable only |
 * | http / malformed / inconsistent | none                    | none                |
 *
 * Channel priority on a shared id: an AVAILABLE main-provider entry is the
 * OVERRIDE — the local entry is suppressed (`duplicate-app-id`) and the app
 * launches through trusted IPC (chamber policy, exact-boot proof and deeplink
 * intent push stay in force). When the main provider reports the id UNAVAILABLE,
 * the local entry survives and launches through the instance's own host domain:
 * the union of both detectors is shown, never a hidden installed app.
 */
import type { OpenInApp, OpenInSource } from './capabilities.ts'

/** Which carrier an entry launches through. */
export type OpenInChannel = 'local' | 'main'

/** Why a candidate app is not part of the rendered set. */
export type OpenInSuppressionReason =
  /** The source id/transport pair is malformed or inconsistent. */
  | 'unknown-source'
  /** A non-local source whose transport cannot carry remote launches. */
  | 'transport-not-ssh'
  /** A non-local source cannot launch the machine’s own apps. */
  | 'source-not-local'
  /** The app is not installed/available right now. */
  | 'app-unavailable'
  /** A remote source can only use apps with a remote carrier. */
  | 'app-not-remote-capable'
  /** The id is owned by another channel: an available main-provider override
   *  wins, the rest lose. */
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
  /** Instance-hosted catalog projection; null = unknown/unread (fail-closed). */
  readonly localEntries: readonly OpenInApp[] | null
  /** Desktop main-process projection; null = unknown/unread (fail-closed). */
  readonly mainEntries: readonly OpenInApp[] | null
}

type SourceClass = 'local' | 'remote-ssh' | 'unsupported'

const SOURCE_PREFIXES = ['dsh-', 'gateway-', 'ssh-'] as const
// Mirrors shared/capabilities.ts INSTANCE_ID and the desktop/renderer transport
// authorities (same grammar).
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
 * both pool projections (or null) and gets the rendered set plus the explicit
 * suppression record.
 */
export function buildOpenInViewModel(input: OpenInViewModelInput): OpenInViewModel {
  const sourceClass = classifySource(input.source)
  const entries: OpenInViewEntry[] = []
  const suppressed: OpenInSuppressedApp[] = []
  const accepted = new Set<string>()
  const mainEntries = input.mainEntries ?? []
  // An AVAILABLE main-provider entry owns its id (the IPC override); an unavailable one does not.
  const mainOverrideIds = new Set(mainEntries.filter(app => app.available).map(app => app.id))
  const consider = (app: OpenInApp, channel: OpenInChannel): void => {
    if (sourceClass === 'unsupported') {
      suppressed.push({ id: app.id, channel, reason: unsupportedReason(input.source) })
      return
    }
    if (channel === 'local' && sourceClass === 'remote-ssh') {
      suppressed.push({ id: app.id, channel, reason: 'source-not-local' })
      return
    }
    if (channel === 'local' && mainOverrideIds.has(app.id)) {
      suppressed.push({ id: app.id, channel, reason: 'duplicate-app-id' })
      return
    }
    if (sourceClass === 'remote-ssh' && !app.remoteCapable) {
      suppressed.push({ id: app.id, channel, reason: 'app-not-remote-capable' })
      return
    }
    // Availability outranks the duplicate check: an unavailable main entry
    // duplicating a rendered local entry is reported as unavailable, not duplicate.
    if (!app.available) {
      suppressed.push({ id: app.id, channel, reason: 'app-unavailable' })
      return
    }
    if (accepted.has(app.id)) {
      suppressed.push({ id: app.id, channel, reason: 'duplicate-app-id' })
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
  for (const app of input.localEntries ?? []) consider(app, 'local')
  for (const app of mainEntries) consider(app, 'main')
  const defaultEntryId = (entries.find(entry => entry.displayKind === 'vscode') ?? entries[0])?.id
  return { entries, suppressed, defaultEntryId, visible: entries.length > 0 }
}
