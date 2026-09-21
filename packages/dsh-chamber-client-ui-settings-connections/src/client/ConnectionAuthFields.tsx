/**
 * Gateway authentication / certificate-pin fields for the connection form
 * (design 17 §7; moved verbatim out of ConnectionsSection.tsx in the 2026-12
 * phase-3 modularization). Both render the same DOM anchors as before.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SshInstanceSpec } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import type { HostDraft } from './connection-form.ts'
import css from './ConnectionsSection.module.css'

/** 插件管理入口图标（UX 重构 P2a）：primitives 无 cordis/插件候选，按 sidebar
 *  本地自绘先例自绘（16px，stroke 跟随 currentColor）。
 *  字形来源：lucide `plug`，ISC License，https://lucide.dev/license */
export function PluginManageIcon16() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  )
}

/**
 * The gateway authentication area (design 17 §7): BOTH write-only credentials
 * — the shared token (§7.2) and the login password (§7.1) — each optional and
 * independently committable. The hint copy distinguishes the three states
 * (P3-1): NEW = "both empty sends the request without auth"; plain EDIT =
 * "leave empty keeps the stored credential"; TARGET-CHANGED edit = "the old
 * credential is cleared, re-enter" — the last also carries the top-of-form
 * warning and a required-credential validation (P2). The explicit clear
 * button is the wipe path for plain edits. Rendered once for every gateway
 * transport (http direct and ssh tunnel).
 */
export function GatewayAuthFields({ draft, onChange, fieldErrors, editing, targetChanged, onClearToken, onClearPassword, tokenFieldId, passwordFieldId, t }: {
  draft: HostDraft
  onChange: (patch: Partial<HostDraft>) => void
  fieldErrors: Partial<Record<keyof HostDraft, string>>
  editing: SshInstanceSpec | 'new' | null
  /** True while editing a row whose transport target changed (P2/P3-1). */
  targetChanged: boolean
  onClearToken: () => void
  onClearPassword: () => void
  /** Per-instance input ids (useId): the dialog can render in N-ctx panels in
   *  the same document — static ids would alias across panels. */
  tokenFieldId: string
  passwordFieldId: string
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  // Stored credentials never return to the renderer — clearing goes straight
  // to the main process. The button only exists while EDITING a registry
  // gateway row (a new row has nothing stored yet).
  const canClear = editing !== null && editing !== 'new' && editing.kind === 'gateway'
  const hint = editing === null || editing === 'new'
    ? t('gatewayCredentialsHintAdd')
    : targetChanged
      ? t('gatewayCredentialsHintRetarget')
      : t('gatewayCredentialsHintEdit')
  return (
    <>
      {/* 2026-12 复审（HTML 规范）：label 不得含 labeled control 之外的
          labelable 元素——「清除」按钮与输入框同处 label 会污染输入框的
          可访问名称。外层改 div，字段名改 label htmlFor 关联。 */}
      <div className={css.field}>
        <span className={css.fieldLabelRow}>
          <label className={css.fieldLabel} htmlFor={tokenFieldId}>{t('fieldGatewayToken')}</label>
          {canClear
            ? (
              <button
                type="button"
                className={css.clearPassword}
                onClick={() => { void onClearToken() }}
              >
                {t('gatewayTokenClear')}
              </button>
            )
            : null}
        </span>
        <input
          id={tokenFieldId}
          className={css.input}
          type="password"
          value={draft.gatewayToken}
          maxLength={4096}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={t('fieldGatewayTokenPlaceholder')}
          onChange={event => { onChange({ gatewayToken: event.target.value }) }}
        />
        {fieldErrors.gatewayToken === undefined ? null : <span className={css.error} role="alert">{fieldErrors.gatewayToken}</span>}
      </div>
      <div className={css.field}>
        <span className={css.fieldLabelRow}>
          <label className={css.fieldLabel} htmlFor={passwordFieldId}>{t('fieldGatewayPassword')}</label>
          {canClear
            ? (
              <button
                type="button"
                className={css.clearPassword}
                onClick={() => { void onClearPassword() }}
              >
                {t('gatewayPasswordClear')}
              </button>
            )
            : null}
        </span>
        <input
          id={passwordFieldId}
          className={css.input}
          type="password"
          value={draft.gatewayPassword}
          maxLength={1024}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={t('fieldGatewayPasswordPlaceholder')}
          onChange={event => { onChange({ gatewayPassword: event.target.value }) }}
        />
        {fieldErrors.gatewayPassword === undefined ? null : <span className={css.error} role="alert">{fieldErrors.gatewayPassword}</span>}
      </div>
      <span className={clsx(css.dim, css.spanAll)}>{hint}</span>
    </>
  )
}

/** Optional S23 certificate pin. Unlike credentials this is non-secret
 * registry metadata, so edit prefill and ordinary input binding are required
 * to preserve it. The caller renders this only for gateway+http+https. */
export function GatewaySpkiField({ draft, onChange, fieldError, fieldId, t }: {
  draft: HostDraft
  onChange: (spkiPin: string) => void
  fieldError: string | undefined
  /** Per-instance input id (useId), same N-ctx scoping as GatewayAuthFields. */
  fieldId: string
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabelRow}>
        <label className={css.fieldLabel} htmlFor={fieldId}>{t('fieldSpkiPin')}</label>
        {draft.spkiPin === ''
          ? null
          : (
            <button
              type="button"
              className={css.clearPassword}
              onClick={() => { onChange('') }}
            >
              {t('spkiPinClear')}
            </button>
          )}
      </span>
      <input
        id={fieldId}
        className={css.input}
        value={draft.spkiPin}
        maxLength={64}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={t('fieldSpkiPinPlaceholder')}
        onChange={event => { onChange(event.target.value) }}
      />
      {fieldError === undefined ? null : <span className={css.error} role="alert">{fieldError}</span>}
      <span className={css.dim}>{t('spkiPinHint')}</span>
    </div>
  )
}
