/**
 * Create-worktree dialog, organized after OpenChamber's NewWorktreeDialog
 * (design 08 §4.2): New Branch / Existing Branch tabs, an auto-suggested branch
 * name, a worktree directory auto-synced until edited, the source branch as an
 * informative line, and the host's preview as the security step. Creating NEVER
 * opens a session (the empty worktree workspace appears immediately).
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, IconChevronRightOutline14, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { basenameOf } from '@dsh-chamber/dsh-chamber-client-core'
import { createFromPreview, gitCoordinator, previewCreate } from '../shared/coordinator.ts'
import { gitActionErrorText } from '../shared/action-error.ts'
import { createSourceOptions, sourceBranchChoices } from '../shared/git-facts.ts'
import type { GitWorktreeSnapshot } from '../shared/types.ts'
import type { WorkspaceGitInjected } from './injected.ts'
import css from './SidebarGit.module.css'

export interface CreateWorktreeDialogProps {
  open: boolean
  onClose: () => void
  /** The source whose snapshot drives the form and whose instance runs the saga. */
  sourceId: string
  /** Workspace the dialog was opened from — prefills the source repo select. */
  initialWorkspaceId?: string
  /** Repo of the opening group; used as the same-repo fallback for the prefill. */
  initialRepoId?: string
  t: WorkspaceGitInjected['t']
}

const ADJECTIVES = ['cosmic', 'quiet', 'swift', 'bright', 'calm', 'bold', 'gentle', 'lively', 'sunny', 'rapid']
const NOUNS = ['dolphin', 'falcon', 'willow', 'rocket', 'meadow', 'ember', 'river', 'breeze', 'maple', 'otter']

/** OpenChamber-style two-word slug suggestion, avoiding names already taken by
 *  existing branches/worktrees (best-effort; the host preview stays authoritative). */
function suggestBranchName(taken?: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!
    const name = `${adjective}-${noun}`
    if (taken === undefined || !taken.has(name)) return name
  }
  return `worktree-${Date.now().toString(36)}`
}

/** Blur normalization (OpenChamber parity): trim, strip `refs/heads/`, collapse
 *  whitespace/control characters to `-`, cap at 80 chars. Non-ASCII (CJK) is
 *  PRESERVED — git allows UTF-8 refs; the host's check-ref-format stays the authority. */
function normalizeBranchName(name: string): string {
  const stripped = name.trim().replace(/^refs\/heads\//u, '')
  const normalized = stripped
    .replace(/[\u0000-\u001f\u007f]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
  return normalized.slice(0, 80)
}

/** Pick a directory name not already used by a same-repo worktree — base first,
 *  then numbered suffixes. The host's target-exists check stays authoritative. */
function uniqueDirectoryName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** Branch + directory names already in use by the snapshot (same-repo collisions). */
function takenNames(snapshot: GitWorktreeSnapshot | undefined): Set<string> {
  const taken = new Set<string>()
  for (const repo of snapshot?.repos ?? []) {
    for (const worktree of repo.worktrees) {
      if (worktree.branch !== null) taken.add(worktree.branch)
      // The MAIN checkout lives outside the worktree root — no directory collision.
      if (!worktree.isMain) taken.add(basenameOf(worktree.path))
    }
  }
  return taken
}

/** Last path segment, for same-repo directory-collision prechecks. */
/** Branch → directory slug ("feature/my-branch" → "my-branch"). */
function slugifyBranchName(branch: string): string {
  const clean = branch.trim().split('/').at(-1) ?? branch
  const slugged = clean
    .toLowerCase()
    // Keep CJK/Unicode letters too — a Chinese branch must not degrade to the generic "worktree" directory.
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slugged === '' ? 'worktree' : slugged
}

/** Custom dropdown built on the repo's own Menu primitive. */
function MenuSelect({ value, placeholder, options, disabled, onChange, ariaLabel }: {
  value: string
  placeholder: string
  options: string[]
  disabled?: boolean
  onChange: (value: string) => void
  ariaLabel: string
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      // Every chamber popup menu runs at chamber scale, so this select-like
      // dropdown takes the primitive's `compact` form instead of the 40px default.
      compact
      portal
      align="end"
      open={open}
      onClose={() => setOpen(false)}
      onSelect={(id: string) => { setOpen(false); onChange(id) }}
      items={options.map(option => ({ id: option, label: option }))}
      anchor={(
        <button
          type="button"
          className={css.fieldSelect}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(prev => !prev)}
        >
          <span className={value === '' ? css.fieldSelectPlaceholder : undefined}>
            {value === '' ? placeholder : value}
          </span>
          <IconChevronRightOutline14 size={14} className={css.fieldSelectChevron} />
        </button>
      )}
    />
  )
}

/** One source-scoped create dialog; form state is local to the mount. */
export function CreateWorktreeDialog({
  open, onClose, sourceId, initialWorkspaceId, initialRepoId, t,
}: CreateWorktreeDialogProps): React.ReactNode {
  useSyncExternalStore(gitCoordinator.subscribe, gitCoordinator.getVersion, gitCoordinator.getVersion)
  const source = gitCoordinator.getSource(sourceId)
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branchName, setBranchName] = useState('')
  const [directoryDraft, setDirectoryDraft] = useState('')
  const [directoryTouched, setDirectoryTouched] = useState(false)
  const [startRef, setStartRef] = useState('')
  // ARIA tabs pattern ids (unique per dialog mount).
  const tabsId = useId()
  const panelId = `${tabsId}-panel`
  const [formError, setFormError] = useState<string | null>(null)

  const options = useMemo(
    () => source?.snapshot === undefined ? [] : createSourceOptions(source.snapshot),
    [source?.snapshot],
  )
  const busy = source?.busy !== undefined
  const actionLocked = busy || source?.recovery !== undefined

  // (Re)initialize on open: fresh branch suggestion + synced directory, and the OpenChamber default of creating WITHOUT a session.
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open === prevOpen.current) return
    prevOpen.current = open
    if (!open) return
    const taken = takenNames(source?.snapshot)
    const suggestion = suggestBranchName(taken)
    setMode('new')
    setBranchName(suggestion)
    setDirectoryDraft(uniqueDirectoryName(slugifyBranchName(suggestion), taken))
    setDirectoryTouched(false)
    setStartRef('')
    setFormError(null)
  }, [open, source?.snapshot])

  // A changed source workspace means a different repository — the remembered
  // source branch from the previous repo must not leak.
  useEffect(() => {
    setStartRef('')
  }, [sourceWorkspaceId])

  // Selection sync: keep a valid selection; otherwise prefer the opening
  // workspace, then its repo, then the first option.
  useEffect(() => {
    if (!open) return
    if (options.some(option => option.workspaceId === sourceWorkspaceId)) return
    const preferred = initialWorkspaceId !== undefined && options.some(option => option.workspaceId === initialWorkspaceId)
      ? initialWorkspaceId
      : initialRepoId !== undefined
        ? (options.find(option => option.repoId === initialRepoId)?.workspaceId ?? options[0]?.workspaceId ?? '')
        : (options[0]?.workspaceId ?? '')
    setSourceWorkspaceId(preferred)
  }, [open, options, sourceWorkspaceId, initialWorkspaceId, initialRepoId])

  // Directory auto-syncs from the branch name until the user edits it.
  useEffect(() => {
    if (!open || directoryTouched) return
    setDirectoryDraft(slugifyBranchName(branchName))
  }, [open, branchName, directoryTouched])

  // Source branch for the informative line + known branches for the existing-branch suggestions.
  const sourceRepo = useMemo(() => {
    const snapshot = source?.snapshot
    if (snapshot === undefined || sourceWorkspaceId === '') return undefined
    return snapshot.repos.find(repo => repo.worktrees.some(worktree => worktree.workspaceId === sourceWorkspaceId))
  }, [source?.snapshot, sourceWorkspaceId])
  const sourceBranch = sourceRepo?.worktrees.find(worktree => worktree.isMain)?.branch
    ?? sourceRepo?.worktrees[0]?.branch
  // Remember the last chosen source branch per repository (OpenChamber
  // localStorage parity), restored when the dialog opens.
  const sourceBranchStorageKey = sourceRepo === undefined ? null : `dsh-chamber.git.source-branch.${sourceRepo.repoId}`

  // Existing-branch choices: the host's branch list (show-ref --heads) preferred,
  // then the snapshot's known worktree branches. An unborn row is skipped — its
  // name resolves to no commit, so offering it only makes the picker fail.
  const existingBranchChoices = useMemo(
    () => sourceBranchChoices(
      sourceRepo?.branches ?? [],
      sourceRepo?.worktrees
        .filter(worktree => worktree.headState !== 'unborn')
        .map(worktree => worktree.branch) ?? [],
    ),
    [sourceRepo],
  )

  // Restore the remembered source branch when the key and choices are ready.
  useEffect(() => {
    if (!open || startRef !== '') return
    if (sourceBranchStorageKey === null) return
    let saved = ''
    try {
      saved = localStorage.getItem(sourceBranchStorageKey) ?? ''
    } catch {
      return
    }
    if (saved !== '' && existingBranchChoices.includes(saved)) setStartRef(saved)
  }, [open, sourceBranchStorageKey, startRef, existingBranchChoices])

  const close = (): void => {
    if (busy) return
    setFormError(null)
    onClose()
  }

  const switchMode = (next: 'new' | 'existing'): void => {
    if (next === mode) return
    setMode(next)
    setFormError(null)
    if (next === 'new') {
      const taken = takenNames(source?.snapshot)
      const suggestion = suggestBranchName(taken)
      setBranchName(suggestion)
      setDirectoryTouched(false)
      setDirectoryDraft(uniqueDirectoryName(slugifyBranchName(suggestion), taken))
    } else {
      // Existing mode must never carry the new-mode random suggestion: the select
      // shows its placeholder but the submit would send a stale name.
      setBranchName('')
    }
  }

  // Single-step submit: no preview screen. The host preview (validation +
  // idempotent token) runs invisibly immediately before the create.
  const runCreate = async (): Promise<void> => {
    const cleanBranch = branchName.trim()
    const cleanDirectory = directoryDraft.trim()
    if (sourceWorkspaceId === '' || cleanBranch === '' || cleanDirectory === '') return
    setFormError(null)
    // Save-time collision guard (OpenChamber parity): a directory still taken by
    // a SAME-REPO worktree is auto-suffixed so the save never fails with
    // target-exists. Branch names do not occupy a directory slot.
    const sameRepoTaken = new Set<string>()
    if (sourceRepo !== undefined) {
      for (const worktree of sourceRepo.worktrees) {
        if (!worktree.isMain) sameRepoTaken.add(basenameOf(worktree.path))
      }
    }
    const finalDirectory = uniqueDirectoryName(cleanDirectory, sameRepoTaken)
    if (finalDirectory !== cleanDirectory) setDirectoryDraft(finalDirectory)
    try {
      const preview = await previewCreate(sourceId, {
        sourceWorkspaceId,
        basename: finalDirectory,
        branch: { kind: mode, name: cleanBranch },
        ...(mode === 'new' && startRef !== '' ? { startRef } : {}),
      })
      // createSession: false — creating a worktree NEVER commits a session.
      await createFromPreview(sourceId, preview, { createSession: false, sourceWorkspaceId })
      onClose()
    } catch (error) {
      // The code→copy resolver: user-reachable refusals render localized copy;
      // an unmapped failure keeps its raw (English) message.
      setFormError(gitActionErrorText(error, t))
    }
  }

  const branchReady = branchName.trim() !== ''
  const directoryReady = directoryDraft.trim() !== ''
  const formReady = sourceWorkspaceId !== '' && branchReady && directoryReady
  // Same-repo directory-collision precheck — the new worktree lands at <root>/<repo>/<dir>.
  const directoryConflict = sourceRepo !== undefined && directoryDraft.trim() !== ''
    && sourceRepo.worktrees
      .filter(worktree => !worktree.isMain)
      .some(worktree => basenameOf(worktree.path) === directoryDraft.trim())
  // Blur normalization on the branch name (new mode).
  const normalizeOnBlur = (): void => {
    const normalized = normalizeBranchName(branchName)
    if (normalized !== branchName) {
      setBranchName(normalized)
      if (!directoryTouched) setDirectoryDraft(uniqueDirectoryName(slugifyBranchName(normalized), takenNames(source?.snapshot)))
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('createTitle')}
      closeLabel={t('close')}
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" disabled={actionLocked || !formReady} onClick={() => { void runCreate() }}>{busy ? t('creating') : t('createConfirm')}</Button>
        </>
      )}
    >
      <div className={css.fields}>
        <div className={css.tabs} role="tablist" aria-label={t('branchMode')}>
          {/* Sliding thumb: the active segment's pill glides between the two halves. */}
          <span className={css.tabThumb} data-right={mode === 'existing' ? true : undefined} aria-hidden="true" />
          <button
            type="button"
            role="tab"
            id={`${tabsId}-new`}
            aria-controls={panelId}
            aria-selected={mode === 'new'}
            tabIndex={mode === 'new' ? 0 : -1}
            className={mode === 'new' ? css.tabActive : css.tab}
            disabled={actionLocked}
            onClick={() => switchMode('new')}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') switchMode('existing')
            }}
          >
            {t('branchNew')}
          </button>
          <button
            type="button"
            role="tab"
            id={`${tabsId}-existing`}
            aria-controls={panelId}
            aria-selected={mode === 'existing'}
            tabIndex={mode === 'existing' ? 0 : -1}
            className={mode === 'existing' ? css.tabActive : css.tab}
            disabled={actionLocked}
            onClick={() => switchMode('existing')}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') switchMode('new')
            }}
          >
            {t('branchExisting')}
          </button>
        </div>
        <div
          role="tabpanel"
          id={panelId}
          className={css.tabPanel}
          aria-labelledby={mode === 'new' ? `${tabsId}-new` : `${tabsId}-existing`}
        >
        {mode === 'new' ? (
          <>
            <label>
              <span>{t('branchName')}</span>
              <Input
                className={css.fieldInput}
                value={branchName}
                disabled={actionLocked}
                placeholder={t('branchPlaceholder')}
                onChange={event => { setBranchName(event.target.value) }}
                onBlur={normalizeOnBlur}
              />
            </label>
            <label>
              <span className={css.fieldRow}>
                <span>{t('worktreeDirectory')}</span>
                {directoryTouched && directoryDraft.trim() !== slugifyBranchName(branchName) && (
                  <button
                    type="button"
                    className={css.resetDirectory}
                    disabled={actionLocked}
                    onClick={() => setDirectoryTouched(false)}
                  >
                    {t('resetDirectory')}
                  </button>
                )}
              </span>
              <Input
                className={css.fieldInput}
                value={directoryDraft}
                disabled={actionLocked}
                placeholder={t('worktreeDirectoryPlaceholder')}
                onChange={event => { setDirectoryTouched(true); setDirectoryDraft(event.target.value) }}
              />
            </label>
            {directoryConflict && (
              // Outside the <label> — a label only accepts phrasing content.
              <p className={css.directoryConflict} role="alert">{t('directoryConflictHint')}</p>
            )}
            <label>
              <span>{t('sourceBranch')}</span>
              <MenuSelect
                value={startRef}
                placeholder={sourceBranch ?? t('sourceBranchDefault')}
                // The main checkout's branch stays SELECTABLE: the host resolves it
                // to that branch's HEAD, and filtering it out would leave a remembered
                // pick shadowing main and single-branch repositories.
                options={existingBranchChoices}
                disabled={actionLocked}
                ariaLabel={t('sourceBranch')}
                onChange={value => {
                  setStartRef(value)
                  try {
                    if (sourceBranchStorageKey !== null) {
                      localStorage.setItem(sourceBranchStorageKey, value)
                    }
                  } catch {
                    // Persistence is best-effort; a failed write never blocks.
                  }
                }}
              />
            </label>
            {startRef !== '' && sourceBranch !== undefined && startRef !== sourceBranch && (
              <p className={css.sourceFrom}>{t('sourceFrom').replace('{source}', startRef)}</p>
            )}
          </>
        ) : (
          <>
            <label>
              <span>{t('existingBranch')}</span>
              {existingBranchChoices.length > 0 ? (
                <MenuSelect
                  value={branchName}
                  placeholder={t('existingBranchPlaceholder')}
                  options={existingBranchChoices}
                  disabled={actionLocked}
                  ariaLabel={t('existingBranch')}
                  onChange={value => { setBranchName(value) }}
                />
              ) : (
                <Input
                  className={css.fieldInput}
                  value={branchName}
                  disabled={actionLocked}
                  placeholder={t('existingBranchPlaceholder')}
                  onChange={event => { setBranchName(event.target.value) }}
                />
              )}
            </label>
            <label>
              <span>{t('worktreeDirectory')}</span>
              <Input
                className={css.fieldInput}
                value={directoryDraft}
                disabled={actionLocked}
                placeholder={t('worktreeDirectoryPlaceholder')}
                onChange={event => { setDirectoryTouched(true); setDirectoryDraft(event.target.value) }}
              />
            </label>
          </>
        )}
        </div>
        {formError !== null && <p className={css.formError} role="alert">{formError}</p>}
      </div>
    </Modal>
  )
}
