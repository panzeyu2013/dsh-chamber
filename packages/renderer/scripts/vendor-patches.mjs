/**
 * Vendor source patch registry (design 09 §3.6, 2026-09 round-3 D3).
 *
 * WHY THIS EXISTS: the chamber shell serves ONE page from the control-plane
 * origin and multiplexes every instance under a per-instance base path
 * (`/api/i/<id>/*`). The official client assumes it is served from the dsh
 * origin, so any same-origin absolute URL it builds hits the control plane
 * instead of the instance. Our in-repo forks (connection / web / api-gateway)
 * cover the transport carriers; the file-API URL built by `ui-chat` is not a
 * carrier, and forking the whole ui-chat client (82 files / ~11.3k lines) for
 * one line is not a proportionate maintenance cost.
 *
 * HOW IT WORKS: this registry is applied by the renderer's vite plugin
 * (`vite.config.mjs` → `deepseekSource().transform`). It never writes to the
 * vendor tree: each edit is anchored to the EXACT pinned upstream snippet and
 * fails loudly (build error) when that snippet is missing or ambiguous, so a
 * pin upgrade cannot silently drop a patch. The unpatched sources are checked
 * independently by `verify-upstream-touchpoints.mjs` C9 and by
 * `scripts/vendor-patches.test.mjs`.
 *
 * ADDING A PATCH: only for a same-origin absolute URL (or equally hard
 * upstream assumption) that the N-ctx shell breaks and that cannot be fixed in
 * a chamber package. Register the file, the reason, and one or more exact
 * `expect`→`replace` edits; prefer an optional chamber-provided standard prop
 * (see `chamberFileApiBase`) with upstream behaviour as the fallback, so an
 * official-layout deployment stays correct.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Read-only symlink tree into the pinned dsh checkout. */
const VENDOR_ROOT = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))

/**
 * @typedef {object} VendorPatchEdit
 * @property {string} expect  Exact pinned-upstream text (must occur exactly once).
 * @property {string} replace Replacement text.
 *
 * @typedef {object} VendorPatch
 * @property {readonly string[]} idSuffixes Module-id suffixes that select the
 *   file. The renderer resolves vendor sources through `realpathSync`, so the
 *   id is usually the SUBMODULE path (`…/vendor/harness-checkout/packages/…`),
 *   not the symlinked `@deepseek-ai/<pkg>` path — both forms are listed.
 * @property {string} vendorFile Path under `vendor/harness-packages/@deepseek-ai/`.
 * @property {string} reason     Why chamber cannot fix this in its own package.
 * @property {readonly VendorPatchEdit[]} edits
 */

/**
 * Every registered vendor patch. Keep this list small: each entry is a
 * permanent upgrade liability, and C9 fails the pin bump when an anchor drifts.
 * @type {readonly VendorPatch[]}
 */
export const VENDOR_PATCHES = Object.freeze([
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
      'packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx',
    ]),
    vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
    reason: 'same-origin absolute file-API URL: `${origin}/api/file` resolves to the control plane in the N-ctx shell',
    edits: Object.freeze([
      Object.freeze({
        expect: 'export function localPathMediaUrl(protocol: string, origin: string, value: string): string | undefined {',
        replace: 'export function localPathMediaUrl(protocol: string, origin: string, value: string, basePath = \'\'): string | undefined {',
      }),
      Object.freeze({
        expect: '  return `${origin}/api/file?path=${encodeURIComponent(value)}`',
        replace: '  return `${origin}${basePath}/api/file?path=${encodeURIComponent(value)}`',
      }),
      Object.freeze({
        expect: '  /** The owning view\'s locale seat, passed down as a plain prop. */\n  t: ChatViewSlotProps[\'t\']\n}',
        replace: '  /** The owning view\'s locale seat, passed down as a plain prop. */\n  t: ChatViewSlotProps[\'t\']\n'
          + '  /**\n'
          + '   * chamber patch: per-entry API base path of the view this node belongs to\n'
          + '   * (`/api/i/<id>`), injected as a root standard prop by the chamber layout\n'
          + '   * fork. Absent on an official-layout deployment -> upstream behaviour.\n'
          + '   */\n'
          + '  chamberFileApiBase?: string | undefined\n}',
      }),
      Object.freeze({
        expect: '  blocks, streaming, interrupted, renderMessageImages,\n  reasoningHidden = false, revealProcess, mentions, t,\n}: AssistantMarkdownProps) {',
        replace: '  blocks, streaming, interrupted, renderMessageImages,\n  reasoningHidden = false, revealProcess, mentions, t, chamberFileApiBase,\n}: AssistantMarkdownProps) {',
      }),
      Object.freeze({
        expect: '  const pathImages = useMemo<MarkdownPathImages>(() => {\n'
          + '    const { protocol, origin } = window.location\n'
          + '    return { resolve: value => localPathMediaUrl(protocol, origin, value) }\n'
          + '  }, [])',
        replace: '  const pathImages = useMemo<MarkdownPathImages>(() => {\n'
          + '    const { protocol, origin } = window.location\n'
          + '    // chamber patch: the page origin is the control plane in the N-ctx\n'
          + '    // shell, so the file API must carry the per-entry base path.\n'
          + '    return { resolve: value => localPathMediaUrl(protocol, origin, value, chamberFileApiBase ?? \'\') }\n'
          + '  }, [chamberFileApiBase])',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-file-upload/src/client/runtime.ts',
      'packages/client/file-upload/src/client/runtime.ts',
    ]),
    vendorFile: 'dsh-client-file-upload/src/client/runtime.ts',
    reason: 'same-origin absolute upload URL: `new URL("/api/session/uploadFileBinary", location.origin)` posts to the control plane in the N-ctx shell (composer attachments 404)',
    edits: Object.freeze([
      Object.freeze({
        expect: '    this.transport = hook === undefined ? workerTransport() : customTransport(hook.fetch)',
        replace: '    // chamber patch: the page origin is the control plane under the N-ctx\n'
          + '    // shell, so every upload URL must carry this entry\'s API base path.\n'
          + '    // ctx.get returns undefined when the chamber fact is absent (the cordis\n'
          + '    // proxy THROWS on an unprovided service, so never read it as a property).\n'
          + '    const chamberFileApiBase = (ctx.get(\'chamberBasePath\') as string | undefined) ?? \'\'\n'
          + '    this.transport = hook === undefined ? workerTransport(chamberFileApiBase) : customTransport(hook.fetch, chamberFileApiBase)',
      }),
      Object.freeze({
        expect: 'function customTransport(customFetch: FileUploadFetch): FileUploadTransport {',
        replace: 'function customTransport(customFetch: FileUploadFetch, basePath = \'\'): FileUploadTransport {',
      }),
      Object.freeze({
        expect: '      const response = await customFetch(resolveUrl(request.path), init)',
        replace: '      const response = await customFetch(resolveUrl(request.path, basePath), init)',
      }),
      Object.freeze({
        expect: 'function workerTransport(): FileUploadTransport {',
        replace: 'function workerTransport(basePath = \'\'): FileUploadTransport {',
      }),
      Object.freeze({
        expect: '          url: resolveUrl(request.path).href,',
        replace: '          url: resolveUrl(request.path, basePath).href,',
      }),
      Object.freeze({
        expect: 'function resolveUrl(path: string): URL {',
        replace: 'function resolveUrl(path: string, basePath = \'\'): URL {',
      }),
      Object.freeze({
        expect: "  return new URL(path, origin === undefined || origin === 'null' ? 'http://dsh.internal' : origin)",
        replace: "  return new URL(`${basePath}${path}`, origin === undefined || origin === 'null' ? 'http://dsh.internal' : origin)",
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-session-log-export/src/client/controller.ts',
      'packages/session-query/session-log-export/src/client/controller.ts',
    ]),
    vendorFile: 'dsh-session-log-export/src/client/controller.ts',
    reason: 'same-origin absolute export URL: `new URL("/api/session.export", location.origin)` downloads from the control plane in the N-ctx shell (the /export dialog and header action 404)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)\n'
          + '\n'
          + '  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()',
        replace: '  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)\n'
          + '\n'
          + '  /** chamber patch: per-entry API base path for the export route. */\n'
          + '  chamberFileApiBase = \'\'\n'
          + '\n'
          + '  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()',
      }),
      Object.freeze({
        expect: "      const url = new URL('/api/session.export', hostBase())",
        replace: "      const url = new URL(`${this.chamberFileApiBase}/api/session.export`, hostBase())",
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-session-log-export/src/client/index.ts',
      'packages/session-query/session-log-export/src/client/index.ts',
    ]),
    vendorFile: 'dsh-session-log-export/src/client/index.ts',
    reason: 'hands the per-entry API base path to the export controller (apply owns the only ctx)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  const controller = new SessionLogDownloadController()',
        replace: '  const controller = new SessionLogDownloadController()\n'
          + '  // chamber patch: the export URL must carry this entry\'s API base path.\n'
          + '  controller.chamberFileApiBase = (ctx.get(\'chamberBasePath\') as string | undefined) ?? \'\'',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/present-open.ts',
      'packages/client/ui-deliverables/src/client/present-open.ts',
    ]),
    vendorFile: 'dsh-client-ui-deliverables/src/client/present-open.ts',
    reason: 'same-origin absolute present URLs: `/api/present.host|open` hits the control plane in the N-ctx shell (delivery-card open/reveal 404)',
    edits: Object.freeze([
      Object.freeze({
        expect: 'export class PresentedOpenController {\n'
          + '  /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */',
        replace: 'export class PresentedOpenController {\n'
          + '  /** chamber patch: per-entry API base path for the present routes. */\n'
          + '  private readonly chamberFileApiBase: string\n'
          + '  /**\n'
          + '   * @param chamberFileApiBase - per-entry API base path (`/api/i/<id>`), \'\' when absent.\n'
          + '   */\n'
          + '  constructor(chamberFileApiBase = \'\') {\n'
          + '    this.chamberFileApiBase = chamberFileApiBase\n'
          + '  }\n'
          + '  /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */',
      }),
      Object.freeze({
        expect: '      const response = await fetch(PRESENT_HOST_PATH, { signal })',
        replace: '      const response = await fetch(`${this.chamberFileApiBase}${PRESENT_HOST_PATH}`, { signal })',
      }),
      Object.freeze({
        expect: '      const response = await fetch(action === \'open\' ? url : `${url}&action=reveal`, { method: \'POST\', signal: this.lifetime.signal })',
        replace: '      const response = await fetch(`${this.chamberFileApiBase}${action === \'open\' ? url : `${url}&action=reveal`}`, { method: \'POST\', signal: this.lifetime.signal })',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/index.ts',
      'packages/client/ui-deliverables/src/client/index.ts',
    ]),
    vendorFile: 'dsh-client-ui-deliverables/src/client/index.ts',
    reason: 'hands the per-entry API base path to the present controller (the plugin apply owns the only ctx)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  const opener = new PresentedOpenController()',
        replace: '  const opener = new PresentedOpenController((ctx.get(\'chamberBasePath\') as string | undefined) ?? \'\')',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
      'packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx',
    ]),
    vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
    reason: 'forwards the chamberFileApiBase root standard prop into AssistantMarkdown (no chamber package can thread it)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, t,\n}: ChatNodeViewProps<\'assistant-step\'>) {',
        replace: '  node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, t,\n'
          + '  chamberFileApiBase,\n}: ChatNodeViewProps<\'assistant-step\'>) {',
      }),
      Object.freeze({
        expect: '      mentions={mentions}\n      t={t}\n    />',
        replace: '      mentions={mentions}\n      t={t}\n      chamberFileApiBase={chamberFileApiBase}\n    />',
      }),
    ]),
  }),
])

/** Normalize a module id: drop vite query/hash and force POSIX separators. */
function normalizeId(id) {
  return String(id).split('?')[0].split('#')[0].replaceAll('\\', '/')
}

/**
 * Apply every patch that selects this module id.
 * @param {string} id - the module id vite reports.
 * @param {string} code - the module source.
 * @returns {{ code: string, applied: string[] } | undefined} undefined when no patch matches.
 */
export function applyVendorPatches(id, code) {
  const normalized = normalizeId(id)
  let next = code
  const applied = []
  for (const patch of VENDOR_PATCHES) {
    if (!patch.idSuffixes.some(suffix => normalized.endsWith(suffix))) continue
    for (const [index, edit] of patch.edits.entries()) {
      const hits = next.split(edit.expect).length - 1
      if (hits !== 1) {
        throw new Error(
          `vendor patch ${patch.vendorFile} edit#${index}: anchor matched ${hits} times (expected exactly 1). `
          + `The pinned upstream text changed — re-derive the patch against the new pin. Reason: ${patch.reason}`,
        )
      }
      next = next.replace(edit.expect, edit.replace)
    }
    applied.push(patch.vendorFile)
  }
  return applied.length === 0 ? undefined : { code: next, applied }
}

/**
 * Freshness gate: every anchor must still match exactly once in the UNPATCHED
 * pinned vendor source. Used by the pin-verification script (C9) and the unit
 * test, so an upstream drift fails before a build does.
 * @param {string} [vendorRoot] - override for tests.
 * @returns {Array<{ vendorFile: string, ok: boolean, detail: string }>}
 */
export function checkVendorPatchSources(vendorRoot = VENDOR_ROOT) {
  const results = []
  for (const patch of VENDOR_PATCHES) {
    let source
    try {
      source = readFileSync(`${vendorRoot}${patch.vendorFile}`, 'utf8')
    } catch (error) {
      results.push({ vendorFile: patch.vendorFile, ok: false, detail: `unreadable: ${error.message}` })
      continue
    }
    let ok = true
    let detail = `${patch.edits.length} anchor(s) matched once`
    for (const [index, edit] of patch.edits.entries()) {
      const hits = source.split(edit.expect).length - 1
      if (hits !== 1) {
        ok = false
        detail = `edit#${index}: anchor matched ${hits} times (expected 1) — ${patch.reason}`
        break
      }
    }
    results.push({ vendorFile: patch.vendorFile, ok, detail })
  }
  return results
}
