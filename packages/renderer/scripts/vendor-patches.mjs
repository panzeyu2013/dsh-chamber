/**
 * Vendor source patch registry (design 09 §3.6).
 *
 * WHY THIS EXISTS: the chamber shell serves ONE page from the control-plane
 * origin and multiplexes every instance under a per-instance base path
 * (`/api/i/<id>/*`). The official client assumes it is served from the dsh
 * origin, so any app-owned URL it builds — origin absolute or, since 0.1.7,
 * document-relative against the single page's `document.baseURI` — hits the
 * control plane instead of the instance. Our in-repo forks (connection / web /
 * api-gateway) cover the transport carriers; the file-API URL built by
 * `ui-chat` is not a carrier, and forking the whole ui-chat client (82 files /
 * ~11.3k lines) for one line is not a proportionate maintenance cost.
 *
 * HOW IT WORKS: this registry is applied by the renderer's vite plugin
 * (`vite.config.mjs` → `deepseekSource().transform`). It never writes to the
 * vendor tree: each edit is anchored to the EXACT pinned upstream snippet and
 * fails loudly (build error) when that snippet is missing or ambiguous, so a
 * pin upgrade cannot silently drop a patch. The unpatched sources are checked
 * independently by `verify-upstream-touchpoints.mjs` C9 and by
 * `scripts/vendor-patches.test.mjs`.
 *
 * ADDING A PATCH: only for a same-origin absolute or document-relative URL (or
 * equally hard upstream assumption) that the N-ctx shell breaks and that cannot
 * be fixed in a chamber package. Register the file, the reason, and one or more
 * exact `expect`→`replace` edits; prefer an optional chamber-provided standard
 * prop (see `chamberFileApiBase`) with upstream behaviour as the fallback, so
 * an official-layout deployment stays correct.
 *
 * SECOND ADMITTED CLASS (measured shell CPU — correctness patches keep
 * priority): an upstream constant or CSS animation whose per-frame cost is
 * MEASURED on the target hardware and which a chamber package cannot express
 * (hashed CSS-module class names are unselectable from outside; the publication
 * scheduler is module-private). Such an entry MUST state the A/B measurement in
 * `reason` (same Electron/display, renderer+GPU process CPU via
 * `app.getAppMetrics` cumulative deltas) and is held to the same C9 anchor gate
 * as a correctness patch, so a pin bump re-derives it loudly instead of
 * silently dropping it. Never widen this class for a perf change that a chamber
 * package or a visibility gate can already express.
 *
 * THIRD ADMITTED CLASS (logic defect in a module-private state machine, admitted
 * by maintainer ruling): an upstream behaviour that is observable in the shipped
 * shell and that a chamber package cannot fix — from outside, a package can only
 * compensate against the module's own state. Such an entry MUST state the
 * measured symptom and the accepted behaviour trade-off in `reason`, is held to
 * the same C9 anchor gate, and is deleted once the pin carries the upstream fix.
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
    reason: 'document-relative file-API URL (upstream resolves it against `document.baseURI`) resolves to the control-plane root in the N-ctx shell: one page cannot carry a per-entry base URI',
    edits: Object.freeze([
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
        expect: '  blocks, streaming, interrupted, renderMessageImages, groupPart, useDisclosure,\n'
          + '  reasoningHidden = false, usePresentation, revealProcess, mentions, t,\n}: AssistantMarkdownProps) {',
        replace: '  blocks, streaming, interrupted, renderMessageImages, groupPart, useDisclosure,\n'
          + '  reasoningHidden = false, usePresentation, revealProcess, mentions, t, chamberFileApiBase,\n}: AssistantMarkdownProps) {',
      }),
      Object.freeze({
        expect: '  const pathImages = useMemo<MarkdownPathImages>(() => {\n'
          + '    return { resolve: value => localPathMediaUrl(document.baseURI, value) }\n'
          + '  }, [])',
        replace: '  const pathImages = useMemo<MarkdownPathImages>(() => {\n'
          + '    // chamber patch: the page base is the control plane in the N-ctx shell, so\n'
          + '    // the file API must resolve from this entry\'s own base path.\n'
          + '    const base = chamberFileApiBase === undefined\n'
          + '      ? document.baseURI\n'
          + '      : new URL(`${chamberFileApiBase}/`, document.baseURI).href\n'
          + '    return { resolve: value => localPathMediaUrl(base, value) }\n'
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
    reason: 'document-relative upload URL (upstream resolves it against `document.baseURI`) resolves to the control-plane root in the N-ctx shell (composer attachments 404)',
    edits: Object.freeze([
      Object.freeze({
        expect: '    this.transport = hook === undefined ? workerTransport() : customTransport(hook.fetch)',
        replace: '    // chamber patch: the page base is the control plane under the N-ctx\n'
          + '    // shell, so every upload URL must carry this entry\'s API base prefix\n'
          + '    // (`/api/i/<id>/`; empty when the chamber fact is absent). ctx.get returns\n'
          + '    // undefined for an unprovided service (the cordis proxy THROWS on a\n'
          + '    // property read, so never read it as a property).\n'
          + '    const chamberBasePath = (ctx.get(\'chamberBasePath\') as string | undefined) ?? \'\'\n'
          + '    const chamberFileApiBase = chamberBasePath === \'\' ? \'\' : `${chamberBasePath}/`\n'
          + '    this.transport = hook === undefined ? workerTransport(chamberFileApiBase) : customTransport(hook.fetch, chamberFileApiBase)',
      }),
      Object.freeze({
        expect: 'function customTransport(customFetch: FileUploadFetch): FileUploadTransport {',
        replace: 'function customTransport(customFetch: FileUploadFetch, basePath = \'\'): FileUploadTransport {',
      }),
      Object.freeze({
        expect: '      const response = await customFetch(request.path, init)',
        replace: '      const response = await customFetch(`${basePath}${request.path}`, init)',
      }),
      Object.freeze({
        expect: 'function workerTransport(): FileUploadTransport {',
        replace: 'function workerTransport(basePath = \'\'): FileUploadTransport {',
      }),
      Object.freeze({
        expect: '          url: new URL(request.path, document.baseURI).href,',
        replace: '          url: new URL(`${basePath}${request.path}`, document.baseURI).href,',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-session-log-export/src/client/controller.ts',
      'packages/session-query/session-log-export/src/client/controller.ts',
    ]),
    vendorFile: 'dsh-session-log-export/src/client/controller.ts',
    reason: 'document-relative export URL resolves to the control-plane root in the N-ctx shell (the /export dialog and header action 404)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)\n'
          + '\n'
          + '  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()',
        replace: '  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)\n'
          + '\n'
          + '  /** chamber patch: per-entry API base prefix (`/api/i/<id>/`; empty when absent). */\n'
          + '  chamberFileApiBase = \'\'\n'
          + '\n'
          + '  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()',
      }),
      Object.freeze({
        expect: '      const route = `${SESSION_LOG_EXPORT_ROUTE}?${query.toString()}`',
        replace: '      const route = `${this.chamberFileApiBase}${SESSION_LOG_EXPORT_ROUTE}?${query.toString()}`',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-session-log-export/src/client/index.ts',
      'packages/session-query/session-log-export/src/client/index.ts',
    ]),
    vendorFile: 'dsh-session-log-export/src/client/index.ts',
    reason: 'hands the per-entry API base prefix to the export controller (apply owns the only ctx)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  const controller = new SessionLogDownloadController()',
        replace: '  const controller = new SessionLogDownloadController()\n'
          + '  // chamber patch: the export URL must carry this entry\'s API base prefix.\n'
          + '  const chamberBasePath = ctx.get(\'chamberBasePath\') as string | undefined\n'
          + '  controller.chamberFileApiBase = chamberBasePath === undefined ? \'\' : `${chamberBasePath}/`',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/present-open.ts',
      'packages/client/ui-deliverables/src/client/present-open.ts',
    ]),
    vendorFile: 'dsh-client-ui-deliverables/src/client/present-open.ts',
    reason: 'document-relative present URLs resolve to the control-plane root in the N-ctx shell (delivery-card open/reveal 404)',
    edits: Object.freeze([
      Object.freeze({
        expect: 'export class PresentedOpenController {\n'
          + '  /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */',
        replace: 'export class PresentedOpenController {\n'
          + '  /** chamber patch: per-entry API base prefix (`/api/i/<id>/`; empty when absent). */\n'
          + '  private readonly chamberFileApiBase: string\n'
          + '  /**\n'
          + '   * @param chamberFileApiBase - per-entry API base path (`/api/i/<id>`), \'\' when absent.\n'
          + '   */\n'
          + '  constructor(chamberFileApiBase = \'\') {\n'
          + '    this.chamberFileApiBase = chamberFileApiBase === \'\' ? \'\' : `${chamberFileApiBase}/`\n'
          + '  }\n'
          + '  /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */',
      }),
      Object.freeze({
        expect: '      const response = await fetch(PRESENT_HOST_ROUTE, { signal })',
        replace: '      const response = await fetch(`${this.chamberFileApiBase}${PRESENT_HOST_ROUTE}`, { signal })',
      }),
      Object.freeze({
        expect: '      const response = await fetch(target, { method: \'POST\', signal: this.lifetime.signal })',
        replace: '      const response = await fetch(`${this.chamberFileApiBase}${target}`, { method: \'POST\', signal: this.lifetime.signal })',
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
        expect: '  node, groupPart, useDisclosure, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, usePresentation, t,\n}: AssistantNodeViewProps) {',
        replace: '  node, groupPart, useDisclosure, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, usePresentation, t,\n'
          + '  chamberFileApiBase,\n}: AssistantNodeViewProps) {',
      }),
      Object.freeze({
        expect: '      mentions={mentions}\n      t={t}\n    />',
        replace: '      mentions={mentions}\n      t={t}\n      chamberFileApiBase={chamberFileApiBase}\n    />',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css',
      'packages/client/ui-chat/src/client/chat/ReasoningRow.module.css',
    ]),
    vendorFile: 'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css',
    reason: 'measured 120 Hz frame cost: the running-row sweep animates `left` (-300px→100%), forcing layout+paint every frame. A/B of the REAL pinned CSS bytes with this registry applied (Electron 43.4.0 / Chromium 150 / M5 Pro 120 Hz, app.getAppMetrics cumulative deltas): 3 concurrent rows 12.3% renderer / 7.6% GPU before → 1.3% / 1.2% after; 1 row 15.4% / 9.2% → 1.0% / 1.0%. Hashed CSS-module class names make a chamber-side override unselectable from styles.css, and the sweep is upstream UX: retarget it, never delete it. The sibling command-row sweep was retired upstream in the 0.1.7 line.',
    edits: Object.freeze([
      Object.freeze({
        expect: '  animation: dsh-reasoning-row-sweep 2.6s ease-out infinite;',
        replace: '  /* chamber patch: sweep on the compositor only (vendor-patches.mjs reason) */\n'
          + '  animation: dsh-reasoning-row-sweep-x 2.6s ease-out infinite;',
      }),
      Object.freeze({
        expect: '@keyframes dsh-reasoning-row-sweep {\n  0% { left: -300px; }\n  90%, 100% { left: 100%; }\n}',
        replace: '@keyframes dsh-reasoning-row-sweep-x {\n'
          + '  0% { transform: translateX(-300px); }\n'
          + "  /* 100vw exits any row width; the row's overflow:hidden clips the tail\n"
          + '     exactly like the upstream left:100% end state. */\n'
          + '  90%, 100% { transform: translateX(100vw); }\n'
          + '}',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
      'packages/client/ui-conversation/src/client/conversation/assembly.ts',
    ]),
    vendorFile: 'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
    reason: 'measured 120 Hz re-render cost: the upstream three-paint publication chain is pinned at 40 flushes/s under a saturated stream (3 frames x 8.3ms) and each flush commits the whole transcript. A/B executing the REAL upstream and patched method bodies verbatim (1500-row React tree, Electron 43.4.0 / Chromium 150 / M5 Pro 120 Hz): 100 events/s 40 flush/s / 22.5% renderer before → 11 flush/s / 9.5% after (-58%); 25 events/s 25 / 16.6% → 14 / 9.6% (-42%); 8 events/s 8 / 5.8% → 8 / 7.4% (same cadence, difference within run noise). The scheduler is module-private; no chamber package can gate it, and hidden-window stalling alone does not cover the visible-but-streaming case.',
    edits: Object.freeze([
      Object.freeze({
        expect: '  private frame: number | undefined',
        replace: '  private frame: number | undefined\n'
          + '  /** chamber patch: slice-scheduler timestamps in ms (monotonic clock). */\n'
          + '  private lastFlushAt = 0\n'
          + '  private lastPublishAt = 0',
      }),
      Object.freeze({
        expect: '      if (this.frame !== undefined) return\n'
          + '      // Cross three paint opportunities before publishing high-frequency stream updates.\n'
          + '      this.frame = requestAnimationFrame(() => {\n'
          + '        this.frame = requestAnimationFrame(() => {\n'
          + '          this.frame = requestAnimationFrame(() => {\n'
          + '            this.frame = undefined\n'
          + '            this.flush()\n'
          + '          })\n'
          + '        })\n'
          + '      })\n'
          + '      return',
        replace: '      if (this.frame !== undefined) return\n'
          + '      // chamber patch: quiet streams keep the upstream three-paint wait; saturated\n'
          + '      // streams coalesce into a fixed 80 ms slice, re-checked each frame and\n'
          + '      // flushed on the first frame at/after the boundary (vendor-patches.mjs\n'
          + '      // reason). The immediate publication still bypasses this branch entirely.\n'
          + '      const now = performance.now()\n'
          + '      const saturated = now - this.lastPublishAt < 40\n'
          + '      this.lastPublishAt = now\n'
          + '      if (saturated && now - this.lastFlushAt < 80) {\n'
          + '        this.frame = requestAnimationFrame(() => {\n'
          + '          this.frame = undefined\n'
          + "          this.publish('animation-frame')\n"
          + '        })\n'
          + '        return\n'
          + '      }\n'
          + '      if (saturated) {\n'
          + '        this.frame = requestAnimationFrame(() => {\n'
          + '          this.frame = undefined\n'
          + '          this.flush()\n'
          + '        })\n'
          + '        return\n'
          + '      }\n'
          + '      this.frame = requestAnimationFrame(() => {\n'
          + '        this.frame = requestAnimationFrame(() => {\n'
          + '          this.frame = requestAnimationFrame(() => {\n'
          + '            this.frame = undefined\n'
          + '            this.flush()\n'
          + '          })\n'
          + '        })\n'
          + '      })\n'
          + '      return',
      }),
      Object.freeze({
        expect: '  private flush(): void {\n'
          + '    if (this.assembler.flush()) this.snapshot.set(this.currentSnapshot())\n'
          + '    this.openTurn.set(this.assembler.openTurn())\n'
          + '  }',
        replace: '  private flush(): void {\n'
          + '    // chamber patch: the slice scheduler measures from the last flush.\n'
          + '    this.lastFlushAt = performance.now()\n'
          + '    if (this.assembler.flush()) this.snapshot.set(this.currentSnapshot())\n'
          + '    this.openTurn.set(this.assembler.openTurn())\n'
          + '  }',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-chat/src/client/chat/use-chat-reading.ts',
      'packages/client/ui-chat/src/client/chat/use-chat-reading.ts',
    ]),
    vendorFile: 'dsh-client-ui-chat/src/client/chat/use-chat-reading.ts',
    reason: 'sampled-settle logic defect (observable scroll offset): the viewport attributes any position-only movement to the reader, so a delivery no reader input produced (correlated trigger, scroll-side step not yet identified: the preparing -> started row replacement of a direct bash call, which PTC subcalls never render) arms the 500 ms sample; content that grows inside that window is not followed, and when the sample settled inside the follow tolerance (FOLLOW_THRESHOLD = 24 px) the reading layer kept the residual offset instead of re-pinning, so the newest row stayed half-hidden above the composer with data-chat-following-tail still set and no back-to-bottom affordance until the next layout change. Measured in the live frontend against the chamber-built ui-chat: a 12 px non-reader offset persisted indefinitely (12 px = half of a 24 px row) and any later layout change re-pinned it. Attribution and settle both live in this module-private state machine, so a chamber package could only nudge the scrollport from outside against it; this edit makes a settled sample agree with what the onScroll first branch and onResize already do inside the same tolerance. Accepted trade-off: a deliberate reader nudge within 24 px is re-pinned at the settle instead of surviving until the next layout change. Delete this entry once upstream carries the fix (upstream-preferred form: intent-based attribution in use-chat-viewport.ts).',
    edits: Object.freeze([
      Object.freeze({
        expect: '    if (!scroll.movedByReader && followingTail) this.followTail()',
        replace: '    // chamber patch: while the follow owns the tail, a settled sample re-pins the floor\n'
          + '    // instead of keeping the residual offset the tolerance band allows.\n'
          + '    if (followingTail) this.followTail()',
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
