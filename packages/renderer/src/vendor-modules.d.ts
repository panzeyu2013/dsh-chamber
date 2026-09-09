/**
 * Ambient typing for the dsh workspace packages the renderer bundles
 * (design 05 §2: workspace source compiled by vite via resolve aliases, see
 * vite.config.mjs). The vendor packages are excluded from the repository
 * typecheck (root tsconfig excludes vendor/), and their built type outputs do
 * not exist in the source-only vendor tree, so each specifier the renderer
 * imports is declared loosely here. The chamber-owned copies
 * (dsh-client-connection / dsh-client-web / dsh-chamber-client-ui-sidebar) are
 * typechecked by their own package projects; the renderer still consumes
 * their named types loosely here (cordis Context, AppWebEntry, chamber
 * bridge).
 */

declare module '@deepseek-ai/cordis' {
  /** Loose minimal shape, mirroring the cordis src/context.ts interface+class merge. */
  interface Context {
    plugin(...args: any[]): this
    inject(...args: any[]): this
    on(...args: any[]): this
    emit(...args: any[]): unknown
    get(...args: any[]): unknown
    provide(...args: any[]): unknown
    /** Cordis effect scope: the callback's returned disposer runs on fiber teardown. */
    effect(fn: () => (() => void) | void, label?: string): void
    /**
     * chamber v1: per-instance sessions runtime face (loose mirror of ISessions
     * from @deepseek-ai/dsh-api-session-controller/client — the dsh-v0.1.2-alpha.1
     * home of ctx.sessions; the old dsh-client-runtime face is gone). The
     * `list.byId` / `open` surface shell.ts's dispatchOpen relies on is
     * preserved by the new ISessions contract.
     */
    sessions: {
      open(id: string): void
      list: { getSnapshot(): { byId?: Record<string, unknown> } }
    }
  }
  class Context {
    constructor()
    static is(value: unknown): value is Context
  }
}

declare module '@deepseek-ai/dsh-client-web' {
  /** Module transport hook (boot.ts BootSeams, Pick<ClientModuleCreateOptions, 'loadBundle'>). */
  export interface BootSeams {
    loadBundle?: (url: string) => Promise<void>
  }
  /**
   * chamber patch (05 §3.6 / design 09): mirror of boot.ts AppWebEntryOptions —
   * per-instance extra host-graph client-plugin rows (bundles pre-loaded by
   * the chamber shell; ids only merged into the boot rows here). dsh-v0.1.2-alpha.1
   * BootModuleRow alignment: the required `initialUrl` (the preloaded combo
   * url — the chamber merge preloads each entry's own combo, so it equals the
   * row url) and `inject` (empty — the composite covers the whole official
   * shell, extras have no inject edges to arrive).
   */
  export interface AppWebEntryOptions extends BootSeams {
    extraRows?: { id: string; url: string; initialUrl: string; rev: string; inject: string[] }[]
    /** Per-entry context initializer; called before loader/plugin materialization. */
    configureContext?: (ctx: Context) => void
  }
  /**
   * chamber patch (2026-08 first-boot race fix, 05 §4): install-or-reuse the
   * page-level module system (window.__DSH_MODULES__ + the __ModuleLoader__
   * registration sink). shell.ts calls this BEFORE preloading any host-graph
   * bundle so the extra bundles' scripts always evaluate against an installed
   * sink; idempotent, run() adopts the same instance.
   *
   * C3 (2026-09 性能审计): the return face mirrors the slice shell.ts now
   * consumes — `manifest` (the parsed boot graph rows) and `prefetch(id)` (the
   * kernel's immediately-tier preload path, module-cache deduped). Single
   * source of truth for the shape: packages/dsh-client-web/src/boot.ts
   * (ensureWebModuleSystem / prefetchImmediateTier). Drift watch: this ambient
   * shadows the real package types, so a signature change on the real
   * ClientModuleSystem is NOT caught by tsc — keep the mirror in lockstep
   * with the copy's boot.ts and the test fixture
   * (test-fixtures/dsh-client-web.mjs / .d.mts).
   */
  export function ensureWebModuleSystem(seams?: BootSeams): {
    manifest: { plugins: ReadonlyArray<{ id: string; immediately?: boolean }> }
    prefetch(id: string): Promise<void>
  }
  /** The web shell kernel consumed by shell.ts (boot.ts). */
  export class AppWebEntry {
    constructor(el: HTMLElement, options?: AppWebEntryOptions)
    run(): Promise<unknown>
    dispose(): Promise<void>
    /** chamber patch: settled runtime context (boot.ts accessor; session opens ride ctx.sessions; undefined after dispose). */
    runtimeCtx: Context | undefined
    /** chamber patch (2026-08, 05 §4 失败呈现修订): boot failure report — run() resolves on boot-chain failures by design (the dsh loading page renders the in-shell report), but the chamber shell must see it to present its own per-instance fallback; undefined while loading or after a clean settle. */
    bootError: string | undefined
  }
}

declare module '@deepseek-ai/dsh-client-connection/client'
// dsh-v0.1.2-alpha.1 provider group (dsh-client-runtime deleted): the store is
// a plain module (the platform store word — imported BARE, no /client
// subpath; registered as a module-table covered factory by chamber-entry, not
// a cordis plugin), the api controllers (ctx.sessions / ctx.workspaces) and
// the ui-session / ui-chat / ui-approval conversation families are first-screen
// plugins (chamber-entry.ts import list + COVERED_FACTORIES).
declare module '@deepseek-ai/dsh-client-store'
// C3 (2026-09 性能审计): the ui-primitives platform word imported BARE by
// chamber-entry.ts (covered factory, never ctx.plugin — see the seed.ts /
// platform.ts deviation notes in dsh-client-web).
declare module '@deepseek-ai/dsh-client-ui-primitives'
// alpha.2: the docking-kit platform word the composite answers with a
// covered factory (pure library — no cordis plugin, no ./client export).
declare module '@deepseek-ai/dsh-client-ui-dockkit'
declare module '@deepseek-ai/dsh-api-session-controller/client'
declare module '@deepseek-ai/dsh-api-workspace-controller/client'
declare module '@deepseek-ai/dsh-client-locale/client'
declare module '@deepseek-ai/dsh-client-modules/client'
declare module '@deepseek-ai/dsh-typert-registry/client'
declare module '@deepseek-ai/dsh-api-gateway/client'
declare module '@deepseek-ai/dsh-api-remotes/client'

declare module '@deepseek-ai/dsh-client-ui-agent-preset/client'
// 2026-09 三轮: covered so the registered vendor patch can carry the per-entry
// base path on the upload URL (the host half stays an instance host row).
declare module '@deepseek-ai/dsh-client-file-upload/client'
declare module '@deepseek-ai/dsh-client-ui-approval/client'
// rc.8 deferred-family client entries (design 09 §4; chamber-entry.ts
// registerDeferred dynamic imports): attachment (composer + message-image
// slot fills), brand-official (official brand occupants — gated on the
// 'official' build profile, a no-op in the chamber build), reference (the
// unified `@` input-trigger source).
declare module '@deepseek-ai/dsh-client-ui-attachment/client'
declare module '@deepseek-ai/dsh-client-ui-brand-official/client'
// dsh-v0.1.2-alpha.1 first-screen conversation families (decision D6): ui-chat
// owns the conversation.view + chat-node rendering, ui-session the sessions
// root source + scope adapter (chamber-entry.ts static imports).
declare module '@deepseek-ai/dsh-client-ui-chat/client'
declare module '@deepseek-ai/dsh-client-ui-commands/client'
declare module '@deepseek-ai/dsh-client-ui-conversation/client'
declare module '@deepseek-ai/dsh-client-ui-deliverables/client'
declare module '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'
declare module '@deepseek-ai/dsh-client-ui-goal/client'
declare module '@deepseek-ai/dsh-client-ui-input-trigger/client'
declare module '@deepseek-ai/dsh-client-ui-jobs/client'
declare module '@deepseek-ai/dsh-client-ui-layout/client'
declare module '@deepseek-ai/dsh-client-ui-message-feedback/client'
declare module '@deepseek-ai/dsh-client-ui-model-selection/client'
declare module '@deepseek-ai/dsh-client-ui-permission-presets/client'
declare module '@deepseek-ai/dsh-client-ui-plan/client'
// rc.8 page-own (design 09 §4): ui-renderer is adopted by the shell kernel
// (the boot mounts through its ctx.uiRenderer) — chamber-entry never imports
// it; declared for the ambient surface only.
declare module '@deepseek-ai/dsh-client-ui-reference/client'
declare module '@deepseek-ai/dsh-client-ui-renderer/client'
declare module '@deepseek-ai/dsh-client-ui-settings/client'
declare module '@deepseek-ai/dsh-client-ui-settings-general/client'
declare module '@deepseek-ai/dsh-client-ui-settings-models/client'
declare module '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client'
declare module '@deepseek-ai/dsh-client-ui-session/client'
declare module '@deepseek-ai/dsh-client-ui-sidebar/client'
declare module '@deepseek-ai/dsh-client-ui-skill/client'
declare module '@deepseek-ai/dsh-client-ui-subagent/client'
declare module '@deepseek-ai/dsh-client-ui-theme/client'
declare module '@deepseek-ai/dsh-client-ui-tool/client'
declare module '@deepseek-ai/dsh-client-ui-trajectory/client'
declare module '@deepseek-ai/dsh-client-ui-user-questions/client'
declare module '@deepseek-ai/dsh-client-ui-workflow-run/client'
declare module '@deepseek-ai/dsh-client-ui-workspace/client'

/**
 * The chamber self-built sidebar plugin (packages/dsh-chamber-client-ui-sidebar, 05
 * §2): registers the layout 'sidebar' slot shell whose region renders the
 * multi-source session list. The renderer only plugs it into the per-instance
 * boot graph; loose face.
 */
declare module '@dsh-chamber/dsh-chamber-client-ui-sidebar/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/** Chamber Git worktree sidebar occupant (design 08). */
declare module '@dsh-chamber/dsh-chamber-client-ui-git/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/** Chamber open-in header button (design 16 + open-in extension). */
declare module '@dsh-chamber/dsh-chamber-client-ui-open-in/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber-owned ui-layout fork (packages/dsh-chamber-client-ui-layout,
 * design 06): replaces the official layout's 'root' registration so the
 * sidebar width preference is shared across every shell boot and persisted.
 * The renderer only plugs it into the per-instance boot graph; loose face.
 */
declare module '@dsh-chamber/dsh-chamber-client-ui-layout/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber self-built connections settings section plugin
 * (packages/dsh-chamber-client-ui-settings-connections, 05 §5): registers the
 * 'settings.section' entry id 'connections' — local instance card + remote
 * host management. The renderer only plugs it into the per-instance boot
 * graph; loose face.
 */
declare module '@dsh-chamber/dsh-chamber-client-ui-settings-connections/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber self-built settings shell plugin
 * (packages/dsh-chamber-client-ui-settings-bridge): registers the 'sidebar.settings'
 * entry id 'chamber-shell' at priority -1, shadowing the official
 * SettingsRoot — a server dropdown over the selected instance's official
 * settings sections, plus the fixed chamber-global connections entry. The
 * renderer only plugs it into the per-instance boot graph; loose face.
 */
declare module '@dsh-chamber/dsh-chamber-client-ui-settings-bridge/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}


/** Stock web-profile fallback knob retained by dsh-client-connection. Chamber
 * N-ctx passes an explicit per-entry basePath and does not write this global. */
declare global {
  interface Window {
    __DSH_BASE_PATH__?: string
  }
}
