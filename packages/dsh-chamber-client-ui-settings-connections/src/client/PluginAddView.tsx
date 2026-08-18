/**
 * Plugin add view (design 13 §5.8): three add paths — spec input (frontend
 * validation + main-process re-validation), best-effort npm registry search
 * (via npm_search IPC, main-side), and local folder import.
 *
 * Remote: spec → pluginApply (restart:false, non-disruptive); folder →
 * pluginMaterializeAddPick (pick-only: the main process opens the picker).
 * Local: spec → local_plugin_add; folder → local_plugin_add_file (pick-only).
 * The main process re-validates every spec (§7.2) regardless of this form.
 */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NpmSearchPackage, SshInstanceSpec } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'
import { localPluginAdd, localPluginAddFile, npmSearch, pluginApply, pluginMaterializeAddPick } from './control-plane.ts'
import css from './ConnectionsSection.module.css'

/** The §7.2 add-spec whitelist: `name`, `@scope/name`, or `name@<safe version>`. */
const ADD_SPEC = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next))?$/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The add view. `spec` is null for the local instance (whose add/remove now
 * runs through the LOCAL `dsh plugin` exec, design 13 §5.1).
 * @param props.t - bound translate.
 * @param props.spec - remote instance, or null for the local instance.
 * @param props.onInstalled - re-pull the manifests after a successful add.
 */
export function PluginAddView({ t, spec, onInstalled }: {
  t: (key: SettingsConnectionsKey) => string
  spec: SshInstanceSpec | null
  onInstalled: () => void
}): ReactNode {
  const isRemote = spec !== null

  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<NpmSearchPackage[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  const installSpec = useCallback(async (raw: string): Promise<void> => {
    const value = raw.trim()
    if (!ADD_SPEC.test(value)) {
      setDraftError(t('pluginsAddSpecInvalid'))
      return
    }
    setInstalling(true)
    setDraftError(null)
    setResult(null)
    try {
      if (isRemote && spec !== null) {
        const res = await pluginApply(spec.id, { add: [value], remove: [], restart: false })
        if ('error' in res) setDraftError(res.error)
        else if (res.result.failed.length > 0 || !res.result.verified) {
          // pluginApply resolves {ok:true} even when an individual add failed
          // or the manifest assertion failed (design 13 §4.5) — fail loud and
          // keep the input; never report a false success.
          const first = res.result.failed[0]
          setDraftError(first !== undefined ? `${value}：${first.error}` : t('pluginsVerifyFailed'))
        } else {
          setResult(t('pluginsDeferred'))
          setDraft('')
          onInstalled()
        }
      } else {
        const res = await localPluginAdd(value)
        if ('error' in res) setDraftError(res.error)
        else { setResult(t('pluginsApplied')); setDraft(''); onInstalled() }
      }
    } catch (err) {
      setDraftError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }, [isRemote, spec, t, onInstalled])

  const importFolder = useCallback(async (): Promise<void> => {
    setInstalling(true)
    setDraftError(null)
    setResult(null)
    try {
      if (isRemote && spec !== null) {
        const res = await pluginMaterializeAddPick(spec.id)
        if ('error' in res) setDraftError(res.error)
        else if ('cancelled' in res) { /* silent no-op (picker dismissed) */ }
        else { setResult(t('pluginsDeferred')); onInstalled() }
      } else {
        const res = await localPluginAddFile()
        if ('error' in res) setDraftError(res.error)
        else if ('cancelled' in res) { /* silent no-op (picker dismissed) */ }
        else { setResult(t('pluginsApplied')); onInstalled() }
      }
    } catch (err) {
      setDraftError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }, [isRemote, spec, t, onInstalled])

  const runSearch = useCallback(async (): Promise<void> => {
    const value = query.trim()
    if (value === '') return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await npmSearch(value)
      if ('error' in res) setSearchError(res.error)
      else setHits(res.packages)
    } catch (err) {
      setSearchError(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }, [query])

  const onSpecChange = useCallback((value: string): void => {
    setDraft(value)
    setDraftError(null)
  }, [])

  return (
    <div className={css.pluginAdd}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('pluginsAddSpec')}</span>
        <input
          className={css.input}
          value={draft}
          spellCheck={false}
          disabled={installing}
          placeholder={t('pluginsAddSpecPlaceholder')}
          onChange={event => { onSpecChange(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter' && !installing) void installSpec(draft) }}
        />
        {draftError !== null ? <span className={css.error} role="alert">{draftError}</span> : null}
        {result !== null && draftError === null ? <span className={css.hint}>{result}</span> : null}
      </label>
      <div className={css.pluginAddActions}>
        <Button variant="primary" size="sm" disabled={installing} onClick={() => { void installSpec(draft) }}>
          {installing ? t('saving') : t('pluginsAddInstall')}
        </Button>
      </div>

      <div className={css.pluginSearch}>
        <span className={css.fieldLabel}>{t('pluginsAddSearch')}</span>
        <div className={css.pluginSearchRow}>
          <input
            className={css.input}
            value={query}
            spellCheck={false}
            disabled={searching}
            placeholder={t('pluginsAddSearchPlaceholder')}
            onChange={event => { setQuery(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter' && !searching) void runSearch() }}
          />
          <Button variant="outline" size="sm" disabled={searching || query.trim() === ''} onClick={() => { void runSearch() }}>
            {searching ? t('loading') : t('pluginsAddSearch')}
          </Button>
        </div>
        <p className={css.dim}>{t('pluginsAddSearchHint')}</p>
        {searchError !== null ? <p className={css.error} role="alert">{searchError}</p> : null}
        {hits.length > 0
          ? (
            <ul className={css.pluginHits}>
              {hits.map(hit => (
                <li key={hit.name} className={css.pluginHit}>
                  <code className={css.mono}>{hit.name}</code>
                  <span className={css.pluginHitVersion}>{hit.version}</span>
                  {hit.description !== undefined && hit.description !== '' ? <span className={css.dim}>{hit.description}</span> : null}
                  <span className={css.footSpacer} />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={installing}
                    onClick={() => { void installSpec(`${hit.name}@${hit.version}`) }}
                  >
                    {t('pluginsAddInstall')}
                  </Button>
                </li>
              ))}
            </ul>
          )
          : null}
      </div>

      <div className={css.pluginFolder}>
        <Button variant="ghost" size="sm" disabled={installing} onClick={() => { void importFolder() }}>
          {t('pluginsAddFolder')}
        </Button>
      </div>
    </div>
  )
}
