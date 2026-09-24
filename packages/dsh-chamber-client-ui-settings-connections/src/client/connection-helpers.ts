/**
 * Pure derivation/format helpers for the connections section: the section component keeps
 * orchestration and JSX only. Window-free and React-free, the plain-node suite locks them.
 */
import type { SshInstanceSpec, SshPhase } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { draftToInput, type HostDraft } from './connection-form.ts'
import { parseGatewayUrl } from './gateway-url.ts'
import { credentialReentryFor } from './save-host.ts'

export function slugifyAlias(alias: string): string {
  return alias.toLowerCase().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function credentialReentryEdit(editing: SshInstanceSpec | 'new' | null, value: HostDraft): { sshPassword: boolean; gatewayToken: boolean; gatewayPassword: boolean } {
  if (editing === null || editing === 'new') return { sshPassword: false, gatewayToken: false, gatewayPassword: false }
  if (value.transport === 'http' && !parseGatewayUrl(value.gatewayUrl).ok) {
    return { sshPassword: false, gatewayToken: false, gatewayPassword: false }
  }
  return credentialReentryFor(editing, draftToInput(value))
}

/** Localize a URL-parse failure — shared by validation and the defensive save-time re-check so both report the same loud error. */
export function gatewayUrlErrorText(parsed: Extract<ReturnType<typeof parseGatewayUrl>, { ok: false }>, t: (key: SettingsConnectionsKey) => string): string {
  return parsed.error === 'required'
    ? t('validationDirectUrlRequired')
    : parsed.error === 'https'
      ? t('validationDirectUrlHttps')
      : parsed.error === 'host'
        ? t('validationDirectUrlHost')
        : t('validationDirectUrlOrigin')
}

/** /health dsh 状态 → 本地化徽标键（03 七态）。 */
export function localStatusKey(status: string): SettingsConnectionsKey {
  switch (status) {
    case 'ready': return 'statusReady'
    case 'starting': return 'statusStarting'
    case 'degraded': return 'statusDegraded'
    case 'restarting': return 'statusRestarting'
    case 'restart-exhausted': return 'statusRestartExhausted'
    case 'stopped': return 'statusStopped'
    case 'error': return 'statusError'
    default: return 'statusUnknown'
  }
}

/** 隧道 phase → 本地化徽标键（非秘密投影）。 */
export function phaseKey(phase: SshPhase | undefined): SettingsConnectionsKey {
  switch (phase) {
    case 'idle': return 'phaseIdle'
    case 'connecting': return 'phaseConnecting'
    case 'ready': return 'phaseReady'
    case 'degraded': return 'phaseDegraded'
    case 'error': return 'phaseError'
    default: return 'phaseUnknown'
  }
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}
