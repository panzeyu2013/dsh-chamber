/**
 * Approval/question notifier (design 17 §8.3): consumes the dsh `events.mux`
 * answerable frames and forwards them to a caller; answers flow back through
 * `POST /api/respond`. The feature host re-exposes this as `/chamber/approvals`
 * (SSE push + answer) — here it is the transport-agnostic core.
 */

import { openEventStream, respond, type Logger, type ServerRequest } from '@dsh-chamber/control-plane'

export interface ApprovalRequest {
  sessionId: string
  approvalId: string
  /** The ServerRequest rpcId to echo on the answer (NOT the approvalId). */
  rpcId: string
  toolName: string
  reason?: string
}

export interface QuestionRequest {
  sessionId: string
  /** The ServerRequest rpcId to echo on the answer. */
  rpcId: string
  /** AskUserQuestionItem[] (dsh-user-questions vocabulary). */
  questions: unknown[]
}

export interface ApprovalNotifier {
  /** Open (or wait for) the mux stream; reconnects until stopped. */
  start(): void
  /** Close the stream + release the AbortController. */
  stop(): void
  answerApproval(req: ApprovalRequest, outcome: 'allowed-once' | 'rejected'): Promise<void>
  answerQuestion(req: QuestionRequest, answer: unknown): Promise<void>
}

/** The carrier accepted the HTTP request but the dsh host rejected the
 * client-response (late/duplicate rpcId or a payload that does not match the
 * pending interaction). Callers must keep their local pending row. */
export class AnswerRejectedError extends Error {
  readonly code = 'answer_rejected'
  readonly reason: string
  constructor(reason: string) {
    super(`dsh rejected the answer: ${reason}`)
    this.name = 'AnswerRejectedError'
    this.reason = reason
  }
}

/** Upstream-unavailable error mapped to an explicit 503 by the route layer
 * (S4: never a misleading 500 internal when the managed dsh is not ready). */
function notReadyError(what: string): Error & { code: string } {
  const error = new Error(`${what}: local dsh instance is not ready`) as Error & { code: string }
  error.code = 'instance_unavailable'
  return error
}

export function createApprovalNotifier(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  onApproval(req: ApprovalRequest): void
  onQuestion(req: QuestionRequest): void
  onApprovalResolved?(sessionId: string, approvalId: string): void
  onQuestionResolved?(questionRpcId: string): void
  /** Mux replay is the pending baseline; discard the previous generation. */
  onGenerationStart?(): void
  openStream?: (baseUrl: string, path: string, signal?: AbortSignal) => AsyncIterable<ServerRequest>
  respondDsh?: typeof respond
  reconnectDelayMs?: number
}): ApprovalNotifier {
  let abort: AbortController | null = null
  let lifecycleEpoch = 0
  const openStream = deps.openStream ?? openEventStream
  const respondDsh = deps.respondDsh ?? respond
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1_000

  function waitForRetry(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(done, reconnectDelayMs)
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  async function consume(baseUrl: string, signal: AbortSignal, epoch: number): Promise<void> {
    try {
      for await (const frame of openStream(baseUrl, '/api/events.mux', signal)) {
        if (epoch !== lifecycleEpoch) return
        if (frame.method === 'approval/requested') {
          const p = frame.payload
          if (typeof p.sessionId === 'string' && typeof p.approvalId === 'string' && typeof p.toolName === 'string') {
            deps.onApproval({
              sessionId: p.sessionId,
              approvalId: p.approvalId,
              rpcId: frame.rpcId,
              toolName: p.toolName,
              ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
            })
          }
        } else if (frame.method === 'question/requested') {
          const p = frame.payload
          if (typeof p.sessionId === 'string' && Array.isArray(p.questions)) {
            deps.onQuestion({ sessionId: p.sessionId, rpcId: frame.rpcId, questions: p.questions as unknown[] })
          }
        } else if (frame.method === 'approval/resolved') {
          const p = frame.payload
          if (typeof p.sessionId === 'string' && typeof p.approvalId === 'string') {
            deps.onApprovalResolved?.(p.sessionId, p.approvalId)
          }
        } else if (frame.method === 'question/resolved') {
          const p = frame.payload
          if (typeof p.questionRpcId === 'string') deps.onQuestionResolved?.(p.questionRpcId)
        }
        void frame // (the full frame is intentionally not forwarded — only the projected request)
      }
    } catch (error) {
      if (!signal.aborted) deps.logger.warn(`approval-notifier: mux stream ended: ${String(error)}`)
    }
  }

  async function run(signal: AbortSignal, epoch: number): Promise<void> {
    while (!signal.aborted && epoch === lifecycleEpoch) {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) {
        await waitForRetry(signal)
        continue
      }
      deps.onGenerationStart?.()
      await consume(baseUrl, signal, epoch)
      if (!signal.aborted && epoch === lifecycleEpoch) await waitForRetry(signal)
    }
  }

  return {
    start(): void {
      if (abort !== null) return
      const controller = new AbortController()
      const epoch = ++lifecycleEpoch
      abort = controller
      void run(controller.signal, epoch)
    },
    stop(): void {
      if (abort !== null) {
        lifecycleEpoch += 1
        abort.abort()
        abort = null
      }
    },
    async answerApproval(req: ApprovalRequest, outcome: 'allowed-once' | 'rejected'): Promise<void> {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) throw notReadyError('approval answer')
      const receipt = await respondDsh(baseUrl, {
        rpcId: req.rpcId,
        result: { ok: true, value: { sessionId: req.sessionId, approvalId: req.approvalId, outcome } },
      })
      if (!receipt.accepted) throw new AnswerRejectedError(receipt.reason ?? 'rejected')
    },
    async answerQuestion(req: QuestionRequest, answer: unknown): Promise<void> {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) throw notReadyError('question answer')
      const receipt = await respondDsh(baseUrl, {
        rpcId: req.rpcId,
        result: { ok: true, value: { sessionId: req.sessionId, answer } },
      })
      if (!receipt.accepted) throw new AnswerRejectedError(receipt.reason ?? 'rejected')
    },
  }
}

// Re-export for the route layer's type surface.
export type { ServerRequest }
