/** Gateway-only orchestration settings surface (design 17 §8.5). */
import { useEffect, useMemo, useState } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import {
  GatewayOrchestrationApi,
  buildGatewayQuestionAnswer,
  type GatewayInteraction,
  type GatewayQuestion,
  type GatewayQuestionAnswer,
  type GatewayScheduledJob,
  type GatewaySession,
  type GatewaySettings,
  type GatewaySettingsPatch,
  type GatewayWorktree,
} from './gateway-orchestration-api.ts'
import css from './SettingsShell.module.css'

type Translate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

interface Resource<T> {
  value: T | null
  loading: boolean
  error: string | null
}

interface GatewayData {
  settings: Resource<GatewaySettings>
  sessions: Resource<GatewaySession[]>
  interactions: Resource<GatewayInteraction[]>
  schedule: Resource<GatewayScheduledJob[]>
  worktrees: Resource<GatewayWorktree[]>
}

const emptyResource = <T,>(): Resource<T> => ({ value: null, loading: true, error: null })

function emptyData(): GatewayData {
  return {
    settings: emptyResource(),
    sessions: emptyResource(),
    interactions: emptyResource(),
    schedule: emptyResource(),
    worktrees: emptyResource(),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTimestamp(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return String(value)
  }
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value}ms`
  if (value < 60_000) return `${Math.round(value / 1_000)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  return `${Math.round(value / 3_600_000)}h`
}

function ResourceState({ resource, empty, t }: {
  resource: Resource<unknown[]>
  empty: string
  t: Translate
}) {
  if (resource.value === null && resource.loading) return <p className={css.gatewayMuted}>{t('gatewayLoading')}</p>
  if (resource.value?.length === 0 && resource.error === null) return <p className={css.gatewayMuted}>{empty}</p>
  return resource.error === null ? null : <p role="alert" className={css.gatewayError}>{resource.error}</p>
}

function QuestionCard({ request, busy, t, onAnswer }: {
  request: GatewayQuestion
  busy: boolean
  t: Translate
  onAnswer: (rpcId: string, answer: GatewayQuestionAnswer) => Promise<void>
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})

  const select = (questionId: string, label: string, multiSelect: boolean, checked: boolean): void => {
    setSelected(current => {
      if (!multiSelect) return { ...current, [questionId]: checked ? [label] : [] }
      const values = current[questionId] ?? []
      const next = checked ? [...new Set([...values, label])] : values.filter(value => value !== label)
      return { ...current, [questionId]: next }
    })
  }

  return (
    <article className={css.gatewayInteraction}>
      <div className={css.gatewayRowHead}>
        <strong>{t('gatewayQuestion')}</strong>
        <code>{request.sessionId}</code>
      </div>
      {request.questions.map(question => (
        <fieldset key={question.id} className={css.gatewayQuestionGroup} disabled={busy}>
          <legend>{question.header ?? question.question}</legend>
          {question.header !== undefined && <p className={css.gatewayQuestionText}>{question.question}</p>}
          {question.detail !== undefined && <p className={css.gatewayMuted}>{question.detail}</p>}
          <div className={css.gatewayChoices}>
            {question.options.map(option => {
              const checked = (selected[question.id] ?? []).includes(option.label)
              return (
                <label key={option.label} className={css.gatewayChoice}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`gateway-question-${request.rpcId}-${question.id}`}
                    checked={checked}
                    onChange={event => select(question.id, option.label, question.multiSelect, event.target.checked)}
                  />
                  <span>
                    <span>{option.label}</span>
                    {option.description !== undefined && <small>{option.description}</small>}
                  </span>
                </label>
              )
            })}
          </div>
          <label className={css.gatewayCustomAnswer}>
            <span>{t('gatewayCustomAnswer')}</span>
            <input
              type="text"
              value={custom[question.id] ?? ''}
              onChange={event => setCustom(current => ({ ...current, [question.id]: event.target.value }))}
            />
          </label>
        </fieldset>
      ))}
      <button
        type="button"
        className={css.gatewayPrimaryButton}
        disabled={busy}
        onClick={() => void onAnswer(request.rpcId, buildGatewayQuestionAnswer(request, selected, custom))}
      >
        {busy ? t('gatewaySubmitting') : t('gatewaySubmitAnswer')}
      </button>
    </article>
  )
}

/**
 * A gateway surface is mounted only for a connected `kind:'gateway'` server.
 * Its source id is canonical and the API client derives every path from it.
 */
export function GatewayOrchestrationView({ sourceId, t }: { sourceId: string; t: Translate }) {
  const api = useMemo(() => new GatewayOrchestrationApi(sourceId), [sourceId])
  const [data, setData] = useState<GatewayData>(emptyData)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [settingsDraft, setSettingsDraft] = useState<GatewaySettingsPatch>({
    git: { enabled: false },
    notifications: { enabled: false },
    schedule: { enabled: false },
  })
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let polling = false
    setData(emptyData())
    setSettingsDirty(false)
    setActionError(null)

    const loadSettings = async (): Promise<void> => {
      try {
        const value = await api.settings()
        if (cancelled) return
        setData(current => ({ ...current, settings: { value, loading: false, error: null } }))
        setSettingsDraft({
          git: { enabled: value.git?.enabled === true },
          notifications: { enabled: value.notifications?.enabled === true },
          schedule: { enabled: value.schedule?.enabled === true },
        })
      } catch (error) {
        if (!cancelled) setData(current => ({
          ...current,
          settings: { ...current.settings, loading: false, error: message(error) },
        }))
      }
    }

    const loadLive = async (initial: boolean): Promise<void> => {
      if (polling) return
      polling = true
      if (initial) {
        setData(current => ({
          ...current,
          sessions: { ...current.sessions, loading: true },
          interactions: { ...current.interactions, loading: true },
          schedule: { ...current.schedule, loading: true },
          worktrees: { ...current.worktrees, loading: true },
        }))
      }
      await Promise.allSettled([
        api.sessions().then(value => {
          if (!cancelled) setData(current => ({ ...current, sessions: { value, loading: false, error: null } }))
        }).catch(error => {
          if (!cancelled) setData(current => ({
            ...current, sessions: { ...current.sessions, loading: false, error: message(error) },
          }))
        }),
        api.interactions().then(value => {
          if (!cancelled) setData(current => ({ ...current, interactions: { value, loading: false, error: null } }))
        }).catch(error => {
          if (!cancelled) setData(current => ({
            ...current, interactions: { ...current.interactions, loading: false, error: message(error) },
          }))
        }),
        api.schedule().then(value => {
          if (!cancelled) setData(current => ({ ...current, schedule: { value, loading: false, error: null } }))
        }).catch(error => {
          if (!cancelled) setData(current => ({
            ...current, schedule: { ...current.schedule, loading: false, error: message(error) },
          }))
        }),
        api.worktrees().then(value => {
          if (!cancelled) setData(current => ({ ...current, worktrees: { value, loading: false, error: null } }))
        }).catch(error => {
          if (!cancelled) setData(current => ({
            ...current, worktrees: { ...current.worktrees, loading: false, error: message(error) },
          }))
        }),
      ])
      polling = false
    }

    void loadSettings()
    void loadLive(true)
    // JSON polling is deliberately bounded and generation-scoped. It avoids a
    // long-lived EventSource credential surface while still keeping pending
    // interactions and orchestration projections current.
    const timer = window.setInterval(() => { void loadLive(false) }, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api, refreshNonce])

  const updateToggle = (key: keyof GatewaySettingsPatch, enabled: boolean): void => {
    setSettingsDraft(current => ({ ...current, [key]: { enabled } }))
    setSettingsDirty(true)
  }

  const saveSettings = async (): Promise<void> => {
    setBusyAction('settings')
    setActionError(null)
    try {
      const value = await api.updateSettings(settingsDraft)
      setData(current => ({ ...current, settings: { value, loading: false, error: null } }))
      setSettingsDraft({
        git: { enabled: value.git?.enabled === true },
        notifications: { enabled: value.notifications?.enabled === true },
        schedule: { enabled: value.schedule?.enabled === true },
      })
      setSettingsDirty(false)
    } catch (error) {
      setActionError(message(error))
    } finally {
      setBusyAction(null)
    }
  }

  const answerApproval = async (rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
    setBusyAction(rpcId)
    setActionError(null)
    try {
      await api.answerApproval(rpcId, outcome)
      setData(current => ({
        ...current,
        interactions: {
          ...current.interactions,
          value: current.interactions.value?.filter(item => item.rpcId !== rpcId) ?? null,
          error: null,
        },
      }))
    } catch (error) {
      setActionError(message(error))
    } finally {
      setBusyAction(null)
    }
  }

  const answerQuestion = async (rpcId: string, answer: GatewayQuestionAnswer): Promise<void> => {
    setBusyAction(rpcId)
    setActionError(null)
    try {
      await api.answerQuestion(rpcId, answer)
      setData(current => ({
        ...current,
        interactions: {
          ...current.interactions,
          value: current.interactions.value?.filter(item => item.rpcId !== rpcId) ?? null,
          error: null,
        },
      }))
    } catch (error) {
      setActionError(message(error))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className={css.gatewaySurface}>
      <div className={css.gatewayTitleRow}>
        <div>
          <h2>{t('gatewayTitle')}</h2>
          <p>{t('gatewayIntro')}</p>
        </div>
        <button type="button" className={css.gatewayButton} onClick={() => setRefreshNonce(value => value + 1)}>
          {t('gatewayRefresh')}
        </button>
      </div>
      {actionError !== null && <p role="alert" className={css.gatewayError}>{actionError}</p>}

      <section className={css.gatewayCard} aria-labelledby={`gateway-settings-${sourceId}`}>
        <h3 id={`gateway-settings-${sourceId}`}>{t('gatewaySettingsTitle')}</h3>
        {data.settings.error !== null && <p role="alert" className={css.gatewayError}>{data.settings.error}</p>}
        {data.settings.value === null && data.settings.loading ? (
          <p className={css.gatewayMuted}>{t('gatewayLoading')}</p>
        ) : data.settings.value !== null ? (
          <>
            <div className={css.gatewayToggles}>
              <label><input type="checkbox" checked={settingsDraft.git.enabled} onChange={event => updateToggle('git', event.target.checked)} />{t('gatewaySettingGit')}</label>
              <label><input type="checkbox" checked={settingsDraft.notifications.enabled} onChange={event => updateToggle('notifications', event.target.checked)} />{t('gatewaySettingNotifications')}</label>
              <label><input type="checkbox" checked={settingsDraft.schedule.enabled} onChange={event => updateToggle('schedule', event.target.checked)} />{t('gatewaySettingSchedule')}</label>
            </div>
            <div className={css.gatewayCardActions}>
              {data.settings.value.revision !== undefined && <span className={css.gatewayMuted}>{t('gatewayRevision', { revision: data.settings.value.revision })}</span>}
              <button
                type="button"
                className={css.gatewayPrimaryButton}
                disabled={!settingsDirty || busyAction === 'settings'}
                onClick={() => void saveSettings()}
              >
                {busyAction === 'settings' ? t('gatewaySaving') : t('gatewaySaveSettings')}
              </button>
            </div>
          </>
        ) : null}
      </section>

      <section className={css.gatewayCard}>
        <h3>{t('gatewayPendingTitle', { count: data.interactions.value?.length ?? 0 })}</h3>
        <ResourceState resource={data.interactions} empty={t('gatewayPendingEmpty')} t={t} />
        <div className={css.gatewayList}>
          {data.interactions.value?.map(interaction => interaction.kind === 'approval' ? (
            <article key={interaction.rpcId} className={css.gatewayInteraction}>
              <div className={css.gatewayRowHead}>
                <strong>{t('gatewayApproval')}</strong>
                <code>{interaction.sessionId}</code>
              </div>
              <p>{interaction.toolName}</p>
              {interaction.reason !== undefined && <p className={css.gatewayMuted}>{interaction.reason}</p>}
              <div className={css.gatewayCardActions}>
                <button type="button" className={css.gatewayButton} disabled={busyAction === interaction.rpcId} onClick={() => void answerApproval(interaction.rpcId, 'rejected')}>{t('gatewayReject')}</button>
                <button type="button" className={css.gatewayPrimaryButton} disabled={busyAction === interaction.rpcId} onClick={() => void answerApproval(interaction.rpcId, 'allowed-once')}>{t('gatewayAllowOnce')}</button>
              </div>
            </article>
          ) : (
            <QuestionCard key={interaction.rpcId} request={interaction} busy={busyAction === interaction.rpcId} t={t} onAnswer={answerQuestion} />
          ))}
        </div>
      </section>

      <section className={css.gatewayCard}>
        <h3>{t('gatewaySessionsTitle', { count: data.sessions.value?.length ?? 0 })}</h3>
        <ResourceState resource={data.sessions} empty={t('gatewaySessionsEmpty')} t={t} />
        <div className={css.gatewayList}>
          {data.sessions.value?.map(session => (
            <article key={session.sessionId} className={css.gatewayCompactRow}>
              <div className={css.gatewayRowHead}>
                <strong>{session.title ?? session.sessionId}</strong>
                <span>{session.running ? t('gatewayRunning') : t('gatewayStopped')}</span>
              </div>
              {session.title !== undefined && <code>{session.sessionId}</code>}
              {session.cwd !== undefined && <code>{session.cwd}</code>}
              <small>{formatTimestamp(session.updatedAt)}</small>
            </article>
          ))}
        </div>
      </section>

      <section className={css.gatewayCard}>
        <h3>{t('gatewayScheduleTitle', { count: data.schedule.value?.length ?? 0 })}</h3>
        <ResourceState resource={data.schedule} empty={t('gatewayScheduleEmpty')} t={t} />
        <div className={css.gatewayList}>
          {data.schedule.value?.map(job => (
            <article key={job.id} className={css.gatewayCompactRow}>
              <div className={css.gatewayRowHead}>
                <strong>{job.targetSessionId}</strong>
                <span>{job.intervalMs === null ? t('gatewayOnce') : t('gatewayRepeats')}</span>
              </div>
              <p className={css.gatewayPrompt}>{job.prompt}</p>
              <small>{t('gatewayDelay', { delay: formatDuration(job.delayMs) })}{job.intervalMs === null ? '' : ` · ${t('gatewayInterval', { interval: formatDuration(job.intervalMs) })}`}</small>
            </article>
          ))}
        </div>
      </section>

      <section className={css.gatewayCard}>
        <h3>{t('gatewayWorktreesTitle', { count: data.worktrees.value?.length ?? 0 })}</h3>
        <ResourceState resource={data.worktrees} empty={t('gatewayWorktreesEmpty')} t={t} />
        <div className={css.gatewayList}>
          {data.worktrees.value?.map(worktree => (
            <article key={worktree.workspaceId} className={css.gatewayCompactRow}>
              <div className={css.gatewayRowHead}>
                <strong>{worktree.branch}</strong>
                <span>{worktree.state}</span>
              </div>
              <code>{worktree.path}</code>
              {worktree.sessionId !== undefined && <small>{t('gatewaySessionRef', { sessionId: worktree.sessionId })}</small>}
              {worktree.error !== undefined && <p className={css.gatewayError}>{worktree.error}</p>}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
