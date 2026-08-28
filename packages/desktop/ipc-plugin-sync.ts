/**
 * Remote/local plugin management wiring (design 13 M2+M3, split from main.ts
 * — A1): the plugin IPC surface (remote plugin list/apply, local plugin
 * list/add/remove, npm search), the chamber host-package ready-time seed
 * (design 09 module A + 08), the pack-and-transfer materialize channels and
 * the main-process confirmation dialogs. The orchestration logic lives in
 * plugin-sync.ts (pure, contract A/B); the electron dialogs, the transport
 * adapter closures and the IPC handlers live here.
 *
 * The ready-time seed listener is registered on the transport manager's
 * status bus alongside ipc-ssh.ts's listener (register order: ssh first —
 * its register/push listener, then this seed listener).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { TrustedIpc } from './renderer-trust.ts'
import type { TransportManager } from './transport-manager.ts'
import { probeClientGraphLive, probeGitWorktreeLive } from './ssh-provider.ts'
import {
  applyPlugins,
  CLIENT_GRAPH_INSERT_ID,
  CLIENT_GRAPH_PACKAGE_NAME,
  describeLocalPluginAddConfirmation,
  describeLocalPluginRemoveConfirmation,
  describeMaterializeConfirmation,
  describePluginApplyConfirmation,
  describeSeedConfirmation,
  disposePluginSyncChildren,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
  localPluginList,
  isMaterializeSpec,
  materializeAndAdd,
  redactLocalPluginManifest,
  remoteHome,
  remotePluginList,
  resolveLocalMaterializeDirectory,
  runLocalDshPlugin,
  seedRemoteChamberHostPackages,
} from './plugin-sync.ts'
import type { ChamberHostPackageSeed, ExecFn, RemoteSpec, StatusFn } from './plugin-sync.ts'

/** Dependencies injected by main.ts at startup (whenReady assembly). */
export interface PluginSyncWiringCtx {
  trustedIpc: TrustedIpc
  transportManager: () => TransportManager | null
  mainWindow: () => BrowserWindow | null
  /** The local dsh workspace (null = not found) — local `dsh plugin` runs
   *  against it (design 13 §5.1). */
  dshWorkspace: string | null
  /** <userData> path (the authoritative local dsh home is
   *  <userData>/state/dsh-home). */
  userDataPath: string
}

export interface PluginSyncWiring {
  /** Unsubscribe ready-time seeding, terminate local pack/plugin children and
   * wait for them to exit before Electron quits. */
  disposeAsync(): Promise<void>
}

const pkgDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(pkgDir, '..', '..')

export function registerPluginSync(ctx: PluginSyncWiringCtx): PluginSyncWiring {
  const { trustedIpc, transportManager, mainWindow, dshWorkspace, userDataPath } = ctx

  // The authoritative local dsh home is <userData>/state/dsh-home (the real
  // spawn home, design 13 §2.2) — never dsh-chamber:info.dshHome.
  const localDshHome = path.join(userDataPath, 'state', 'dsh-home')
  // Host package sources for the remote seed (design 13 §4.6). Packaged
  // builds carry copies under dist/; dev reads the same source dirs used by
  // the local control-plane seed.
  const moduleASourceDir = app.isPackaged
    ? path.join(pkgDir, 'dist', 'host-graph-package')
    : path.join(repoRoot, 'packages', 'dsh-host-client-graph')
  const gitWorktreeHostSourceDir = app.isPackaged
    ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
    : path.join(repoRoot, 'packages', 'dsh-chamber-host-git-worktree')
  const chamberHostPackageSeeds: ChamberHostPackageSeed[] = [
    {
      insertId: CLIENT_GRAPH_INSERT_ID,
      packageName: CLIENT_GRAPH_PACKAGE_NAME,
      sourceDir: moduleASourceDir,
      label: 'host-graph',
    },
    {
      insertId: GIT_WORKTREE_INSERT_ID,
      packageName: GIT_WORKTREE_PACKAGE_NAME,
      sourceDir: gitWorktreeHostSourceDir,
      label: 'git-worktree',
    },
  ]

  const sm = transportManager()
  if (sm === null) return { disposeAsync: disposePluginSyncChildren }

  // Plugin-sync dependency injection (design 13 M2+M3, contract A): the
  // orchestration in plugin-sync.ts is decoupled from the transport runtime,
  // so it is adapted here onto transport-manager.exec(id, action, payload?).
  // The contract types (TransportExecAction / TransportRunPayload) are
  // SHARED from transport-provider.ts — the compiler checks this assignment
  // (no cast): plugin-sync's ExecFn is structurally the manager's exec.
  const execTransport: ExecFn = sm.exec
  const statusTransport: StatusFn = (id) => sm.status(id)
  // Live-effect probe for the chamber host-graph state (design 09 module A):
  // adapts probeClientGraphLive (ssh-provider.ts, tunnel RPC) onto
  // plugin-sync's LiveProbe shape. `readyUrl` is main-process only (never
  // the renderer); no ready tunnel → null = "not probed" (the plugin UI then
  // renders 生效状态未知 instead of a guessed claim).
  const liveProbeFor = (id: string): (() => Promise<boolean | null>) => () => {
    const url = sm.readyUrl(id)
    if (url === null) return Promise.resolve(null)
    try {
      const parsed = new URL(url)
      const port = parsed.port === '' ? null : Number(parsed.port)
      if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null)
      return probeClientGraphLive({ host: parsed.hostname, port }).then(result =>
        result === 'live' ? true : result === 'not-live' ? false : null)
    } catch {
      return Promise.resolve(null)
    }
  }
  // Live-effect probe for the SECOND chamber host package (design 08 §11):
  // same shape as liveProbeFor, hitting gitWorktree/previewCreate. A 404
  // there is deterministic "the running instance never loaded the
  // git-worktree row" — host-graph being live from an older boot does NOT
  // prove it (a ready-time seed can add the git row after that boot).
  const gitWorktreeLiveProbeFor = (id: string): (() => Promise<boolean | null>) => () => {
    const url = sm.readyUrl(id)
    if (url === null) return Promise.resolve(null)
    try {
      const parsed = new URL(url)
      const port = parsed.port === '' ? null : Number(parsed.port)
      if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null)
      return probeGitWorktreeLive({ host: parsed.hostname, port }).then(result =>
        result === 'live' ? true : result === 'not-live' ? false : null)
    } catch {
      return Promise.resolve(null)
    }
  }
  // In-flight guard for the ready-time chamber host-package seed (design 09 §6
  // 遗留 1): a Set of instance ids whose seed is currently running — pure
  // concurrency guard, not a "seeded" flag (the seed is idempotent, so
  // reconnects re-run a cheap content-hash no-op instead).
  const hostPackageSeeding = new Set<string>()
  const findRemoteSpec = (id: string): RemoteSpec | null => {
    const instance = sm.listInstances().find((entry) => entry.id === id)
    if (instance === undefined) return null
    return { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null }
  }
  // Remote install-level fallback path shared by both chamber host packages.
  const remoteHostPackageDir = (spec: RemoteSpec, packageName: string): string =>
    `${remoteHome(spec.remoteDshHome)}/profiles/node_modules/${packageName}`

  // Plugin-action confirmation (design 09 §4 v1 mitigation): the pack-and-
  // transfer / local-install / local-remove IPC channels must pass a
  // main-process dialog — a remote instance's client bundle executes in the
  // chamber page (declared trust boundary) and could otherwise drive these
  // silently. Fail closed without a window; one dialog at a time (a script
  // burst must not stack dialogs).
  type PluginConfirmResult = { ok: true } | { cancelled: true } | { ok: false; error: string }
  let pluginConfirmOpen = false
  async function confirmPluginAction(
    win: BrowserWindow | null,
    copy: { message: string; detail: string },
  ): Promise<PluginConfirmResult> {
    if (win === null || win.isDestroyed()) return { ok: false, error: 'no window for confirmation' }
    if (pluginConfirmOpen) return { ok: false, error: 'another confirmation is in progress' }
    pluginConfirmOpen = true
    try {
      // A hidden-to-tray window must not receive an invisible dialog — show
      // it first so the confirmation is a real user action.
      if (!win.isVisible()) win.show()
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: copy.message,
        message: copy.message,
        detail: copy.detail,
        buttons: ['取消', '确认'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return response === 1 ? { ok: true } : { cancelled: true }
    } finally {
      pluginConfirmOpen = false
    }
  }

  // Remote chamber host-package seed: when an SSH instance comes ready,
  // materialize every built package and merge their loader rows together.
  // NOT silent — the plugin management UI probes the live state and shows
  // the injection block verbatim (installed/patched), and the seed result
  // is logged here; a failure is retried on the next ready (the seed is
  // idempotent, content-hash skip). Idempotency also makes the guard a
  // pure in-flight Set: reconnects re-run a cheap no-op seed instead of
  // tracking a persisted "seeded" flag that could drift from the remote.
  const unsubscribeStatus = sm.onStatusChanged((id, status) => {
    if (status.kind === 'ssh' && status.phase === 'ready' && !hostPackageSeeding.has(id)) {
      hostPackageSeeding.add(id)
      void (async () => {
        try {
          const builtSeeds = chamberHostPackageSeeds.filter(seed => existsSync(path.join(seed.sourceDir, 'dist', 'index.js')))
          if (builtSeeds.length === 0) {
            console.log(`[dsh-chamber] chamber host seed skipped for ${id}: no built host package artifacts`)
            sm.appendLog(id, 'info', 'chamber host 包未注入：构建产物缺失；远端相关客户端能力不可用')
            return
          }
          const missingSeeds = chamberHostPackageSeeds.filter(seed => !builtSeeds.includes(seed))
          if (missingSeeds.length > 0) {
            sm.appendLog(id, 'info', `chamber host 包部分未注入（构建产物缺失）：${missingSeeds.map(seed => seed.label).join(', ')}`)
          }
          const spec = findRemoteSpec(id)
          if (spec === null) return
          const result = await seedRemoteChamberHostPackages(execTransport, spec, chamberHostPackageSeeds)
          if (result.ok) {
            const seeded = result.packages.map(entry => entry.insertId).join(',')
            const message = `chamber host packages seeded onto ${id} (${seeded}; wrote=${result.wrote}, patched=${result.patched})`
            console.log(`[dsh-chamber] ${message}`)
            const packageSummary = result.packages.map(entry =>
              `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}（${remoteHostPackageDir(spec, entry.packageName)}）`).join('；')
            sm.appendLog(id, 'info', `chamber host 包注入完成：${packageSummary}；boot 层${result.patched ? '已合并挂载' : '无需改动'}（重启后生效）`)
          } else {
            console.warn(`[dsh-chamber] chamber host seed failed for ${id}: ${result.error}`)
            sm.appendLog(id, 'error', `chamber host 包注入失败：${result.error}`)
          }
        } catch (err) {
          const message = `chamber host seed error for ${id}: ${String(err)}`
          console.warn(`[dsh-chamber] ${message}`)
          sm.appendLog(id, 'error', `chamber host 包注入异常：${String(err)}`)
        } finally {
          hostPackageSeeding.delete(id)
        }
      })()
    }
  })

  // Plugin management surface (design 13 M2+M3, contract B): restart the remote
  // service, read the remote/local plugin manifests, apply a plugin-set change,
  // and best-effort npm search (main-process fetch; the renderer stays on
  // 127.0.0.1). All handlers go through the trustedIpc fence and resolve loud
  // {error} / {ok:...} shapes — never a silent empty success, never an
  // unhandled rejection. renderer-supplied specs are re-validated inside
  // applyPlugins (defense in depth).
  ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_LIST, trustedIpc(async ({ id }) => {
    const spec = findRemoteSpec(id)
    if (spec === null) return { ok: false, error: 'ssh instance not found' }
    return remotePluginList(execTransport, spec, { liveProbe: liveProbeFor(id), gitWorktreeLiveProbe: gitWorktreeLiveProbeFor(id) })
  }))
  ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_APPLY, trustedIpc(async ({ id, add, remove, restart }) => {
    const spec = findRemoteSpec(id)
    if (spec === null) return { ok: false, error: 'ssh instance not found' }
    // A non-boolean `restart` (e.g. the string 'false') must never be
    // treated as truthy and trigger an unwanted restart — refused here
    // before any exec (applyPlugins re-checks too, defense in depth).
    if (restart !== undefined && typeof restart !== 'boolean') {
      return { ok: false, error: 'restart must be a boolean' }
    }
    // Known bundle packages for the §4.5 ④ bundles assertion (design 13):
    // the LOCAL manifest's bundle-declaring dependency names. When the
    // local profile is unreadable there is no local source to sync from,
    // so the bundles half of the assertion is skipped (dependencies
    // membership is still asserted); never a silent wrong assertion.
    let knownBundles: string[] | undefined
    try {
      knownBundles = localPluginList(localDshHome).bundleLines
    } catch (localError) {
      console.warn('[dsh-chamber] 本地清单不可读，bundle 激活层断言跳过：', localError)
      knownBundles = undefined
    }
    // User confirmation (design 09 §4 v1 mitigation, 2026 final review):
    // a registry add/remove on a REMOTE instance is a persistent execution
    // surface — a page script must not drive it silently. Restart-only
    // applies stay ungated (same class as the restart_service surface).
    const addList = Array.isArray(add) ? add.filter((entry): entry is string => typeof entry === 'string') : []
    const removeList = Array.isArray(remove) ? remove.filter((entry): entry is string => typeof entry === 'string') : []
    if (addList.length > 0 || removeList.length > 0) {
      const instance = sm.listInstances().find(entry => entry.id === id)
      const confirm = await confirmPluginAction(mainWindow(), describePluginApplyConfirmation({
        targetLabel: instance !== undefined ? (instance.label || instance.host) : null,
        targetId: id,
        add: addList,
        remove: removeList,
        restart: restart === true,
      }))
      if ('cancelled' in confirm) return { ok: true, cancelled: true }
      if (!confirm.ok) return { ok: false, error: confirm.error }
    }
    return applyPlugins(execTransport, statusTransport, spec, { add, remove, restart }, { knownBundles })
  }))
  ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_LIST, trustedIpc(() => {
    try {
      // Projection redaction (design 09 §4 v1 mitigation): local-path spec
      // values (file:/link:/absolute…) must never echo local absolute paths
      // into the renderer — a remote bundle could read them.
      return { ok: true, manifest: redactLocalPluginManifest(localPluginList(localDshHome)) }
    } catch (error) {
      // The dsh-home/profile path is main-process-only. Preserve the full
      // diagnosis locally but return a path-free projection to the renderer.
      console.error('[dsh-chamber] 读取本地插件清单失败：', error)
      return { ok: false, error: 'local plugin manifest is unreadable' }
    }
  }))
  ipcMain.handle(IPC_CHANNELS.NPM_SEARCH, trustedIpc(async ({ query }) => {
    if (typeof query !== 'string' || query.trim() === '') return { ok: false, error: 'empty search query' }
    const text = query.trim()
    if (text.length > 256) return { ok: false, error: 'search query is too long' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    timer.unref?.()
    try {
      const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`, {
        signal: controller.signal,
      })
      if (!response.ok) return { ok: false, error: `npm search failed (HTTP ${response.status})` }
      const data = (await response.json()) as { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> }
      const objects = Array.isArray(data.objects) ? data.objects : []
      const packages = objects
        .map(entry => entry.package)
        .filter((pkg): pkg is { name: string; version: unknown; description: unknown } => pkg !== undefined && typeof pkg.name === 'string')
        .map(pkg => ({
          name: pkg.name,
          version: typeof pkg.version === 'string' ? pkg.version : '',
          ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
        }))
      return { ok: true, packages }
    } catch (error) {
      return { ok: false, error: `npm search failed: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
  }))

  // Host-graph seed + materialize + local plugin exec (design 13 M4): the M2
  // orchestration functions that were implemented but not yet wired. Seed
  // installs module A onto the remote (09 遗留 1); materialize packs a local
  // plugin dir and installs it remotely — the ADD view goes through
  // materialize_add_pick (folder picker in MAIN, pick-only), the sync view
  // through materialize_add (dir resolved from the local manifest, validated
  // here as absolute + directory); local add/remove run `dsh plugin` against
  // the LOCAL dsh home (05 §5.1).
  ipcMain.handle(IPC_CHANNELS.SSH_SEED_HOST_GRAPH, trustedIpc(async ({ id }) => {
    const spec = findRemoteSpec(id)
    if (spec === null) return { ok: false, error: 'ssh instance not found' }
    // Not shipped is a loud error on the MANUAL path (the button must never
    // look like it succeeded while writing nothing) — the auto path skips
    // with an info log instead. The manual resend covers BOTH chamber host
    // packages (host-graph + git-worktree): a remote connected before the
    // git package existed only picks it up through this path or the next
    // ready transition.
    const missing = chamberHostPackageSeeds.filter(seed => !existsSync(path.join(seed.sourceDir, 'dist', 'index.js')))
    if (missing.length > 0) {
      return { ok: false, error: `chamber host 包未打包：${missing.map(seed => seed.label).join('、')} 的 dist/index.js 缺失——请先构建（pnpm run build:host-packages）` }
    }
    if (hostPackageSeeding.has(id)) return { ok: false, error: 'chamber host seed in progress' }
    // Manual-path user confirmation (2026 review): the seed is a persistent
    // remote modification (writes packages + merges the boot layer) — the
    // only ungated channel of its class. The AUTO path (ready transition)
    // calls seedRemoteChamberHostPackages directly and is unaffected.
    // Cancel → {ok, cancelled}.
    {
      const instance = sm.listInstances().find(entry => entry.id === id)
      const confirm = await confirmPluginAction(mainWindow(), describeSeedConfirmation({
        targetLabel: instance !== undefined ? (instance.label || instance.host) : null,
        targetId: id,
      }))
      if ('cancelled' in confirm) return { ok: true, cancelled: true }
      if (!confirm.ok) return { ok: false, error: confirm.error }
    }
    hostPackageSeeding.add(id)
    try {
      const result = await seedRemoteChamberHostPackages(execTransport, spec, chamberHostPackageSeeds)
      // Surface the outcome in the instance's ring-buffer log (the connections
      // UI log panel) — the injection is never a silent modification.
      if (result.ok) {
        const summary = result.packages.map(entry => `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}`).join('、')
        sm.appendLog(id, 'info', `chamber host 包注入完成：${summary}；boot 层${result.patched ? '已挂载' : '无需改动'}（重启后生效）`)
      } else {
        sm.appendLog(id, 'error', `chamber host 包注入失败：${result.error}`)
      }
      return result
    } finally {
      hostPackageSeeding.delete(id)
    }
  }))
  // materialize_add (sync view): renderer supplies only the dependency NAME.
  // Main re-reads the authoritative local manifest and resolves/canonicalizes
  // its path; an IPC caller can never choose an arbitrary local directory.
  ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD, trustedIpc(async ({ id, name }) => {
    const spec = findRemoteSpec(id)
    if (spec === null) return { ok: false, error: 'ssh instance not found' }
    if (typeof name !== 'string') return { ok: false, error: 'invalid plugin name' }
    const resolved = resolveLocalMaterializeDirectory(localDshHome, name)
    if (!resolved.ok) return resolved
    // User confirmation (design 09 §4 v1 mitigation): pack-and-transfer
    // sends LOCAL source to the remote — a script in the page must not be
    // able to do this silently. Cancel mirrors the picker's cancelled shape.
    const instance = sm.listInstances().find(entry => entry.id === id)
    const confirm = await confirmPluginAction(mainWindow(), describeMaterializeConfirmation({
      pluginName: name,
      pluginPath: resolved.path,
      targetLabel: instance !== undefined ? (instance.label || instance.host) : null,
      targetId: id,
    }))
    if ('cancelled' in confirm) return { ok: true, cancelled: true }
    if (!confirm.ok) return { ok: false, error: confirm.error }
    return materializeAndAdd(execTransport, spec, resolved.path)
  }))
  // materialize_add_pick (add view): PICK-ONLY — the folder picker runs here in
  // the main process, so a compromised renderer can never drive the pack surface
  // to an arbitrary local directory (design 13 §5.8 hardening).
  ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD_PICK, trustedIpc(async ({ id }) => {
    const spec = findRemoteSpec(id)
    if (spec === null) return { ok: false, error: 'ssh instance not found' }
    const win = mainWindow()
    if (win === null || win.isDestroyed()) return { ok: false, error: 'no main window' }
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true }
    return materializeAndAdd(execTransport, spec, picked.filePaths[0])
  }))
  ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD_FILE, trustedIpc(async () => {
    if (dshWorkspace === null) return { ok: false, error: 'dsh workspace not found' }
    const win = mainWindow()
    if (win === null || win.isDestroyed()) return { ok: false, error: 'no main window' }
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true }
    const result = await runLocalDshPlugin(
      dshWorkspace,
      localDshHome,
      'add',
      `file:${picked.filePaths[0]}`,
      { allowFileSpec: true },
    )
    if (result.ok) return { ok: true }
    console.error('[dsh-chamber] 本地路径插件安装失败：', result.error)
    return { ok: false, error: 'local file plugin add failed' }
  }))
  ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD, trustedIpc(async ({ spec: specArg }) => {
    if (dshWorkspace === null) return { ok: false, error: 'dsh workspace not found' }
    // `file:` imports must go through the main-process folder picker
    // (desktop_local_plugin_add_file); this spec channel only accepts registry
    // specs so a compromised renderer can never drive the local pack surface
    // to an arbitrary directory (design 13 §5.8 hardening).
    if (typeof specArg !== 'string') return { ok: false, error: 'invalid plugin spec' }
    if (isMaterializeSpec(specArg)) {
      return { ok: false, error: 'local file imports must use the folder picker' }
    }
    // User confirmation (design 09 §4 v1 mitigation): installing a registry
    // package into the LOCAL profile creates a persistent execution surface
    // on the next local boot — never a silent script action.
    const confirm = await confirmPluginAction(mainWindow(), describeLocalPluginAddConfirmation(specArg))
    if ('cancelled' in confirm) return { ok: true, cancelled: true }
    if (!confirm.ok) return { ok: false, error: confirm.error }
    const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg)
    if (result.ok) return { ok: true }
    console.error('[dsh-chamber] 本地 registry 插件安装失败：', result.error)
    return { ok: false, error: 'local plugin add failed' }
  }))
  ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_REMOVE, trustedIpc(async ({ name }) => {
    if (dshWorkspace === null) return { ok: false, error: 'dsh workspace not found' }
    if (typeof name !== 'string' || name === '') return { ok: false, error: 'invalid plugin name' }
    // User confirmation (design 09 §4 v1 mitigation): removal is destructive
    // — a page script must not be able to wipe the local profile silently.
    const confirm = await confirmPluginAction(mainWindow(), describeLocalPluginRemoveConfirmation(name))
    if ('cancelled' in confirm) return { ok: true, cancelled: true }
    if (!confirm.ok) return { ok: false, error: confirm.error }
    const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name)
    if (result.ok) return { ok: true }
    console.error('[dsh-chamber] 本地插件卸载失败：', result.error)
    return { ok: false, error: 'local plugin remove failed' }
  }))

  let disposed = false
  return {
    async disposeAsync(): Promise<void> {
      if (!disposed) {
        disposed = true
        unsubscribeStatus()
      }
      await disposePluginSyncChildren()
    },
  }
}
