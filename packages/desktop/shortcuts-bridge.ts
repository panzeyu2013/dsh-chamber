/**
 * Desktop keyboard bridge + shortcut-preference transaction for the rc.2
 * '@deepseek-ai/dsh-client-shortcuts' client plugin (design 25 section 4.4.1
 * keyboard seat).
 *
 * Why this module exists: the official shortcuts service is constructed for
 * EVERY official client family that injects 'shortcuts' (ui-conversation,
 * ui-workspace, ui-settings-general, ui-sidebar-*, ...). With the document root
 * marked 'data-platform' (see preload.cts markDocumentPlatform), the service
 * classifies the runtime as 'desktop' and (a) throws when
 * 'window.dshDesktop.keyboard' is absent -- taking the whole shell down -- and
 * (b) accepts native input only when its 'revision' equals the renderer's
 * accepted preference revision. That revision is minted by the storage owner
 * (upstream ShortcutPersistence) and reaches the renderer through
 * 'dshDesktop.shortcuts'. This module is therefore BOTH halves: the
 * transaction that mints/publishes revisions and the input gate that stamps
 * them onto normalized physical-key input.
 *
 * Upstream parity: the before-input-event decision table, the chord/dead-key
 * bookkeeping, the 'only matching input is delivered' rule and the persistence
 * transaction are the rc.2 apps/desktop/src/keyboard.ts + keybindings.ts
 * semantics, including the scopedDesktop gate: Linux keeps DOM dispatch for
 * main-document shortcuts and only forwards accepted embedded-frame bindings.
 * The upstream protocol implementation itself is loaded from the
 * active dsh runtime tree (the same tree whose client packages the page
 * loads), never re-implemented here: see loadDesktopShortcutProtocol.
 *
 * This module is deliberately electron-free (the top-level electron gate scans
 * every non-whitelisted file): the Electron before-input-event/webContents
 * glue lives in main.ts, which feeds plain DesktopKeyEvent values in and
 * applies DesktopKeyDecision values out.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Desktop-carrier IPC channels (the dshDesktop bridge of the official desktop
 * preload, apps/desktop/src/ipc.ts DESKTOP_IPC). They are NOT part of the
 * chamber A-bridge manifest (IPC_CHANNELS / bridge-manifest.json describe the
 * dshChamber <-> Swift sidecar contract); preload.cts duplicates the literals
 * because the sandboxed preload build is a self-contained CJS file
 * (build-preload.mjs), and test/ipc/desktop-carrier-surface.test.ts pins the
 * two sides together.
 */
export const DESKTOP_SHORTCUTS_CHANNELS = {
  GET: 'dsh-desktop:shortcuts-get',
  EDIT: 'dsh-desktop:shortcuts-edit',
  RECORDING: 'dsh-desktop:shortcuts-recording',
  CLOSE_WINDOW: 'dsh-desktop:shortcuts-close-window',
  INPUT: 'dsh-desktop:shortcuts-input',
  CHANGED: 'dsh-desktop:shortcuts-changed',
} as const

/** Input platform of the receiving device (upstream ShortcutPlatform). */
export type ShortcutPlatform = 'macos' | 'windows' | 'linux'

/** Normalized physical binding (upstream NormalizedBinding). */
export interface NormalizedBinding {
  readonly code: string
  readonly secondCode?: string
  readonly modifiers: readonly ('control' | 'alt' | 'shift' | 'meta')[]
}

/** One accepted effective row (the fields the input gate reads). */
export interface EffectiveShortcut {
  readonly id: string
  readonly binding: NormalizedBinding | null
  readonly issue: string | null
  readonly conflicts: readonly string[]
}

/** Serialized preference document (upstream ShortcutDocument). */
export interface ShortcutDocument {
  readonly schemaVersion: 1 | 2
  readonly profiles: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/** Serializable command definition accepted from the trusted product frame. */
export interface ShortcutDefinition {
  readonly id: string
  readonly defaults: Readonly<Record<string, unknown>>
  readonly fixed?: readonly unknown[]
}

/** Storage-owner snapshot (upstream ShortcutConfigSnapshot). */
export interface ShortcutConfigSnapshot {
  readonly revision: string
  readonly sequence: number
  readonly document: ShortcutDocument
  readonly status: 'loading' | 'ready' | 'unreadable'
  readonly error: 'read' | 'invalid' | 'future' | null
  readonly usingDefaults: boolean
}

/** Classified save outcome (upstream ShortcutSaveResult). */
export interface ShortcutSaveResult {
  readonly status: 'saved' | 'stale' | 'unreadable' | 'write-failed' | 'not-ready' | 'conflict'
  readonly snapshot: ShortcutConfigSnapshot
  readonly issue?: string
  readonly conflicts?: readonly string[]
}

/** File-origin storage seam handed to ShortcutPersistence. */
export interface ShortcutStorage {
  read(): string | null | Promise<string | null>
  write(raw: string): void | Promise<void>
}

/** Single-writer transaction instance (upstream ShortcutPersistence). */
export interface ShortcutPersistenceInstance {
  setDefinitions(definitions: readonly ShortcutDefinition[] | null): void
  dispose(): void
  readCurrent(): Promise<ShortcutConfigSnapshot>
  edit(edit: unknown, revision: string): Promise<ShortcutSaveResult>
}

/** The upstream protocol slice this module consumes. */
export interface DesktopShortcutProtocol {
  ShortcutPersistence: new (
    storage: ShortcutStorage,
    runtime: 'desktop',
    platform: ShortcutPlatform,
    rereadBeforeWrite: boolean,
    publish: (snapshot: ShortcutConfigSnapshot) => void,
  ) => ShortcutPersistenceInstance
  parseShortcutDefinitions(value: unknown): readonly ShortcutDefinition[]
  parseShortcutEdit(value: unknown): unknown
  effectiveShortcuts(
    definitions: readonly ShortcutDefinition[],
    document: ShortcutDocument,
    runtime: 'desktop',
    platform: ShortcutPlatform,
  ): readonly EffectiveShortcut[]
  bindingKey(binding: NormalizedBinding): string
}

/**
 * Every member DesktopShortcutsBridge consumes. A candidate module missing any of
 * them is rejected at load: parseShortcutEdit in particular backs edit(), so a
 * module without it would otherwise half-wire and throw only on the first edit.
 */
const PROTOCOL_MEMBERS: readonly (keyof DesktopShortcutProtocol)[] = [
  'ShortcutPersistence',
  'parseShortcutDefinitions',
  'parseShortcutEdit',
  'effectiveShortcuts',
  'bindingKey',
]

/**
 * Load the upstream shortcuts protocol from an installed dsh runtime tree.
 *
 * The runtime tree is the only authority for this protocol: the page loads its
 * client half from the SAME tree, so revisions, normalization and validation
 * cannot drift between the two processes. Candidates are tried in order
 * (active runtime first, then the bundled tree); every failed candidate is
 * loud. Returns null when no tree carries the package -- callers then leave the
 * keyboard bridge detached (the shell still mounts; preferences stay
 * unreadable), never a half-wired interception.
 *
 * @param workspaceDirs - dsh workspace roots (each carries node_modules/).
 * @returns the protocol module, or null when no candidate resolves.
 */
export async function loadDesktopShortcutProtocol(
  workspaceDirs: readonly string[],
): Promise<DesktopShortcutProtocol | null> {
  const seen = new Set<string>()
  for (const workspaceDir of workspaceDirs) {
    if (workspaceDir === '' || seen.has(workspaceDir)) continue
    seen.add(workspaceDir)
    try {
      const requireFromTree = createRequire(join(workspaceDir, 'package.json'))
      const resolved = requireFromTree.resolve('@deepseek-ai/dsh-client-shortcuts/protocol')
      const protocol = await import(pathToFileURL(resolved).href) as DesktopShortcutProtocol
      const missing = PROTOCOL_MEMBERS.filter(member => typeof protocol[member] !== 'function')
      if (missing.length > 0) {
        console.error('[dsh-chamber] dsh-client-shortcuts/protocol 形状不完整（缺 '
          + missing.join(', ') + '）：' + resolved)
        continue
      }
      return protocol
    } catch (error) {
      console.warn('[dsh-chamber] 无法从 ' + workspaceDir + ' 加载 dsh-client-shortcuts/protocol：'
        + (error instanceof Error ? error.message : String(error)))
    }
  }
  return null
}

/** Native input delivered to the trusted product document (upstream DesktopShortcutInput minus the webview arm). */
export type DesktopShortcutInput = { readonly revision: string } & (
  | { readonly kind: 'menu'; readonly commandId: string }
  | {
    readonly kind: 'keyboard' | 'iframe'
    readonly frameName: string
    readonly code: string
    readonly secondCode?: string
    readonly control: boolean
    readonly alt: boolean
    readonly shift: boolean
    readonly meta: boolean
    readonly repeat: boolean
  }
)

/** One Electron before-input-event fact, detached from the Electron type. */
export interface DesktopKeyEvent {
  readonly type: 'keyDown' | 'keyUp' | 'char'
  readonly key: string
  readonly code: string
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly isAutoRepeat: boolean
  readonly isComposing: boolean
  readonly modifiers: readonly string[]
  /** Focused frame: '' = main frame, a non-empty name = embedding element, null = none. */
  readonly frameName: string | null
  /** Owning window focused and enabled. */
  readonly windowActive: boolean
}

/** What main.ts must do with one native key event. */
export interface DesktopKeyDecision {
  readonly preventDefault: boolean
  /** Menu-accelerator suppression value for this event (upstream setIgnoreMenuShortcuts). */
  readonly ignoreMenuShortcuts: boolean
  /** Non-null = deliver this normalized input to the product document. */
  readonly input: DesktopShortcutInput | null
}

/**
 * Window-local keyboard gate + preference transaction. One instance serves the
 * single main window (chamber is single-window); window re-creation calls
 * resetInput()/clearCatalog() through the navigation and blur hooks in main.ts.
 */
export class DesktopShortcutsBridge {
  private readonly protocol: DesktopShortcutProtocol
  private readonly platform: ShortcutPlatform
  private readonly send: (channel: string, payload: unknown) => boolean
  private readonly persistence: ShortcutPersistenceInstance
  private definitions: readonly ShortcutDefinition[] = []
  private keys: ReadonlySet<string> = new Set()
  private revision: string | undefined
  private recordingActive = false
  private deadKey = false
  private inputFrame: string | null = null
  private inputRevision: string | undefined
  private readonly held = new Set<string>()
  private readonly consumed = new Map<string, 'press' | 'repeat'>()

  /**
   * @param deps - protocol module, platform, storage and the push edge.
   */
  constructor(deps: {
    protocol: DesktopShortcutProtocol
    platform: ShortcutPlatform
    storage: ShortcutStorage
    send: (channel: string, payload: unknown) => boolean
  }) {
    this.protocol = deps.protocol
    this.platform = deps.platform
    this.send = deps.send
    // rereadBeforeWrite=false: the Electron file adapter is the only writer
    // (upstream desktopKeybindings uses the same flag).
    this.persistence = new this.protocol.ShortcutPersistence(deps.storage, 'desktop', deps.platform, false,
      (snapshot) => { this.publish(snapshot) })
  }

  /**
   * Install or revoke the product command catalog, then read the file.
   * @param input - renderer-supplied serializable definitions.
   * @returns the accepted snapshot (the renderer's config revision source).
   */
  async get(input: unknown): Promise<ShortcutConfigSnapshot> {
    this.definitions = this.protocol.parseShortcutDefinitions(input)
    this.persistence.setDefinitions(this.definitions)
    return this.persistence.readCurrent()
  }

  /**
   * Persist one revision-checked preference edit.
   * @param input - renderer-supplied edit operation.
   * @param expectedRevision - state the user reviewed the edit against.
   * @returns classified save outcome and accepted snapshot.
   */
  async edit(input: unknown, expectedRevision: unknown): Promise<ShortcutSaveResult> {
    if (typeof expectedRevision !== 'string') throw new Error('desktop shortcuts: invalid revision')
    return this.persistence.edit(this.protocol.parseShortcutEdit(input), expectedRevision)
  }

  /**
   * Toggle native recording capture (menu accelerators stay suppressed while recording).
   * @param active - renderer-supplied boolean.
   * @returns the menu-suppression value main.ts must apply.
   */
  recording(active: unknown): boolean {
    if (typeof active !== 'boolean') throw new Error('desktop shortcuts: invalid recording state')
    this.recordingActive = active
    return active
  }

  /**
   * Decide whether the owning window may close for an accepted revision.
   * @param expected - revision the renderer acted on.
   * @param state - live window focus/enabled facts.
   * @returns true = main.ts must close the window.
   */
  closeWindow(expected: unknown, state: { focused: boolean; enabled: boolean }): boolean {
    if (typeof expected !== 'string') throw new Error('desktop shortcuts: invalid revision')
    return expected === this.revision && this.revision !== undefined && !this.recordingActive
      && state.focused && state.enabled
  }

  /**
   * Route one native key event through the upstream parity decision table.
   * @param event - native key fact.
   * @returns preventDefault / menu suppression / optional normalized input.
   */
  handleKeyEvent(event: DesktopKeyEvent): DesktopKeyDecision {
    const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(value => event[value])
    const singleKey = this.protocol.bindingKey({ code: event.code, modifiers })
    const match = this.keys.has(singleKey)
    const ignoreMenuShortcuts = this.recordingActive || match
    if (this.revision === undefined || !event.windowActive) {
      this.resetInput()
      return { preventDefault: false, ignoreMenuShortcuts, input: null }
    }
    if (event.frameName === null) {
      this.held.clear()
      this.consumed.clear()
      return { preventDefault: false, ignoreMenuShortcuts, input: null }
    }
    const composing = event.isComposing || event.key === 'Dead' || this.deadKey || event.modifiers.includes('altgr')
    if (event.type === 'keyDown') this.deadKey = event.key === 'Dead'
    if (this.recordingActive || composing) {
      this.held.clear()
      this.consumed.clear()
      return { preventDefault: false, ignoreMenuShortcuts, input: null }
    }
    // Upstream scopedDesktop (apps/desktop/src/keyboard.ts:45,158,184) gates the
    // chord/priority bookkeeping to windows||macos. Linux dispatches
    // main-document shortcuts through the DOM (client/shortcuts/src/client/
    // index.ts:71 passes native=false; desktop README:41) and only forwards
    // accepted embedded-frame bindings, so a Linux main-frame event must never
    // preventDefault or produce native input.
    if (this.platform === 'linux') {
      const main = event.frameName === ''
      if (!match || main) return { preventDefault: false, ignoreMenuShortcuts, input: null }
      return {
        preventDefault: true,
        ignoreMenuShortcuts,
        input: event.type === 'keyDown' ? {
          revision: this.revision,
          kind: 'iframe',
          frameName: event.frameName,
          code: event.code,
          repeat: event.isAutoRepeat,
          control: event.control,
          alt: event.alt,
          shift: event.shift,
          meta: event.meta,
        } : null,
      }
    }
    if (this.inputFrame !== event.frameName || this.inputRevision !== this.revision) {
      this.held.clear()
      this.inputFrame = event.frameName
      this.inputRevision = this.revision
    }
    const modifierKey = /^(Control|Alt|Shift|Meta)(?:Left|Right)$/u.test(event.code)
    if (event.type === 'keyUp') {
      // A chord's first key reached the renderer, so its release must reach the
      // same input handlers (upstream consumed-map rule).
      const preventDefault = this.consumed.get(event.code) === 'press'
      this.consumed.delete(event.code)
      this.held.delete(event.code)
      if (modifierKey) this.held.clear()
      return { preventDefault, ignoreMenuShortcuts, input: null }
    }
    if (event.type !== 'keyDown') return { preventDefault: false, ignoreMenuShortcuts, input: null }
    if (!event.isAutoRepeat) this.consumed.delete(event.code)
    if (modifierKey) {
      this.held.clear()
      return { preventDefault: false, ignoreMenuShortcuts, input: null }
    }
    if (event.isAutoRepeat && this.consumed.has(event.code) && !match) {
      return { preventDefault: true, ignoreMenuShortcuts, input: null }
    }
    if (event.isAutoRepeat && !this.held.has(event.code) && !match) {
      return { preventDefault: false, ignoreMenuShortcuts, input: null }
    }
    this.held.add(event.code)
    const codes: [string, ...string[]] = [event.code, ...[...this.held].filter(value => value !== event.code)]
    codes.sort()
    const pair = { code: codes[0], ...(codes[1] === undefined ? {} : { secondCode: codes[1] }), modifiers }
    let binding: { code: string; secondCode?: string } = { code: event.code }
    let priority = match
    if (codes.length === 2 && this.keys.has(this.protocol.bindingKey(pair))) {
      binding = pair
      priority = true
    }
    const main = event.frameName === ''
    if (!priority && (main || !match)) return { preventDefault: false, ignoreMenuShortcuts, input: null }
    if (!event.isAutoRepeat) {
      if (binding.secondCode !== undefined) {
        this.consumed.set(binding.code, 'repeat')
        this.consumed.set(binding.secondCode, 'repeat')
      }
      this.consumed.set(event.code, 'press')
    }
    // Electron can omit both keyups after interception; completed presses
    // cannot seed another chord (upstream rule).
    this.held.clear()
    return {
      preventDefault: true,
      ignoreMenuShortcuts,
      input: {
        revision: this.revision,
        kind: main ? 'keyboard' : 'iframe',
        frameName: main ? '' : event.frameName,
        code: binding.code,
        ...(binding.secondCode === undefined ? {} : { secondCode: binding.secondCode }),
        repeat: event.isAutoRepeat,
        control: event.control,
        alt: event.alt,
        shift: event.shift,
        meta: event.meta,
      },
    }
  }

  /** Clear chord/dead-key bookkeeping (window blur, frame change, keyboard teardown). */
  resetInput(): void {
    this.deadKey = false
    this.held.clear()
    this.consumed.clear()
    this.inputFrame = null
    this.inputRevision = undefined
  }

  /** Drop the product catalog on a main-frame navigation (upstream clear()). */
  clearCatalog(): void {
    this.definitions = []
    this.keys = new Set()
    this.revision = undefined
    this.recordingActive = false
    this.resetInput()
    this.persistence.setDefinitions(null)
  }

  /** Stop publishing late transaction completions. */
  dispose(): void {
    this.persistence.dispose()
  }

  private publish(snapshot: ShortcutConfigSnapshot): void {
    const previousRevision = this.revision
    this.revision = this.definitions.length === 0 || snapshot.status === 'loading' ? undefined : snapshot.revision
    const rows = snapshot.status === 'loading'
      ? []
      : this.protocol.effectiveShortcuts(this.definitions, snapshot.document, 'desktop', this.platform)
    this.keys = new Set(rows.flatMap(row => row.binding !== null && row.issue === null && row.conflicts.length === 0
      ? [this.protocol.bindingKey(row.binding)]
      : []))
    if (this.revision !== previousRevision) this.resetInput()
    this.send(DESKTOP_SHORTCUTS_CHANNELS.CHANGED, snapshot)
  }
}

/** Input shape of the main-process Electron glue (subset of Electron.Input). */
export interface ElectronKeyInputLike {
  readonly type: string
  readonly key: string
  readonly code: string
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly isAutoRepeat: boolean
  readonly isComposing: boolean
  readonly modifiers: readonly string[]
}

/**
 * Build the decision input from Electron facts (keeps the Electron type out of
 * this module; main.ts calls it right before handleKeyEvent).
 * @param input - Electron before-input-event input.
 * @param frameName - focused frame name ('' main, null none).
 * @param windowActive - owning window focused and enabled.
 * @returns the detached key fact.
 */
export function desktopKeyEvent(input: ElectronKeyInputLike, frameName: string | null,
  windowActive: boolean): DesktopKeyEvent {
  return {
    type: input.type === 'keyDown' || input.type === 'keyUp' || input.type === 'char' ? input.type : 'char',
    key: input.key,
    code: input.code,
    control: input.control,
    alt: input.alt,
    shift: input.shift,
    meta: input.meta,
    isAutoRepeat: input.isAutoRepeat,
    isComposing: input.isComposing,
    modifiers: input.modifiers,
    frameName,
    windowActive,
  }
}
