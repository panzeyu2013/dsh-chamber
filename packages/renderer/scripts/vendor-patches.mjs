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
 * The transform also returns a GENERATED sourcemap (see the "Patched-code
 * sourcemap" section above `applyVendorPatches`): a code-only transform silently
 * drops the module from every emitted chunk map, so the map is part of the
 * contract, not an extra.
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
 * `reason` (same machine/display, renderer+GPU process CPU cumulative deltas;
 * the shipping Swift shell measures via Activity Monitor/ps plus Web Inspector
 * Layout counts, while the frozen Electron leg named `app.getAppMetrics`) and is
 * held to the same C9 anchor gate as a correctness patch, so a pin bump
 * re-derives it loudly instead of silently dropping it. An entry whose reason
 * says ADMISSION PENDING is a worktree candidate only: it must not ride a
 * release build until the A/B is recorded (gate = release checklist + STATUS).
 * Never widen this class for a perf change that a chamber package or a
 * visibility gate can already express.
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
 * context (never a page-global knob, a URL guess or `import.meta.url`), OR - for
 * a document-level DOM-event registry no chamber package owns - from the
 * mounting component's own subtree (THIRD ADMITTED FORM below); keep
 * upstream behaviour as the fallback so an official-layout deployment is
 * unaffected, and retire once upstream scopes the fact itself.
 *
 * FIFTH ADMITTED CLASS (chamber shell behaviour gate, admitted by maintainer
 * ruling): an upstream branch or seat whose ACTIVATION is wrong under the
 * chamber shell -- not a URL, not a measured cost, not a scoped fact. The
 * desktop branch keys off a carrier the composite must expose for other
 * official seats, so it arms even though the shell it assumes does not exist,
 * and its first act (a full-screen shell.overlay) is not something a chamber
 * package can veto without shadowing the official family. Such an entry MUST
 * state the concrete takeover/degradation symptom and the accepted trade-off
 * in reason, keep upstream behaviour reachable behind an explicit escape hatch
 * (never a silent permanent disable), carry a bundle marker, and be deleted
 * once upstream stops keying the branch off that carrier.

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
 * FOURTH CLASS, THIRD ADMITTED FORM (per-mount DOM scope, admitted by maintainer
 * ruling by the __DSH_HOST_PATHS__ containment patch): the page-global fact is a
 * document-level DOM-event registry whose correct scope is the mounting
 * component's own subtree - a per-mount fact, so `chamberBasePath` is not involved
 * and no page-global knob may stand in for it. Such an entry MUST take the scope
 * from the component's own mount (an ancestor resolved at call time), guard EVERY
 * document-level side effect of the registry (not only the terminal one), keep
 * upstream behaviour when no chamber view is mounted, refuse when the scope
 * cannot be resolved while chamber views ARE mounted, state the accepted
 * trade-off and the measured symptom in reason, and carry `noRetireForm`
 * (upstream has no N-shell notion to anchor on).
 *
 * FOURTH CLASS, FOURTH ADMITTED FORM (page-global singleton) -
 * ADMISSION PENDING（fourth-form ruling）; see the two ui-theme entries): the
 * page-global fact is a DOM resource every mounted instance shell installs for
 * itself - identical theme stylesheets and one icon sprite - so N shells multiply
 * a single page-wide artifact N times and a hidden shell keeps its copy alive.
 * Unlike the per-mount form above, the fix is DEDUPE, not re-scoping: publish the
 * resource ONCE per document behind a page-level registry keyed on a global symbol
 * (`Symbol.for`, because each shell may run its own bundle instance, so
 * module-private state is per instance, never page-wide) and release it only when
 * the last owner disposes. Such an entry MUST state the measured per-shell DOM
 * symptom and the accepted trade-off in reason, stay DOM-equivalent to upstream on
 * a single-instance page (one resource, removed on dispose, no chamber knob), and
 * carry `noRetireForm` until upstream defines a page-level singleton contract of
 * its own. ADMISSION PENDING: the maintainer ruling that admits this form has NOT
 * been recorded, so these entries are worktree candidates only (the pending
 * class② measurement discipline above applies): they must NOT ride a release build, and
 * the ruling must be recorded in design 09 §3.6 before any release carries them -
 * tracked by the release checklist's fourth-form blocking row.
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
 * The retire form shared by the entry-scoped base-API entries: upstream has to expose
 * an entry-private base (an accepted parameter or a ctx service) before any text shape
 * exists to assert, so retirement is C9 drift + a maintainer ruling. One constant keeps
 * the copies from drifting apart.
 */
const NO_RETIRE_FORM_ENTRY_BASE_API = 'no stable upstream text shape: the retire form is a new entry-scoped base API for this route (an accepted base parameter or an entry-private ctx service), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.'

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
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
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
        expect: '  blocks, streaming, textInteractionSource = false, interrupted, loadImage, groupPart, useDisclosure,\n'
          + '  reasoningHidden = false, usePresentation, revealProcess, mentions, renderSlot, useGroupAction, t,\n}: AssistantMarkdownProps) {',
        replace: '  blocks, streaming, textInteractionSource = false, interrupted, loadImage, groupPart, useDisclosure,\n'
          + '  reasoningHidden = false, usePresentation, revealProcess, mentions, renderSlot, useGroupAction, t, chamberFileApiBase,\n}: AssistantMarkdownProps) {',
      }),
      Object.freeze({
        expect: '  const pathImages = useMemo<MarkdownPathImages>(() => {\n'
          + '    return { resolve: value => localPathMediaUrl(document.baseURI, value) }\n'
          + '  }, [])',
        replace: '  const pathImages = useMemo<MarkdownPathImages>(() => {\n'
          + '    // chamber patch: the page base is the control plane in the N-ctx shell, so\n'
          + '    // the file API must resolve from this entry\'s own base path.\n'
          + '    const base = chamberFileApiBase === undefined || chamberFileApiBase === \'\'\n'
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
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
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
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
    vendorFile: 'dsh-session-log-export/src/client/controller.ts',
    reason: 'document-relative export URL resolves to the control-plane root in the N-ctx shell (the /export dialog URL and shell.overlay download 404)',
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
          + '  controller.chamberFileApiBase = chamberBasePath === undefined || chamberBasePath === \'\' ? \'\' : `${chamberBasePath}/`',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/present-open.ts',
      'packages/client/ui-deliverables/src/client/present-open.ts',
    ]),
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
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
    reason: 'hands the per-entry API base path to the present controller and both read stores (the plugin apply owns the only ctx)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  const opener = new PresentedOpenController()',
        replace: '  const opener = new PresentedOpenController((ctx.get(\'chamberBasePath\') as string | undefined) ?? \'\')',
      }),
      Object.freeze({
        expect: '  const summaries = new ChangesSummaryStore()\n'
        + '  const diffs = new ChangesDiffStore()',
        replace: '  const summaries = new ChangesSummaryStore()\n'
        + '  const diffs = new ChangesDiffStore()\n'
        + '  // chamber patch: the summary and diff reads must carry this entry\'s API base prefix\n'
        + '  // (undefined/empty-safe; the store keeps the un-prefixed URL as its state key).\n'
        + '  const chamberBasePath = ctx.get(\'chamberBasePath\') as string | undefined\n'
        + '  const chamberFileApiBase = chamberBasePath === undefined || chamberBasePath === \'\' ? \'\' : `${chamberBasePath}/`\n'
        + '  summaries.chamberFileApiBase = chamberFileApiBase\n'
        + '  diffs.chamberFileApiBase = chamberFileApiBase',
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
        expect: '  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions,\n'
          + '  usePresentation, renderSlot, t, sessionId, useContextMenu, resolveFilePath,\n}: AssistantNodeViewProps) {',
        replace: '  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions,\n'
          + '  usePresentation, renderSlot, t, sessionId, useContextMenu, resolveFilePath,\n'
          + '  chamberFileApiBase,\n}: AssistantNodeViewProps & {\n'
          + '  /** chamber patch: per-entry API base prefix. */\n'
          + '  chamberFileApiBase?: string | undefined\n'
          + '}) {',
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
        // rc.2 refactor: flush() now delegates to publishing()/publishSnapshot()
        // (assistant-turn publication error recovery). The scheduler timestamp
        // stays at the flush ENTRY, not in publishing(): publishing() also serves
        // activate(), and stamping there would reset the slice clock on target
        // activation, a behavior the pre-refactor flush() did not have.
        expect: '  private flush(): void {\n'
          + '    this.publishing(() => this.assembler.flush())\n'
          + '  }',
        replace: '  private flush(): void {\n'
          + '    // chamber patch: the slice scheduler measures from the last flush.\n'
          + '    this.lastFlushAt = performance.now()\n'
          + '    this.publishing(() => this.assembler.flush())\n'
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
    noRetireForm: 'no stable upstream text shape: the fix is upstream relocating the seat declarations out of the workspace-browser registration (or an API that lets another owner take a declared child over), which cannot be asserted as text today. C9 drift failure + maintainer ruling, not an automated retire check.',
    vendorFile: 'dsh-client-ui-workspace/src/client/index.ts',
    reason: 'shared UI seat whose declaration is owned by an upstream component the chamber shell never mounts (fourth admitted class, ownership-transfer form): the official workspace-browser registration declares sidebar.session.row.leading / sidebar.session.row.trailing / sidebar.session.row.hover (trailing is new upstream; the chamber sidebar owns its rows and does not adopt that seat (decided: design 06 §10 / design 09 §3.6)), while the chamber shell renders its own multi-source list and never mounts that registration (the sidebar.workspaces hole stays declared but is never called, held by the I-4 sidebar lock). A second declaration of the same seat throws in ui-slots, and no chamber package can transfer a declaration, so only the seat owner can move it: this edit deletes the three upstream declarations, and the chamber sidebar re-declares only leading and hover, rendering them inside its own rows (trailing stays deliberately unadopted; the upstream `inline` marker (ui-slots: span anchors / span error placeholders instead of div) is a render hint for the official row and is not mirrored, because the chamber row owns its own geometry and its CSS was built against the div anchor). Accepted trade-off: in an official-layout deployment (no chamber shell) the seats are undeclared, an occupant inject waits forever (silent), and the official row dead renderSlot calls would throw if that row were ever mounted.',
    edits: Object.freeze([
      Object.freeze({
        expect: "        'sidebar.session.row.leading': { kind: 'list', scope: 'root', inline: true },\n"
          + "        'sidebar.session.row.trailing': { kind: 'list', scope: 'root', inline: true },\n"
          + "        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },\n",
        replace: '',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/Deliverables.tsx',
      'packages/client/ui-deliverables/src/client/Deliverables.tsx',
    ]),
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
    vendorFile: 'dsh-client-ui-deliverables/src/client/Deliverables.tsx',
    reason: 'the delivery-card file-action owner route (api/present.open) is document-relative, so the official open-in consumer fetches the control-plane page origin in the N-ctx shell: the delivery-card folder menu cannot list applications',
    edits: Object.freeze([
      Object.freeze({
        expect: '& Pick<GlobalStandardProps, \'useSessions\' | \'useContextMenu\'> & InjectFace<DeliverablesInjected>',
        replace: '& Pick<GlobalStandardProps, \'useSessions\' | \'useContextMenu\'> & {\n'
        + '  /**\n'
        + '   * chamber patch: this entry\'s API base path (`/api/i/<id>`, no trailing\n'
        + '   * slash), absent when the chamber fact is absent. An owner action route must\n'
        + '   * carry it: the official open-in consumer fetches this URL directly, and in\n'
        + '   * the N-ctx shell the page origin is the control plane.\n'
        + '   */\n'
        + '  chamberFileApiBase?: string | undefined\n'
        + '} & InjectFace<DeliverablesInjected>',
      }),
      Object.freeze({
        expect: '  useChangesDiff, loadChangesDiff, useChangesSummary, reloadPresentedHost, loadChangesSummary, useShowCodeDiff, renderSlot,\n'
        + '}: Pick<TurnTailOwnerProps, \'openFile\'> & {',
        replace: '  useChangesDiff, loadChangesDiff, useChangesSummary, reloadPresentedHost, loadChangesSummary, useShowCodeDiff, renderSlot,\n'
        + '  chamberFileApiBase,\n'
        + '}: Pick<TurnTailOwnerProps, \'openFile\'> & {',
      }),
      Object.freeze({
        expect: '            actionUrl: presentedFileUrl(sessionId, file.seq, file.index),',
        replace: '            actionUrl: (chamberFileApiBase === undefined || chamberFileApiBase === \'\' ? \'\' : `${chamberFileApiBase}/`) + presentedFileUrl(sessionId, file.seq, file.index),',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/ReviewTab.tsx',
      'packages/client/ui-deliverables/src/client/ReviewTab.tsx',
    ]),
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
    vendorFile: 'dsh-client-ui-deliverables/src/client/ReviewTab.tsx',
    reason: 'the review file-action owner route (api/changes.open) is document-relative, so the official open-in consumer fetches the control-plane page origin in the N-ctx shell: the review tab folder menu cannot list applications',
    edits: Object.freeze([
      Object.freeze({
        expect: 'export type ReviewTabProps = PropsRuntime<\'sidebar.right.pane.tab\'> & PropsStore<ReturnType<typeof createReviewStore>>',
        replace: 'export type ReviewTabProps = PropsRuntime<\'sidebar.right.pane.tab\'> & {\n'
        + '  /**\n'
        + '   * chamber patch: this entry\'s API base path (`/api/i/<id>`, no trailing\n'
        + '   * slash), absent when the chamber fact is absent. An owner action route must\n'
        + '   * carry it: the official open-in consumer fetches this URL directly, and in\n'
        + '   * the N-ctx shell the page origin is the control plane.\n'
        + '   */\n'
        + '  chamberFileApiBase?: string | undefined\n'
        + '} & PropsStore<ReturnType<typeof createReviewStore>>',
      }),
      Object.freeze({
        expect: '  loadChangesSummary, loadChangesDiff, reloadPresentedHost, openChanged, t, renderSlot,\n'
        + '}: ReviewTabProps): ReactNode {',
        replace: '  loadChangesSummary, loadChangesDiff, reloadPresentedHost, openChanged, t, renderSlot,\n'
        + '  chamberFileApiBase,\n'
        + '}: ReviewTabProps): ReactNode {',
      }),
      Object.freeze({
        expect: '            actionUrl: changedFileUrl(sessionId, seq, index), available: native,',
        replace: '            actionUrl: (chamberFileApiBase === undefined || chamberFileApiBase === \'\' ? \'\' : `${chamberFileApiBase}/`) + changedFileUrl(sessionId, seq, index), available: native,',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-deliverables/src/client/host-read-store.ts',
      'packages/client/ui-deliverables/src/client/host-read-store.ts',
    ]),
    noRetireForm: NO_RETIRE_FORM_ENTRY_BASE_API,
    vendorFile: 'dsh-client-ui-deliverables/src/client/host-read-store.ts',
    reason: 'the summary and diff reads (api/changes.summary, api/changes.diff) are document-relative, so both stores fetch the control-plane page origin in the N-ctx shell: the summary never resolves (changed-files card missing, review tab unreachable) and the diff errors. ONLY the wire URL is rebased — the state key stays the authenticated URL every caller already holds',
    edits: Object.freeze([
      Object.freeze({
        expect: 'export class HostReadStore<T> {\n'
        + '  /** Record URLs key the state across Sessions and turns. */',
        replace: 'export class HostReadStore<T> {\n'
        + '  /** chamber patch: per-entry API base prefix (`/api/i/<id>/`; \'\' when absent). */\n'
        + '  chamberFileApiBase = \'\'\n'
        + '  /** Record URLs key the state across Sessions and turns. */',
      }),
      Object.freeze({
        expect: '      next = await this.policy.decode(await fetch(url, { signal }))',
        replace: '      next = await this.policy.decode(await fetch(`${this.chamberFileApiBase}${url}`, { signal }))',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-chat/src/client/chat/ChatView.tsx',
      'packages/client/ui-chat/src/client/chat/ChatView.tsx',
    ]),
    noRetireForm: 'retires with the AssistantMarkdown entry above (one prop, one route family); no independent upstream text shape to assert.',
    vendorFile: 'dsh-client-ui-chat/src/client/chat/ChatView.tsx',
    reason: 'the chat view resolves decoded file-reference images against document.baseURI, which is the control-plane origin in the N-ctx shell: mentioned-image previews 404 (the sibling pathImages provider in AssistantMarkdown already carries the same prop)',
    edits: Object.freeze([
      Object.freeze({
        expect: '  usePresentation, useProjection, useInteractionIds, dispatchInteraction, t, fileDrag,\n}: ChatViewSlotProps) {',
        replace: '  usePresentation, useProjection, useInteractionIds, dispatchInteraction, t, fileDrag, chamberFileApiBase,\n}: ChatViewSlotProps & {\n'
          + '  /**\n'
          + '   * chamber patch: this entry\'s API base path (`/api/i/<id>`, no trailing\n'
          + '   * slash), absent when the chamber fact is absent. A file-API URL must\n'
          + '   * carry it: the page origin is the control plane in the N-ctx shell.\n'
          + '   */\n'
          + '  chamberFileApiBase?: string | undefined\n'
          + '}) {',
      }),
      Object.freeze({
        expect: '    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),',
        replace: '    resolve: (path: string) => fileMediaUrl(chamberFileApiBase === undefined || chamberFileApiBase === \'\' ? document.baseURI : new URL(`${chamberFileApiBase}/`, document.baseURI).href, resolveWorkspacePath(cwd, path)),',
      }),
      Object.freeze({
        // The labels block is upstream text the resolver edit leaves alone: binding it
        // keeps this deps anchor from moving onto a sibling memo that shares the same
        // `cwd` / `t` dependencies.
        expect: '    labels: {\n'
          + "      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),\n"
          + "      dialog: t('image.dialog'), close: t('image.close'),\n"
          + '    },\n'
          + '  }), [cwd, t, fileDrag, sessionId])',
        replace: '    labels: {\n'
          + "      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),\n"
          + "      dialog: t('image.dialog'), close: t('image.close'),\n"
          + '    },\n'
          + '  }), [chamberFileApiBase, cwd, t, fileDrag, sessionId])',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      "dsh-client-ui-attachment/src/client/drop-events.ts",
      "packages/client/ui-attachment/src/client/drop-events.ts",
    ]),
    noRetireForm: "no stable upstream text shape: the fix is a containment contract (every document-level drag/drop side effect is limited to the event target own shell subtree, while the upstream viewport-left reset stays global), not a snippet - upstream has no N-shell notion to anchor on.",
    vendorFile: "dsh-client-ui-attachment/src/client/drop-events.ts",
    reason: "N-ctx multi-instance correctness (fourth admitted class, third admitted form = per-mount DOM scope, maintainer ruling): the drag/drop listeners live on document, which every mounted instance shell shares, so one drag or drop is seen by every shell - the on-screen composer and every hidden remote composer alike. Symptoms measured in the shipped shell: one dropped image attaches to more than one instance draft, a hidden shell vetoes the visible shell by writing dataTransfer.dropEffect = none (dragover), and it covers the visible shell with its own drop overlay (dragenter). Scope derives from the attachment mount own [data-instance] ancestor (a per-mount fact, not a page-global knob; no base path is involved), upstream behaviour remains the fallback for a layout with no instance shells, an owner that resolves to null while instance shells ARE mounted is refused (fail-closed), and the upstream viewport-left reset stays global so leaving the window always clears every shell overlay. ACCEPTED TRADE-OFF: a drag or drop landing outside every instance shell (chamber overlay, cross-instance portal) is intaken by no composer.",
    edits: Object.freeze([
      Object.freeze({
        expect: " * @param setDragActive - publish whether a file drag is active.\n * @param readFileDrag - resolve an original image retained by this application during a browser drag.\n * @returns cleanup for exactly these listeners.\n */\nexport function installDocumentDropEvents(\n  canAcceptDrop: ComposerAttachmentsProps['canAcceptDrop'],\n  onAddFiles: ComposerAttachmentsProps['onAddFiles'],\n  dragDepth: { current: number },\n  setDragActive: (active: boolean) => void,\n  readFileDrag: (transfer: DataTransfer) => File | undefined,\n): () => void {",
        replace: " * @param setDragActive - publish whether a file drag is active.\n * @param readFileDrag - resolve an original image retained by this application during a browser drag.\n * @param ownerView - resolves this attachment view own subtree; a drop or\n *   drag event outside it belongs to another mounted shell and is not ours.\n * @returns cleanup for exactly these listeners.\n */\nexport function installDocumentDropEvents(\n  canAcceptDrop: ComposerAttachmentsProps['canAcceptDrop'],\n  onAddFiles: ComposerAttachmentsProps['onAddFiles'],\n  dragDepth: { current: number },\n  setDragActive: (active: boolean) => void,\n  readFileDrag: (transfer: DataTransfer) => File | undefined,\n  ownerView?: () => Element | null,\n): () => void {",
      }),
      Object.freeze({
        expect: "  const onDragEnter = (event: globalThis.DragEvent): void => {\n    const dataTransfer = fileTransfer(event)\n    if (dataTransfer === null) return",
        replace: "  const dropLandsInView = (event: globalThis.DragEvent): boolean => {\n    if (ownerView === undefined) return true\n    const owner = ownerView()\n    if (owner === null) return document.querySelector('[data-instance]') === null\n    const target = event.target\n    const node = target instanceof Element ? target : (target instanceof Node ? target.parentElement : null)\n    return node !== null && owner.contains(node)\n  }\n  const onDragEnter = (event: globalThis.DragEvent): void => {\n    if (!dropLandsInView(event)) return\n    const dataTransfer = fileTransfer(event)\n    if (dataTransfer === null) return",
      }),
      Object.freeze({
        expect: "  const onDragOver = (event: globalThis.DragEvent): void => {\n    const dataTransfer = fileTransfer(event)",
        replace: "  const onDragOver = (event: globalThis.DragEvent): void => {\n    if (!dropLandsInView(event)) return\n    const dataTransfer = fileTransfer(event)",
      }),
      Object.freeze({
        expect: "  const onDragLeave = (event: globalThis.DragEvent): void => {\n    if (fileTransfer(event) === null) return\n    dragDepth.current = Math.max(0, dragDepth.current - 1)\n    if (dragDepth.current === 0) setDragActive(false)\n    const leftViewport = event.clientX <= 0 || event.clientY <= 0\n      || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight\n    if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()\n  }",
        replace: "  const onDragLeave = (event: globalThis.DragEvent): void => {\n    if (fileTransfer(event) === null) return\n    const leftViewport = event.clientX <= 0 || event.clientY <= 0\n      || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight\n    // 上游的「指针离开视口」逃生口必须先于归属判定：目标为 html/body 的 dragleave 不属于任何壳，\n    // 但它证明拖拽会话已出窗，每个壳都要清掉自己的 overlay（OS 拖拽页面侧不保证有 dragend）。\n    if ((event.target === document.documentElement || event.target === document.body) && leftViewport) {\n      reset()\n      return\n    }\n    if (!dropLandsInView(event)) return\n    dragDepth.current = Math.max(0, dragDepth.current - 1)\n    if (dragDepth.current === 0) setDragActive(false)\n  }",
      }),
      Object.freeze({
        expect: "    if (canAcceptDrop) {\n      const image = dataTransfer.types.includes(FILE_DRAG_TOKEN_TYPE) ? readFileDrag(dataTransfer) : undefined",
        replace: "    if (canAcceptDrop && dropLandsInView(event)) {\n      const image = dataTransfer.types.includes(FILE_DRAG_TOKEN_TYPE) ? readFileDrag(dataTransfer) : undefined",
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      "dsh-client-ui-attachment/src/client/ComposerAttachments.tsx",
      "packages/client/ui-attachment/src/client/ComposerAttachments.tsx",
    ]),
    noRetireForm: "retires with the drop-events containment entry above: the owner resolver exists only to feed that check; upstream would need an N-shell-aware drag/drop contract, not a snippet.",
    vendorFile: "dsh-client-ui-attachment/src/client/ComposerAttachments.tsx",
    reason: "wiring half of the same fourth-class defect (third admitted form = per-mount DOM scope): threads this attachment view mount subtree into the containment check so the document-level drag/drop listeners can scope themselves per shell. Measured symptom (with the drop-events half only): hidden shells still reacted to dragenter/dragover of a drop aimed at another shell (overlay + dropEffect veto). ACCEPTED TRADE-OFF: a drag outside every instance shell is not intaken by any composer. No chamber package owns this component; the containment scope is per-mount, not a page-global knob, and a missing owner keeps upstream behaviour.",
    edits: Object.freeze([
      Object.freeze({
        expect: "  const dragDepth = useRef(0)",
        replace: "  const dragDepth = useRef(0)\n  // chamber patch: the drop listeners live on document, which every mounted\n  // instance shell shares, so every handler must be limited to events landing\n  // inside THIS attachment view own subtree (data-instance is the view root).\n  const ownerRef = useRef<HTMLSpanElement | null>(null)\n  const ownerView = useCallback((): Element | null =>\n    ownerRef.current?.closest('[data-instance]') ?? null, [])",
      }),
      Object.freeze({
        expect: "    return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, readFileDrag)\n  }, [canAcceptDrop, onAddFiles, readFileDrag])",
        replace: "    return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, readFileDrag, ownerView)\n  }, [canAcceptDrop, onAddFiles, readFileDrag, ownerView])",
      }),
      Object.freeze({
        expect: "  return (\n    <>\n      {dragActive && (",
        replace: "  return (\n    <span ref={ownerRef} style={{ display: 'contents' }}>\n      {dragActive && (",
      }),
      Object.freeze({
        expect: "      )}\n    </>\n  )\n}",
        replace: "      )}\n    </span>\n  )\n}",
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-settings-account/src/client/index.ts',
      'packages/client/ui-settings-account/src/client/index.ts',
    ]),
    noRetireForm: 'chamber behaviour, not an upstream re-anchor: the composite gates the official desktop-onboarding overlay off because it takes over #root and parks without desktop configForms (design 09 §3.5). Retirement = the upstream overlay stops being desktop-gated, or a chamber-side account surface replaces it; C9 drift failure + maintainer ruling, not an automated retire check.',
    vendorFile: 'dsh-client-ui-settings-account/src/client/index.ts',
    reason: 'the official desktop-onboarding shell.overlay seat portals a full-screen surface, zeroes + inerts #root and parks on the settings loading state under the composite (no desktop configForms settles it); the account settings section itself registers outside the desktop branch and stays',
    edits: Object.freeze([
      Object.freeze({
        expect: '  if (desktop) {\n    const controller = new DesktopOnboardingController(',
        replace: '  // chamber patch (alpha.3): gate the desktop onboarding overlay off in the\n'
          + '  // composite — its full-screen shell.overlay seat takes over #root and parks\n'
          + '  // without desktop configForms (design 09 §3.5). The account settings section\n'
          + '  // registers outside this branch and stays; set the global to restore upstream.\n'
          + '  if (desktop && (globalThis as { __dshChamberAccountOverlay?: boolean }).__dshChamberAccountOverlay === true) {\n    const controller = new DesktopOnboardingController(',
      }),
      Object.freeze({
        // The overlay registration was the only writer of that flag
        // (:278-280 setVisible/publish), so gating the branch alone would leave
        // desktopOnboardingVisible truthy forever and permanently suppress the
        // upstream account menu (AccountMenu reads !desktopOnboardingVisible; the
        // rc.2 AccountNoticeStack component itself no longer exists).
        expect: '    view: undefined, details: undefined, avatar: undefined, failed: false, loginVisible: false, desktopOnboardingVisible: desktop,',
        replace: '    view: undefined, details: undefined, avatar: undefined, failed: false, loginVisible: false, desktopOnboardingVisible: desktop && (globalThis as { __dshChamberAccountOverlay?: boolean }).__dshChamberAccountOverlay === true,',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-theme/src/client/styles.ts',
      'packages/client/ui-theme/src/client/styles.ts',
    ]),
    noRetireForm: 'no stable upstream text shape: the fix is a page-level singleton/refcount contract for the theme DOM resources, which upstream has no N-shell notion to assert against. C9 drift failure + maintainer ruling, not an automated retire check.',
    vendorFile: 'dsh-client-ui-theme/src/client/styles.ts',
    reason: 'N-ctx multi-instance correctness (FOURTH CLASS, FOURTH ADMITTED FORM (page-global singleton) - ADMISSION PENDING（fourth-form ruling）): the single page mounts one shell per instance; ui-theme itself is a page-level module singleton, but installThemeStyles runs once per mounted shell ctx and appends its own eight <style data-plugin-css> sheets per shell - the measured multi-shell page carried 575 <style> / 736 CSSStyleSheet nodes and a hidden shell keeps its eight alive. The sheets are module constants, identical across shells, and no chamber package can dedupe a DOM node another plugin owns; module-private state may differ per bundle instance, so the dedupe registry must sit on the document behind Symbol.for. This edit publishes each sheet once per document behind a document-level registry keyed on Symbol.for and refcounts it; the last owner removes it. Accepted trade-off: on a multi-shell page every shell shares the same eight sheets (identical content, so nothing changes visually) and a hidden shell no longer holds its own copy; the sheets stay until the last shell disposes, not until the first. A single-instance page gets the upstream DOM exactly (one sheet per name, removed on dispose) and no chamber knob is involved. ADMISSION PENDING: the maintainer ruling that admits this fourth form has not been recorded, so this entry is a worktree candidate only and must not ride a release build until the ruling is recorded (design 09 §3.6; tracked by the fourth-form release blocking row in the release checklist).',
    edits: Object.freeze([
      Object.freeze({
        expect: '/**\n'
          + ' * Mount global theme sheets; window-backed documents also publish the DPR-aware stroke width.\n'
          + ' * @param ctx - Owning plugin context.\n'
          + ' */\n'
          + 'export function installThemeStyles(ctx: Context): void {',
        replace: '/**\n'
          + ' * chamber patch (FOURTH CLASS, FOURTH ADMITTED FORM - page-global singleton;\n'
          + ' * ADMISSION PENDING（fourth-form ruling）): one page hosts N mounted shell ctxs;\n'
          + ' * ui-theme is a page-level module singleton, but installThemeStyles runs once\n'
          + ' * per shell ctx and appends the same eight <style data-plugin-css> sheets per\n'
          + ' * shell (measured multi-shell page: 575 <style> / 736 CSSStyleSheet nodes, and\n'
          + ' * a hidden shell keeps its eight alive). The sheets are module constants,\n'
          + ' * identical across shells. Publish each sheet ONCE per document and refcount\n'
          + ' * it; the registry lives on the document behind `Symbol.for` so it also\n'
          + ' * survives bundle/rev drift (module-private state may differ per instance).\n'
          + ' * The last owner removes the node - the upstream single-instance DOM.\n'
          + ' */\n'
          + 'const CHAMBER_PAGE_STYLES = Symbol.for(\'dsh-chamber:page-theme-styles\')\n'
          + '\n'
          + 'type ChamberPageStyleEntry = { el: HTMLStyleElement; refs: number }\n'
          + '\n'
          + '/** Acquire one page-global theme sheet for this owner; returns its release. */\n'
          + 'function acquirePageStyle(name: string, css: string): () => void {\n'
          + '  const host = document as unknown as { [key: symbol]: Map<string, ChamberPageStyleEntry> | undefined }\n'
          + '  let registry = host[CHAMBER_PAGE_STYLES]\n'
          + '  if (registry === undefined) {\n'
          + '    registry = new Map()\n'
          + '    host[CHAMBER_PAGE_STYLES] = registry\n'
          + '  }\n'
          + '  let entry = registry.get(name)\n'
          + '  if (entry === undefined) {\n'
          + '    const tag = document.createElement(\'style\')\n'
          + '    tag.dataset.plugin = PLUGIN_ID\n'
          + '    tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`\n'
          + '    tag.textContent = css\n'
          + '    document.head.appendChild(tag)\n'
          + '    entry = { el: tag, refs: 0 }\n'
          + '    registry.set(name, entry)\n'
          + '  }\n'
          + '  // chamber patch: an external all-document sweep (removeOwnedStyles-style) can detach\n'
          + '  // the shared sheet; a newly mounted shell must never reuse a detached node.\n'
          + '  if (entry.el.isConnected === false) document.head.appendChild(entry.el)\n'
          + '  const shared = entry\n'
          + '  shared.refs += 1\n'
          + '  return () => {\n'
          + '    shared.refs -= 1\n'
          + '    if (shared.refs > 0) return\n'
          + '    shared.el.remove()\n'
          + '    if (registry.get(name) === shared) registry.delete(name)\n'
          + '  }\n'
          + '}\n'
          + '\n'
          + '/**\n'
          + ' * Mount global theme sheets; window-backed documents also publish the DPR-aware stroke width.\n'
          + ' * @param ctx - Owning plugin context.\n'
          + ' */\n'
          + 'export function installThemeStyles(ctx: Context): void {',
      }),
      Object.freeze({
        expect: '  for (const [name, css] of STYLES) {\n'
          + '    ctx.effect(() => {\n'
          + '      const tag = document.createElement(\'style\')\n'
          + '      tag.dataset.plugin = PLUGIN_ID\n'
          + '      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`\n'
          + '      tag.textContent = css\n'
          + '      document.head.appendChild(tag)\n'
          + '      return () => { tag.remove() }\n'
          + '    }, `ui-theme: ${name} stylesheet`)\n'
          + '  }',
        replace: '  for (const [name, css] of STYLES) {\n'
          + '    // chamber patch: the sheet is page-global and refcounted; see acquirePageStyle.\n'
          + '    ctx.effect(() => acquirePageStyle(name, css), `ui-theme: ${name} stylesheet`)\n'
          + '  }',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-theme/src/client/icon-sprite.ts',
      'packages/client/ui-theme/src/client/icon-sprite.ts',
    ]),
    noRetireForm: 'no stable upstream text shape: the fix is a page-level singleton/refcount contract for the icon sprite, which upstream has no N-shell notion to assert against. C9 drift failure + maintainer ruling, not an automated retire check.',
    vendorFile: 'dsh-client-ui-theme/src/client/icon-sprite.ts',
    reason: 'N-ctx multi-instance correctness (FOURTH CLASS, FOURTH ADMITTED FORM (page-global singleton) - ADMISSION PENDING（fourth-form ruling）): the single page mounts one shell per instance; installIconSprite runs once per mounted shell ctx and prepends its own <svg data-dsh-icon-sprite> with every ICON_SYMBOLS <symbol> rendered once per shell - the measured multi-shell page carried 23,932 SVGSymbolElement nodes and a hidden shell keeps its sprite alive. No chamber package owns this component and module-private state is per bundle instance, so the page-wide fact must live on the document behind Symbol.for. This edit publishes one sprite per document with a refcount and a SHARED markup map, so an identical theme applied by a second shell is a no-op; the last owner removes the sprite. Accepted trade-off: the theme is a document-level singleton, so the shared sprite reflects the LAST theme/change applied by any shell (last write wins); a single-instance page gets the upstream DOM exactly (one sprite, removed on dispose) and no chamber knob is involved. ADMISSION PENDING: the maintainer ruling that admits this fourth form has not been recorded, so this entry is a worktree candidate only and must not ride a release build until the ruling is recorded (design 09 §3.6; tracked by the fourth-form release blocking row in the release checklist).',
    edits: Object.freeze([
      Object.freeze({
        expect: '/**\n'
          + ' * Mount the sprite and keep each symbol on the active theme\'s replacement or\n'
          + ' * the ui-primitives default; plugin disposal removes the sprite.\n'
          + ' * @param ctx - owning plugin context; `theme/change` snapshots drive updates.\n'
          + ' * @param icons - replacements of the theme active at install time.\n'
          + ' */\n'
          + 'export function installIconSprite(ctx: Context, icons: IconReplacements | undefined): void {\n'
          + '  if (typeof document === \'undefined\') return\n'
          + '  const sprite = document.createElementNS(SVG_NS, \'svg\')\n'
          + '  sprite.setAttribute(\'aria-hidden\', \'true\')\n'
          + '  sprite.setAttribute(\'data-dsh-icon-sprite\', \'\')\n'
          + '  sprite.style.cssText = \'position: absolute; width: 0; height: 0; overflow: hidden\'\n'
          + '  const rendered = new Map<string, SVGSymbolElement>()\n'
          + '  const markups = new Map<string, string>()\n'
          + '  const apply = (replacements: IconReplacements = {}): void => {\n'
          + '    for (const [id, fallback] of Object.entries(ICON_SYMBOLS) as [IconSymbolId, string][]) {\n'
          + '      const markup = replacements[id] ?? fallback\n'
          + '      if (markups.get(id) === markup) continue\n'
          + '      const symbol = toSymbol(id, markup)\n'
          + '      const previous = rendered.get(id)\n'
          + '      if (previous === undefined) sprite.append(symbol)\n'
          + '      else previous.replaceWith(symbol)\n'
          + '      rendered.set(id, symbol)\n'
          + '      markups.set(id, markup)\n'
          + '    }\n'
          + '  }\n'
          + '  apply(icons)\n'
          + '  ctx.effect(() => {\n'
          + '    document.body.prepend(sprite)\n'
          + '    return () => { sprite.remove() }\n'
          + '  }, \'ui-theme: icon sprite\')\n'
          + '  ctx.on(\'theme/change\', (snapshot) => { apply(snapshot.active.icons) })\n'
          + '}',
        replace: '/**\n'
          + ' * chamber patch (FOURTH CLASS, FOURTH ADMITTED FORM - page-global singleton;\n'
          + ' * ADMISSION PENDING（fourth-form ruling）): one page hosts N mounted shell ctxs;\n'
          + ' * installIconSprite runs once per shell ctx and prepends one sprite per shell\n'
          + ' * (measured multi-shell page: 23,932 SVGSymbolElement nodes and one\n'
          + ' * <svg data-dsh-icon-sprite> per shell). The page-wide fact must live on the\n'
          + ' * document behind `Symbol.for` (module-private state may differ per bundle\n'
          + ' * instance); the sprite is published once and refcounted, and its markup map\n'
          + ' * is shared so an identical theme applied by a second shell is a no-op. The\n'
          + ' * last owner removes the sprite - the upstream single-instance DOM.\n'
          + ' */\n'
          + 'const CHAMBER_PAGE_ICON_SPRITE = Symbol.for(\'dsh-chamber:page-icon-sprite\')\n'
          + '\n'
          + 'type ChamberPageSprite = {\n'
          + '  readonly sprite: SVGSVGElement\n'
          + '  refs: number\n'
          + '  readonly rendered: Map<string, SVGSymbolElement>\n'
          + '  readonly markups: Map<string, string>\n'
          + '}\n'
          + '\n'
          + '/** Acquire the page-global sprite for this owner; returns its state and release. */\n'
          + 'function acquirePageSprite(): { state: ChamberPageSprite; release: () => void } {\n'
          + '  const host = document as unknown as { [key: symbol]: ChamberPageSprite | undefined }\n'
          + '  let state = host[CHAMBER_PAGE_ICON_SPRITE]\n'
          + '  if (state === undefined) {\n'
          + '    const sprite = document.createElementNS(SVG_NS, \'svg\')\n'
          + '    sprite.setAttribute(\'aria-hidden\', \'true\')\n'
          + '    sprite.setAttribute(\'data-dsh-icon-sprite\', \'\')\n'
          + '    sprite.style.cssText = \'position: absolute; width: 0; height: 0; overflow: hidden\'\n'
          + '    state = { sprite, refs: 0, rendered: new Map(), markups: new Map() }\n'
          + '    host[CHAMBER_PAGE_ICON_SPRITE] = state\n'
          + '  }\n'
          + '  // chamber patch: re-attach a detached shared sprite before a new owner claims it.\n'
          + '  if (state.sprite.isConnected === false && typeof document.body !== \'undefined\' && document.body !== null) {\n'
          + '    document.body.prepend(state.sprite)\n'
          + '  }\n'
          + '  const shared = state\n'
          + '  const release = (): void => {\n'
          + '    shared.refs -= 1\n'
          + '    if (shared.refs > 0) return\n'
          + '    shared.sprite.remove()\n'
          + '    if (host[CHAMBER_PAGE_ICON_SPRITE] === shared) delete host[CHAMBER_PAGE_ICON_SPRITE]\n'
          + '  }\n'
          + '  return { state: shared, release }\n'
          + '}\n'
          + '\n'
          + '/**\n'
          + ' * Mount the page-global sprite and keep each symbol on the active theme\'s\n'
          + ' * replacement or the ui-primitives default; disposal releases this owner\'s\n'
          + ' * share and removes the sprite only when it was the last owner.\n'
          + ' * @param ctx - owning plugin context; `theme/change` snapshots drive updates.\n'
          + ' * @param icons - replacements of the theme active at install time.\n'
          + ' */\n'
          + 'export function installIconSprite(ctx: Context, icons: IconReplacements | undefined): void {\n'
          + '  if (typeof document === \'undefined\') return\n'
          + '  const page = acquirePageSprite()\n'
          + '  const apply = (replacements: IconReplacements = {}): void => {\n'
          + '    for (const [id, fallback] of Object.entries(ICON_SYMBOLS) as [IconSymbolId, string][]) {\n'
          + '      const markup = replacements[id] ?? fallback\n'
          + '      if (page.state.markups.get(id) === markup) continue\n'
          + '      const symbol = toSymbol(id, markup)\n'
          + '      const previous = page.state.rendered.get(id)\n'
          + '      if (previous === undefined) page.state.sprite.append(symbol)\n'
          + '      else previous.replaceWith(symbol)\n'
          + '      page.state.rendered.set(id, symbol)\n'
          + '      page.state.markups.set(id, markup)\n'
          + '    }\n'
          + '  }\n'
          + '  apply(icons)\n'
          + '  ctx.effect(() => {\n'
          + '    if (page.state.refs === 0) document.body.prepend(page.state.sprite)\n'
          + '    page.state.refs += 1\n'
          + '    return page.release\n'
          + '  }, \'ui-theme: icon sprite\')\n'
          + '  ctx.on(\'theme/change\', (snapshot) => { apply(snapshot.active.icons) })\n'
          + '}',
      }),
    ]),
  }),
  Object.freeze({
    idSuffixes: Object.freeze([
      'dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts',
      'packages/client/ui-chat/src/client/chat/use-chat-viewport.ts',
    ]),
    retireCheck: Object.freeze({
      probes: Object.freeze([
        Object.freeze({
          // Upstream carries the fix when the onScroll HANDLER ITSELF coalesces delivery (rAF / a
          // flush helper / microtask). The probe anchors to the handler declaration and stops at
          // the handler's own closing brace: a bare `onScroll` hit (the addEventListener call site
          // is the first one in this file) followed by a fixed-size window would read unrelated
          // frame code in ANOTHER method as the upstream fix the moment pin drift moves the two
          // into that window - a pure anchor drift must stay a drift, not a bogus release-blocking
          // retire-candidate (P2-3). `\n  }` is the class-method terminator at its 2-space indent;
          // nested blocks close at 4+ spaces, so it cannot stop early.
          match: Object.freeze([
            /private readonly onScroll = \(event: Event\): void => \{(?:(?!\n  \})[\s\S])*?(?:requestAnimationFrame|flushScroll|queueMicrotask)/,
          ]),
        }),
      ]),
      note: 'Upstream batches scroll delivery to one geometry read per frame (the onScroll handler itself coalesces via rAF/flush/microtask). Delete this entry + its artifact marker, move the coalesced-delivery shape into RETIRED_PATCHES, and keep the A/B evidence with the release note.',
    }),
    vendorFile: 'dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts',
    reason: 'SECOND ADMITTED CLASS (measured shell frame cost) - ADMISSION PENDING: the same-machine macOS A/B this class requires has NOT been executed yet; the protocol (patched vs unpatched build, same machine/session, 10 s of scrolling, renderer+GPU process CPU cumulative delta, layout counts from the Web Inspector timeline) is part of the class policy in design 09 §3.6 and must be recorded in this entry before the release that carries it; instrument = the shipping Swift leg (Activity Monitor / ps cpu + Web Inspector Layout counts), since the Electron leg that named app.getAppMetrics is frozen and not shipped. Measured symptom from the shipped WKWebView shell: the scroll listener synchronously reads geometry (use-chat-viewport.ts onScroll: scroller.scrollTop for the landing-echo check, then readScroll -> scrollMetrics: clientHeight/scrollTop/scrollHeight), and the shell trace shows that read forcing Document::updateLayout -> full re-layout of the 160-level Flex transcript, once per scroll event while streaming content keeps the layout dirty. This edit coalesces scroll deliveries to ONE geometry read per animation frame (the read then happens on the frame the paint already needs, not per event) and keeps delivery ahead of scrollend by flushing the pending frame synchronously in onScrollEnd. Follow semantics are unchanged: the coalesced delivery is the same readScroll result (FOLLOW_THRESHOLD 24 px, animating/scrollend settle, movedByReader attribution, jump/toBottom all stay in use-scroll-follow.ts); accepted trade-offs are a delivery that can arrive one frame later than the event and geometry read at that frame rather than at event time; the landing-echo suppression still skips the flush. Fallback: when requestAnimationFrame is unavailable the handler flushes synchronously (upstream behaviour). Delete this entry once upstream batches scroll delivery itself (see retireCheck).',
    edits: Object.freeze([
      Object.freeze({
        expect: '  /** Discards a closing measurement that no size observation consumed by the end of its frame. */\n'
          + '  private closingFrame: number | null = null',
        replace: '  /** Discards a closing measurement that no size observation consumed by the end of its frame. */\n'
          + '  private closingFrame: number | null = null\n'
          + '  /** Coalesced scroll delivery waiting for the next frame (chamber patch; see onScroll). */\n'
          + '  private scrollFrame: number | null = null',
      }),
      Object.freeze({
        expect: '    this.observer?.disconnect()\n'
          + '    this.observer = null\n'
          + '    this.elements = null',
        replace: '    this.observer?.disconnect()\n'
          + '    this.observer = null\n'
          + '    // chamber patch: a coalesced scroll delivery must not run after detach.\n'
          + '    if (this.scrollFrame !== null && typeof cancelAnimationFrame === \'function\') cancelAnimationFrame(this.scrollFrame)\n'
          + '    this.scrollFrame = null\n'
          + '    this.elements = null',
      }),
      Object.freeze({
        expect: '  private readonly onScroll = (event: Event): void => {\n'
          + '    if (this.elements === null || event.target !== this.elements.scroller) return\n'
          + '    if (this.observation.landing !== null && this.elements.scroller.scrollTop === this.observation.top) return\n'
          + '    this.invalidate()\n'
          + '    if (this.paging !== null) {\n'
          + '      this.events?.resize()\n'
          + '      return\n'
          + '    }\n'
          + '    const scroll = this.readScroll()\n'
          + '    if (scroll !== null) this.events?.scroll(scroll)\n'
          + '  }',
        replace: '  private readonly onScroll = (event: Event): void => {\n'
          + '    if (this.elements === null || event.target !== this.elements.scroller) return\n'
          + '    // chamber patch: a scroll event can arrive while the transcript layout is dirty\n'
          + '    // (streaming content mutated in the same frame), so the synchronous geometry read\n'
          + '    // below forces Document::updateLayout once PER EVENT. Coalesce delivery to one read\n'
          + '    // per frame; follow policy is unchanged because the read then happens on the frame\n'
          + '    // the paint already needs, and onScrollEnd flushes the pending delivery first.\n'
          + '    if (typeof requestAnimationFrame !== \'function\' || typeof cancelAnimationFrame !== \'function\') {\n'
          + '      this.flushScroll()\n'
          + '      return\n'
          + '    }\n'
          + '    if (this.scrollFrame === null) {\n'
          + '      this.scrollFrame = requestAnimationFrame(() => {\n'
          + '        this.scrollFrame = null\n'
          + '        this.flushScroll()\n'
          + '      })\n'
          + '    }\n'
          + '  }\n'
          + '\n'
          + '  /** Deliver the frame\'s coalesced scroll from one geometry read (chamber patch). */\n'
          + '  private flushScroll(): void {\n'
          + '    if (this.elements === null) return\n'
          + '    if (this.observation.landing !== null && this.elements.scroller.scrollTop === this.observation.top) return\n'
          + '    this.invalidate()\n'
          + '    if (this.paging !== null) {\n'
          + '      this.events?.resize()\n'
          + '      return\n'
          + '    }\n'
          + '    const scroll = this.readScroll()\n'
          + '    if (scroll !== null) this.events?.scroll(scroll)\n'
          + '  }',
      }),
      Object.freeze({
        expect: '    if (event.target === this.elements?.scroller) {\n'
          + '      this.events?.scrollEnd(true)',
        replace: '    if (event.target === this.elements?.scroller) {\n'
          + '      // chamber patch: deliver the frame\'s coalesced scroll before scrollend, so the\n'
          + '      // settle sees the scroll-then-scrollend order the unbatched handler had.\n'
          + '      if (this.scrollFrame !== null) {\n'
          + '        if (typeof cancelAnimationFrame === \'function\') cancelAnimationFrame(this.scrollFrame)\n'
          + '        this.scrollFrame = null\n'
          + '        this.flushScroll()\n'
          + '      }\n'
          + '      this.events?.scrollEnd(true)',
      }),
    ]),
  }),

])

/** Normalize a module id: drop vite query/hash and force POSIX separators. */
function normalizeId(id) {
  return String(id).split('?')[0].split('#')[0].replaceAll('\\', '/')
}

/* ------------------------------------------------------------------------- *
 * Patched-code sourcemap
 * ------------------------------------------------------------------------- *
 * The transform is a text REWRITER: it moves lines. A transform that returns
 * `{ code }` without a map makes rollup push a `missing` map into the module's
 * chain, log SOURCEMAP_BROKEN ("Sourcemap is likely to be incorrect: a plugin
 * (dsh-chamber-deepseek-source) was used to transform files …") and drop the
 * module from EVERY emitted .map — a stack frame in a patched file then resolves
 * to the minified bundle position instead of the pinned source. rollup's escape
 * hatch `map: null` means "the transformation did not move code", which is false
 * here, so the map is generated while the edits are applied:
 *  - untouched spans map offset-for-offset (exact line AND column);
 *  - inside a rewritten anchor the lines are aligned with an LCS, so an inserted
 *    or deleted region keeps the surviving lines on their own lines and an
 *    inserted line inherits the previous match;
 *  - `sourcesContent` is the UNPATCHED source (what every position came from),
 *    which is also what makes a patched module readable in devtools.
 * The artifact side is fenced by verify-vendor-patch-applied.mjs: every
 * registered vendor file must appear in an emitted .map with content and at
 * least one mapping, so dropping the map fails `build:renderer` instead of only
 * printing a SOURCEMAP_BROKEN warning per patched module. Design reference:
 * 09 §3.6.
 */

/**
 * A current-text span plus the original span it came from. An unchanged segment
 * has equal lengths and maps offset-for-offset; a rewritten segment carries the
 * anchor it replaced.
 * @typedef {object} PatchSegment
 * @property {number} curStart Offset in the rewritten text (inclusive).
 * @property {number} curEnd Offset in the rewritten text (exclusive).
 * @property {number} origStart Offset in the pinned source (inclusive).
 * @property {number} origEnd Offset in the pinned source (exclusive).
 * @property {boolean} changed Whether an edit rewrote this span.
 */

/** VLQ base64 alphabet of the sourcemap v3 specification. */
const BASE64_VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * @param {number} value
 * @returns {string} one base64-VLQ field.
 */
function encodeVlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let encoded = ''
  do {
    let digit = rest & 31
    rest >>>= 5
    if (rest > 0) digit |= 32
    encoded += BASE64_VLQ[digit]
  } while (rest > 0)
  return encoded
}

/**
 * @param {string} text
 * @returns {number[]} the offset of every line start.
 */
function lineStartOffsets(text) {
  const starts = [0]
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text.charCodeAt(offset) === 10) starts.push(offset + 1)
  }
  return starts
}

/**
 * @param {number[]} starts
 * @param {number} offset
 * @returns {number} the line index containing the offset.
 */
function lineIndexOf(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * @param {string} text
 * @param {number[]} starts
 * @param {number} line
 * @returns {string} the line text without its terminator.
 */
function lineText(text, starts, line) {
  const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length
  return text.slice(starts[line], end).replace(/\r$/u, '')
}

/**
 * Split the segment list so the offset becomes a segment boundary. A rewritten
 * span is split proportionally: its mapping is approximate by construction.
 * @param {PatchSegment[]} segments
 * @param {number} offset
 * @returns {number} index of the segment that starts at the offset.
 */
function splitSegmentAt(segments, offset) {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (offset === segment.curStart) return index
    if (offset > segment.curStart && offset < segment.curEnd) {
      const ratio = (offset - segment.curStart) / (segment.curEnd - segment.curStart)
      const origSplit = segment.origStart + Math.round(ratio * (segment.origEnd - segment.origStart))
      segments.splice(index, 1,
        { ...segment, curEnd: offset, origEnd: origSplit },
        { ...segment, curStart: offset, origStart: origSplit })
      return index + 1
    }
  }
  return segments.length
}

/**
 * Record one applied edit: the span it replaced becomes a rewritten segment and
 * every later segment shifts by the length delta.
 * A span the edit's own anchor covers cannot be rewritten twice: no registered
 * patch anchors into text an earlier edit of the same file produced, so the
 * proportional split below is defensive (it keeps the map monotone and in range
 * if that ever changes, at the cost of precision inside that span).
 * @param {PatchSegment[]} segments
 * @param {number} at Current-text offset of the anchor.
 * @param {number} expectedLength Anchor length.
 * @param {number} replacementLength Replacement length.
 * @returns {PatchSegment[]}
 */
function replaceSegment(segments, at, expectedLength, replacementLength) {
  const first = splitSegmentAt(segments, at)
  const after = splitSegmentAt(segments, at + expectedLength)
  const origStart = segments[first].origStart
  const origEnd = segments[Math.max(first, after - 1)].origEnd
  const delta = replacementLength - expectedLength
  const tail = segments.slice(after).map((segment) => ({
    ...segment,
    curStart: segment.curStart + delta,
    curEnd: segment.curEnd + delta,
  }))
  return [
    ...segments.slice(0, first),
    { curStart: at, curEnd: at + replacementLength, origStart, origEnd, changed: true },
    ...tail,
  ]
}

/**
 * Align the lines of a rewritten span with the lines it came from: a surviving
 * line keeps its own upstream line, an inserted line inherits the last match
 * (never a line past the anchor).
 * @param {string} original
 * @param {string} patched
 * @param {PatchSegment} segment
 * @param {number[]} originalStarts
 * @param {number[]} patchedStarts
 * @returns {Map<number, number>} absolute generated line -> absolute upstream line.
 */
function alignRewrittenLines(original, patched, segment, originalStarts, patchedStarts) {
  const generatedFirst = lineIndexOf(patchedStarts, segment.curStart)
  const generatedLast = lineIndexOf(patchedStarts, Math.max(segment.curStart, segment.curEnd - 1))
  const sourceFirst = lineIndexOf(originalStarts, segment.origStart)
  const sourceLast = lineIndexOf(originalStarts, Math.max(segment.origStart, segment.origEnd - 1))
  const generatedLines = []
  for (let line = generatedFirst; line <= generatedLast; line += 1) {
    generatedLines.push(lineText(patched, patchedStarts, line))
  }
  const sourceLines = []
  for (let line = sourceFirst; line <= sourceLast; line += 1) {
    sourceLines.push(lineText(original, originalStarts, line))
  }
  // Longest common subsequence over the two line lists. Spans are one anchor plus
  // its replacement (tens of lines), so the quadratic table stays cheap.
  const rows = sourceLines.length
  const columns = generatedLines.length
  const common = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1))
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      common[row][column] = sourceLines[row] === generatedLines[column]
        ? common[row + 1][column + 1] + 1
        : Math.max(common[row + 1][column], common[row][column + 1])
    }
  }
  const matched = new Array(columns).fill(-1)
  for (let row = 0, column = 0; row < rows && column < columns;) {
    if (sourceLines[row] === generatedLines[column]) {
      matched[column] = row
      row += 1
      column += 1
    } else if (common[row + 1][column] >= common[row][column + 1]) {
      row += 1
    } else {
      column += 1
    }
  }
  const aligned = new Map()
  let sourceLine = sourceFirst
  for (let index = 0; index < columns; index += 1) {
    if (matched[index] !== -1) sourceLine = sourceFirst + matched[index]
    aligned.set(generatedFirst + index, sourceLine)
  }
  return aligned
}

/**
 * A v3 sourcemap with one source: the rewritten module.
 * @typedef {object} PatchSourcemap
 * @property {number} version
 * @property {string[]} sources
 * @property {string[]} sourcesContent
 * @property {string[]} names
 * @property {string} mappings
 */

/**
 * Build the v3 sourcemap for a rewritten module: `sources[0]` is the module id
 * (rollup resolves it against the module's own directory) and `sourcesContent[0]`
 * is the pinned upstream source.
 * @param {string} id Normalized module id.
 * @param {string} original Pinned upstream source.
 * @param {string} patched Rewritten source.
 * @param {readonly PatchSegment[]} segments
 * @returns {PatchSourcemap}
 */
function buildPatchSourcemap(id, original, patched, segments) {
  const originalStarts = lineStartOffsets(original)
  const patchedStarts = lineStartOffsets(patched)
  /** @type {{ line: number, column: number, sourceLine: number, sourceColumn: number }[]} */
  const mappings = []
  /**
   * @param {number} offset
   * @param {number} sourceOffset
   */
  const add = (offset, sourceOffset) => {
    const line = lineIndexOf(patchedStarts, offset)
    const sourceLine = lineIndexOf(originalStarts, sourceOffset)
    mappings.push({
      line,
      column: offset - patchedStarts[line],
      sourceLine,
      sourceColumn: sourceOffset - originalStarts[sourceLine],
    })
  }
  for (const segment of segments) {
    // A pure deletion has no generated text to map (the following segment maps
    // the position that closed the gap).
    if (segment.curEnd <= segment.curStart) continue
    const firstLine = lineIndexOf(patchedStarts, segment.curStart) + 1
    const lastLine = lineIndexOf(patchedStarts, segment.curEnd - 1)
    if (segment.changed) {
      const aligned = alignRewrittenLines(original, patched, segment, originalStarts, patchedStarts)
      const fallback = lineIndexOf(originalStarts, segment.origStart)
      add(segment.curStart, segment.origStart)
      for (let line = firstLine; line <= lastLine; line += 1) {
        add(patchedStarts[line], originalStarts[aligned.get(line) ?? fallback])
      }
      continue
    }
    add(segment.curStart, segment.origStart)
    for (let line = firstLine; line <= lastLine; line += 1) {
      add(patchedStarts[line], segment.origStart + (patchedStarts[line] - segment.curStart))
    }
  }
  const encodedLines = []
  let line = 0
  let column = 0
  let sourceLine = 0
  let sourceColumn = 0
  let current = []
  for (const mapping of mappings) {
    while (line < mapping.line) {
      encodedLines.push(current.join(','))
      current = []
      line += 1
      column = 0
    }
    current.push(
      encodeVlq(mapping.column - column)
      + encodeVlq(0)
      + encodeVlq(mapping.sourceLine - sourceLine)
      + encodeVlq(mapping.sourceColumn - sourceColumn),
    )
    column = mapping.column
    sourceLine = mapping.sourceLine
    sourceColumn = mapping.sourceColumn
  }
  encodedLines.push(current.join(','))
  return {
    version: 3,
    sources: [id],
    sourcesContent: [original],
    names: [],
    mappings: encodedLines.join(';'),
  }
}

/**
 * Decode a v3 sourcemap's encoded mappings into per-generated-line segments:
 * `[generatedColumn]` or `[generatedColumn, sourceIndex, sourceLine, sourceColumn]`.
 * @param {string} mappings
 * @returns {number[][][]}
 */
export function decodeSourcemapMappings(mappings) {
  const lines = []
  let line = []
  let offset = 0
  let generatedColumn = 0
  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  /** @returns {number} one VLQ field. */
  const nextValue = () => {
    let shift = 0
    let value = 0
    let digit
    do {
      digit = BASE64_VLQ.indexOf(mappings[offset])
      offset += 1
      if (digit === -1) throw new Error(`invalid sourcemap VLQ character: ${mappings[offset - 1]}`)
      value += (digit & 31) << shift
      shift += 5
    } while (digit & 32)
    const negative = (value & 1) === 1
    value >>>= 1
    return negative ? -value : value
  }
  while (offset < mappings.length) {
    const character = mappings[offset]
    if (character === ';') {
      lines.push(line)
      line = []
      generatedColumn = 0
      offset += 1
      continue
    }
    if (character === ',') {
      offset += 1
      continue
    }
    generatedColumn += nextValue()
    if (offset >= mappings.length || mappings[offset] === ',' || mappings[offset] === ';') {
      line.push([generatedColumn])
      continue
    }
    sourceIndex += nextValue()
    sourceLine += nextValue()
    sourceColumn += nextValue()
    line.push([generatedColumn, sourceIndex, sourceLine, sourceColumn])
    // An optional fifth field carries the name index (minifiers emit it); it is
    // consumed so the next segment is not read out of phase, then dropped.
    if (offset < mappings.length && mappings[offset] !== ',' && mappings[offset] !== ';') nextValue()
  }
  lines.push(line)
  return lines
}

/**
 * Count mappings per source index WITHOUT materialising the decoded lines: the
 * artifact gate scans multi-megabyte bundle maps where a full decode is wasteful.
 * @param {string} mappings
 * @returns {Map<number, number>} source index -> number of mapping segments.
 */
export function countSourcemapSegments(mappings) {
  const counts = new Map()
  let offset = 0
  let generatedColumn = 0
  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  /** @returns {number} one VLQ field. */
  const nextValue = () => {
    let shift = 0
    let value = 0
    let digit
    do {
      digit = BASE64_VLQ.indexOf(mappings[offset])
      offset += 1
      if (digit === -1) throw new Error(`invalid sourcemap VLQ character: ${mappings[offset - 1]}`)
      value += (digit & 31) << shift
      shift += 5
    } while (digit & 32)
    const negative = (value & 1) === 1
    value >>>= 1
    return negative ? -value : value
  }
  while (offset < mappings.length) {
    const character = mappings[offset]
    if (character === ';') {
      generatedColumn = 0
      offset += 1
      continue
    }
    if (character === ',') {
      offset += 1
      continue
    }
    generatedColumn += nextValue()
    if (offset < mappings.length && mappings[offset] !== ',' && mappings[offset] !== ';') {
      sourceIndex += nextValue()
      sourceLine += nextValue()
      sourceColumn += nextValue()
      counts.set(sourceIndex, (counts.get(sourceIndex) ?? 0) + 1)
      // Optional name field (see decodeSourcemapMappings): consumed, not counted.
      if (offset < mappings.length && mappings[offset] !== ',' && mappings[offset] !== ';') nextValue()
    }
  }
  return counts
}

/**
 * Apply every patch that selects this module id.
 * @param {string} id - the module id vite reports.
 * @param {string} code - the module source.
 * @returns {{ code: string, applied: string[], map: PatchSourcemap } | undefined} undefined when no patch matches.
 */
export function applyVendorPatches(id, code) {
  const normalized = normalizeId(id)
  /** @type {PatchSegment[]} */
  let segments = [{ curStart: 0, curEnd: code.length, origStart: 0, origEnd: code.length, changed: false }]
  let next = code
  const applied = []
  for (const patch of VENDOR_PATCHES) {
    if (!patch.idSuffixes.some(suffix => normalized.endsWith(suffix))) continue
    for (const [index, edit] of patch.edits.entries()) {
      const hits = next.split(edit.expect).length - 1
      if (hits !== 1) {
        throw new Error(
          `vendor patch ${patch.vendorFile} edit#${index}: anchor matched ${hits} times (expected exactly 1). `
          + `The pinned upstream text changed — re-derive the patch against the new pin. Reason: ${patch.reason} `
          + `Anchor: ${JSON.stringify(edit.expect.slice(0, 160))}`,
        )
      }
      const at = next.indexOf(edit.expect)
      segments = replaceSegment(segments, at, edit.expect.length, edit.replace.length)
      next = next.slice(0, at) + edit.replace + next.slice(at + edit.expect.length)
    }
    applied.push(patch.vendorFile)
  }
  if (applied.length === 0) return undefined
  return { code: next, applied, map: buildPatchSourcemap(normalized, code, next, segments) }
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
 * Evaluate one entry's `retireCheck` against the pinned (unpatched) tree, exposed
 * for the live-probe fence in vendor-patches.test.mjs. C9 only evaluates
 * `retireCheck` after an anchor has drifted, so a probe that already matches the
 * CURRENT pin (a tautology, or an upstream fix that arrived without moving our
 * anchors) would otherwise stay invisible until it is reported with the wrong
 * remediation. A hit here is C9's retire-candidate phase: retire the entry, move
 * the upstream shape into RETIRED_PATCHES and delete its artifact marker.
 * @param {VendorPatch} patch - entry that declares `retireCheck`.
 * @param {string} [vendorRoot] - override for tests.
 * @returns {{ ok: boolean, detail: string }}
 */
export function probeVendorPatchRetirement(patch, vendorRoot = VENDOR_ROOT) {
  if (patch.retireCheck === undefined) throw new Error(`${patch.vendorFile}: no retireCheck to probe`)
  return retireCheckVerdict(patch, vendorRoot, new Map())
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
        detail = `edit#${index}: anchor matched ${hits} times (expected 1) — anchor ${JSON.stringify(edit.expect.slice(0, 160))}`
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
