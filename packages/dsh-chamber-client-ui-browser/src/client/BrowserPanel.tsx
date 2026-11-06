/**
 * Remote Browser launcher (design 28): address bar + per-source remote-loopback
 * forward list; the local instance renders only the address bar (a loopback
 * address is this machine, so it opens there instead of forwarding).
 *
 * What it does
 *  - parses the typed address with the pure host/scheme table
 *    (src/shared/address.ts) and plans one action (system-browser link leg or
 *    a forward through the trusted bridge);
 *  - polls `forward.list` (v1 has no push channel) and renders bound / binding
 *    / error / stale rows with open / reopen / close;
 *  - renders loading, empty, missing-bridge and error states with localized copy
 *    and `role="alert"` announcements.
 *
 * What it never does: embed a page (no iframe/webview), build a forward URL,
 * pass a URL to main, or own a forward's lifetime. A public URL uses the
 * existing system-browser link leg; a remote loopback URL is opened by main
 * from the record id + validated path.
 *
 * TODO(W0/pin): the exact slot `inject` hook signature is the pinned vendor's
 * (rc.2 passes `(sessionId, actions)` to a factory whose result is spread as
 * props). This component only reads the injected object, so a signature change
 * touches src/client/index.ts, not this file. Swift routing is inspected in
 * MainWindowController.createWebViewWith: a target=_blank external http(s)
 * navigation is handed to NSWorkspace before the new window is denied; the S3
 * drill still clicks this programmatic anchor end to end.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  parseBrowserAddress,
  type AddressRefusalReason,
} from '../shared/address.ts'
import {
  FORWARD_POLL_INTERVAL_MS,
  PER_SOURCE_FORWARD_LIMIT,
  parseForwardAck,
  parseForwardListResult,
  parseForwardRequestResult,
  type BrowserForwardBridge,
  type ForwardFailureCode,
  type ForwardRecord,
} from '../shared/forward-bridge.ts'
import type { BrowserSource } from '../shared/source.ts'
import {
  addressErrorKey,
  buildRemoteRows,
  forwardErrorKey,
  mergeForwardRecord,
  planAddressSubmit,
  sourceForwardLimitReached,
  type AddressPlan,
  type RemoteRow,
} from '../shared/launcher-model.ts'
import type { BrowserKey, BrowserTranslate } from '../locales.ts'
import styles from './BrowserPanel.module.css'

export interface BrowserPanelInjected {
  t: BrowserTranslate
  source: BrowserSource
  sourceFingerprint: string
  bridge: BrowserForwardBridge | null
}

export interface BrowserPanelProps extends BrowserPanelInjected {}

type ListPhase = 'loading' | 'ready' | 'error'

interface Notice {
  key: BrowserKey
  params?: Record<string, string | number>
}

export function BrowserPanel({ t, source, sourceFingerprint, bridge }: BrowserPanelProps) {
  const [draft, setDraft] = useState('')
  const [addressError, setAddressError] = useState<AddressRefusalReason | null>(null)
  const [actionError, setActionError] = useState<ForwardFailureCode | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [records, setRecords] = useState<ForwardRecord[]>([])
  const [listPhase, setListPhase] = useState<ListPhase>('loading')
  const [listError, setListError] = useState<ForwardFailureCode | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [busy, setBusy] = useState(false)
  const [busyRowId, setBusyRowId] = useState<string | null>(null)
  // A page can hold several N-ctx instances (and several open sessions), so the
  // address input id must be per-panel rather than a fixed string.
  const addressId = useId()
  // Last successfully opened path per record, so "reopen" keeps the user's page
  // (main still re-validates the path against the record's origin).
  const lastPaths = useRef(new Map<string, string>())

  useEffect(() => {
    // The local instance has no forward leg: the panel never polls or renders
    // the remote section for it (the address bar still opens on this machine).
    if (!source.mayForward || bridge === null) return
    let disposed = false
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const result = parseForwardListResult(await bridge.list({ sourceId: source.sourceId, sourceFingerprint }))
        if (disposed) return
        if (result.ok) {
          setRecords(result.records)
          setListPhase('ready')
          setListError(null)
        } else {
          setListPhase('error')
          setListError(result.code)
        }
      } catch {
        if (!disposed) {
          setListPhase('error')
          setListError('unknown')
        }
      } finally {
        inFlight = false
      }
    }
    setListPhase('loading')
    void tick()
    const timer = setInterval(() => { void tick() }, FORWARD_POLL_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [bridge, source.mayForward, source.sourceId, sourceFingerprint, reloadToken])

  const rows = useMemo(() => buildRemoteRows(records), [records])
  const limitReached = sourceForwardLimitReached(records)
  const errorKey = addressError !== null
    ? addressErrorKey(addressError)
    : actionError !== null ? forwardErrorKey(actionError) : null

  const clearFeedback = (): void => {
    setAddressError(null)
    setActionError(null)
    setNotice(null)
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    clearFeedback()
    const applicationOrigin = typeof window === 'undefined' ? undefined : window.location.origin
    const plan = planAddressSubmit(parseBrowserAddress(draft, { applicationOrigin }), source)
    if (plan.kind === 'reject') {
      setAddressError(plan.reason)
      return
    }
    if (plan.kind === 'system-browser') {
      openSystemLink(plan.url)
      setNotice({
        key: plan.reachability === 'local-machine'
          ? 'notice.localMachine'
          : plan.reachability === 'private-network' ? 'notice.privateNetwork' : 'notice.publicOpened',
      })
      return
    }
    void runForward(plan)
  }

  const runForward = async (plan: Extract<AddressPlan, { kind: 'forward' }>): Promise<void> => {
    if (!source.mayForward || bridge === null) {
      setActionError('unavailable')
      return
    }
    setBusy(true)
    try {
      const requested = parseForwardRequestResult(await bridge.request({
        sourceId: source.sourceId,
        sourceFingerprint,
        port: plan.port,
        scheme: plan.scheme,
      }))
      if (!requested.ok) {
        setActionError(requested.code)
        return
      }
      setRecords((previous) => mergeForwardRecord(previous, requested.record))
      lastPaths.current.set(requested.record.id, plan.requestPath)
      // request() keeps a failed record visible (auth/bind/spawn errors); never
      // call openInBrowser for it, or the user sees a misleading stale row and
      // a second error on top of the real failure.
      if (requested.record.state !== 'bound') return
      const opened = parseForwardAck(await bridge.openInBrowser({
        sourceId: source.sourceId,
        sourceFingerprint,
        id: requested.record.id,
        path: plan.requestPath,
      }))
      if (!opened.ok) {
        setActionError(opened.code)
        return
      }
      setNotice({ key: plan.certificateWarning ? 'address.httpsWarning' : 'notice.forwardOpened' })
    } catch {
      setActionError('unknown')
    } finally {
      setBusy(false)
    }
  }

  const openRow = async (row: RemoteRow): Promise<void> => {
    if (bridge === null) return
    setBusyRowId(row.id)
    setActionError(null)
    try {
      const opened = parseForwardAck(await bridge.openInBrowser({
        sourceId: source.sourceId,
        sourceFingerprint,
        id: row.id,
        path: lastPaths.current.get(row.id) ?? '/',
      }))
      if (!opened.ok) setActionError(opened.code)
    } catch {
      setActionError('unknown')
    } finally {
      setBusyRowId(null)
    }
  }

  const reopenRow = async (row: RemoteRow): Promise<void> => {
    if (bridge === null) return
    if (row.openable) {
      await openRow(row)
      return
    }
    // A stale/error record is released first: request() is idempotent on a
    // live record and would otherwise return the same failed record forever.
    const requestPath = lastPaths.current.get(row.id) ?? '/'
    setBusyRowId(row.id)
    setActionError(null)
    try {
      const released = parseForwardAck(await bridge.release({
        sourceId: source.sourceId,
        sourceFingerprint,
        id: row.id,
      }))
      if (!released.ok && released.code !== 'not-found') {
        setActionError(released.code)
        return
      }
      lastPaths.current.delete(row.id)
      setRecords((previous) => previous.filter((record) => record.id !== row.id))
    } catch {
      setActionError('unknown')
      return
    } finally {
      setBusyRowId(null)
    }
    await runForward({
      kind: 'forward',
      port: row.remotePort,
      scheme: row.scheme,
      path: requestPath,
      requestPath,
      certificateWarning: row.scheme === 'https',
    })
  }

  const closeRow = async (row: RemoteRow): Promise<void> => {
    if (bridge === null) return
    setBusyRowId(row.id)
    setActionError(null)
    try {
      const released = parseForwardAck(await bridge.release({
        sourceId: source.sourceId,
        sourceFingerprint,
        id: row.id,
      }))
      if (!released.ok) {
        setActionError(released.code)
        return
      }
      lastPaths.current.delete(row.id)
      setRecords((previous) => previous.filter((record) => record.id !== row.id))
    } catch {
      setActionError('unknown')
    } finally {
      setBusyRowId(null)
    }
  }

  return (
    <div className={styles.root} data-chamber-browser-panel="" data-source={source.sourceId} aria-busy={busy}>
      <form className={styles.toolbar} onSubmit={submit}>
        <label className={styles.addressLabel} htmlFor={addressId}>{t('address.label')}</label>
        <input
          id={addressId}
          className={styles.address}
          value={draft}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          placeholder={t('address.placeholder')}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? t('address.busy') : t('address.submit')}
        </button>
      </form>

      {errorKey !== null && <p className={styles.error} role="alert">{t(errorKey)}</p>}
      {notice !== null && <p className={styles.notice} role="status">{t(notice.key, notice.params)}</p>}

      {source.mayForward && (
        <section className={styles.section} aria-labelledby={`${addressId}-remote`}>
          <h2 className={styles.sectionTitle} id={`${addressId}-remote`}>{t('remote.section')}</h2>
          {bridge === null ? (
            <p className={styles.empty}>{t('remote.noBridge')}</p>
          ) : listPhase === 'error' ? (
            <div className={styles.listError} role="alert">
              <span>{t('remote.listFailed')}</span>
              <span>{listError === null ? '' : t(forwardErrorKey(listError))}</span>
              <button type="button" className={styles.linkButton} onClick={() => { setReloadToken((token) => token + 1) }}>
                {t('remote.retry')}
              </button>
            </div>
          ) : listPhase === 'loading' && rows.length === 0 ? (
            <p className={styles.empty}>{t('remote.loading')}</p>
          ) : rows.length === 0 ? (
            <p className={styles.empty}>{t('remote.empty')}</p>
          ) : (
            <ul className={styles.list}>
              {rows.map((row) => (
                <li key={row.id} className={styles.row} data-state={row.state} data-stale={row.stale ? 'true' : 'false'}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowPort}>{t('remote.port', { port: row.remotePort })}</span>
                    <code className={styles.rowUrl}>{row.displayUrl}</code>
                    <span className={styles.rowState}>{t(row.stateKey)}</span>
                  </div>
                  {row.closable && (
                    <div className={styles.rowActions}>
                      {(row.openable || row.reissuable) && (
                        <button
                          type="button"
                          className={styles.rowAction}
                          disabled={busy || busyRowId === row.id}
                          onClick={() => { void (row.openable ? openRow(row) : reopenRow(row)) }}
                        >
                          {t(row.actionKey)}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.rowAction}
                        disabled={busy || busyRowId === row.id}
                        onClick={() => { void closeRow(row) }}
                      >
                        {t('remote.close')}
                      </button>
                    </div>
                  )}
                  {row.errorCode !== undefined && <p className={styles.rowError}><code>{row.errorCode}</code></p>}
                </li>
              ))}
            </ul>
          )}
          {bridge !== null && rows.length > 0 && <p className={styles.hint}>{t('remote.sharedRisk')}</p>}
          {limitReached && <p className={styles.warning}>{t('remote.limit', { limit: PER_SOURCE_FORWARD_LIMIT })}</p>}
        </section>
      )}
    </div>
  )
}

/**
 * The system-browser link leg: a real anchor click, intercepted by the desktop
 * window-open fence (isExternalLinkUrl) and handed to the OS browser. The URL was
 * validated by parseBrowserAddress before this point; the launcher never renders
 * an anchor from raw input.
 *
 * Swift: MainWindowController.createWebViewWith routes a target=_blank external
 * http(s) click to NSWorkspace; the S3 drill still verifies this exact path.
 */
function openSystemLink(url: string): void {
  if (typeof document === 'undefined') return
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
