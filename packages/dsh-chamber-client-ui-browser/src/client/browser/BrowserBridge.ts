/**
 * Native guest carrier contract (design 28 v3 §3/§4, ADR-0004).
 *
 * The Swift shell owns one child WKWebView per tab. The renderer never touches
 * the guest: it acquires a lease, sends navigation intents (navigate / command /
 * frame / keymap), reports the placeholder geometry and consumes the four pushed
 * event faces (state / openRequested / input / forwardNeeded). The live lease is
 * mirrored onto the placeholder as `data-chamber-browser-lease` so the page-level
 * input replay addresses the focused occurrence (D12). The page-level carrier is the
 * Swift-only `dshChamber.browser` namespace (whitelisted in
 * `packages/desktop/bridge-swift-only-additions.json`); a page without it does
 * NOT register the Browser row (fail-closed — the iframe carrier is retired).
 *
 * Pure: types + runtime guards, no DOM/Node access. Every pushed payload is
 * untrusted input (a cross-process projection) and is validated here.
 */

/** Exact guest target: a direct URL, or a forward record main must load as its alias. */
export type BrowserGuestTarget =
  | { readonly kind: 'direct'; readonly url: string }
  | { readonly kind: 'forward'; readonly recordId: string; readonly path: string }

/**
 * Placeholder geometry in CSS pixels, relative to the shell webView bounds.
 * Geometry ONLY: visibility/occlusion ride as top-level fields of the invoke and
 * of the state push (design 28 §3:85 — `frame:{x,y,w,h}, visible, occluded`).
 */
export interface BrowserGuestFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One placeholder report: geometry plus its top-level visibility flags. */
export interface BrowserFrameReport {
  readonly frame: BrowserGuestFrame
  readonly visible: boolean
  readonly occluded: boolean
}

/** Pushed guest state (main → renderer). */
export interface BrowserGuestState {
  readonly tabId: string
  readonly lease: string
  readonly url: string
  readonly title: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly loading: boolean
  readonly error?: { readonly code?: number; readonly description?: string }
  /** Optional top-level visibility projection (main-side occlusion/z-order). */
  readonly visible?: boolean
  readonly occluded?: boolean
}

/** Pushed new-window request (main → renderer): the panel opens a browser tab. */
export interface BrowserGuestOpenRequest {
  readonly tabId: string
  readonly url: string
  /**
   * The opener tab occurrence (RT-11; design 28 §3:89). The carrier rejects a
   * push whose lease does not match the receiving occurrence; an absent lease is
   * the older-shim compatibility arm. The opened tab is a NEW occurrence, so the
   * lease is attribution only and never becomes the new tab's lease.
   */
  readonly lease?: string
}

/**
 * Pushed primary-modifier key from a focused guest (main → renderer; design 28
 * §3:89). Canonical wire shape =
 * `{tabId, code, modifiers: ['meta'|'alt'|'shift'|'control'], repeat?, lease?}`.
 * The legacy boolean shape (`primary/alt/shift/control/repeat`) stays accepted so
 * a shim/Swift rollout order cannot break the replay.
 *
 * `lease` is the focused tab occurrence's live guest lease (D12). The page-level
 * replay prefers the placeholder carrying `data-chamber-browser-lease` (written by
 * `NativeGuestPresentation.setLease`) and falls back to `data-chamber-browser-tab`
 * when the push has no lease (older shim). It is attribution only, never a
 * credential.
 */
export interface BrowserGuestInput {
  readonly tabId: string
  readonly code: string
  readonly modifiers: readonly string[]
  readonly repeat?: boolean
  /** Legacy alias for the primary modifier (maps to meta). */
  readonly primary?: boolean
  /** The focused occurrence's live guest lease; absent = older-shim compatibility arm. */
  readonly lease?: string
}

/**
 * Pushed forward negotiation request (main → renderer, design 28 §2.10).
 *
 * The guest's main frame navigated to a loopback target without the address bar.
 * Main suspends that navigation and asks the renderer for the same forward
 * lease the address bar would attach; the renderer answers with
 * `navigate({ kind: 'forward', recordId, path })` on success (main then cancels
 * the suspended navigation and loads the alias) or drops it on failure (main
 * shows the failure projection). Payload is untrusted; only `tabId`/`url` are read.
 */
export interface BrowserGuestForwardNeeded {
  readonly tabId: string
  readonly url: string
  /** The lease the negotiation belongs to (absent on an older shim = match any). */
  readonly lease?: string
}

/** Carrier identity one tab occurrence acquires a lease with (design 28 §3). */
export interface NativeGuestCarrier {
  readonly bridge: BrowserBridge
  readonly sessionId: string
  readonly sourceId: string
  readonly sourceFingerprint: string
  /** Workspace partition key; main resolves the authoritative CWD from it. */
  readonly workspaceKey: string
  /**
   * Authoritative re-read of the workspace partition key (design 28 §4.4): the
   * per-entry ctx knows the host-authoritative Workspace list, so the key is the
   * session's workspace CWD rather than the placeholder {@link workspaceKey}.
   * Absent = the static key is used.
   */
  readonly resolveWorkspaceKey?: () => Promise<string>
}

/** Guest event faces the renderer subscribes to. */
export interface BrowserBridgeEvents {
  state(listener: (value: BrowserGuestState) => void): () => void
  openRequested(listener: (value: BrowserGuestOpenRequest) => void): () => void
  input(listener: (value: BrowserGuestInput) => void): () => void
  forwardNeeded(listener: (value: BrowserGuestForwardNeeded) => void): () => void
}

/**
 * One effective shortcut combination the shell must forward from a focused guest
 * (design 28 v3 §4.5). `primary` is the platform's primary modifier (Command on
 * macOS, Control elsewhere); `control` is the literal Control key on macOS.
 */
export interface BrowserKeyCombo {
  readonly code: string
  readonly primary: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly control: boolean
}

/**
 * Effective-combination source owned by the page (the renderer adapter reads the
 * Shortcuts service snapshots). Absent = the shell keeps its own empty keymap.
 */
export interface BrowserKeyComboSource {
  /** Current effective combinations (catalog + config + fixed commands). */
  read(): readonly BrowserKeyCombo[]
  /** @returns unsubscribe; fires on any snapshot change. */
  subscribe(listener: () => void): () => void
}

/** Lease identity: one tab occurrence, minted by main. */
export interface BrowserGuestLease {
  readonly tabId: string
  readonly lease: string
}

/** Acquire inputs: the lease request and the first geometry report. */
export interface BrowserGuestAcquireInput {
  readonly tabId: string
  readonly sessionId: string
  readonly sourceId: string
  readonly sourceFingerprint: string
  readonly workspaceKey: string
  readonly frame: BrowserGuestFrame
  readonly visible: boolean
  readonly occluded: boolean
}

/** One invoke result; main answers a closed code on refusal. */
export type BrowserGuestAck = { readonly ok: true } | { readonly ok: false; readonly code: string }

/** The carrier surface the launcher consumes (implemented by the renderer adapter). */
export interface BrowserBridge {
  acquire(input: BrowserGuestAcquireInput): Promise<{ readonly ok: true; readonly lease: string } | { readonly ok: false; readonly code: string }>
  release(input: BrowserGuestLease): Promise<BrowserGuestAck>
  navigate(input: BrowserGuestLease & { readonly target: BrowserGuestTarget }): Promise<BrowserGuestAck>
  command(input: BrowserGuestLease & { readonly command: BrowserGuestCommand }): Promise<BrowserGuestAck>
  frame(input: BrowserGuestLease & BrowserFrameReport): Promise<BrowserGuestAck>
  /**
   * Register the effective shortcut combinations the shell must forward from a
   * focused guest. Optional: a shim without it keeps guest keys inert (fail-safe,
   * never swallows them); v1 forwards only when both this and {@link combos} exist.
   */
  keymap?(input: BrowserGuestLease & { readonly combos: readonly BrowserKeyCombo[] }): Promise<BrowserGuestAck>
  /** Effective-combination source the launcher pushes through `keymap`. */
  readonly combos?: BrowserKeyComboSource
  readonly events: BrowserBridgeEvents
}

/** Guest navigation commands (design 28 §3). */
export type BrowserGuestCommand = 'goBack' | 'goForward' | 'reload' | 'stop'

/**
 * The invokes a carrier MUST provide, in invoke order. This is the product
 * single source for the whitelist; `keymap` is the optional sixth (absent on an
 * older shim = guest keys stay inert), so the full six-name face is
 * `[...REQUIRED_BROWSER_INVOKES, 'keymap']`.
 */
export const REQUIRED_BROWSER_INVOKES = ['acquire', 'release', 'navigate', 'command', 'frame'] as const
/** Push channel names (main → renderer). */
export const BROWSER_PUSHES = ['state', 'openRequested', 'input', 'forwardNeeded'] as const

const BOUND = /^[A-Za-z0-9_-]{1,128}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** Narrow an untrusted pushed state; null when any invariant is broken. */
export function parseBrowserGuestState(value: unknown): BrowserGuestState | null {
  if (!isRecord(value)) return null
  const { tabId, lease, url, title, canGoBack, canGoForward, loading, error, visible, occluded } = value
  if (!isBoundedString(tabId, 128) || !BOUND.test(tabId)) return null
  if (!isBoundedString(lease, 128) || !BOUND.test(lease)) return null
  // INC-02/R-08: a null url/title projection must not drop the whole record (an
  // error push with a null page identity still has to reach the failure bar).
  if (url !== null && url !== undefined && (typeof url !== 'string' || url.length > 4096)) return null
  if (title !== null && title !== undefined && (typeof title !== 'string' || title.length > 512)) return null
  if (typeof canGoBack !== 'boolean' || typeof canGoForward !== 'boolean' || typeof loading !== 'boolean') return null
  if (error !== undefined && error !== null) {
    if (!isRecord(error)) return null
    const code = error.code
    const description = error.description
    if (code !== undefined && (typeof code !== 'number' || !Number.isFinite(code))) return null
    if (description !== undefined && (typeof description !== 'string' || description.length > 512)) return null
  }
  if (visible !== undefined && typeof visible !== 'boolean') return null
  if (occluded !== undefined && typeof occluded !== 'boolean') return null
  const parsed: BrowserGuestState = {
    tabId, lease, url: typeof url === 'string' ? url : '', title: typeof title === 'string' ? title : '', canGoBack, canGoForward, loading,
    ...(isRecord(error) ? { error: { ...(typeof error.code === 'number' ? { code: error.code } : {}), ...(typeof error.description === 'string' ? { description: error.description } : {}) } } : {}),
    ...(typeof visible === 'boolean' ? { visible } : {}),
    ...(typeof occluded === 'boolean' ? { occluded } : {}),
  }
  return parsed
}

/** Narrow an untrusted open-request push (the optional opener lease is bounded like forward-needed). */
export function parseBrowserOpenRequest(value: unknown): BrowserGuestOpenRequest | null {
  if (!isRecord(value)) return null
  if (!isBoundedString(value.tabId, 128) || typeof value.url !== 'string' || value.url.length > 4096) return null
  if (value.lease !== undefined && (typeof value.lease !== 'string' || value.lease === '' || value.lease.length > 128)) return null
  return { tabId: value.tabId, url: value.url, ...(typeof value.lease === 'string' ? { lease: value.lease } : {}) }
}

/** Narrow an untrusted forward-needed push (url is only classified as loopback later). */
export function parseBrowserForwardNeeded(value: unknown): BrowserGuestForwardNeeded | null {
  if (!isRecord(value)) return null
  if (!isBoundedString(value.tabId, 128) || typeof value.url !== 'string' || value.url.length > 4096) return null
  if (value.lease !== undefined && (typeof value.lease !== 'string' || value.lease === '' || value.lease.length > 128)) return null
  return { tabId: value.tabId, url: value.url, ...(typeof value.lease === 'string' ? { lease: value.lease } : {}) }
}

/**
 * Structural probe for the carrier bridge: the five required invokes plus the
 * optional `keymap` sixth, and the four event faces (`state`, `openRequested`,
 * `input`, `forwardNeeded`).
 */
export function asBrowserBridge(value: unknown): BrowserBridge | null {
  if (!isRecord(value)) return null
  for (const method of REQUIRED_BROWSER_INVOKES) {
    let member: unknown
    try { member = value[method] } catch { return null }
    if (typeof member !== 'function') return null
  }
  // Optional `keymap`: when present it must be a function (never a broken face).
  try {
    const keymap = value.keymap
    if (keymap !== undefined && typeof keymap !== 'function') return null
  } catch { return null }
  let events: unknown
  try { events = value.events } catch { return null }
  if (!isRecord(events)) return null
  for (const name of BROWSER_PUSHES) {
    let member: unknown
    try { member = events[name] } catch { return null }
    if (typeof member !== 'function') return null
  }
  return value as unknown as BrowserBridge
}
