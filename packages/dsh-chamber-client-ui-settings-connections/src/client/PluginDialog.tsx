/**
 * PluginDialog.tsx — the READ-ONLY plugin view (D1 plugin write-face retirement): one
 * component whose backend fork is confined to data sources. Zones: ① diagnostic banner
 * (bannerProjection) + the settled-boot gap; ② chamber built-in table (rows DERIVED by the
 * pure `deriveChamberRows`) with the RETAINED chamber host-package provisioning actions
 * (ssh 「注入」 seed_host_graph / gateway 「重新同步」 gateway_plugin_sync / the ssh
 * restart-to-apply hint); ③ installed plugin rows, READ-ONLY (name, spec/version masked,
 * role + protected badges, live state, unsyncable marker) and the official client-plugin
 * inventory (loadPluginInventory + plugin-inventory-text projections); ④ http-direct stays a
 * read-only Loader list.
 *
 * Backends: local (local manifest read), ssh (plugin_list / local_plugin_list reads),
 * gateway (gatewayInstalled + seed-cache + Loader inventory reads), http (Loader inventory
 * read only). Every USER plugin write surface (add/import/npm search/diff/apply/remove/undo/
 * materialize/task journal) was retired; only chamber provisioning remains.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
// Page-owned restart→reload completion for the ssh chamber seed's restart-to-apply step:
// a restart refreshes the host's plugin mounts, but this window keeps the pre-restart client
// plugin set until it boots again.
import {
  RESTART_RELOAD_BUDGET_MS,
  armWindowReloadWhenServed,
  waitForSourceServing,
} from '@dsh-chamber/dsh-chamber-client-core'
import type {
  ChamberHostPackageState,
  LocalPluginManifest,
  RemotePluginManifest,
  SshInstanceSpec,
} from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import {
  gatewayChamberSeedCache,
  gatewayInstalled,
  gatewayPluginSync,
  localPluginList,
  pluginList,
  restartService,
  seedHostGraph,
  type GatewayInstalledProjection,
} from './control-plane.ts'
import { gatewayReadFenceText } from './managed-restart.ts'
import { errorMessage } from './error-text.ts'
import { pluginRowsOf, projectInstalledRows, type InstalledRowView } from './plugin-model.ts'
import { loadPluginInventory, type PluginInventorySnapshot } from './plugin-inventory-api.ts'
import {
  officialPluginsPageSourceId,
  probeOfficialPluginsPage,
  type OfficialPluginsPageCapability,
} from './plugin-capability.ts'
import {
  chamberBadgeClass,
  categoryLabel,
  roleBadgeClass,
  roleLabel,
  type InstalledCategory,
  type ViewPhase,
} from './plugin-dialog-status.ts'
import {
  deriveChamberRows,
  installedRowLiveState,
  sshChamberGates,
  thirdPartyEntries,
  thirdPartyLiveState,
  type ChamberRowDescriptor,
  type ThirdPartyLiveState,
} from './plugin-inventory-text.ts'
import { bannerProjection, bootGapText, pluginDiagnosticTone, type PluginDiagnostic, type ServerBootGap } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

export type PluginDialogTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; spec: SshInstanceSpec }
  | { kind: 'gateway'; sourceId: string; label: string }
  | { kind: 'http'; sourceId: string; label: string }

/**
 * The read-only plugin dialog.
 * @param props.diagnostic - this instance's client-plugin runtime diagnostic; the dialog is its detail surface.
 */
export function PluginDialog({ t, target, diagnostic, bootGap, onRecheckDiagnostic, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  target: PluginDialogTarget
  diagnostic?: PluginDiagnostic | undefined
  /** The instance's settled-boot gap — a DIFFERENT fact from `diagnostic`. */
  bootGap?: ServerBootGap | undefined
  onRecheckDiagnostic?: () => void
  onClose: () => void
}): ReactNode {
  const isLocal = target.kind === 'local'
  const isSsh = target.kind === 'ssh'
  const isGateway = target.kind === 'gateway'
  const isHttp = target.kind === 'http'
  const sshSpec = target.kind === 'ssh' ? target.spec : null
  const sourceId = target.kind === 'gateway' || target.kind === 'http' ? target.sourceId : null
  /** The RAW registry instance id (no `gateway-` proxy prefix) — every /chamber
   *  REST wrapper and gateway IPC takes it; the wrappers own the /api/i/gateway-<id> prefix. */
  const gatewayId = target.kind === 'gateway' ? target.sourceId.slice('gateway-'.length) : null
  /** Official Plugins page verdict for THIS instance ('probing' = no claim yet). */
  const [officialPage, setOfficialPage] = useState<OfficialPluginsPageCapability | 'probing'>('probing')
  // Official Plugins page capability (design 05 §5, C 分层 2026-09): the instance's
  // own page is reachable exactly when its client boot graph carries the
  // ui-plugin-manager row. `unknown` renders NOTHING — a failed probe must never be
  // presented as "this instance cannot manage plugins".
  const officialPageSourceId = officialPluginsPageSourceId(target)
  useEffect(() => {
    let cancelled = false
    setOfficialPage('probing')
    void probeOfficialPluginsPage(officialPageSourceId).then((verdict) => {
      if (!cancelled) setOfficialPage(verdict)
    })
    return () => { cancelled = true }
  }, [officialPageSourceId])

  const [sshPhase, setSshPhase] = useState<ViewPhase>('loading')
  const [localManifest, setLocalManifest] = useState<LocalPluginManifest | null>(null)
  const [remoteManifest, setRemoteManifest] = useState<RemotePluginManifest | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [localFailed, setLocalFailed] = useState(false)
  const [profileNotInit, setProfileNotInit] = useState(false)

  // chamber-injected host-graph: manual seed fallback
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  // one-click restart for the injected-but-not-live state
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  /** A seed that wrote/patched needs a restart even when module A was already
   *  live (host-graph live does not prove the newly seeded boot row loaded). Cleared
   *  by a successful restart. */
  const [pendingRestart, setPendingRestart] = useState(false)

  const [localList, setLocalList] = useState<LocalPluginManifest | null>(null)
  const [localListError, setLocalListError] = useState<string | null>(null)
  const [localLoading, setLocalLoading] = useState(false)

  const [viewPhase, setViewPhase] = useState<ViewPhase>('loading')
  const [viewError, setViewError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PluginInventorySnapshot | null>(null)
  /** 本地实例 Loader 快照（源 = /api/i/local）：读失败（实例未运行等）置 null
   *  静默降级——状态列留空，绝不报错横幅（本地重启入口在连接卡，对话框外）。 */
  const [localSnapshot, setLocalSnapshot] = useState<PluginInventorySnapshot | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  /** 最近一次 Loader 快照：reload 期间保留旧帧渲染、仅首载显示 loading
   *  （避免「loading→footer 闪没 + 瞬时谎报未注入」）。 */
  const snapshotRef = useRef<PluginInventorySnapshot | null>(null)
  /** reload 进行中：刷新按钮禁用（防重复并发 + 隐式 busy 提示）。 */
  const [reloading, setReloading] = useState(false)
  // The EXPECTED chamber host-package set + the local side's per-package state,
  // from the desktop's profile manifest (never hardcoded here). Unreadable is the
  // same loud hint, never a silent "not injected". Re-runs on every reload.
  const [localChamberPackages, setLocalChamberPackages] = useState<ChamberHostPackageState[] | null>(null)
  const [localSideFailed, setLocalSideFailed] = useState(false)
  // Gateway chamber seed-cache projection (A0 read side).
  const [seedCache, setSeedCache] = useState<Record<string, string | null> | null>(null)
  const [seedCacheError, setSeedCacheError] = useState<string | null>(null)
  // Manual chamber sync: re-runs the ready registration's seed-cache sync through the main process.
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Gateway management projection: the installed list (READ-ONLY).
  const [installed, setInstalled] = useState<GatewayInstalledProjection | null>(null)
  const [installedError, setInstalledError] = useState<string | null>(null)

  // Diagnostic self-heal: whenever the banner shows a problem, ask the host to
  // re-check — the host re-verifies CHANNEL-class states only and skips boot-fact
  // classes without fetching, so this cannot loop.
  useEffect(() => {
    if (diagnostic === undefined || diagnostic.state === 'ok') return
    onRecheckDiagnostic?.()
  }, [diagnostic?.state])

  const loadLocalList = useCallback(async (): Promise<void> => {
    setLocalLoading(true)
    try {
      const res = await localPluginList()
      if ('error' in res) {
        setLocalListError(res.error)
        setLocalList(null)
      } else {
        setLocalList(res.manifest)
        setLocalListError(null)
      }
    } catch (err) {
      setLocalListError(errorMessage(err))
      setLocalList(null)
    } finally {
      setLocalLoading(false)
    }
  }, [])

  /**
   * Reload the ssh READ projection (local manifest + remote manifest). The chamber
   * table reads the local projection as the 本地 column AND as the fallback row source
   * when the remote read fails — a later failure must not discard it.
   */
  const loadRemoteList = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null) return
    setSshPhase('loading')
    setLoadError(null)
    setLocalFailed(false)
    setProfileNotInit(false)
    try {
      const localRes = await localPluginList()
      if ('error' in localRes) {
        setLoadError(localRes.error)
        setLocalFailed(true)
        setSshPhase('error')
        return
      }
      setLocalManifest(localRes.manifest)
      const remoteRes = await pluginList(sshSpec.id)
      if ('error' in remoteRes) {
        setLoadError(remoteRes.error)
        setSshPhase('error')
        return
      }
      // The chamber block is probed independently of package.json, so a corrupt remote
      // manifest must not throw away rows the probe DID answer.
      setRemoteManifest(remoteRes.manifest)
      // cat ok but package.json unparseable: the manifest carries a loud error with an
      // empty dependency set — surface it, never a silent "manifests match".
      if (remoteRes.manifest.error !== undefined && remoteRes.manifest.error !== '') {
        setLoadError(remoteRes.manifest.error)
        setSshPhase('error')
        return
      }
      setProfileNotInit(!remoteRes.manifest.profileExists)
      setSshPhase('ready')
    } catch (err) {
      setLoadError(errorMessage(err))
      setSshPhase('error')
    }
  }, [isSsh, sshSpec])

  /** Manual host-graph seed fallback: writes module A onto the remote + ensures
   *  the cordis.patch.yml insert, then re-probes (chamber provisioning, not a user plugin write). */
  const doSeedHostGraph = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null || seedBusy) return
    setSeedBusy(true)
    setSeedError(null)
    try {
      const res = await seedHostGraph(sshSpec.id)
      // SshSeedHostGraphResult has no cancelled arm: the main-process seed has no dialog/picker to dismiss.
      if (res.ok) {
        setPendingRestart(res.wrote === true || res.patched === true)
      } else {
        setSeedError(res.error)
        setPendingRestart(false)
      }
    } catch (err) {
      setSeedError(errorMessage(err))
      setPendingRestart(false)
    } finally {
      setSeedBusy(false)
      await loadRemoteList()
    }
  }, [isSsh, sshSpec, seedBusy, loadRemoteList])

  /** One-click restart: the chamber host packages are seeded and the insert is in
   *  place, but the RUNNING instance has not loaded them — restarting makes them
   *  live. Re-probes after. */
  const doRestartNow = useCallback(async (): Promise<void> => {
    if (!isSsh || sshSpec === null || restartBusy || seedBusy) return
    setRestartBusy(true)
    setRestartError(null)
    try {
      const res = await restartService(sshSpec.id)
      if ('error' in res) {
        setRestartError(res.error)
      } else {
        setPendingRestart(false)
        onRecheckDiagnostic?.()
        // Page-owned restart→reload completion: the window only picks the new client half
        // up on a fresh boot, and the completion must survive this dialog closing.
        const reloadSourceId = `dsh-${sshSpec.id}`
        void armWindowReloadWhenServed(
          reloadSourceId,
          () => waitForSourceServing(reloadSourceId, { timeoutMs: 120_000 }),
          { budgetMs: RESTART_RELOAD_BUDGET_MS },
        )
      }
    } catch (err) {
      setRestartError(errorMessage(err))
    } finally {
      setRestartBusy(false)
      await loadRemoteList()
    }
  }, [isSsh, sshSpec, restartBusy, seedBusy, loadRemoteList, onRecheckDiagnostic])

  useEffect(() => {
    if (isSsh) void loadRemoteList()
    else if (isLocal) void loadLocalList()
  }, [isSsh, isLocal, loadRemoteList, loadLocalList])

  useEffect(() => {
    if (sourceId === null) return
    let cancelled = false
    // 首载（无旧帧）才显示 loading；reload 保留旧快照，避免 footer 闪没 + badge 瞬时谎报「未注入」。
    const hadData = snapshotRef.current !== null
    if (!hadData) {
      setViewPhase('loading')
      setViewError(null)
    } else {
      setReloading(true)
    }
    loadPluginInventory(sourceId).then(next => {
      if (cancelled) return
      setReloading(false)
      snapshotRef.current = next
      setSnapshot(next)
      setViewError(null)
      setViewPhase('ready')
    }).catch(err => {
      if (cancelled) return
      setReloading(false)
      if (hadData) {
        // reload 失败：保留旧帧并如实显示错误（不闪 loading、不谎报状态）。
        setViewError(errorMessage(err))
      } else {
        snapshotRef.current = null
        setSnapshot(null)
        setViewError(errorMessage(err))
        setViewPhase('error')
      }
    })
    return () => { cancelled = true }
  }, [sourceId, reloadNonce])

  // local: Loader 快照（第三方行生效状态）——本对话框打开时与每次 zone reload 加载；
  // 运行中的本地实例只在「dsh 运行时」→「重启 dsh」（对话框外）变化，故无需按操作重载。
  useEffect(() => {
    if (!isLocal) return
    let cancelled = false
    loadPluginInventory('local').then(next => {
      if (cancelled) return
      setLocalSnapshot(next)
    }).catch(() => {
      if (cancelled) return
      // 本地实例未运行/清单不可读 → 快照置 null：状态列中性显示，绝不因读失败谎报状态。
      setLocalSnapshot(null)
    })
    return () => { cancelled = true }
  }, [isLocal, reloadNonce])

  useEffect(() => {
    if (sourceId === null) return
    let cancelled = false
    localPluginList().then(res => {
      if (cancelled) return
      if ('error' in res) {
        setLocalSideFailed(true)
        setLocalChamberPackages(null)
        return
      }
      const chamber = res.manifest.chamber
      if (chamber.ok !== true) {
        setLocalSideFailed(true)
        setLocalChamberPackages(null)
        return
      }
      setLocalSideFailed(false)
      setLocalChamberPackages([...chamber.packages])
    }).catch(() => {
      if (cancelled) return
      setLocalSideFailed(true)
      setLocalChamberPackages(null)
    })
    return () => { cancelled = true }
  }, [sourceId, reloadNonce])

  // Gateway-only chamber seed-cache read: load on open and re-run on every reload / after a manual sync.
  useEffect(() => {
    if (gatewayId === null) return
    let cancelled = false
    gatewayChamberSeedCache(gatewayId).then(next => {
      if (cancelled) return
      const byName: Record<string, string | null> = {}
      for (const item of next.items) byName[item.name] = item.version ?? null
      setSeedCache(byName)
      setSeedCacheError(null)
    }).catch(err => {
      if (cancelled) return
      setSeedCache(null)
      setSeedCacheError(errorMessage(err))
    })
    return () => { cancelled = true }
  }, [gatewayId, reloadNonce])

  // Gateway-only management projection: the installed list (READ-ONLY) loads on open and
  // after every manual sync. The installed read shares the write fence, so it is the one
  // read that retries; a discarded read (reload/unmount) cannot issue another request.
  useEffect(() => {
    if (gatewayId === null) return
    let cancelled = false
    const controller = new AbortController()
    gatewayInstalled(gatewayId, { signal: controller.signal }).then(next => {
      if (cancelled) return
      setInstalled(next)
      setInstalledError(null)
    }).catch(err => {
      if (cancelled) return
      setInstalled(null)
      setInstalledError(errorMessage(err))
    })
    return () => { cancelled = true; controller.abort() }
  }, [gatewayId, reloadNonce])

  /** 手动 chamber 同步：把桌面本机 chamber 两包重新上传进 gateway 种子缓存——ready 自动
   *  同步失败或版本漂移时的兜底。失败显式投影为 ok:false + error；无论成败都重读两条投影。 */
  const chamberSyncNow = async (): Promise<void> => {
    if (gatewayId === null || syncing) return
    setSyncing(true)
    setSyncNote(null)
    setSyncError(null)
    try {
      const result = await gatewayPluginSync(gatewayId)
      if (!result.ok) {
        setSyncError(result.error)
      } else if (result.uploaded) {
        setSyncNote(t('chamberSyncUploaded'))
      } else if (result.skipped) {
        setSyncNote(t('chamberSyncSkipped'))
      } else {
        setSyncNote(t('chamberSyncUpToDate'))
      }
    } catch (err) {
      setSyncError(errorMessage(err))
    } finally {
      setSyncing(false)
      setReloadNonce(n => n + 1)
    }
  }

  const close = useCallback((): void => {
    // 非模态 busy 门控：seed/重启/同步在跑时关框会让主进程操作继续而结果无处呈现。
    if (seedBusy || restartBusy || syncing) return
    onClose()
  }, [onClose, seedBusy, restartBusy, syncing])

  const label = isLocal ? t('localTitle') : isSsh && sshSpec !== null ? sshSpec.label : target.kind === 'gateway' || target.kind === 'http' ? target.label : ''
  const title = `${t('pluginsTitle')} · ${label}`

  // diagnostic banner (bannerProjection de-dup)
  const diagnosticBanner = diagnostic !== undefined && diagnostic.state !== 'ok'
    ? bannerProjection(diagnostic, t)
    : null

  // ---- ② chamber built-in table ----
  /** Rows are DERIVED by the pure, tested `deriveChamberRows` (plugin-inventory-text.ts) —
   *  this component only maps descriptors to elements. The LOCAL target's expected AND
   *  local list come from its OWN profile manifest; every remote target's expected list
   *  and local column come from the desktop's own projection, with ssh preferring the
   *  remote probe when it succeeded (on probe failure the desktop projection is the
   *  fallback row source, so a remote-only read failure stays visible instead of
   *  emptying the table). `localOnly` registry rows are dropped before any state is
   *  read, so a non-local target never lists them. */
  const sshRemoteChamber = isSsh ? remoteManifest?.chamber : undefined
  /** The desktop's own chamber projection. The dedicated `localChamberPackages` read is
   *  gated on a gateway/http `sourceId`, so it never runs for ssh; that arm reads the same
   *  projection from the local manifest loadRemoteList fetched (本地 column must not sit on 未知,
   *  and a failed probe must not leave the table empty). */
  const desktopChamberPackages = isSsh && localManifest !== null && localManifest.chamber.ok === true
    ? localManifest.chamber.packages
    : localChamberPackages
  const chamberRows: ChamberRowDescriptor[] = deriveChamberRows({
    target: target.kind,
    expected: isLocal
      ? (localList !== null && localList.chamber.ok === true ? localList.chamber.packages : null)
      : desktopChamberPackages,
    localManifestChamber: desktopChamberPackages,
    remoteChamber: isSsh ? (sshRemoteChamber ?? null) : null,
    inventory: snapshot,
    seedCache: isGateway ? seedCache : null,
    localSideFailed,
  })
  const chamberCacheAbsent = chamberRows.some(row => row.cacheAbsent)

  // BOTH boot rows of EVERY APPLICABLE registry package must be present for the chamber
  // host layer to be complete — derived over the whole registry-driven list. sshChamberGates
  // filters `localOnly` first: the remote probe reports such a row as a synthesized
  // installed:false without asking the remote, so counting it would pin 「注入」 true forever.
  const sshGates = sshChamberGates(sshRemoteChamber)
  const remoteNeedsSeed = isSsh && sshGates.needsSeed
  const remoteInjectedNotLive = isSsh && sshGates.injectedNotLive
  const restartPending = remoteInjectedNotLive || pendingRestart

  /** One row's version cell: the derived version text plus the seed-cache drift marker (未同步) when the cache was read. */
  const chamberVersionCell = (row: ChamberRowDescriptor): ReactNode => {
    if (row.versionHintKey !== null) return <span className={css.dim}>{t(row.versionHintKey)}</span>
    return (
      <span className={css.chamberCell}>
        <span className={css.dim}>{row.versionText ?? '—'}</span>
        {row.cacheVersionText !== null ? <span className={css.dim}> · gateway {row.cacheVersionText}</span> : null}
        {row.cacheNotSynced ? <span className={css.dim}> · {t('chamberNotSynced')}</span> : null}
        {row.driftState === 'drift'
          ? (
            <span
              className={css.pluginWarn}
              title={`${t('chamberVersionDrift')}: ${row.versionText ?? 'v?'} ≠ gateway ${row.cacheVersionText ?? 'v?'}`}
            >
              · {t('chamberVersionDrift')}
            </span>
          )
          : null}
      </span>
    )
  }

  const chamberZone = (
    <div className={css.pluginChamber}>
      <p className={css.pluginChamberTitle}>
        {t('chamberInjectedTitle')}
        <span className={css.dim}> · {t('chamberInjectedHint')}</span>
        {/* chamber 区降级标签：seed-cache 读失败 = 该区数据源不可达——区标题如实标注，不静默。 */}
        {isGateway && seedCacheError !== null
          ? <span className={css.error}> · {t('instanceNotReadyZone')}</span>
          : null}
      </p>
      {isGateway && seedCacheError !== null ? <p className={css.error} role="alert">{seedCacheError}</p> : null}
      {isGateway && chamberCacheAbsent ? <p className={css.hint} role="status">{t('chamberSeedCacheAbsent')}</p> : null}
      {/* C 分层：用户插件管理交还实例内官方 Plugins 页（2026-09 裁决）。能力门：
          该页只在实例启动图带 ui-plugin-manager 行时存在；不可用就只提示（绝不恢复
          chamber 写面），探测失败不表态。 */}
      {officialPage === 'available' ? <p className={css.hint}>{t('pluginsOfficialPageHint')}</p> : null}
      {officialPage === 'unavailable'
        ? <p className={css.hint} role="status">{t('pluginsOfficialPageUnsupported')}</p>
        : null}
      <div className={css.chamberTable}>
        <div className={clsx(css.chamberTableRow, css.chamberTableHead)}>
          <span>{t('pluginsColName')}</span>
          <span>{t('pluginsLocalCol')}</span>
          <span>{t('pluginsRemoteCol')}</span>
          <span>{t('pluginsColVersion')}</span>
        </div>
        {chamberRows.map(row => (
          <div key={row.key} className={css.chamberTableRow}>
            <span className={css.chamberCell}>
              {row.nameLabelKey !== null ? t(row.nameLabelKey) : null}
              {row.name !== null
                ? <code className={css.pluginName}>{row.name}</code>
                : <span className={css.dim}>—</span>}
            </span>
            <span className={css.chamberCell}>
              {row.localBadge !== null
                ? <span className={chamberBadgeClass(row.localBadge.tone)}>{t(row.localBadge.labelKey)}</span>
                : <span className={css.dim}>—</span>}
            </span>
            <span className={css.chamberCell}>
              {row.remoteBadge !== null
                ? <span className={chamberBadgeClass(row.remoteBadge.tone)}>{t(row.remoteBadge.labelKey)}</span>
                : <span className={css.dim}>—</span>}
            </span>
            {chamberVersionCell(row)}
          </div>
        ))}
      </div>
      {isGateway
        ? (
          <p className={css.hint}>
            <button
              type="button"
              className={css.chamberSeedButton}
              disabled={syncing}
              onClick={() => { void chamberSyncNow() }}
            >
              {syncing ? t('chamberSyncBusy') : t('chamberSyncNow')}
            </button>
          </p>
        )
        : null}
      {isGateway && syncError !== null
        ? <p className={css.error} role="alert">{t('chamberSyncFailed')}{syncError}</p>
        : null}
      {isGateway && syncNote !== null ? <p className={css.hint} role="status">{syncNote}</p> : null}
      {isSsh && remoteNeedsSeed
        ? (
          <button
            type="button"
            className={css.chamberSeedButton}
            disabled={seedBusy}
            onClick={() => { void doSeedHostGraph() }}
          >
            {seedBusy ? t('chamberSeeding') : t('chamberSeed')}
          </button>
        )
        : isSsh && restartPending
          ? (
            <button
              type="button"
              className={css.chamberSeedButton}
              disabled={restartBusy || seedBusy}
              onClick={() => { void doRestartNow() }}
            >
              {restartBusy ? t('restartManagedDshBusy') : t('restartApplyInPanel')}
            </button>
          )
          : null}
      {isSsh && seedError !== null ? <p className={css.error} role="alert">{t('chamberSeedFailed')}{seedError}</p> : null}
      {isSsh && restartError !== null ? <p className={css.error} role="alert">{t('chamberRestartFailed')}{restartError}</p> : null}
      {isSsh && sshRemoteChamber !== undefined && !sshRemoteChamber.ok
        ? <p className={css.error} role="alert">{sshRemoteChamber.error}</p>
        : null}
      {(isGateway || isHttp) && localSideFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
    </div>
  )

  // ---- ③ read-only installed rows ----
  /** One row's live-state cell (thirdPartyLiveState): a badge-family chip when the Loader
   *  snapshot answers, a neutral dash when it is unavailable — never a state claim from an
   *  unreadable snapshot. */
  const liveStateCell = (state: ThirdPartyLiveState | null): ReactNode => (
    state === null
      ? <span className={css.dim}>—</span>
      : <span className={chamberBadgeClass(state.tone)}>{t(state.labelKey)}</span>
  )

  /** 一行安装列表的角色徽标：角色来自后端 rows 投影，渲染端只渲染；受保护行的 title 指向 protectedHint。 */
  const roleBadge = (row: InstalledRowView): ReactNode => {
    const key = roleLabel(row.role)
    if (key === null) return null
    return (
      <span
        className={clsx(css.pluginKindBadge, roleBadgeClass(row.role))}
        title={row.protected ? t('pluginsProtectedHint') : undefined}
      >
        {t(key)}
      </span>
    )
  }

  /** 受保护行的只读提示：受保护 = 安装组合 / chamber 播种 / 运行时线族成员（后端判定），与「无移除按钮」一起构成只读语义。 */
  const protectedHint = (row: InstalledRowView): ReactNode => (
    row.protected
      ? <span className={css.dim} title={t('pluginsProtectedHint')}>{t('pluginsProtectedHint')}</span>
      : null
  )

  /** 一行的 spec 格：依赖值优先（file: 值掩码芯片化，不直显本地路径）；掩码后无值落到已装版本，两者都有时版本作 dim 后缀。 */
  const installedSpecCell = (row: InstalledRowView, unsyncReason?: string | undefined): ReactNode => (
    <>
      {row.spec !== null && row.spec.startsWith('file:')
        ? <span className={clsx(css.pluginKindBadge, css.pluginKindPlain)} title={unsyncReason ?? t('installedFromMask')}>{t('installedFromMask')}</span>
        : row.spec !== null
          ? <code className={css.pluginSpec} title={unsyncReason}>{row.spec}</code>
          : row.version !== null
            ? <code className={css.pluginSpec} title={unsyncReason}>{row.version}</code>
            : <span className={css.dim}>—</span>}
      {row.spec !== null && row.version !== null ? <span className={css.dim}> · {row.version}</span> : null}
    </>
  )

  /** Local installed list (READ-ONLY: no add area, no per-row remove). */
  const localZone = isLocal
    ? ((): ReactNode => {
      if (localLoading) return <p className={css.dim}>{t('pluginsLoading')}</p>
      if (localListError !== null) {
        return (
          <div className={css.pluginStack}>
            <p className={css.error} role="alert">{localListError}</p>
            <div>
              <Button variant="ghost" icon={<IconRefreshOutlineRegular />} onClick={() => { void loadLocalList() }}>{t('pluginsRetry')}</Button>
            </div>
          </div>
        )
      }
      if (localList === null) return null
      // 已安装 = 本 profile 的依赖表，后端投影只做 role/protected 标注——安装自带组合（B₀）
      // 与 chamber 播种物（S）不造行（官方组合是运行时基线）。受保护名若在依赖表里仍只读可见。
      const installedRows = projectInstalledRows(localList.dependencies, pluginRowsOf(localList))
      return (
        <div className={css.pluginStack}>
          <p className={css.pluginChamberTitle}>{t('installedTab')}</p>
          {installedRows.length === 0 && localList.unsyncable.length === 0
            ? <p className={css.pluginEmptyLead}>{t('pluginsNoLocalPlugins')}</p>
            : (
              <div className={clsx(css.pluginRows, css.pluginRowsColsLocalLive)}>
                <div className={clsx(css.pluginRow, css.pluginRowHead)}>
                  <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                  <span className={css.pluginCellCat}>{t('pluginsColCategory')}</span>
                  <span className={css.pluginCellSpec}>{t('pluginsLocalCol')}</span>
                  <span className={css.pluginCellKind}>{t('pluginsColLiveState')}</span>
                </div>
                <div className={css.pluginRowsBody}>
                  {installedRows.map(row => {
                    const rowCategory: InstalledCategory = localList.bundles.includes(row.name) ? 'bundle' : localList.clientLines.includes(row.name) ? 'client' : 'plain'
                    const unsync = localList.unsyncable.find(item => item.name === row.name)
                    return (
                      <div key={row.name} className={clsx(css.pluginRow, unsync !== undefined && css.pluginRowGray)}>
                        <span className={clsx(css.pluginCell, css.pluginCellName)}>
                          <code className={css.pluginName}>{row.name}</code>
                          {roleBadge(row)}
                          {protectedHint(row)}
                        </span>
                        <span className={clsx(css.pluginCell, css.pluginCellCat)}>
                          <span className={clsx(css.pluginKindBadge, rowCategory === 'bundle' && css.pluginKindBundle, rowCategory === 'client' && css.pluginKindClient, rowCategory === 'plain' && css.pluginKindPlain)}>
                            {t(categoryLabel(rowCategory))}
                          </span>
                        </span>
                        <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                          {/* 与 gateway 列表对称：file: 掩码芯片化，不直显本地路径。 */}
                          {installedSpecCell(row, unsync?.reason)}
                          {unsync !== undefined && !(row.spec ?? '').startsWith('file:') ? <span className={css.pluginKindUnsync}> · {t('pluginsRowUnsyncable')}</span> : null}
                        </span>
                        <span className={clsx(css.pluginCell, css.pluginCellKind)}>
                          {/* 状态格只读运行实例的 Loader 快照：只有同名行才给出生效状态（bundle 层本身不是
                              Loader 行；受保护行是宿主 boot 基线）——无同名行即中性，绝不承诺「重启后生效」。 */}
                          {liveStateCell(installedRowLiveState(localSnapshot, row))}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
        </div>
      )
    })()
    : null

  /** The gateway third-party zone: the installed list, READ-ONLY (no per-row remove, no add area). */
  const gatewayZone = isGateway
    ? ((): ReactNode => {
      // 行集 = 服务端投影的依赖行（受保护判定权威在服务端，渲染端只消费；B₀/S 不造行）。
      const installedRows = installed !== null && installed.ok === true
        ? projectInstalledRows(installed.dependencies, pluginRowsOf(installed))
        : []
      return (
        <div className={css.pluginStack}>
          <p className={css.pluginChamberTitle}>{t('installedTab')}</p>
          {installedError !== null
            ? <p className={css.error} role="alert">{installedError}</p>
            : installed === null
              ? <p className={css.dim}>{t('pluginsLoading')}</p>
              : installed.ok
                ? (
                  installedRows.length === 0
                    ? <p className={css.pluginEmptyLead}>{t('installedEmpty')}</p>
                    : (
                      <div className={clsx(css.pluginRows, css.pluginRowsColsRemoteLive)}>
                        <div className={clsx(css.pluginRow, css.pluginRowHead)}>
                          <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                          <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                          <span className={css.pluginCellKind}>{t('pluginsColLiveState')}</span>
                        </div>
                        <div className={css.pluginRowsBody}>
                          {installedRows.map(row => (
                            <div key={row.name} className={css.pluginRow}>
                              <span className={clsx(css.pluginCell, css.pluginCellName)}>
                                <code className={css.pluginName}>{row.name}</code>
                                {roleBadge(row)}
                                {protectedHint(row)}
                              </span>
                              <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                                {/* file: values are the server-side mask of materialized copies. */}
                                {installedSpecCell(row)}
                              </span>
                              <span className={clsx(css.pluginCell, css.pluginCellKind)}>
                                {/* 与 local 同一判据（installedRowLiveState）：同名 Loader 行才给状态，无同名行即中性——绝不承诺「重启后生效」。 */}
                                {liveStateCell(installedRowLiveState(snapshot, row))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                )
                : installed.code === 'runtime_busy'
                  ? (
                    // The read/write fence: the READ is fine — the instance is mid plugin-change,
                    // so the gateway withheld the projection instead of publishing a torn one.
                    // A retryable busy banner (warn-toned, role="status") — never the read-error
                    // alert and never profile_absent/corrupt.
                    <p className={css.pluginBanner} role="status">
                      {gatewayReadFenceText(installed.refusalCode, 409, 'gatewayReadFencedBusy', t)}
                    </p>
                  )
                  : (
                    // profile_absent / profile_corrupt: the zone banner shows the code and the rows hide; reload retries.
                    <p className={css.pluginBanner} role="status">
                      {installed.code === 'profile_absent' ? t('profileAbsentBanner') : t('profileCorruptBanner')}
                    </p>
                  )}
        </div>
      )
    })()
    : null

  /** http-direct: read-only Loader third-party entries (no /chamber surface, no add).
   *  The projection is the shared pure function — the expected chamber names come from
   *  the chamber projection above, never a literal list, so a future registry host
   *  package cannot leak into this zone. Each row carries its live-state chip. */
  const httpZone = isHttp
    ? ((): ReactNode => {
      if (viewPhase === 'loading') return <p className={css.dim}>{t('pluginsLoading')}</p>
      if (viewPhase === 'error') {
        return <p className={css.error} role="alert">{viewError !== null ? viewError : t('inventoryError')}</p>
      }
      if (snapshot === null) return <p className={css.dim}>{t('inventoryError')}</p>
      const thirdParty = thirdPartyEntries(snapshot, chamberRows.flatMap(row => (row.name === null ? [] : [row.name])))
      if (thirdParty.length === 0) return <p className={css.dim}>{t('inventoryNoThirdParty')}</p>
      return (
        <div className={css.pluginStack}>
          {thirdParty.map(entry => (
            <div key={entry.entryId} className={css.pluginChamberRow}>
              <code className={css.pluginName}>{entry.moduleName}</code>
              {liveStateCell(thirdPartyLiveState(snapshot, entry.moduleName))}
            </div>
          ))}
        </div>
      )
    })()
    : null

  /** ssh: the remote installed list (READ-ONLY) beside the chamber table. No diff/apply
   *  entry, no add area — the ssh write surface is retired; only chamber provisioning remains. */
  const renderRemoteList = (): ReactNode => {
    if (sshPhase === 'loading') return <p className={css.dim}>{t('pluginsLoading')}</p>
    if (sshPhase === 'error') {
      return (
        <div className={css.pluginStack}>
          {localFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
          {loadError !== null ? <p className={css.error} role="alert">{loadError}</p> : null}
        </div>
      )
    }
    if (remoteManifest === null) return <p className={css.dim}>{t('pluginsLoading')}</p>
    // 远端行集来自 desktop main 的投影，只覆盖远端 profile 自己的依赖（B₀/S 不造行）。
    const rows = projectInstalledRows(remoteManifest.dependencies, pluginRowsOf(remoteManifest))
    return (
      <div className={css.pluginStack}>
        {profileNotInit ? <p className={css.pluginBanner} role="status">{t('pluginsProfileNotInitialized')}</p> : null}
        {profileNotInit
          ? null
          : rows.length === 0
            ? <p className={css.pluginEmptyLead}>{t('installedEmpty')}</p>
            : (
              <div className={clsx(css.pluginRows, css.pluginRowsColsRemote)}>
                <div className={clsx(css.pluginRow, css.pluginRowHead)}>
                  <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                  <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                </div>
                <div className={css.pluginRowsBody}>
                  {rows.map(row => (
                    <div key={row.name} className={css.pluginRow}>
                      <span className={clsx(css.pluginCell, css.pluginCellName)}>
                        <code className={css.pluginName}>{row.name}</code>
                        {roleBadge(row)}
                        {protectedHint(row)}
                      </span>
                      <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                        {installedSpecCell(row)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
      </div>
    )
  }

  const sshZone = isSsh
    ? (
      <div className={css.pluginStack}>
        <p className={css.pluginChamberTitle}>{t('installedTab')}</p>
        {renderRemoteList()}
      </div>
    )
    : null

  const footer = ((): ReactNode => {
    if (isLocal) return undefined
    if (isSsh) {
      if (sshPhase === 'loading') return undefined
      return (
        <Button variant="ghost" icon={<IconRefreshOutlineRegular />} onClick={() => { void loadRemoteList(); onRecheckDiagnostic?.() }}>
          {sshPhase === 'error' ? t('pluginsRetry') : t('pluginsRefresh')}
        </Button>
      )
    }
    // gateway / http-direct: a read refresh only.
    if (viewPhase === 'loading') return undefined
    return (
      <Button
        variant="ghost"
        icon={<IconRefreshOutlineRegular />}
        disabled={reloading}
        onClick={() => { setReloadNonce(n => n + 1) }}
      >
        {viewPhase === 'error' ? t('pluginsRetry') : t('pluginsRefresh')}
      </Button>
    )
  })()

  return (
    <Modal
      open
      onClose={close}
      title={title}
      closeLabel={t('close')}
      className={css.dialog}
      contentClassName={css.dialogContent}
      footer={footer}
    >
      {diagnosticBanner !== null
        ? (
          <p
            className={clsx(
              css.pluginDiagnostic,
              css.pluginDiagnosticDetail,
              diagnostic !== undefined && pluginDiagnosticTone(diagnostic.state) === 'problem' ? css.pluginDiagnosticProblem : css.pluginDiagnosticInfo,
            )}
            role="status"
          >
            <strong>{diagnosticBanner.title}</strong>
            {diagnosticBanner.detail !== null ? <span>{t('partialSep')}{diagnosticBanner.detail}</span> : null}
          </p>
        )
        : null}
      {bootGap !== undefined
        ? (
          <>
            <p className={clsx(css.pluginDiagnostic, css.pluginDiagnosticDetail, css.pluginDiagnosticWarn)} role="status">
              <strong>{t('bootGapLabel')}：{bootGapText(bootGap, t)}</strong>
              {/* Services already ride the sentence; only the failed-id list is appended (sentence = count, span = ids). */}
              {(bootGap.failedIds ?? []).length > 0 ? <span>{t('partialSep')}{(bootGap.failedIds ?? []).join(', ')}</span> : null}
            </p>
            <p className={css.hint}>{t('bootGapHint')}</p>
          </>
        )
        : null}
      {diagnostic !== undefined && diagnostic.state === 'instance-version-conflict' && (isLocal || isGateway)
        ? <p className={css.hint}>{t('pluginDiagnosticVersionConflictHint')}</p>
        : null}
      {/* Loader 读失败横幅：gateway 任何非 loading 相位都显示；http 直连仅 reload 失败
          （首载错误已在 httpZone 内渲染，避免重复）。 */}
      {isGateway && viewError !== null && viewPhase !== 'loading'
        ? <p className={css.error} role="alert">{viewError}</p>
        : isHttp && viewError !== null && viewPhase === 'ready'
          ? <p className={css.error} role="alert">{viewError}</p>
          : null}

      <div className={css.pluginManageSections}>
        {chamberZone}
        {sshZone}
        {localZone}
        {gatewayZone}
        {httpZone}
      </div>
    </Modal>
  )
}
