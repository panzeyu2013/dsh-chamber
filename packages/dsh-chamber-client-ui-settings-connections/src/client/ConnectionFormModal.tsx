/**
 * The add/edit connection form modal. DOM anchors, dictionary keys, event order and CSS classes
 * stay as declared; every value the body closes over is an explicit prop.
 */
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { SshConfigHost, SshInstanceSpec } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import type { HostDraft } from './connection-form.ts'
import clsx from 'clsx'
import { Button, IconChevronDownOutline14, IconRefreshOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TransportKind, TransportMethod } from '../global.d.ts'
import { GatewayAuthFields, GatewaySpkiField } from './ConnectionAuthFields.tsx'
import { credentialReentryEdit } from './connection-helpers.ts'
import { MAX_REMOTE_DSH_HOME_CHARS, MAX_SERVICE_NAME_CHARS, MAX_SSH_HOST_CHARS, MAX_SSH_PASSWORD_CHARS, MAX_SSH_USER_CHARS } from './host-validation.ts'
import { changeDraftEndpointUrl, changeDraftKind, changeDraftTransport, spkiPinEligible, TRANSPORT_FORM_OPTIONS, transportFormSchema } from './connection-form.ts'
import css from './ConnectionsSection.module.css'

/** Everything the form body reads or writes in the section component. */
export interface ConnectionFormModalProps {
  /** The connections dictionary lookup. */
  t: (key: SettingsConnectionsKey) => string
  /** The row being edited, 'new' for the add form, null while closed. */
  editing: SshInstanceSpec | 'new' | null
  draft: HostDraft | null
  setDraft: Dispatch<SetStateAction<HostDraft | null>>
  fieldErrors: Partial<Record<keyof HostDraft, string>>
  setFieldErrors: Dispatch<SetStateAction<Partial<Record<keyof HostDraft, string>>>>
  formError: string | null
  setFormError: Dispatch<SetStateAction<string | null>>
  saving: boolean
  closeForm: () => void
  saveDraft: () => Promise<void>
  clearPassword: () => Promise<void>
  clearGatewayToken: () => Promise<void>
  clearGatewayPassword: () => Promise<void>
  configHosts: SshConfigHost[] | null
  configLoading: boolean
  configError: string | null
  loadConfigHosts: () => Promise<void>
  applyConfigHost: (host: SshConfigHost) => void
  gatewayTokenFieldId: string
  gatewayPasswordFieldId: string
  spkiFieldId: string
  sshPasswordFieldId: string
}

export function ConnectionFormModal({
  t, editing, draft, setDraft, fieldErrors, setFieldErrors, formError, setFormError,
  saving, closeForm, saveDraft, clearPassword, clearGatewayToken, clearGatewayPassword,
  configHosts, configLoading, configError, loadConfigHosts, applyConfigHost,
  gatewayTokenFieldId, gatewayPasswordFieldId, spkiFieldId, sshPasswordFieldId,
}: ConnectionFormModalProps): ReactNode {
  return (
      <Modal
        open={editing !== null}
        onClose={closeForm}
        title={editing === 'new' ? t('formAddTitle') : t('formEditTitle')}
        closeLabel={t('close')}
        className={css.dialog}
        contentClassName={css.dialogContent}
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={closeForm}>
              {t('cancel')}
            </Button>
            <Button variant="outline" disabled={saving} onClick={() => { void saveDraft() }}>
              {saving ? t('saving') : t('save')}
            </Button>
          </>
        )}
      >
        {draft === null
          ? null
          : (
            <div className={css.dialogFields}>
              {/* Target edit: the main-owned transaction refuses credential reuse and requires each stored dimension independently; warn before save. */}
              {(() => {
                const reentry = credentialReentryEdit(editing, draft)
                return reentry.sshPassword || reentry.gatewayToken || reentry.gatewayPassword
              })()
                ? <p className={clsx(css.warnHint, css.spanAll)} role="alert">{t('targetChangedHint')}</p>
                : null}
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('kindLabel')}</span>
                {/* 统一下拉箭头：与设置壳/运行时段同一图标词汇。 */}
                <span className={css.selectWrap}>
                  <select
                    className={clsx(css.input, css.selectArrow)}
                    value={draft.kind}
                    onChange={event => {
                      // Target and transport are independent dimensions. The pure helper preserves the selected
                      // transport, adjusts only still-defaulted ports, and clears transient values of the old target.
                      setDraft(changeDraftKind(draft, event.target.value as TransportKind))
                      setFieldErrors({})
                      setFormError(null)
                    }}
                  >
                    <option value="dsh">{t('kindDsh')}</option>
                    <option value="gateway">{t('kindGateway')}</option>
                  </select>
                  <IconChevronDownOutline14 className={css.selectChevron} aria-hidden="true" />
                </span>
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('transportLabel')}</span>
                <span className={css.selectWrap}>
                  <select
                    className={clsx(css.input, css.selectArrow)}
                    value={draft.transport}
                    onChange={event => {
                      setDraft(changeDraftTransport(draft, event.target.value as TransportMethod))
                      setFieldErrors({})
                      setFormError(null)
                    }}
                  >
                    {TRANSPORT_FORM_OPTIONS
                      .filter(schema => schema.targetKinds.includes(draft.kind))
                      .map(schema => (
                        <option key={schema.method} value={schema.method}>
                          {t(schema.method === 'ssh' ? 'transportSsh' : 'transportHttp')}
                        </option>
                      ))}
                  </select>
                  <IconChevronDownOutline14 className={css.selectChevron} aria-hidden="true" />
                </span>
              </label>
              {editing === 'new' && draft.transport === 'ssh'
                ? (
                  <div className={clsx(css.configPicker, css.spanAll)}>
                    <div className={css.configHead}>
                      <span className={css.fieldLabel}>{t('configTitle')}</span>
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={configLoading}
                        data-tip={t('logsRefresh')}
                        aria-label={t('logsRefresh')}
                        onClick={() => { void loadConfigHosts() }}
                      >
                        <IconRefreshOutline16 />
                      </button>
                    </div>
                    {configError !== null
                      ? <p className={css.error} role="alert">{configError}</p>
                      : configHosts === null
                        ? (configLoading ? <p className={css.dim}>{t('configLoading')}</p> : null)
                        : configHosts.length === 0
                          ? <p className={css.dim}>{t('configEmpty')}</p>
                          : (
                            <ul className={css.configList}>
                              {configHosts.map(host => (
                                <li key={host.alias}>
                                  <button
                                    type="button"
                                    className={css.configItem}
                                    onClick={() => { applyConfigHost(host) }}
                                  >
                                    <code className={css.configAlias}>{host.alias}</code>
                                    <span className={css.configMeta}>
                                      {host.user !== null ? `${host.user}@` : ''}{host.hostName}
                                      {host.port !== null ? ` · ${t('sshPort')} ${host.port}` : ''}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                  </div>
                )
                : null}
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('fieldId')}</span>
                <input
                  className={css.input}
                  value={draft.id}
                  disabled={editing !== 'new'}
                  autoFocus
                  maxLength={64}
                  spellCheck={false}
                  placeholder={t('fieldIdPlaceholder')}
                  onChange={event => { setDraft({ ...draft, id: event.target.value }) }}
                />
                {fieldErrors.id === undefined ? null : <span className={css.error} role="alert">{fieldErrors.id}</span>}
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('fieldLabel')}</span>
                <input
                  className={css.input}
                  value={draft.label}
                  maxLength={128}
                  spellCheck={false}
                  placeholder={t('fieldLabelPlaceholder')}
                  onChange={event => { setDraft({ ...draft, label: event.target.value }) }}
                />
                {fieldErrors.label === undefined ? null : <span className={css.error} role="alert">{fieldErrors.label}</span>}
              </label>
              {transportFormSchema(draft.transport).fieldGroup === 'url'
                ? (
                  <>
                    <label className={clsx(css.field, css.spanAll)}>
                      <span className={css.fieldLabel}>{t('fieldDirectUrl')}</span>
                      <input
                        className={css.input}
                        value={draft.gatewayUrl}
                        inputMode="url"
                        autoComplete="url"
                        spellCheck={false}
                        placeholder={t(draft.kind === 'gateway' ? 'fieldGatewayUrlPlaceholder' : 'fieldDshUrlPlaceholder')}
                        onChange={event => { setDraft(changeDraftEndpointUrl(draft, event.target.value)) }}
                      />
                      {fieldErrors.gatewayUrl === undefined ? null : <span className={css.error} role="alert">{fieldErrors.gatewayUrl}</span>}
                      {/* 非拦截安全姿态提示：http 明文是显式用户决策，如实注明、绝不前置拦截。 */}
                      {/^http:\/\//i.test(draft.gatewayUrl.trim())
                        ? <span className={css.warnHint}>{t('gatewayUrlHttpHint')}</span>
                        : null}
                    </label>
                    {spkiPinEligible(draft)
                      ? (
                        <div className={css.spanAll}>
                          <GatewaySpkiField
                            draft={draft}
                            fieldError={fieldErrors.spkiPin}
                            fieldId={spkiFieldId}
                            onChange={spkiPin => { setDraft({ ...draft, spkiPin }) }}
                            t={t}
                          />
                        </div>
                      )
                      : null}
                    {/* Gateway authentication is target-owned and works over both transports; dsh+http deliberately has no auth or SPKI surface. */}
                    {draft.kind === 'gateway'
                      ? (
                        <div className={css.spanContents}>
                          <GatewayAuthFields
                            draft={draft}
                            onChange={patch => { setDraft(prev => (prev === null ? prev : { ...prev, ...patch })) }}
                            fieldErrors={fieldErrors}
                            editing={editing}
                            targetChanged={credentialReentryEdit(editing, draft).gatewayToken || credentialReentryEdit(editing, draft).gatewayPassword}
                            onClearToken={() => { void clearGatewayToken() }}
                            onClearPassword={() => { void clearGatewayPassword() }}
                            tokenFieldId={gatewayTokenFieldId}
                            passwordFieldId={gatewayPasswordFieldId}
                            t={t}
                          />
                        </div>
                      )
                      : null}
                  </>
                )
                : (
                  <>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldHost')}</span>
                      <input
                        className={css.input}
                        value={draft.host}
                        maxLength={MAX_SSH_HOST_CHARS}
                        spellCheck={false}
                        placeholder={t('fieldHostPlaceholder')}
                        onChange={event => { setDraft({ ...draft, host: event.target.value }) }}
                      />
                      {fieldErrors.host === undefined ? null : <span className={css.error} role="alert">{fieldErrors.host}</span>}
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldUser')}</span>
                      <input
                        className={css.input}
                        value={draft.user}
                        maxLength={MAX_SSH_USER_CHARS}
                        spellCheck={false}
                        placeholder={t('fieldUserPlaceholder')}
                        onChange={event => { setDraft({ ...draft, user: event.target.value }) }}
                      />
                      {fieldErrors.user === undefined ? null : <span className={css.error} role="alert">{fieldErrors.user}</span>}
                    </label>
                    {/* SSH transport authentication is independent of target authentication; gateway+ssh renders this field AND GatewayAuthFields. HTML 规范：清除按钮与输入框同处 label 会污染输入框可访问名称——故外层用 div。 */}
                    <div className={clsx(css.field, css.spanAll)}>
                      <span className={css.fieldLabelRow}>
                        <label className={css.fieldLabel} htmlFor={sshPasswordFieldId}>{t('fieldPassword')}</label>
                        {editing !== null && editing !== 'new' && editing.transport === 'ssh'
                          ? (
                            <button
                              type="button"
                              className={css.clearPassword}
                              onClick={() => { void clearPassword() }}
                            >
                              {t('passwordClear')}
                            </button>
                          )
                          : null}
                      </span>
                      <input
                        id={sshPasswordFieldId}
                        className={css.input}
                        type="password"
                        value={draft.password}
                        maxLength={MAX_SSH_PASSWORD_CHARS}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={t('fieldPasswordPlaceholder')}
                        onChange={event => { setDraft({ ...draft, password: event.target.value }) }}
                      />
                      {fieldErrors.password === undefined ? null : <span className={css.error} role="alert">{fieldErrors.password}</span>}
                      <span className={css.dim}>{t('passwordHint')}</span>
                    </div>
                    {draft.kind === 'gateway'
                      ? (
                        <div className={css.spanContents}>
                          <GatewayAuthFields
                            draft={draft}
                            onChange={patch => { setDraft(prev => (prev === null ? prev : { ...prev, ...patch })) }}
                            fieldErrors={fieldErrors}
                            editing={editing}
                            targetChanged={credentialReentryEdit(editing, draft).gatewayToken || credentialReentryEdit(editing, draft).gatewayPassword}
                            onClearToken={() => { void clearGatewayToken() }}
                            onClearPassword={() => { void clearGatewayPassword() }}
                            tokenFieldId={gatewayTokenFieldId}
                            passwordFieldId={gatewayPasswordFieldId}
                            t={t}
                          />
                        </div>
                      )
                      : null}
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldSshPort')}</span>
                      <input
                        className={css.input}
                        value={draft.sshPort}
                        inputMode="numeric"
                        spellCheck={false}
                        placeholder={t('fieldSshPortPlaceholder')}
                        onChange={event => { setDraft({ ...draft, sshPort: event.target.value }) }}
                      />
                      {fieldErrors.sshPort === undefined ? null : <span className={css.error} role="alert">{fieldErrors.sshPort}</span>}
                    </label>
                    <label className={css.field}>
                      {/* The ssh remote port label/placeholder follows the TARGET kind: dsh listens on 30800, a gateway on 30801 next to it. */}
                      <span className={css.fieldLabel}>{draft.kind === 'gateway' ? t('gatewayPort') : t('fieldRemotePort')}</span>
                      <input
                        className={css.input}
                        value={draft.remotePort}
                        inputMode="numeric"
                        spellCheck={false}
                        placeholder={draft.kind === 'gateway' ? t('fieldGatewayRemotePortPlaceholder') : t('fieldRemotePortPlaceholder')}
                        onChange={event => { setDraft({ ...draft, remotePort: event.target.value }) }}
                      />
                      {fieldErrors.remotePort === undefined ? null : <span className={css.error} role="alert">{fieldErrors.remotePort}</span>}
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldServiceName')}</span>
                      <input
                        className={css.input}
                        value={draft.serviceName}
                        maxLength={MAX_SERVICE_NAME_CHARS}
                        spellCheck={false}
                        placeholder={t('fieldServiceNamePlaceholder')}
                        onChange={event => { setDraft({ ...draft, serviceName: event.target.value }) }}
                      />
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('fieldRemoteDshHome')}</span>
                      <input
                        className={css.input}
                        value={draft.remoteDshHome}
                        maxLength={MAX_REMOTE_DSH_HOME_CHARS}
                        spellCheck={false}
                        placeholder={t('fieldRemoteDshHomePlaceholder')}
                        onChange={event => { setDraft({ ...draft, remoteDshHome: event.target.value }) }}
                      />
                      {fieldErrors.remoteDshHome === undefined ? null : <span className={css.error} role="alert">{fieldErrors.remoteDshHome}</span>}
                    </label>
                  </>
                )}
              {formError === null ? null : <p className={clsx(css.error, css.spanAll)} role="alert">{formError}</p>}
            </div>
          )}
      </Modal>
  )
}
