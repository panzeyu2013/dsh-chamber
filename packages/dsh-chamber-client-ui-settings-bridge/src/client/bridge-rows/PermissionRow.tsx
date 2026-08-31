/**
 * Bridge permission preference row (self-built mirror of the official
 * ui-permission-presets PermissionRow — reads/writes the same `permission`
 * settings fact; the full-access pick keeps the same risk gate, and
 * current-session switches remain on the official /permission control of
 * the instance views).
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Menu, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionSettingsState } from './permission-row-controller.ts'
import { FULL_ACCESS_PRESET } from './permission-decode.ts'
import css from './PermissionRow.module.css'

/** Full Settings-row props (bridge-outlet kit + the injected face). */
export interface PermissionRowProps {
  usePermission: SnapshotSelectorHook<PermissionSettingsState>
  load: () => Promise<void>
  select: (preset: string) => Promise<void>
  t: (key: string) => string
}

/**
 * Render the new-session Permission default selector.
 * @param props - bridge-outlet composed slot props.
 * @returns the row, or null when the host does not expose permission settings.
 */
export function PermissionRow({ load, select, usePermission, t }: PermissionRowProps): ReactNode {
  const state = usePermission(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.writable && state.status !== 'unavailable') return
    setOpen(false)
    setAcknowledged(false)
    setConfirmingFullAccess(false)
  }, [state.status, state.writable])

  if (state.status === 'unavailable') return null
  const selected = state.options.find(option => option.id === state.currentValue)
  const busy = state.status === 'loading' || state.status === 'saving' || confirmingFullAccess
  const label = selected?.label
    ?? (busy ? t('loading') : t('unavailable'))
  const description: string = state.error ?? t('description')

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('title')}</div>
          <div className={css.desc} role={state.error === null ? undefined : 'alert'}>{description}</div>
        </div>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={state.options.map(option => ({ id: option.id, label: option.label }))}
          selectedId={state.currentValue}
          onSelect={(id) => {
            setOpen(false)
            if (id === state.currentValue) return
            if (id === FULL_ACCESS_PRESET) {
              setAcknowledged(false)
              setConfirmingFullAccess(true)
              return
            }
            void select(id)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={busy || !state.writable || state.options.length === 0}
              onClick={() => { setOpen(value => !value) }}
            >
              {label}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />
      </div>
      <RiskConfirmation
        open={confirmingFullAccess}
        title={t('confirm.title')}
        description={t('confirm.description')}
        closeLabel={t('confirm.close')}
        acknowledgeLabel={t('confirm.acknowledge')}
        cancelLabel={t('confirm.cancel')}
        confirmLabel={t('confirm.enable')}
        acknowledged={acknowledged}
        disabled={!state.writable || state.status === 'saving'}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => {
          setAcknowledged(false)
          setConfirmingFullAccess(false)
        }}
        onConfirm={() => {
          setAcknowledged(false)
          setConfirmingFullAccess(false)
          void select(FULL_ACCESS_PRESET)
        }}
      />
    </>
  )
}
