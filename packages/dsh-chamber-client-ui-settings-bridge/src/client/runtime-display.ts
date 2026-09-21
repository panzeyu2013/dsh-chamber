/**
 * Pure display projections for the dsh-runtime section (2026-12 audit phase 3):
 * badge maps, timestamp/registry-error/metadata-component formatting. Moved
 * verbatim out of DshRuntimeSection.tsx; the component keeps orchestration and
 * JSX. No React imports — plain formatting/mapping functions only. Also owns
 * the section RuntimeTranslate alias so component and helpers share one signature.
 */
import css from './SettingsShell.module.css'
import type { SettingsBridgeKey } from '../locales.ts'
import type {
  RuntimeBadgeLabel,
  RuntimeBadgeTone,
  RuntimeMetadataComponent,
} from '../../../../packages/renderer/src/runtime-management.ts'

export type RuntimeTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

export const RUNTIME_BADGE_KEYS: Record<RuntimeBadgeLabel, SettingsBridgeKey> = {
  ok: 'dshRuntimeBadgeOk',
  checking: 'dshRuntimeBadgeChecking',
  downloading: 'dshRuntimeBadgeDownloading',
  installing: 'dshRuntimeBadgeInstalling',
  pending: 'dshRuntimeBadgePending',
  applying: 'dshRuntimeBadgeApplying',
  'rolling-back': 'dshRuntimeBadgeRollingBack',
  restarting: 'dshRuntimeBadgeRestarting',
  'swap-attempted': 'dshRuntimeBadgeSwapAttempted',
  'snapshot-failed': 'dshRuntimeBadgeSnapshotFailed',
  'restore-blocked': 'dshRuntimeBadgeRestoreBlocked',
  blocked: 'dshRuntimeBadgeBlocked',
  failed: 'dshRuntimeBadgeFailed',
  error: 'dshRuntimeBadgeError',
  metadata: 'dshRuntimeBadgeMetadata',
}

export const RUNTIME_BADGE_TONE_CLASS: Record<RuntimeBadgeTone, string> = {
  ok: css.runtimeBadgeOk,
  busy: css.runtimeBadgeBusy,
  warn: css.runtimeBadgeWarn,
  danger: css.runtimeBadgeDanger,
}

export function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const locale = typeof document !== 'undefined' && document.documentElement.lang !== ''
    ? document.documentElement.lang
    : 'zh-CN'
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return value
  }
}

/** Map the main-process registry patch failures to localized copy by their
 *  stable machine-readable `code` (never by display-text matching — the main
 *  process may reword `error` without notice). Known codes become dictionary
 *  keys; anything unknown stays honest and raw. */
export function localizeRegistryError(code: string | undefined, error: string, t: RuntimeTranslate): string {
  if (code === 'invalid-registry-origin') {
    return t('dshRuntimeRegistryInvalidOrigin')
  }
  return error
}

export function metadataComponentText(component: RuntimeMetadataComponent, t: RuntimeTranslate): string {
  switch (component) {
    case 'current': return t('dshRuntimeMetadataComponentCurrent')
    case 'override': return t('dshRuntimeMetadataComponentOverride')
    case 'activation-journal': return t('dshRuntimeMetadataComponentJournal')
    case 'recovery-marker': return t('dshRuntimeMetadataComponentRecoveryMarker')
    case 'retained-evidence': return t('dshRuntimeMetadataComponentEvidence')
  }
}
