/**
 * Host-key trust panel (P0-3, minimal M0 entry): the smallest actionable surface for a
 * userActionKind 'hostkey' failure — the presented fingerprint, an explicit changed-key warning,
 * and one「信任并连接」button that runs probe → trust → reconnect. It is deliberately NOT the full
 * M1 dialog (no re-import / no old-vs-new diff table); the desktop projection carries the facts.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopSshSurface, SshInstanceSpec, SshStatusProjection } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { hostKeyTrustActionable, hostKeyTrustView, probeAndTrustHostKey } from './host-key-trust.ts'
import css from './ConnectionsSection.module.css'

export interface HostKeyTrustProps {
  spec: SshInstanceSpec
  status: SshStatusProjection | undefined
  t: (key: SettingsConnectionsKey) => string
  /** The card's own busy/connecting gate (no double action while the tunnel is moving). */
  busy: boolean
  /** The page-level desktop bridge (null while hydrating). */
  bridge: DesktopSshSurface | null
  /** Reconnect after a successful trust write. */
  onTrusted: () => void
}

/** The host-key fingerprint panel; renders nothing unless the failure class is 'hostkey'. */
export function HostKeyTrust({ spec, status, t, busy, bridge, onTrusted }: HostKeyTrustProps): ReactNode {
  const view = hostKeyTrustView(status)
  const [trusting, setTrusting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trust = useCallback(async (): Promise<void> => {
    if (bridge === null || trusting) return
    setTrusting(true)
    setError(null)
    try {
      const outcome = await probeAndTrustHostKey(bridge, spec.id)
      if (!outcome.ok) {
        setError(outcome.error)
        return
      }
      onTrusted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTrusting(false)
    }
  }, [bridge, onTrusted, spec.id, trusting])
  if (view === null) return null
  const actionable = hostKeyTrustActionable(view, busy, trusting)
  return (
    <div className={css.hint} data-host-key-trust={spec.id}>
      <p>{t('hostKeyTrustTitle')}</p>
      {view.changed ? <p className={css.error} role="alert">{t('hostKeyTrustChanged')}</p> : null}
      {view.unavailable ? <p className={css.error} role="alert">{t('hostKeyTrustUnavailable')}</p> : null}
      {view.previousFingerprints.map(fingerprint => (
        <p key={'old-' + fingerprint} className={css.mono}>{t('hostKeyTrustPrevious')}: {fingerprint}</p>
      ))}
      {view.fingerprints.map(fingerprint => (
        <p key={'new-' + fingerprint} className={css.mono}>{t('hostKeyTrustFingerprint')}: {fingerprint}</p>
      ))}
      {error !== null ? <p className={css.error} role="alert">{t('hostKeyTrustFailed').replace('{error}', error)}</p> : null}
      <Button variant="primary" size="sm" disabled={!actionable} onClick={() => { void trust() }}>
        {trusting ? t('hostKeyTrustBusy') : t('hostKeyTrustAction')}
      </Button>
    </div>
  )
}
