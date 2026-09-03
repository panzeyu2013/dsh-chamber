/**
 * Plugin inventory view for gateway connections (design 05 §5 / design 17):
 * the per-connection plugin surface for targets without the SSH exec
 * channel — gateway targets (both transports; the desktop SSH exec surface
 * refuses `kind !== 'dsh'`, design 17 §9.3) and dsh+http direct endpoints.
 *
 * Gateway management is NOT absent: chamber-injected components are synced
 * by the desktop main process through the gateway's own `/chamber/plugins`
 * channel at every ready registration (version-match skip, controlled
 * restart on change — see desktop gateway-provider.ts syncGatewayChamberPlugins)
 * and seeded into the managed profile at every spawn. This view is the
 * read-only READ side of that loop: it mirrors the SSH plugin dialog's sync
 * tab (PluginSyncModal.tsx) — the chamber 内建组件 block (local injection
 * state from the desktop's own local manifest, remote side from the managed
 * instance's LIVE Loader state) plus the third-party loaded plugins
 * (inventory entries minus official `@deepseek-ai/*` and the chamber
 * packages). Data rides the per-instance proxy
 * (`/api/i/<sourceId>/api/pluginInventory/list`, plugin-inventory-api.ts)
 * plus the same `localPluginList` IPC the SSH dialog uses; third-party
 * plugin install/manage happens on the server side (no gateway surface for
 * arbitrary packages — the seed registry whitelist is the bounded channel).
 *
 * Loading / failure states stay local to this component; a failed read can
 * be retried without exposing transport details.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsConnectionsKey } from '../locales.ts'
import { localPluginList } from './control-plane.ts'
import { loadPluginInventory, type PluginInventorySnapshot } from './plugin-inventory-api.ts'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  chamberRemoteKey,
  thirdPartyEntries,
} from './plugin-inventory-text.ts'
import { pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

type ViewPhase = 'loading' | 'error' | 'ready'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The inventory dialog.
 * @param props.sourceId - proxy source id of the target (`dsh-<id>` /
 *   `gateway-<id>`); the RPC rides `/api/i/<sourceId>/api/pluginInventory/list`.
 * @param props.label - connection label for the dialog title.
 * @param props.diagnostic - this instance's client-plugin runtime diagnostic
 *   (design 09 §3.5), shown as the same detail banner as the sync dialog.
 * @param props.onRecheckDiagnostic - host-provided CHANNEL-class self-heal
 *   recheck (design 09 §3.5): fired when the banner is visible on open and
 *   on every explicit 刷新, so a diagnostic that healed since the source's
 *   last shell boot clears without an app restart.
 */
export function PluginInventoryView({ t, sourceId, label, diagnostic, onRecheckDiagnostic, onClose }: {
  t: (key: SettingsConnectionsKey) => string
  sourceId: string
  label: string
  diagnostic?: PluginDiagnostic
  onRecheckDiagnostic?: () => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<ViewPhase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PluginInventorySnapshot | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // The LOCAL side of the chamber rows comes from the desktop's own profile
  // manifest — the exact source the SSH dialog's sync tab reads. Unreadable
  // (local instance not started) is the same loud hint, never a silent
  // "not injected". Re-runs on every reload so 刷新/重试 also refreshes the
  // local side (e.g. the local instance started while the dialog was open).
  const [localInjected, setLocalInjected] = useState<{ hostGraph: boolean; gitWorktree: boolean } | null>(null)
  const [localVersion, setLocalVersion] = useState<{ hostGraph: string | null; gitWorktree: string | null } | null>(null)
  const [localFailed, setLocalFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setError(null)
    loadPluginInventory(sourceId).then(next => {
      if (cancelled) return
      setSnapshot(next)
      setPhase('ready')
    }).catch(err => {
      if (cancelled) return
      setSnapshot(null)
      setError(errorMessage(err))
      setPhase('error')
    })
    return () => { cancelled = true }
  }, [sourceId, reloadNonce])

  useEffect(() => {
    let cancelled = false
    localPluginList().then(res => {
      if (cancelled) return
      if ('error' in res) {
        setLocalFailed(true)
        setLocalInjected(null)
        setLocalVersion(null)
        return
      }
      const chamber = res.manifest.chamber
      if (chamber.ok !== true) {
        setLocalFailed(true)
        setLocalInjected(null)
        setLocalVersion(null)
        return
      }
      setLocalFailed(false)
      setLocalInjected({
        hostGraph: chamber.hostGraph.installed && chamber.hostGraph.patched,
        gitWorktree: chamber.gitWorktree.installed && chamber.gitWorktree.patched,
      })
      setLocalVersion({
        hostGraph: chamber.hostGraph.version,
        gitWorktree: chamber.gitWorktree.version,
      })
    }).catch(() => {
      if (cancelled) return
      setLocalFailed(true)
      setLocalInjected(null)
      setLocalVersion(null)
    })
    return () => { cancelled = true }
  }, [reloadNonce])

  // Diagnostic self-heal (design 09 §3.5): the banner can describe the
  // source's LAST shell boot while the channel healed since (e.g. the
  // gateway's managed dsh restarted with the synced chamber host packages).
  // Whenever the banner shows a problem, ask the host to re-check — the host
  // runner re-verifies CHANNEL-class states only and skips boot-fact classes
  // without fetching, so this cannot loop (an explicit 刷新 re-checks too).
  useEffect(() => {
    if (diagnostic === undefined || diagnostic.state === 'ok') return
    onRecheckDiagnostic?.()
  }, [diagnostic?.state])

  const footer = ((): ReactNode => {
    if (phase === 'loading') return undefined
    if (phase === 'error') {
      return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { setReloadNonce(n => n + 1) }}>{t('pluginsRetry')}</Button>
    }
    return <Button variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { setReloadNonce(n => n + 1); onRecheckDiagnostic?.() }}>{t('pluginsRefresh')}</Button>
  })()

  const title = `${t('pluginsTitle')} · ${label}`
  const thirdParty = snapshot === null ? [] : thirdPartyEntries(snapshot)

  const chamberBlock = snapshot === null ? null : (
    <div className={css.pluginChamber}>
      <p className={css.pluginChamberTitle}>
        {t('chamberInjectedTitle')}
        <span className={css.dim}> · {t('chamberInjectedHint')}</span>
      </p>
      <div className={css.pluginChamberRow}>
        <code className={css.pluginName}>{HOST_GRAPH_PACKAGE}</code>
        {localVersion?.hostGraph !== null && localVersion !== null
          ? <span className={css.dim}> · v{localVersion.hostGraph}</span>
          : null}
        <span className={css.pluginCellSpec}>
          {localInjected === null && !localFailed
            ? <span>—</span>
            : <span>{localInjected?.hostGraph === true ? t('chamberLocalInjected') : t('chamberLocalNotInjected')}</span>}
          <span> · {t(chamberRemoteKey(snapshot.entries, HOST_GRAPH_PACKAGE))}</span>
        </span>
      </div>
      <div className={css.pluginChamberRow}>
        <code className={css.pluginName}>{GIT_WORKTREE_PACKAGE}</code>
        {localVersion?.gitWorktree !== null && localVersion !== null
          ? <span className={css.dim}> · v{localVersion.gitWorktree}</span>
          : null}
        <span className={css.pluginCellSpec}>
          {localInjected === null && !localFailed
            ? <span>—</span>
            : <span>{localInjected?.gitWorktree === true ? t('chamberInstalled') : t('chamberNotInstalled')}</span>}
          <span> · {t(chamberRemoteKey(snapshot.entries, GIT_WORKTREE_PACKAGE))}</span>
        </span>
      </div>
      {localFailed ? <p className={css.hint}>{t('pluginsStartLocalFirst')}</p> : null}
    </div>
  )

  return (
    <Modal
      open
      onClose={onClose}
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
      {phase === 'loading'
        ? <p className={css.dim}>{t('pluginsLoading')}</p>
        : phase === 'error'
          ? <p className={css.error} role="alert">{error !== null ? error : t('inventoryError')}</p>
          : snapshot === null
            ? <p className={css.dim}>{t('inventoryError')}</p>
            : (
            <div className={css.pluginStack}>
              {chamberBlock}
              {thirdParty.length === 0
                ? <p className={css.dim}>{t('inventoryNoThirdParty')}</p>
                : (
                <div className={css.pluginStack}>
                  {thirdParty.map(entry => (
                    <div key={entry.entryId} className={css.pluginChamberRow}>
                      <code className={css.pluginName}>{entry.moduleName}</code>
                      {!entry.enabled
                        ? <span className={css.dim}>{t('pluginDisabled')}</span>
                        : null}
                      {entry.fiberPhase === 'failed'
                        ? <span className={css.error}>{t('pluginPhaseFailed')}</span>
                        : null}
                    </div>
                  ))}
                </div>
                )}
            </div>
            )}
    </Modal>
  )
}
