/**
 * Same-origin client for design 17's gateway-owned orchestration surface.
 *
 * The renderer is intentionally given only a canonical chamber source id. It
 * derives `/api/i/gateway-<id>/chamber/*` locally and never accepts a URL or a
 * bearer token. Desktop's trusted gateway transport injects Authorization
 * after the request has crossed the renderer boundary.
 *
 * Every decoder is a whitelist projection. In particular, settings responses
 * may contain future/unknown keys but this client only returns the three
 * documented non-secret toggle groups; an accidentally persisted token,
 * password, credential, or other unknown field can therefore never be
 * rendered by this surface.
 */

const GATEWAY_SOURCE_ID = /^gateway-[a-zA-Z0-9_-]{1,64}$/
const REQUEST_TIMEOUT_MS = 15_000

export interface GatewaySettings {
  schemaVersion?: number
  revision?: number
  git?: { enabled: boolean }
  notifications?: { enabled: boolean }
  schedule?: { enabled: boolean }
}

export interface GatewaySettingsPatch {
  git: { enabled: boolean }
  notifications: { enabled: boolean }
  schedule: { enabled: boolean }
}

export interface GatewaySession {
  sessionId: string
  title?: string
  running: boolean
  blank: boolean
  cwd?: string
  updatedAt: number
}

export interface GatewayApproval {
  kind: 'approval'
  sessionId: string
  approvalId: string
  rpcId: string
  toolName: string
  reason?: string
}

export interface GatewayQuestionOption {
  label: string
  description?: string
}

export interface GatewayQuestionItem {
  id: string
  header?: string
  question: string
  detail?: string
  multiSelect: boolean
  options: GatewayQuestionOption[]
}

export interface GatewayQuestion {
  kind: 'question'
  sessionId: string
  rpcId: string
  questions: GatewayQuestionItem[]
}

export type GatewayInteraction = GatewayApproval | GatewayQuestion

export interface GatewayQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/**
 * Build the exact question-response vocabulary accepted by the gateway route.
 * Unknown option labels are discarded instead of letting stale/tampered DOM
 * state become an answer to a different prompt generation.
 */
export function buildGatewayQuestionAnswer(
  request: GatewayQuestion,
  selectedById: Readonly<Record<string, readonly string[]>>,
  customById: Readonly<Record<string, string>>,
): GatewayQuestionAnswer {
  return {
    answers: request.questions.map((question) => {
      const allowed = new Set(question.options.map(option => option.label))
      const selected = [...new Set(selectedById[question.id] ?? [])].filter(label => allowed.has(label))
      const bounded = question.multiSelect ? selected : selected.slice(0, 1)
      const custom = (customById[question.id] ?? '').trim()
      return {
        id: question.id,
        selected: bounded,
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

export interface GatewayScheduledJob {
  id: string
  delayMs: number
  intervalMs: number | null
  targetSessionId: string
  prompt: string
}

export interface GatewayWorktree {
  id: string
  workspaceId: string
  sessionId?: string
  repo?: string
  path: string
  branch: string
  ownership?: 'owned' | 'unverified'
  state: 'creating' | 'ready' | 'deleting' | 'failed'
  error?: string
  createdAt: number
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Gateway returned malformed ${label}`)
  }
  return value as Record<string, unknown>
}

function stringField(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key]
  if (typeof value !== 'string' || value === '') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function optionalString(row: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = row[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function finiteNumber(row: Record<string, unknown>, key: string, label: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function optionalFiniteNumber(row: Record<string, unknown>, key: string, label: string): number | undefined {
  if (row[key] === undefined) return undefined
  return finiteNumber(row, key, label)
}

function booleanField(row: Record<string, unknown>, key: string, label: string): boolean {
  const value = row[key]
  if (typeof value !== 'boolean') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function items(value: unknown, label: string): unknown[] {
  const rows = record(value, label).items
  if (!Array.isArray(rows)) throw new Error(`Gateway returned malformed ${label}.items`)
  return rows
}

function toggle(value: unknown, label: string): { enabled: boolean } | undefined {
  if (value === undefined) return undefined
  const row = record(value, label)
  return { enabled: booleanField(row, 'enabled', label) }
}

/** Whitelist projection: unknown settings keys never escape this function. */
export function projectGatewaySettings(value: unknown): GatewaySettings {
  const row = record(value, 'settings')
  const schemaVersion = optionalFiniteNumber(row, 'schemaVersion', 'settings')
  const revision = optionalFiniteNumber(row, 'revision', 'settings')
  const git = toggle(row.git, 'settings.git')
  const notifications = toggle(row.notifications, 'settings.notifications')
  const schedule = toggle(row.schedule, 'settings.schedule')
  return {
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(git !== undefined ? { git } : {}),
    ...(notifications !== undefined ? { notifications } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
  }
}

function projectSession(value: unknown): GatewaySession {
  const row = record(value, 'session')
  const title = optionalString(row, 'title', 'session')
  const cwd = optionalString(row, 'cwd', 'session')
  return {
    sessionId: stringField(row, 'sessionId', 'session'),
    ...(title !== undefined ? { title } : {}),
    running: booleanField(row, 'running', 'session'),
    blank: booleanField(row, 'blank', 'session'),
    ...(cwd !== undefined ? { cwd } : {}),
    updatedAt: finiteNumber(row, 'updatedAt', 'session'),
  }
}

function projectQuestionItem(value: unknown): GatewayQuestionItem {
  const row = record(value, 'question item')
  const header = optionalString(row, 'header', 'question item')
  const detail = optionalString(row, 'detail', 'question item')
  if (!Array.isArray(row.options)) throw new Error('Gateway returned malformed question item.options')
  const options = row.options.map((value) => {
    const option = record(value, 'question option')
    const description = optionalString(option, 'description', 'question option')
    return {
      label: stringField(option, 'label', 'question option'),
      ...(description !== undefined ? { description } : {}),
    }
  })
  if (new Set(options.map(option => option.label)).size !== options.length) {
    throw new Error('Gateway returned duplicate question option labels')
  }
  const multiSelect = row.multiSelect === undefined ? false : booleanField(row, 'multiSelect', 'question item')
  return {
    id: stringField(row, 'id', 'question item'),
    ...(header !== undefined ? { header } : {}),
    question: stringField(row, 'question', 'question item'),
    ...(detail !== undefined ? { detail } : {}),
    multiSelect,
    options,
  }
}

function projectInteraction(value: unknown): GatewayInteraction {
  const row = record(value, 'interaction')
  const kind = row.kind
  if (kind === 'approval') {
    const reason = optionalString(row, 'reason', 'approval')
    return {
      kind,
      sessionId: stringField(row, 'sessionId', 'approval'),
      approvalId: stringField(row, 'approvalId', 'approval'),
      rpcId: stringField(row, 'rpcId', 'approval'),
      toolName: stringField(row, 'toolName', 'approval'),
      ...(reason !== undefined ? { reason } : {}),
    }
  }
  if (kind === 'question') {
    if (!Array.isArray(row.questions)) throw new Error('Gateway returned malformed question.questions')
    const questions = row.questions.map(projectQuestionItem)
    if (new Set(questions.map(question => question.id)).size !== questions.length) {
      throw new Error('Gateway returned duplicate question ids')
    }
    return {
      kind,
      sessionId: stringField(row, 'sessionId', 'question'),
      rpcId: stringField(row, 'rpcId', 'question'),
      questions,
    }
  }
  throw new Error('Gateway returned malformed interaction.kind')
}

function projectScheduledJob(value: unknown): GatewayScheduledJob {
  const row = record(value, 'scheduled job')
  const intervalMs = row.intervalMs
  if (intervalMs !== null && (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs))) {
    throw new Error('Gateway returned malformed scheduled job.intervalMs')
  }
  return {
    id: stringField(row, 'id', 'scheduled job'),
    delayMs: finiteNumber(row, 'delayMs', 'scheduled job'),
    intervalMs,
    targetSessionId: stringField(row, 'targetSessionId', 'scheduled job'),
    prompt: stringField(row, 'prompt', 'scheduled job'),
  }
}

function projectWorktree(value: unknown): GatewayWorktree {
  const row = record(value, 'worktree')
  const state = row.state
  if (state !== 'creating' && state !== 'ready' && state !== 'deleting' && state !== 'failed') {
    throw new Error('Gateway returned malformed worktree.state')
  }
  const ownership = row.ownership
  if (ownership !== undefined && ownership !== 'owned' && ownership !== 'unverified') {
    throw new Error('Gateway returned malformed worktree.ownership')
  }
  const sessionId = optionalString(row, 'sessionId', 'worktree')
  const repo = optionalString(row, 'repo', 'worktree')
  const error = optionalString(row, 'error', 'worktree')
  return {
    id: stringField(row, 'id', 'worktree'),
    workspaceId: stringField(row, 'workspaceId', 'worktree'),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(repo !== undefined ? { repo } : {}),
    path: stringField(row, 'path', 'worktree'),
    branch: stringField(row, 'branch', 'worktree'),
    ...(ownership !== undefined ? { ownership } : {}),
    state,
    ...(error !== undefined ? { error } : {}),
    createdAt: finiteNumber(row, 'createdAt', 'worktree'),
  }
}

/** Derive, never accept, the renderer-visible same-origin gateway prefix. */
export function gatewayChamberBasePath(sourceId: string): string {
  if (!GATEWAY_SOURCE_ID.test(sourceId)) {
    throw new Error(`Invalid gateway source id ${JSON.stringify(sourceId)}`)
  }
  return `/api/i/${sourceId}/chamber`
}

export class GatewayOrchestrationApi {
  private readonly basePath: string
  private readonly fetchImpl: FetchLike

  constructor(sourceId: string, fetchImpl: FetchLike = fetch) {
    this.basePath = gatewayChamberBasePath(sourceId)
    this.fetchImpl = fetchImpl
  }

  private async request(path: string, init: { method?: 'GET' | 'PUT' | 'POST'; body?: unknown } = {}): Promise<unknown> {
    const hasBody = init.body !== undefined
    let response: Response
    try {
      response = await this.fetchImpl(`${this.basePath}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Gateway request failed: ${message}`)
    }
    if (!response.ok) {
      let code: string | undefined
      try {
        const body = record(await response.json(), 'error response')
        if (typeof body.code === 'string') code = body.code
      } catch {
        // Response bodies may be HTML/proxy text. Status remains the authority.
      }
      throw new Error(`Gateway request failed (HTTP ${response.status}${code === undefined ? '' : `, ${code}`})`)
    }
    try {
      return await response.json()
    } catch {
      throw new Error('Gateway returned malformed JSON')
    }
  }

  async settings(): Promise<GatewaySettings> {
    return projectGatewaySettings(await this.request('/settings'))
  }

  async updateSettings(patch: GatewaySettingsPatch): Promise<GatewaySettings> {
    // The statically closed patch is also rebuilt here so callers cannot add
    // secret-looking runtime properties through a cast/spread.
    const body: GatewaySettingsPatch = {
      git: { enabled: patch.git.enabled === true },
      notifications: { enabled: patch.notifications.enabled === true },
      schedule: { enabled: patch.schedule.enabled === true },
    }
    return projectGatewaySettings(await this.request('/settings', { method: 'PUT', body }))
  }

  async sessions(): Promise<GatewaySession[]> {
    return items(await this.request('/sessions'), 'sessions').map(projectSession)
  }

  async interactions(): Promise<GatewayInteraction[]> {
    return items(await this.request('/approvals'), 'interactions').map(projectInteraction)
  }

  async schedule(): Promise<GatewayScheduledJob[]> {
    return items(await this.request('/schedule'), 'schedule').map(projectScheduledJob)
  }

  async worktrees(): Promise<GatewayWorktree[]> {
    return items(await this.request('/git/worktrees'), 'worktrees').map(projectWorktree)
  }

  async answerApproval(rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (rpcId === '') throw new Error('Approval rpcId is required')
    await this.request('/approvals', { method: 'POST', body: { rpcId, outcome } })
  }

  async answerQuestion(rpcId: string, answer: GatewayQuestionAnswer): Promise<void> {
    if (rpcId === '') throw new Error('Question rpcId is required')
    await this.request('/approvals', { method: 'POST', body: { rpcId, answer } })
  }
}
