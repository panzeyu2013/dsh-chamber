/**
 * Bridge General-settings row for the composer's busy-state Enter preference
 * (self-built mirror of the official ui-conversation EnterBehaviorRow — the
 * official component is not importable and its owning plugin cannot run on
 * the child context; the row reads/writes the same `ui-conversation`
 * settings fact through the bridge controller).
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { BusyEnterBehavior } from './enter-row-controller.ts'
import { BUSY_ENTER_BEHAVIORS, DEFAULT_BUSY_ENTER_BEHAVIOR } from './enter-row-controller.ts'
import css from './EnterBehaviorRow.module.css'

/** Full Settings-row props (bridge-outlet kit + the injected face). */
export interface EnterBehaviorRowProps {
  useBusyEnter: SnapshotSelectorHook<BusyEnterBehavior>
  setBusyEnter: (behavior: BusyEnterBehavior) => void
  t: (key: string) => string
}

const OPTIONS: readonly { id: BusyEnterBehavior; label: string }[] = BUSY_ENTER_BEHAVIORS.map(id => ({
  id,
  label: `settings.enter.${id}`,
}))

/**
 * Render the busy-state Enter behavior selector.
 * @param props - bridge-outlet composed slot props.
 * @returns the preference row.
 */
export function EnterBehaviorRow({ useBusyEnter, setBusyEnter, t }: EnterBehaviorRowProps): ReactNode {
  const behavior = useBusyEnter(value => value)
  const [open, setOpen] = useState(false)
  const selectedLabel = behavior === DEFAULT_BUSY_ENTER_BEHAVIOR ? 'settings.enter.queue' : 'settings.enter.steer'

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.enter.title')}</div>
        <div className={css.desc}>{t('settings.enter.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={behavior}
        onSelect={(id) => {
          setOpen(false)
          setBusyEnter(id as BusyEnterBehavior)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(selectedLabel)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
