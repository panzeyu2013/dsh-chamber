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
 *
 * FOURTH ADMITTED CLASS (N-ctx multi-instance correctness, admitted by maintainer
 * ruling): a page-global upstream fact (a persist key, a storage name, a
 * document-level registry) that the single page multiplexes across instances and
 * that no chamber package can re-scope — the fact lives inside a module-private
 * store or an upstream service. Such an entry MUST state the concrete
 * cross-instance symptom and the accepted trade-off in `reason`, derive the
 * scope from the per-entry `chamberBasePath` service provided on the plugin
 * context (never a page-global knob, a URL guess or `import.meta.url`), keep
 * upstream behaviour as the fallback so an official-layout deployment is
 * unaffected, and retire once upstream scopes the fact itself.

 *
 * SAME CLASS, SECOND ADMITTED FORM (ownership transfer, admitted by maintainer
 * ruling): a shared UI seat whose DECLARATION is owned by an upstream component
 * the chamber shell never mounts. The shell cannot re-declare it - ui-slots
 * throws on a second declaration of one seat - and no chamber package can
 * transfer a declaration, so the entry deletes the upstream declaration while
 * the shell declares the seat itself. This form has NO official-layout
 * fallback (without the shell the seat is simply undeclared), so it MUST carry
 * noRetireForm and state that trade-off in reason.
 *
 * RETIREMENT (upstream-drift batch-2 I-7): every entry declares EITHER
 * `retireCheck` (the pinned-upstream shape that carries the fix) or
 * `noRetireForm` (why no stable text shape can be named). C9 keeps a missing
 * anchor release-blocking but evaluates `retireCheck` first: a hit reports
 * `retire-candidate` (still release-blocking) with the remediation — move the
 * entry into `RETIRED_PATCHES` with an exact `ensure` snippet, and delete the
 * patch + its artifact marker in the same change; a miss stays the plain drift
 * failure (re-derive the patch against the new pin).
 *
 * NUMBERING: docs, comments and tests refer to entries as "patch N" — N is the
 * registration ordinal over the project's history (the RETIRED_PATCHES entries keep
 * their number), not an id stored in the table.
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
 * @property {VendorRetireCheck} [retireCheck] Upstream-fix shape; evaluated only
 *   when an anchor no longer matches (see the retirement contract in the header).
 * @property {string} [noRetireForm] Why no stable upstream-fix text shape can be
 *   asserted. Mutually exclusive with `retireCheck`.
 *
 * @typedef {object} VendorRetireProbe
 * @property {string} [vendorFile] Probed file under the vendor root; defaults to
 *   the patch's own file.
 * @property {readonly RegExp[]} [match] Every pattern must occur (NON-global).
 * @property {readonly string[]} [absent] Every exact snippet must be gone.
 *
 * @typedef {object} VendorRetireCheck
 * @property {readonly VendorRetireProbe[]} probes Every probe must agree on the
 *   unpatched pinned source for the fix to be recognized.
 * @property {string} note The upstream fix this shape recognizes + how to retire.
 *
 * @typedef {object} RetiredVendorPatch
 * @property {string} vendorFile Path under `vendor/harness-packages/@deepseek-ai/`.
 * @property {string} reason Which upstream fix retired the patch.
 * @property {string} ensure Exact upstream-fix text (must occur exactly once).
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
    noRetireForm: 'no stable upstream text shape: the retire form is a new entry-scoped base API for this route (an accepted base parameter or an entry-private ctx service), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.',
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
    noRetireForm: 'no stable upstream text shape: the retire form is a new entry-scoped base API for this route (an accepted base parameter or an entry-private ctx service), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.',
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
    noRetireForm: 'no stable upstream text shape: the retire form is a new entry-scoped base API for this route (an accepted base parameter or an entry-private ctx service), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.',
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
    noRetireForm: 'retires with the controller entry above (this apply threads the base into it); no independent upstream text shape to assert.',
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
    noRetireForm: 'no stable upstream text shape: the retire form is a new entry-scoped base API for this route (an accepted base parameter or an entry-private ctx service), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.',
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
    noRetireForm: 'retires with the present-open entry above; no independent upstream text shape to assert.',
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
    noRetireForm: 'retires with the AssistantMarkdown entry above (the prop threading has no purpose once upstream carries the base); no independent upstream text shape to assert.',
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
      'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
      'packages/client/ui-conversation/src/client/conversation/assembly.ts',
    ]),
    retireCheck: Object.freeze({
      probes: Object.freeze([
        Object.freeze({
          match: Object.freeze([/(?:performance|Date)\.now\(\)/, /(?:throttle|coalesc|slice|interval|budget)/i]),
          absent: Object.freeze(['// Cross three paint opportunities before publishing high-frequency stream updates.']),
        }),
      ]),
      note: 'Upstream replaces the three-paint chain with a rate-limited/sliced publication path. Delete this entry + its artifact marker and move the alternative scheduler shape into RETIRED_PATCHES.',
    }),
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
    retireCheck: Object.freeze({
      probes: Object.freeze([
        Object.freeze({
          vendorFile: 'dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts',
          match: Object.freeze([/movedByReader/]),
          absent: Object.freeze(['movedByReader: Math.abs(metrics.top - Math.min(this.observation.top, metrics.floor)) > 0.5']),
        }),
      ]),
      note: 'Upstream attributes movement by intent (the viewport no longer derives movedByReader from the position delta). Delete this entry + its artifact marker and move the intent-attribution shape into RETIRED_PATCHES.',
    }),
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
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-workspace/src/client/navigation.ts',
      'packages/client/ui-workspace/src/client/navigation.ts',
    ]),
    retireCheck: Object.freeze({
      probes: Object.freeze([
        Object.freeze({
          absent: Object.freeze(["persist: { name: 'dsh.sessions.current' }"]),
          match: Object.freeze([/persist[\s\S]{0,200}(?:scope|namespace|instance|basePath|keyPrefix)/i]),
        }),
      ]),
      note: 'Upstream scopes the Workspace selection persist key itself (a scope/namespace option or an instance-derived name). Delete this entry + its artifact marker, move the scoped shape into RETIRED_PATCHES, and retire the sidebar owner-source compensation only if the store no longer needs it.',
    }),
    vendorFile: 'dsh-client-ui-workspace/src/client/navigation.ts',
    reason: 'N-ctx multi-instance correctness (fourth admitted class): the official Workspace selection store persists under the page-global localStorage key `dsh.sessions.current`, while the chamber shell multiplexes every instance into ONE page document — two instances share one selection slot, so a source switch can restore (or overwrite) the other instance\'s current session; the sidebar only compensates by echoing the owner source, the store itself keeps the foreign value. The store is constructed inside the vendor service with no scope input and the key is module-private, so no chamber package can re-key it; the shell provides the per-entry `/api/i/<id>` base path on the plugin context (`chamberBasePath`), which this edit reads. Accepted trade-off: an official-layout deployment (no `chamberBasePath` service) keeps the upstream unscoped key. Delete this entry once upstream scopes the key itself.',
    edits: Object.freeze([
      Object.freeze({
        expect: '  private readonly selection = createSnapshotStore<MainSelection>(' + '\n'
          + "    {}, { persist: { name: 'dsh.sessions.current' } }," + '\n'
          + '  )',
        replace: '  private readonly selection = createSnapshotStore<MainSelection>(' + '\n'
          + "    {}, { persist: { name: 'dsh.sessions.current' + chamberSelectionScope(this.ctx) } }," + '\n'
          + '  )',
      }),
      Object.freeze({
        expect: '/** Structured directory failure exposed to directory UI consumers. */',
        replace: '/* chamber multi-instance correction: one page multiplexes N instances, so a' + '\n'
          + ' * page-global persist key lets a selection from one instance bleed into another.' + '\n'
          + ' * Scope the key to the /api/i/<id> base path of this entry (provided per entry' + '\n'
          + ' * by the shell); the fallback keeps an official-layout deployment unscoped. */' + '\n'
          + 'function chamberSelectionScope(ctx) {' + '\n'
          + "  const scope = ctx.get('chamberBasePath')" + '\n'
          + "  return typeof scope === 'string' && scope !== '' ? '.' + scope : ''" + '\n'
          + '}' + '\n' + '\n'
          + '/** Structured directory failure exposed to directory UI consumers. */',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-workspace/src/client/index.ts',
      'packages/client/ui-workspace/src/client/index.ts',
    ]),
    noRetireForm: 'no stable upstream text shape: the fix is upstream relocating the two seat declarations out of the workspace-browser registration (or an API that lets another owner take a declared child over), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.',
    vendorFile: 'dsh-client-ui-workspace/src/client/index.ts',
    reason: 'shared UI seat whose declaration is owned by an upstream component the chamber shell never mounts (fourth admitted class, ownership-transfer form): the official workspace-browser registration declares sidebar.session.row.leading / sidebar.session.row.hover, while the chamber shell renders its own multi-source list and never mounts that registration (the sidebar.workspaces hole stays declared but is never called, held by the I-4 sidebar lock). A second declaration of the same seat throws in ui-slots, and no chamber package can transfer a declaration, so only the seat owner can move it: this edit deletes the upstream declaration and the chamber sidebar declares both seats and renders them inside its own rows. Accepted trade-off: in an official-layout deployment (no chamber shell) the seats are undeclared, an occupant inject waits forever (silent), and the official row dead renderSlot calls would throw if that row were ever mounted.',
    edits: Object.freeze([
      Object.freeze({
        expect: "        'sidebar.session.row.leading': { kind: 'list', scope: 'root' },\n"
          + "        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },\n",
        replace: '',
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

/** Read a probed vendor file once per check run (string, or { error }). */
function readProbed(vendorRoot, file, cache) {
  if (!cache.has(file)) {
    try {
      cache.set(file, readFileSync(`${vendorRoot}${file}`, 'utf8'))
    } catch (error) {
      cache.set(file, { error })
    }
  }
  return cache.get(file)
}

/**
 * Evaluate one entry's retireCheck against the pinned (unpatched) tree.
 * @returns {{ ok: boolean, detail: string }}
 */
function retireCheckVerdict(patch, vendorRoot, cache) {
  for (const [index, probe] of patch.retireCheck.probes.entries()) {
    const file = probe.vendorFile ?? patch.vendorFile
    const source = readProbed(vendorRoot, file, cache)
    if (typeof source !== 'string') {
      return { ok: false, detail: `probe#${index} unreadable: ${file} (${source.error.message})` }
    }
    for (const pattern of probe.match ?? []) {
      pattern.lastIndex = 0
      if (!pattern.test(source)) {
        return { ok: false, detail: `probe#${index}: fix pattern absent in ${file}: ${pattern}` }
      }
    }
    for (const snippet of probe.absent ?? []) {
      if (source.includes(snippet)) {
        return { ok: false, detail: `probe#${index}: defect text still present in ${file}` }
      }
    }
  }
  return { ok: true, detail: 'all retire probes agree' }
}

/**
 * Freshness gate: every anchor must still match exactly once in the UNPATCHED
 * pinned vendor source. When an anchor no longer matches, the entry's
 * `retireCheck` decides between an upstream fix (`retire-candidate`, still
 * release-blocking) and a plain drift failure. Used by C9 and the unit test, so
 * an upstream drift fails before a build does.
 * @param {string} [vendorRoot] - override for tests.
 * @param {readonly VendorPatch[]} [patches] - override for tests.
 * @returns {Array<{ vendorFile: string, ok: boolean, verdict: 'ok' | 'retire-candidate' | 'drift', detail: string }>}
 */
export function checkVendorPatchSources(vendorRoot = VENDOR_ROOT, patches = VENDOR_PATCHES) {
  const results = []
  const cache = new Map()
  for (const patch of patches) {
    let source
    try {
      source = readFileSync(`${vendorRoot}${patch.vendorFile}`, 'utf8')
    } catch (error) {
      results.push({ vendorFile: patch.vendorFile, ok: false, verdict: 'drift', detail: `unreadable: ${error.message}` })
      continue
    }
    let anchorsOk = true
    let detail = `${patch.edits.length} anchor(s) matched once`
    for (const [index, edit] of patch.edits.entries()) {
      const hits = source.split(edit.expect).length - 1
      if (hits !== 1) {
        anchorsOk = false
        detail = `edit#${index}: anchor matched ${hits} times (expected 1)`
        break
      }
    }
    if (anchorsOk) {
      results.push({ vendorFile: patch.vendorFile, ok: true, verdict: 'ok', detail })
      continue
    }
    if (patch.retireCheck === undefined) {
      results.push({ vendorFile: patch.vendorFile, ok: false, verdict: 'drift', detail: `${detail} — ${patch.reason}` })
      continue
    }
    const retire = retireCheckVerdict(patch, vendorRoot, cache)
    results.push(retire.ok
      ? {
          vendorFile: patch.vendorFile,
          ok: false,
          verdict: 'retire-candidate',
          detail: `${detail}; retireCheck matched — ${patch.retireCheck.note}`,
        }
      : {
          vendorFile: patch.vendorFile,
          ok: false,
          verdict: 'drift',
          detail: `${detail}; retireCheck not matched (${retire.detail}) — re-derive the patch against the new pin`,
        })
  }
  return results
}

/**
 * Registry hygiene for the retirement contract: exactly one of `retireCheck` /
 * `noRetireForm` per entry, and a usable shape whenever `retireCheck` is present.
 * @param {readonly VendorPatch[]} [patches] - override for tests.
 * @returns {string[]} problems (empty = valid).
 */
export function vendorPatchRegistryProblems(patches = VENDOR_PATCHES) {
  const problems = []
  for (const patch of patches) {
    const hasRetire = patch.retireCheck !== undefined
    const hasNoForm = typeof patch.noRetireForm === 'string' && patch.noRetireForm !== ''
    if (hasRetire === hasNoForm) {
      problems.push(`${patch.vendorFile}: exactly one of retireCheck / noRetireForm is required`)
    }
    if (!hasRetire) continue
    const check = patch.retireCheck
    if (!Array.isArray(check.probes) || check.probes.length === 0) {
      problems.push(`${patch.vendorFile}: retireCheck.probes must be a non-empty array`)
    }
    if (typeof check.note !== 'string' || check.note === '') {
      problems.push(`${patch.vendorFile}: retireCheck.note is required`)
    }
    for (const probe of check.probes ?? []) {
      if ((probe.match ?? []).length + (probe.absent ?? []).length === 0) {
        problems.push(`${patch.vendorFile}: a retire probe needs match and/or absent conditions`)
      }
      for (const pattern of probe.match ?? []) {
        if (pattern.global) problems.push(`${patch.vendorFile}: retireCheck patterns must not use /g`)
      }
    }
  }
  return problems
}

/**
 * Patches upstream has fixed and chamber has retired (upstream-drift batch-2
 * I-7). Each entry is an `ensure` assertion: the fix must still be present
 * exactly once, or C9 goes red (regression fence). A `retire-candidate` verdict
 * is accepted by moving the entry here; the VENDOR_PATCHES entry and its artifact
 * marker are deleted in the same change.
 * @type {readonly RetiredVendorPatch[]}
 */
export const RETIRED_PATCHES = Object.freeze([
  Object.freeze({
    vendorFile: 'dsh-client-ui-primitives/src/TextShimmer.module.css',
    reason: 'upstream moved the running-row sweep into the shared TextShimmer with compositor-only keyframes (transform only) and dropped the ui-chat ReasoningRow.module.css sweep this patch retargeted; ReasoningRow.tsx now renders TextShimmer, so the measured per-frame layout+paint cost is gone upstream.',
    ensure: '@keyframes dsh-row-shimmer-sweep {\n  0% { transform: translateX(-100%); }',
  }),
  Object.freeze({
    vendorFile: 'dsh-util-values/src/index.ts',
    reason: 'upstream compares native constructors engine-independently (against the realm own Function.prototype.toString of Array/Object) instead of the one-line native-code template this patch whitespace-normalized, so the JavaScriptCore multi-line failure cannot occur.',
    ensure: "Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === 'Array' ? Array : Object)",
  }),
])

/**
 * Regression fence for retired patches.
 * @param {string} [vendorRoot] - override for tests.
 * @param {readonly RetiredVendorPatch[]} [entries] - override for tests.
 * @returns {Array<{ vendorFile: string, ok: boolean, detail: string }>}
 */
export function checkRetiredPatches(vendorRoot = VENDOR_ROOT, entries = RETIRED_PATCHES) {
  const results = []
  for (const entry of entries) {
    let source
    try {
      source = readFileSync(`${vendorRoot}${entry.vendorFile}`, 'utf8')
    } catch (error) {
      results.push({ vendorFile: entry.vendorFile, ok: false, detail: `unreadable: ${error.message}` })
      continue
    }
    const hits = source.split(entry.ensure).length - 1
    results.push({
      vendorFile: entry.vendorFile,
      ok: hits === 1,
      detail: hits === 1 ? 'ensure matched once' : `ensure matched ${hits} times (expected 1) — upstream fix regressed or drifted`,
    })
  }
  return results
}
