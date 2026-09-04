/**
 * Plugin management dialog (design 13 §5 / design 21 §6.6): the per-instance
 * plugin surface.
 *
 * Remote instances get the three-view sync flow (loading → error ⇄ ready →
 * applying → done) plus an "add" tab and the installed-plugins "list" tab
 * (design 21 §6.6 次序② ssh 增量: per-row remove through the same ssh apply
 * flow + 「撤销最近变更」 via the main-process undo journal); the local
 * instance is the source, so it gets a list (local_plugin_list + local
 * remove) plus the "add" tab. The sync view is a pure projection:
 * plugin-diff.ts computes the rows; registry rows (missing/update) and
 * removes forward through pluginApply, materialize rows (local path specs)
 * forward through pluginMaterializeAdd — the main process re-validates every
 * spec, execs serially (remove before add), restarts (unless deferred),
 * asserts, and re-checks readiness (§4.5). No host frames, no execution
 * here.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberHostGraphState, LocalPluginManifest, PluginApplyFailure, PluginApplyResult, RemotePluginManifest, SshInstanceSpec } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { localPluginList, localPluginRemove, pluginApply, pluginList, pluginMaterializeAdd, restartService, seedHostGraph, sshPluginUndo } from './control-plane.ts'
import {
  computePluginDiff, defaultChecked, isDifferenceRow, rowAddArg,
  type PluginDiff, type PluginRow, type PluginRowKind,
} from './plugin-diff.ts'
import { classifySshApplyResult, isDeniedPluginName } from './plugin-model.ts'
import { PluginAddView } from './PluginAddView.tsx'
import { pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

type PluginPhase = 'loading' | 'error' | 'ready' | 'applying' | 'done'
type PluginTab = 'sync' | 'list' | 'add'
type CategoryFilter = 'all' | 'bundle' | 'plain' | 'client'
type StatusFilter = 'diff' | 'all'

/** Tone of the remote-list operation status line (design 21 §6.6 list tab). */
type RemoteListTone = 'ok' | 'warn' | 'error'

/** One operation outcome line (undo / row-remove executed outcomes). */
interface RemoteListStatus {
  tone: RemoteListTone
  text: string
}

/** Remote-list status tone → the shared copy class it renders with. */
function remoteStatusClass(tone: RemoteListTone): string {
  switch (tone) {
    case 'ok': return css.hint
    case 'warn': return css.pluginWarn
    default: return css.error
  }
}

/** The chamber-injected host package surfaced as a non-actionable info row
 *  (design 09 方案 A, module A) — the single source of truth for the name is
 *  plugin-sync.ts CLIENT_GRAPH_PACKAGE_NAME. */
const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-host-client-graph'
const GIT_WORKTREE_PACKAGE = '@dsh-chamber/dsh-host-git-worktree'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Row-kind → localized label key. */
function kindLabel(kind: PluginRowKind): SettingsConnectionsKey {
  switch (kind) {
    case 'missing': return 'pluginsRowAdd'
    case 'update': return 'pluginsRowUpdate'
    case 'extra': return 'pluginsRowRemove'
    case 'materialize': return 'pluginsRowMaterialize'
    case 'unsyncable': return 'pluginsRowUnsyncable'
    default: return 'pluginsConsistent'
  }
}

/** A row's category badge: bundle / client / plain. */
function categoryLabel(category: PluginRow['category']): SettingsConnectionsKey {
  switch (category) {
    case 'bundle': return 'pluginsCatBundle'
    case 'client': return 'pluginsCatClient'
    default: return 'pluginsCatPlain'
  }
}

/** Whether a row has a checkbox (the four actionable kinds). */
function isActionable(kind: PluginRowKind): boolean {
  return isDifferenceRow(kind)
}

/**
 * The plugin management modal.
 * @param props.t - bound translate.
 * @param props.spec - remote instance spec, or null for the local instance.
 * @param props.diagnostic - this instance's client-plugin runtime diagnostic
 *   (design 09 §3.5): the modal is the detail surface — status, plugin id and
 *   reason — that instance cards deliberately keep short.
 * @param props.onClose - close (ignored while applying, §5.7).
 */
export function PluginSyncModal({ t, spec, diagnostic, onRecheckDiagnostic, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  spec: SshInstanceSpec | null
  diagnostic?: PluginDiagnostic | undefined
  /** Host-provided CHANNEL-class self-heal recheck (design 09 §3.5): fired
   *  when the banner is visible on open / turns channel-class, so a
   *  diagnostic that healed since the source's last shell boot clears
   *  without an app restart. */
  onRecheckDiagnostic?: () => void
  onClose: () => void
}): ReactNode {
  const isRemote = spec !== null
  const [tab, setTab] = useState<PluginTab>(isRemote ? 'sync' : 'list')

  // ---- remote sync three-view state ----
  const [phase, setPhase] = useState<PluginPhase>('loading')
  const [localManifest, setLocalManifest] = useState<LocalPluginManifest | null>(null)
  const [remoteManifest, setRemoteManifest] = useState<RemotePluginManifest | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [localFailed, setLocalFailed] = useState(false)
  const [profileNotInit, setProfileNotInit] = useState(false)
  const [diff, setDiff] = useState<PluginDiff | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [restart, setRestart] = useState(true)
  const [result, setResult] = useState<PluginApplyResult | null>(null)
  const [resultError, setResultError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const applyingRef = useRef(false)

  // ---- chamber-injected host-graph (design 09): manual seed fallback ----
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  // ---- one-click restart for the injected-but-not-live state (08 §11) ----
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  /** A seed that wrote/patched needs a restart to take effect, even when
   *  module A was already live (host-graph live does not prove the newly
   *  seeded git-worktree boot row loaded). Cleared by a successful restart. */
  const [pendingRestart, setPendingRestart] = useState(false)

  // ---- filters ----
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('diff')

  // ---- local list state (local instance) ----
  const [localList, setLocalList] = useState<LocalPluginManifest | null>(null)
  const [localListError, setLocalListError] = useState<string | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localRemoveTarget, setLocalRemoveTarget] = useState<string | null>(null)
  const [localRemoveBusy, setLocalRemoveBusy] = useState(false)
  const [localRemoveError, setLocalRemoveError] = useState<string | null>(null)

  // ---- remote installed-list state (design 21 §6.6, ssh list tab) ----
  /** Operation outcome line (undo / row-remove executed outcomes) above the
   *  rows; survives the post-op manifest reload (loadSync only touches the
   *  sync-tab result state). */
  const [remoteListStatus, setRemoteListStatus] = useState<RemoteListStatus | null>(null)
  /** Per-row verbatim failures (English, unlocalized per convention) shown
   *  under the row that is still installed — the row never left the profile,
   *  so retry stays possible. */
  const [remoteRowErrors, setRemoteRowErrors] = useState<Record<string, string>>({})
  /** Row awaiting its per-row remove confirmation (opens the confirm modal). */
  const [remoteRemoveTarget, setRemoteRemoveTarget] = useState<string | null>(null)
  const [remoteRemoveBusy, setRemoteRemoveBusy] = useState(false)
  /** Main-process undo confirm + inverse apply in flight (its own dialog). */
  const [undoBusy, setUndoBusy] = useState(false)

  // Diagnostic self-heal (design 09 §3.5): the banner can describe the
  // source's LAST shell boot while the channel healed since. Whenever the
  // banner shows a problem, ask the host to re-check — the host runner
  // re-verifies CHANNEL-class states only and skips boot-fact classes without
  // fetching, so this cannot loop.
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

  /** Confirm-remove one plugin from the LOCAL dsh profile (design 13 §5.1). */
  const confirmLocalRemove = useCallback(async (): Promise<void> => {
    if (localRemoveTarget === null || localRemoveBusy) return
    setLocalRemoveBusy(true)
    setLocalRemoveError(null)
    try {
      const res = await localPluginRemove(localRemoveTarget)
      if ('error' in res) {
        setLocalRemoveError(res.error)
      } else {
        setLocalRemoveTarget(null)
        // Main-process confirmation dismissed: silent no-op — nothing was
        // removed, keep the list as-is (never a misleading refresh).
        if (!('cancelled' in res)) await loadLocalList()
      }
    } catch (err) {
      setLocalRemoveError(errorMessage(err))
    } finally {
      setLocalRemoveBusy(false)
    }
  }, [localRemoveTarget, localRemoveBusy, loadLocalList])

  /**
   * Reload the sync projection. `keepChecked` preserves the user's checked
   * rows (a seed 注入 re-probe must not silently reset the selection — the
   * chamber row is not part of the third-party diff, so the checked set stays
   * valid across it; only rows that actually left the diff are dropped).
   */
  const loadSync = useCallback(async (keepChecked = false): Promise<void> => {
    if (!isRemote || spec === null) return
    setPhase('loading')
    setLoadError(null)
    setLocalFailed(false)
    setProfileNotInit(false)
    try {
      const localRes = await localPluginList()
      if ('error' in localRes) {
        setLoadError(localRes.error)
        setLocalFailed(true)
        setPhase('error')
        return
      }
      const remoteRes = await pluginList(spec.id)
      if ('error' in remoteRes) {
        setLoadError(remoteRes.error)
        setPhase('error')
        return
      }
      // cat succeeded but package.json failed to parse: the manifest carries a
      // loud error with an empty dependency set — surface it, never show a
      // silent "manifests match" against the empty projection.
      if (remoteRes.manifest.error !== undefined && remoteRes.manifest.error !== '') {
        setLoadError(remoteRes.manifest.error)
        setPhase('error')
        return
      }
      setLocalManifest(localRes.manifest)
      setRemoteManifest(remoteRes.manifest)
      setProfileNotInit(!remoteRes.manifest.profileExists)
      const d = computePluginDiff(localRes.manifest, remoteRes.manifest)
      setDiff(d)
      if (keepChecked) {
        const rows = new Set(d.rows.map(row => row.name))
        setChecked(prev => new Set([...prev].filter(name => rows.has(name))))
      } else {
        setChecked(new Set(d.rows.filter(row => defaultChecked(row.kind)).map(row => row.name)))
      }
      setResult(null)
      setResultError(null)
      setPhase('ready')
    } catch (err) {
      setLoadError(errorMessage(err))
      setPhase('error')
    }
  }, [isRemote, spec])

  /** Manual host-graph seed fallback (design 09 module B): writes module A
   *  onto the remote + ensures the cordis.patch.yml insert, then re-probes.
   *  The ready-time auto-seed normally covers this (main process); the button
   *  is the visible retry path for the failure/half-injected states — the
   *  injection is never a silent modification. Gated against a concurrent
   *  apply (both mutate the remote profile via the main process). */
  const doSeedHostGraph = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || seedBusy) return
    if (applyingRef.current) return
    setSeedBusy(true)
    setSeedError(null)
    try {
      const res = await seedHostGraph(spec.id)
      // seed_host_graph never returns cancelled: the main-process seed
      // handler has no confirmation dialog to dismiss (design 21 §10 — the
      // ssh seed confirm gap is a registered open item).
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
      await loadSync(true)
    }
  }, [isRemote, spec, seedBusy, loadSync])

  /**
   * One-click restart (design 08 §11): the chamber host packages are seeded
   * and the cordis.patch.yml insert is in place, but the RUNNING instance has
   * not loaded it — restarting the instance is the step that makes them live.
   * Re-probes afterwards so the live tri-state re-evaluates.
   */
  const doRestartNow = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || restartBusy || seedBusy) return
    if (applyingRef.current) return
    setRestartBusy(true)
    setRestartError(null)
    try {
      const res = await restartService(spec.id)
      if ('error' in res) {
        setRestartError(res.error)
      } else {
        setPendingRestart(false)
        // The restart IS the canonical heal action for a channel-class
        // diagnostic — ask the host to re-check (the runner skips boot-fact
        // classes and never writes during the restart window's 503s).
        onRecheckDiagnostic?.()
      }
    } catch (err) {
      setRestartError(errorMessage(err))
    } finally {
      setRestartBusy(false)
      await loadSync(true)
    }
  }, [isRemote, spec, restartBusy, seedBusy, loadSync, onRecheckDiagnostic])

  /**
   * Row-level REMOVE on the remote installed list (design 21 §6.6 次序② ssh
   * 等价): after the per-row confirm modal, the row forwards as a one-row
   * remove batch through the SAME ssh plugin_apply surface the sync flow uses
   * ({remove:[name]}, restart per the modal's 重启生效 checkbox — the modal
   * state, never a fixed constant), and the outcome is classified through
   * the model layer. Row-level honesty: a refused or executed-but-failed
   * remove leaves the plugin installed — the failure is attached to the ROW
   * as a verbatim (unlocalized) line under it, and no reload runs (nothing
   * changed). An executed remove reloads the projection (the row left the
   * profile) and its not-fully-effective states (deferred / verification or
   * readiness failure) surface as the status line above the list.
   */
  const confirmRemoteRemove = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || remoteRemoveTarget === null) return
    if (remoteRemoveBusy || undoBusy) return
    if (applyingRef.current || seedBusy || restartBusy) return
    const name = remoteRemoveTarget
    setRemoteRemoveBusy(true)
    setRemoteListStatus(null)
    setRemoteRowErrors(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    try {
      const res = await pluginApply(spec.id, { add: [], remove: [name], restart })
      // plugin_apply has no cancelled arm (no main-process confirm on the ssh
      // apply — design 21 §10 open item): a refusal is always ok:false.
      if ('error' in res) {
        // Wholesale refusal (single-flight / invalid input / ownership):
        // nothing ran, the row is untouched.
        setRemoteRowErrors(prev => ({ ...prev, [name]: res.error }))
      } else {
        const r = res.result
        const failed = r.failed.find(item => item.spec === name)
        if (failed !== undefined) {
          // The remove exec itself failed: nothing left the profile — verbatim
          // failure under the row, no reload (a reload would not change it).
          setRemoteRowErrors(prev => ({ ...prev, [name]: failed.error }))
        } else {
          // Fully executed. Model-layer classification (ssh apply
          // normalization, plugin-model.ts §3): the executed summary keeps
          // the producer's fail-loud markers — mirror the sync result view's
          // honest copy (never collapse them into a clean success).
          const outcome = classifySshApplyResult(res)
          // No cancelled outcome on the ssh path (plugin_apply has no cancel);
          // the executed arm is narrowed by its own member.
          if ('failed' in outcome) {
            setRemoteListStatus({ tone: 'error', text: outcome.failed.error })
          } else if ('executed' in outcome) {
            const executed = outcome.executed
            let tone: RemoteListTone
            let text: string
            if (executed.verified === false) {
              // Post-change assertion failed (fail-loud, no rollback); the
              // readyNote (English, verbatim) explains when present.
              tone = 'error'
              text = `${t('pluginsVerifyFailed')}${executed.readyNote === undefined ? '' : ` ${executed.readyNote}`}`
            } else if (executed.ready === false) {
              // Restart executed but the readiness recheck failed — same loud
              // copy as the sync result view's ready-failed line.
              tone = 'error'
              text = t('pluginsReadyFailed')
            } else if (executed.restarted) {
              // Clean success (or restart ok with the readiness recheck
              // skipped — its readyNote, verbatim, rides along). Short
              // success copy reuses the apply result's own success word.
              tone = 'ok'
              text = `${t('pluginsApplied')}${executed.readyNote === undefined ? '' : ` · ${executed.readyNote}`}`
            } else {
              // Deferred (the 重启生效 checkbox was off) or the restart
              // itself failed: applied but not active — restartNeededHint.
              tone = 'warn'
              text = t('restartNeededHint')
            }
            setRemoteListStatus({ tone, text })
            // Executed removes reload the projection (the row left the
            // profile); keepChecked preserves any sync-tab selection across
            // the reload.
            await loadSync(true)
          }
        }
      }
    } catch (err) {
      setRemoteRowErrors(prev => ({ ...prev, [name]: errorMessage(err) }))
    } finally {
      setRemoteRemoveBusy(false)
      setRemoteRemoveTarget(null)
      setRestart(true)
    }
  }, [isRemote, spec, remoteRemoveTarget, remoteRemoveBusy, undoBusy, restart, loadSync, t])

  /**
   * 「撤销最近变更」 on the remote installed list (design 21 §6.4/§6.6 ssh
   * journal undo): id-only intent into the main-process undo — the journal
   * is authoritative, the renderer never supplies a spec. cancelled (the
   * user dismissed the main-process dialog) is a silent no-op; ok:true arms
   * re-executed the inverse row, so the projection reloads after them. The
   * undo outcome's executed-but-not-effective signal is the PRESENCE of
   * undone.restarted (main.ts undo handler): clean (absent, or restarted
   * with ready !== false) → 已撤销最近变更; restarted false / ready false →
   * honest undoNotEffective.
   */
  const doUndo = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null) return
    if (undoBusy || remoteRemoveBusy) return
    if (applyingRef.current || seedBusy || restartBusy) return
    setUndoBusy(true)
    setRemoteListStatus(null)
    setRemoteRowErrors({})
    try {
      const res = await sshPluginUndo(spec.id)
      if ('cancelled' in res) {
        // User dismissed the main-process undo confirmation: silent no-op.
      } else if (res.ok) {
        const undone = res.undone
        const clean = undone.restarted === undefined
          || (undone.restarted === true && undone.ready !== false)
        if (clean) {
          setRemoteListStatus({ tone: 'ok', text: t('undoDone') })
        } else if (undone.restarted === false) {
          // Change applied without a restart (e.g. the instance was
          // stopped) — the same pending-restart shape the gateway undo
          // reports, not a failure.
          const note = undone.readyNote === undefined ? '' : ` ${undone.readyNote}`
          setRemoteListStatus({ tone: 'warn', text: `${t('undoDone')} · ${t('restartNeededHint')}${note}` })
        } else {
          // A restart ran but the instance did not come back ready — honest
          // failure surface (its own undoNotEffective copy).
          const note = undone.readyNote === undefined ? '' : ` ${undone.readyNote}`
          setRemoteListStatus({ tone: 'error', text: `${t('undoNotEffective')}${note}` })
        }
        await loadSync(true)
      } else if (res.unavailable === 'none') {
        setRemoteListStatus({ tone: 'ok', text: t('undoUnavailableNone') })
      } else if (res.unavailable === 'file-backed') {
        setRemoteListStatus({ tone: 'warn', text: t('undoUnavailableFileBacked') })
      } else {
        // No unavailable code (unknown id / instance gone / refused): the
        // error text is a main-process message — verbatim per convention.
        setRemoteListStatus({ tone: 'error', text: res.error })
      }
    } catch (err) {
      setRemoteListStatus({ tone: 'error', text: errorMessage(err) })
    } finally {
      setUndoBusy(false)
    }
  }, [isRemote, spec, undoBusy, remoteRemoveBusy, loadSync, t])

  useEffect(() => {
    if (isRemote) void loadSync()
    else void loadLocalList()
  }, [isRemote, loadSync, loadLocalList])

  const toggleRow = useCallback((name: string): void => {
    if (applyingRef.current) return
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const selected = diff?.rows.filter(row => checked.has(row.name)) ?? []
  const removeRows = selected.filter(row => row.kind === 'extra')
  const changeCount = selected.filter(row => isDifferenceRow(row.kind)).length
  const willRestart = restart && changeCount > 0

  const doApply = useCallback(async (): Promise<void> => {
    if (!isRemote || spec === null || diff === null || applyingRef.current) return
    // A seed 注入 in flight mutates the same remote profile (module A files +
    // cordis.patch.yml) — never apply while it is mid-write (2026-08 review).
    // An in-flight installed-list op (row remove / undo) also writes the same
    // profile through the same main-process surface — never overlap them.
    if (seedBusy || restartBusy || remoteRemoveBusy || undoBusy) return
    const sel = diff.rows.filter(row => checked.has(row.name))
    const materializeRows = sel.filter(row => row.kind === 'materialize')
    const add = sel
      .filter(row => row.kind === 'missing' || row.kind === 'update')
      .map(rowAddArg)
    const remove = sel.filter(row => row.kind === 'extra').map(row => row.name)
    applyingRef.current = true
    setPhase('applying')
    setResult(null)
    setResultError(null)
    try {
      // Materialize rows (design 13 §4.6): pack-and-transfer via the desktop IPC —
      // NEVER `dsh plugin add <name>` from the registry (§4.5). Per-row
      // isolation: an unresolvable local dir or a failed transfer fails that
      // row only (AGENTS.md: one failed entity must not block the rest).
      const failed: PluginApplyFailure[] = []
      let applied = 0
      for (const row of materializeRows) {
        const res = await pluginMaterializeAdd(spec.id, row.name)
        // materialize_add (name-resolved) has no picker/confirm to dismiss,
        // so no cancelled arm exists at this call site (the pick variant
        // plugin_materialize_add_pick carries it — PluginAddView handles it).
        if ('error' in res) failed.push({ spec: row.name, error: res.error })
        else applied += 1
      }

      // Registry rows + removes ride the existing pluginApply orchestration
      // (remove-first, serial, restart unless deferred, assert, ready recheck).
      if (add.length > 0 || remove.length > 0) {
        const res = await pluginApply(spec.id, { add, remove, restart })
        // plugin_apply has no cancelled arm (no main-process confirm on the
        // ssh apply — design 21 §10 open item); a refusal is always ok:false.
        if ('error' in res) {
          setResultError(res.error)
          // The registry apply was refused outright (e.g. apply in progress):
          // no restart was attempted — the materialized installs (if any) take
          // effect on the next restart, so frame them as deferred, never as a
          // failed restart.
          setResult({ applied, failed, skipped: 0, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
        } else {
          setResult({
            applied: applied + res.result.applied,
            failed: [...failed, ...res.result.failed],
            skipped: res.result.skipped,
            restarted: res.result.restarted,
            deferred: res.result.deferred,
            verified: res.result.verified,
            ready: res.result.ready,
          })
        }
      } else {
        // Materialize-only apply: the desktop materialize path installs but
        // does not restart in v1 — the installs take effect on the next
        // restart (honest, same framing as a deferred registry apply).
        setResult({ applied, failed, skipped: 0, restarted: false, deferred: true, verified: failed.length === 0, ready: null })
      }
    } catch (err) {
      setResultError(errorMessage(err))
    } finally {
      applyingRef.current = false
      setRestart(true)
      setPhase('done')
    }
  }, [isRemote, spec, diff, checked, restart, seedBusy, restartBusy, remoteRemoveBusy, undoBusy, t])

  const onApplyClick = useCallback((): void => {
    if (applyingRef.current) return
    if (removeRows.length > 0) { setConfirmRemove(true); return }
    if (willRestart) { setConfirmApply(true); return }
    void doApply()
  }, [removeRows.length, willRestart, doApply])

  const onRemoveConfirm = useCallback((): void => {
    setConfirmRemove(false)
    if (willRestart) { setConfirmApply(true); return }
    void doApply()
  }, [willRestart, doApply])

  const onApplyConfirm = useCallback((): void => {
    setConfirmApply(false)
    void doApply()
  }, [doApply])

  const close = useCallback((): void => {
    if (applyingRef.current) return
    // While a nested confirm modal (remove / apply / local-remove) is open,
    // the primitives Modal registers its own document-level Escape listener —
    // without this gate one Escape would ALSO close this main modal (its
    // listener runs too), discarding the user's checked selection (2026-08
    // review). The nested modals close themselves via their own onClose.
    if (confirmRemove || confirmApply || localRemoveTarget !== null || remoteRemoveTarget !== null) return
    onClose()
  }, [onClose, confirmRemove, confirmApply, localRemoveTarget, remoteRemoveTarget])

  const title = `${t('pluginsTitle')} · ${spec === null ? t('localTitle') : spec.label}`
  const applying = phase === 'applying'

  // ---- filtered rows for the diff table ----
  const visibleRows = (diff?.rows ?? []).filter(row => {
    if (query !== '' && !row.name.toLowerCase().includes(query.trim().toLowerCase())) return false
    if (category !== 'all' && row.category !== category) return false
    if (status === 'diff' && !isDifferenceRow(row.kind)) return false
    return true
  })

  const footer = ((): ReactNode => {
    if (phase === 'loading') {
      // No footer. The primitives Modal always renders a working header close
      // (plus Escape / mask click → onClose), so a footer close would be
      // redundant — and on the LOCAL instance `phase` stays 'loading' forever
      // (loadSync only runs for remote), which previously left a DEAD disabled
      // 「关闭」button. The X closes in every phase.
      return undefined
    }
    if (phase === 'error') {
      return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync(); onRecheckDiagnostic?.() }}>{t('pluginsRetry')}</Button>
    }
    if (phase === 'applying') {
      return <Button variant="outline" disabled>{t('busyTasks')}</Button>
    }
    if (phase === 'done') {
      return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadSync(); onRecheckDiagnostic?.() }}>{t('pluginsRefresh')}</Button>
    }
    // ready
    return (
      <>
        <Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={changeCount === 0 || seedBusy || restartBusy} onClick={onApplyClick}>
          {t('pluginsApply')} {changeCount > 0 ? `${changeCount}` : ''}
        </Button>
      </>
    )
  })()

  return (
    <>
      <Modal
        open
        onClose={close}
        title={title}
        closeLabel={t('close')}
        className={css.dialog}
        contentClassName={css.dialogContent}
        footer={footer}
      >
        {diagnostic !== undefined && diagnostic.state !== 'ok'
          ? (
            <p
              className={clsx(
                css.pluginDiagnostic,
                css.pluginDiagnosticDetail,
                pluginDiagnosticTone(diagnostic.state) === 'problem' ? css.pluginDiagnosticProblem : css.pluginDiagnosticInfo,
              )}
              role="status"
            >
              <strong>{t('pluginDiagnosticLabel')}：{pluginDiagnosticText(diagnostic.state, t)}</strong>
              {diagnostic.pluginId !== undefined && <span>{diagnostic.pluginId}</span>}
              {diagnostic.message !== undefined && <span>{diagnostic.message}</span>}
            </p>
          )
          : null}
        <div className={css.pluginTabs}>
          {/* Remote tab order sync / add / list (design 21 §6.6 text order):
              the new installed list is APPENDED so the two pre-existing
              remote tabs keep their exact positions; local keeps list / add. */}
          {(isRemote ? (['sync', 'add', 'list'] as const) : (['list', 'add'] as const)).map(id => (
            <button
              key={id}
              type="button"
              className={clsx(css.pluginTab, tab === id && css.pluginTabActive)}
              disabled={applying}
              onClick={() => { setTab(id) }}
            >
              {t(id === 'sync' ? 'pluginsSyncTab' : id === 'add' ? 'pluginsAddTab' : isRemote ? 'installedTab' : 'pluginsListTab')}
            </button>
          ))}
        </div>

        {tab === 'add'
          ? <PluginAddView t={t} spec={spec} onInstalled={() => { if (isRemote) void loadSync(); else void loadLocalList() }} />
          : tab === 'list'
            ? isRemote ? renderRemoteList() : renderLocalList()
            : renderSyncView()}
      </Modal>

      <Modal
        open={confirmRemove}
        onClose={() => { setConfirmRemove(false) }}
        title={t('pluginsApplyTitle')}
        closeLabel={t('close')}
        description={t('pluginsRemoveRisk')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.deleteConfirm} onClick={onRemoveConfirm}>{t('deleteConfirm')}</Button>
          </>
        )}
      />

      <Modal
        open={confirmApply}
        onClose={() => { setConfirmApply(false) }}
        title={t('pluginsApplyTitle')}
        closeLabel={t('close')}
        description={t('pluginsRestartWarning')}
        className={css.dialog}
        footer={(
          <>
            <Button variant="outline" autoFocus onClick={() => { setConfirmApply(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={onApplyConfirm}>{t('pluginsApply')}</Button>
          </>
        )}
      >
        <label className={css.pluginDeferRow}>
          <input type="checkbox" checked={!restart} onChange={event => { setRestart(!event.target.checked) }} />
          <span>{t('pluginsDeferRestart')}</span>
        </label>
      </Modal>

      <Modal
        open={localRemoveTarget !== null}
        onClose={() => { if (!localRemoveBusy) setLocalRemoveTarget(null) }}
        title={t('pluginsLocalRemoveTitle')}
        closeLabel={t('close')}
        description={t('pluginsLocalRemoveDescription')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={localRemoveBusy} onClick={() => { setLocalRemoveTarget(null) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.deleteConfirm} disabled={localRemoveBusy} onClick={() => { void confirmLocalRemove() }}>
              {localRemoveBusy ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />

      {/* Per-row remove confirm on the REMOTE installed list (design 21 §6.6):
          mirrors the local-remove pattern; the same 重启生效 checkbox state
          the sync apply flow uses governs the restart (removal applies on the
          next restart when unchecked — the checkbox state, never a silent
          constant). removeRowConfirmDescription carries a {name} placeholder;
          the bound locale translate is key-only, so the placeholder is
          substituted here (both dictionaries use the same token). */}
      <Modal
        open={remoteRemoveTarget !== null}
        onClose={() => { if (!remoteRemoveBusy) setRemoteRemoveTarget(null) }}
        title={t('removeRowConfirmTitle')}
        closeLabel={t('close')}
        description={t('removeRowConfirmDescription').replace('{name}', remoteRemoveTarget ?? '')}
        className={css.deleteDialog}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={remoteRemoveBusy} onClick={() => { setRemoteRemoveTarget(null) }}>{t('cancel')}</Button>
            <Button variant="outline" className={css.deleteConfirm} disabled={remoteRemoveBusy} onClick={() => { void confirmRemoteRemove() }}>
              {remoteRemoveBusy ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      >
        <label className={css.pluginDeferRow}>
          <input type="checkbox" checked={!restart} disabled={remoteRemoveBusy} onChange={event => { setRestart(!event.target.checked) }} />
          <span>{t('pluginsDeferRestart')}</span>
        </label>
      </Modal>
    </>
  )

  function renderSyncView(): ReactNode {
    if (phase === 'loading') {
      return <p className={css.dim}>{t('pluginsLoading')}</p>
    }
    if (phase === 'error') {
      return (
        <div className={css.pluginStack}>
          {localFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
          {loadError !== null ? <p className={css.error} role="alert">{loadError}</p> : null}
        </div>
      )
    }
    if (phase === 'applying') {
      return (
        <div className={css.pluginStack}>
          <p className={css.dim}>{t('busyTasks')}</p>
          <p className={css.hint}>{t('pluginsApply')} {changeCount}</p>
        </div>
      )
    }
    if (phase === 'done') {
      return renderResult()
    }
    // ready
    return renderTable()
  }

  /**
   * The chamber-injected component row (design 09 module A+B): shown in BOTH
   * the sync and the local-list views so the injection is never a silent
   * modification — the local side (auto-seeded by the control plane per
   * spawn) and the remote side (auto-seeded by the desktop at ready; manual
   * 注入 button as the visible retry for failure/half-injected states).
   */
  function renderChamberBlock(): ReactNode {
    // Local side: the sync view (remote) fills localManifest, the local list
    // view fills localList — same LocalPluginManifest shape, one source.
    const localCh = (isRemote ? localManifest : localList)?.chamber
    const remoteCh = isRemote ? remoteManifest?.chamber : undefined
    const localInjected = localCh?.ok === true && localCh.hostGraph.installed && localCh.hostGraph.patched
    // Module A's own version (design 09): the local projection is the source
    // of truth when readable (the seed copies the same packaged module A to
    // both sides); fall back to the remote projection only when the local
    // manifest is unavailable. null → no version chip (never a guessed one).
    const version = localCh?.ok === true
      ? localCh.hostGraph.version
      : remoteCh?.ok === true ? remoteCh.hostGraph.version : null
    const gitVersion = localCh?.ok === true
      ? localCh.gitWorktree.version
      : remoteCh?.ok === true ? remoteCh.gitWorktree.version : null
    const localGitInjected = localCh?.ok === true
      && localCh.gitWorktree.installed && localCh.gitWorktree.patched
    // Per-package remote tri-state (hostGraph and gitWorktree share the
    // installed/patched/live shape). Live-effect (design 09 module A
    // liveness): the desktop's tunnel RPC probe answers whether the RUNNING
    // instance has actually loaded the package — live → 已生效; probed
    // not-loaded → 重启后生效; unprobed/unclassifiable → 生效状态未知.
    // Never a constant claim.
    const remotePackageLabel = (state: ChamberHostGraphState | null | undefined): ReactNode => {
      if (state === undefined) return '—'
      if (state === null) return <span className={css.error}>{t('chamberRemoteUnknown')}</span>
      if (state.installed && state.patched) {
        return state.live === true
          ? t('chamberRemoteLive')
          : state.live === false
            ? t('chamberRemoteInjected')
            : t('chamberRemoteInjectedUnknown')
      }
      if (state.installed) return t('chamberRemotePartial')
      return t('chamberRemoteNotInjected')
    }
    const hostGraphRemote = remoteCh === undefined ? undefined : remoteCh.ok ? remoteCh.hostGraph : null
    const gitWorktreeRemote = remoteCh === undefined ? undefined : remoteCh.ok ? remoteCh.gitWorktree : null
    // BOTH boot rows must be present for the chamber host layer to be
    // complete: the git-worktree insert is its OWN row in the same
    // cordis.patch.yml, and its presence is probed separately (a machine
    // seeded before the git package existed carries only the client-graph
    // row — files present, git RPC still 404).
    const remoteNeedsSeed = isRemote && remoteCh !== undefined
      && (!remoteCh.ok
        || !(remoteCh.hostGraph.installed && remoteCh.hostGraph.patched)
        || !(remoteCh.gitWorktree.installed && remoteCh.gitWorktree.patched))
    // Injected but the RUNNING instance has not loaded a boot insert
    // (probed not-loaded) — restart is the one step that makes it live. A
    // seed that wrote/patched ALSO demands a restart (the running instance
    // only loads the boot layer at start). Each package has its own live
    // tri-state: host-graph live from an older boot does NOT prove the
    // git-worktree row loaded (design 08 §11) — either not-live gates the
    // restart button.
    const remoteInjectedNotLive = isRemote && remoteCh?.ok === true
      && remoteCh.hostGraph.installed && remoteCh.hostGraph.patched && remoteCh.hostGraph.live === false
    const remoteGitNotLive = isRemote && remoteCh?.ok === true
      && remoteCh.gitWorktree.installed && remoteCh.gitWorktree.patched && remoteCh.gitWorktree.live === false
    const restartPending = remoteInjectedNotLive || remoteGitNotLive || pendingRestart
    return (
      <div className={css.pluginChamber}>
        <p className={css.pluginChamberTitle}>
          {t('chamberInjectedTitle')}
          <span className={css.dim}> · {t('chamberInjectedHint')}</span>
        </p>
        <div className={css.pluginChamberRow}>
          <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>
          {version !== null ? <span className={css.dim}> · v{version}</span> : null}
          <span className={css.pluginCellSpec}>
            {localInjected ? t('chamberLocalInjected') : t('chamberLocalNotInjected')}
            {isRemote ? <span> · {remotePackageLabel(hostGraphRemote)}</span> : null}
          </span>
          {remoteNeedsSeed
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
            : restartPending
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
        </div>
        <div className={css.pluginChamberRow}>
          <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>
          {gitVersion !== null ? <span className={css.dim}> · v{gitVersion}</span> : null}
          <span className={css.pluginCellSpec}>
            {localGitInjected ? t('chamberInstalled') : t('chamberNotInstalled')}
            {isRemote ? <span> · {remotePackageLabel(gitWorktreeRemote)}</span> : null}
          </span>
        </div>
        {seedError !== null ? <p className={css.error} role="alert">{t('chamberSeedFailed')}{seedError}</p> : null}
        {restartError !== null ? <p className={css.error} role="alert">{t('chamberRestartFailed')}{restartError}</p> : null}
        {remoteCh !== undefined && !remoteCh.ok ? <p className={css.error} role="alert">{remoteCh.error}</p> : null}
      </div>
    )
  }

  function renderTable(): ReactNode {
    if (diff === null) return null
    const total = diff.rows.length
    const differenceCount = diff.rows.filter(row => isDifferenceRow(row.kind)).length
    const hasLocal = Object.keys(localManifest?.dependencies ?? {}).length > 0

    return (
      <div className={css.pluginStack}>
        {renderChamberBlock()}
        {profileNotInit ? <p className={css.pluginBanner} role="status">{t('pluginsProfileNotInitialized')}</p> : null}
        {total === 0
          ? <p className={css.dim}>{t('pluginsNoThirdParty')}</p>
          : (
            <>
              {!hasLocal ? <p className={css.hint}>{t('pluginsNoLocalPlugins')}</p> : null}
              {differenceCount === 0 ? <p className={css.dim}>{t('pluginsNoDiff')}</p> : null}

              <div className={css.pluginToolbar}>
                <input
                  className={clsx(css.input, css.pluginSearchInput)}
                  value={query}
                  spellCheck={false}
                  placeholder={t('pluginsSearchPlaceholder')}
                  onChange={event => { setQuery(event.target.value) }}
                />
                <div className={css.pluginFilterGroup}>
                  <span className={css.pluginFilterLabel}>{t('pluginsCatAll')}</span>
                  {(['all', 'bundle', 'plain', 'client'] as const).map(c => (
                    <button
                      key={c}
                      type="button"
                      className={clsx(css.pluginPill, category === c && css.pluginPillActive)}
                      onClick={() => { setCategory(c) }}
                    >
                      {c === 'all' ? t('pluginsFilterAll') : t(categoryLabel(c))}
                    </button>
                  ))}
                </div>
                <div className={css.pluginFilterGroup}>
                  <span className={css.pluginFilterLabel}>{t('pluginsFilterDiff')}</span>
                  {(['diff', 'all'] as const).map(s => (
                    <button
                      key={s}
                      type="button"
                      className={clsx(css.pluginPill, status === s && css.pluginPillActive)}
                      onClick={() => { setStatus(s) }}
                    >
                      {t(s === 'diff' ? 'pluginsFilterDiff' : 'pluginsFilterAll')}
                    </button>
                  ))}
                </div>
              </div>

              {visibleRows.length === 0
                ? <p className={css.dim}>{t('pluginsNoMatch')}</p>
                : (
                  <div className={css.pluginRows}>
                    <div className={clsx(css.pluginRow, css.pluginRowHead)}>
                      <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                      <span className={css.pluginCellCat}>{t('pluginsColCategory')}</span>
                      <span className={css.pluginCellKind}>{t('pluginsColStatus')}</span>
                      <span className={css.pluginCellSpec}>{t('pluginsLocalCol')}</span>
                      <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                    </div>
                    {visibleRows.map(row => renderRow(row))}
                  </div>
                )}
            </>
          )}
      </div>
    )
  }

  function renderRow(row: PluginRow): ReactNode {
    const actionable = isActionable(row.kind)
    const isExtra = row.kind === 'extra'
    const isUnsync = row.kind === 'unsyncable'
    const isChecked = checked.has(row.name)
    const isUpdate = row.kind === 'update'

    return (
      <div
        key={row.name}
        className={clsx(css.pluginRow, isUnsync && css.pluginRowGray)}
      >
        <label className={clsx(css.pluginCell, css.pluginCellName)}>
          {actionable
            ? <input type="checkbox" className={css.pluginCheckbox} checked={isChecked} disabled={applying} onChange={() => { toggleRow(row.name) }} />
            : null}
          <code className={css.pluginName} title={row.reason ?? row.name}>{row.name}</code>
        </label>
        <span className={clsx(css.pluginCell, css.pluginCellCat)}>
          <span className={clsx(css.pluginKindBadge, row.category === 'bundle' && css.pluginKindBundle, row.category === 'client' && css.pluginKindClient, row.category === 'plain' && css.pluginKindPlain)}>
            {t(categoryLabel(row.category))}
          </span>
        </span>
        <span className={clsx(css.pluginCell, css.pluginCellKind)}>
          <span className={clsx(css.pluginKind, isUnsync && css.pluginKindUnsync)}>{t(kindLabel(row.kind))}</span>
        </span>
        <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
          <code className={css.pluginSpec}>{row.localSpec ?? '—'}</code>
          {row.unlocked ? <span className={css.dim}> {t('pluginsUnlockedLatest')}</span> : null}
        </span>
        <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
          {isUpdate ? <span className={css.pluginArrow}>→</span> : null}
          <code className={css.pluginSpec}>{row.remoteSpec ?? '—'}</code>
          {row.kind === 'materialize' ? <span className={css.dim}> · {t('pluginsRowMaterialize')}</span> : null}
        </span>
        {isExtra && isChecked ? <p className={css.pluginRisk}>{t('pluginsRemoveRisk')}</p> : null}
      </div>
    )
  }

  function renderResult(): ReactNode {
    const r = result
    return (
      <div className={css.pluginStack}>
        {resultError !== null ? <p className={css.error} role="alert">{resultError}</p> : null}
        {r === null
          ? null
          : (
            <>
              <p className={css.pluginSummary}>
                {t('pluginsApplied')} {r.applied} · {t('pluginsFailed')} {r.failed.length} · {t('pluginsSkipped')} {r.skipped}
              </p>
              {r.failed.length > 0
                ? (
                  <ul className={css.pluginFailedList}>
                    {r.failed.map(item => (
                      <li key={item.spec} className={css.pluginFailedItem}>
                        <code className={css.mono}>{item.spec}</code>
                        <span className={css.error}>{item.error}</span>
                      </li>
                    ))}
                  </ul>
                )
                : null}
              {r.restarted ? <p className={css.hint}>{t('pluginsRestarted')}</p> : null}
              {r.deferred ? <p className={css.hint}>{t('pluginsDeferred')}</p> : null}
              {!r.deferred && !r.restarted && r.applied > 0
                ? (
                  <p className={css.pluginWarn}>
                    {/* No systemd service configured is a config gap, not a
                        failed restart — say so instead of the generic message. */}
                    {spec !== null && spec.serviceName === null ? t('pluginsRestartUnconfigured') : t('pluginsRestartFailed')}
                  </p>
                )
                : null}
              {!r.verified ? <p className={css.error} role="alert">{t('pluginsVerifyFailed')}</p> : null}
              {r.ready === false ? <p className={css.error} role="alert">{t('pluginsReadyFailed')}</p> : null}
              {/* Restart happened but readiness was not re-checked (the instance
                  was not connected before restart) — show the main process's
                  readyNote verbatim instead of claiming success or failure. */}
              {r.restarted && r.ready === null && r.readyNote !== undefined
                ? <p className={css.hint}>{r.readyNote}</p>
                : null}
            </>
          )}
      </div>
    )
  }

  function renderLocalList(): ReactNode {
    if (localLoading) return <p className={css.dim}>{t('loading')}</p>
    if (localListError !== null) {
      // The local list never leaves phase 'loading' (loadSync runs for remote
      // only), so the footer stays empty here — a visible retry is the only
      // recovery short of reopening the modal (2026-08 review).
      return (
        <div className={css.pluginStack}>
          <p className={css.error} role="alert">{localListError}</p>
          <div>
            <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void loadLocalList() }}>{t('pluginsRetry')}</Button>
          </div>
        </div>
      )
    }
    if (localList === null) return null
    const deps = Object.entries(localList.dependencies)
    if (deps.length === 0 && localList.unsyncable.length === 0) {
      return (
        <div className={css.pluginStack}>
          {renderChamberBlock()}
          <p className={css.dim}>{t('pluginsNoLocalPlugins')}</p>
        </div>
      )
    }
    return (
      <div className={css.pluginStack}>
        {renderChamberBlock()}
        {localRemoveError !== null ? <p className={css.error} role="alert">{localRemoveError}</p> : null}
        <div className={css.pluginRows}>
          <div className={clsx(css.pluginRow, css.pluginRowLocal, css.pluginRowHead)}>
            <span className={css.pluginCellName}>{t('pluginsColName')}</span>
            <span className={css.pluginCellCat}>{t('pluginsColCategory')}</span>
            <span className={css.pluginCellSpec}>{t('pluginsLocalCol')}</span>
            <span className={css.pluginCellCat} />
          </div>
          {deps.map(([name, spec]) => {
            const category = localList.bundles.includes(name) ? 'bundle' : localList.clientLines.includes(name) ? 'client' : 'plain'
            const unsync = localList.unsyncable.find(item => item.name === name)
            return (
              <div key={name} className={clsx(css.pluginRow, css.pluginRowLocal, unsync !== undefined && css.pluginRowGray)}>
                <label className={clsx(css.pluginCell, css.pluginCellName)}>
                  <code className={css.pluginName}>{name}</code>
                </label>
                <span className={clsx(css.pluginCell, css.pluginCellCat)}>
                  <span className={clsx(css.pluginKindBadge, category === 'bundle' && css.pluginKindBundle, category === 'client' && css.pluginKindClient, category === 'plain' && css.pluginKindPlain)}>
                    {t(categoryLabel(category))}
                  </span>
                </span>
                <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                  <code className={css.pluginSpec} title={unsync?.reason}>{spec}</code>
                  {unsync !== undefined ? <span className={css.pluginKindUnsync}> · {t('pluginsRowUnsyncable')}</span> : null}
                </span>
                <button
                  type="button"
                  className={css.iconButton}
                  disabled={localRemoveBusy || applying}
                  data-tip={t('pluginsRemoveRow')}
                  aria-label={`${t('pluginsRemoveRow')}: ${name}`}
                  onClick={() => { setLocalRemoveTarget(name); setLocalRemoveError(null) }}
                >
                  <IconTrashOutline16 />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  /**
   * The REMOTE installed-plugins list (design 21 §6.6 次序② ssh 增量): the
   * third-party subset of the (main-side masked) remote manifest — official/
   * chamber domains are reserved and never listed here (deny mirror, same
   * predicate the model and the main process share). Per-row remove forwards
   * through the same ssh plugin_apply flow; the header carries the
   * 「撤销最近变更」 entry into the main-process undo journal. Rows ride the
   * sync projection, so the loading/error phases share the sync tab's views
   * verbatim. SSH-equivalence guardrails: local-mode code paths, existing tab
   * labels/positions, and the sync/add views are untouched; every new key is
   * from the Phase-5 family already in locales.ts (0 locale edits).
   */
  function renderRemoteList(): ReactNode {
    // The sync tab owns the phase machine; the list rows ride its projection,
    // so the load/error views are the sync ones (identical recovery surface).
    if (phase === 'loading' || phase === 'error') return renderSyncView()
    if (remoteManifest === null) return <p className={css.dim}>{t('pluginsLoading')}</p>
    const deps = Object.entries(remoteManifest.dependencies)
      .filter(([name]) => !isDeniedPluginName(name))
    const opBusy = remoteRemoveBusy || undoBusy
    const opsBlocked = opBusy || applying || seedBusy || restartBusy
    const statusTone = remoteListStatus?.tone
    return (
      <div className={css.pluginStack}>
        {/* ssh backend has no defer/cache surface: an absent profile is
            auto-created on the next apply — same copy as the sync tab
            (gateway keeps profileAbsentBanner's cache-intent copy). */}
        {profileNotInit ? <p className={css.pluginBanner} role="status">{t('pluginsProfileNotInitialized')}</p> : null}
        <div className={css.pluginToolbar}>
          <Button variant="ghost" size="sm" disabled={opsBlocked} onClick={() => { void doUndo() }}>
            {t('undoAvailable')}
          </Button>
        </div>
        {remoteListStatus !== null
          ? (
            <p className={remoteStatusClass(statusTone ?? 'ok')} role={statusTone === 'error' ? 'alert' : 'status'}>
              {remoteListStatus.text}
            </p>
          )
          : null}
        {profileNotInit
          ? null
          : deps.length === 0
            ? <p className={css.dim}>{t('installedEmpty')}</p>
            : (
              <div className={css.pluginRows}>
                <div className={clsx(css.pluginRow, css.pluginRowRemote, css.pluginRowHead)}>
                  <span className={css.pluginCellName}>{t('pluginsColName')}</span>
                  <span className={css.pluginCellSpec}>{t('pluginsRemoteCol')}</span>
                  <span className={css.pluginCellCat} />
                </div>
                {deps.map(([name, spec]) => (
                  // The row and its under-row error note are adjacent list
                  // entries (the .pluginRows column gap spaces them) so a
                  // failed remove — the row is still installed — keeps its
                  // verbatim failure visible for retry.
                  <Fragment key={name}>
                    <div className={clsx(css.pluginRow, css.pluginRowRemote)}>
                      <label className={clsx(css.pluginCell, css.pluginCellName)}>
                        <code className={css.pluginName}>{name}</code>
                      </label>
                      <span className={clsx(css.pluginCell, css.pluginCellSpec)}>
                        {/* file: values are the main-side mask of remote
                            materialized copies — never a remote path in the
                            renderer; the chip names what it is. */}
                        {spec.startsWith('file:')
                          ? <span className={clsx(css.pluginKindBadge, css.pluginKindPlain)}>{t('installedFromMask')}</span>
                          : <code className={css.pluginSpec}>{spec}</code>}
                      </span>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={opsBlocked}
                        data-tip={t('pluginsRemoveRow')}
                        aria-label={`${t('pluginsRemoveRow')}: ${name}`}
                        onClick={() => { setRemoteRemoveTarget(name) }}
                      >
                        <IconTrashOutline16 />
                      </button>
                    </div>
                    {remoteRowErrors[name] !== undefined
                      ? <p className={css.error} role="alert">{remoteRowErrors[name]}</p>
                      : null}
                  </Fragment>
                ))}
              </div>
            )}
      </div>
    )
  }
}
