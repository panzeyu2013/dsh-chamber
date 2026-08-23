/**
 * Approval/question notifier (design 16 §8.3): consumes the dsh `events.mux`
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
  /** Open the mux stream (idempotent). No-op when dsh is not ready. */
  start(): void
  /** Close the stream + release the AbortController. */
  stop(): void
  answerApproval(req: ApprovalRequest, outcome: 'allowed-once' | 'rejected'): Promise<void>
  answerQuestion(req: QuestionRequest, answer: unknown): Promise<void>
}

export function createApprovalNotifier(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  onApproval(req: ApprovalRequest): void
  onQuestion(req: QuestionRequest): void
}): ApprovalNotifier {
  let abort: AbortController | null = null

  async function consume(baseUrl: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of openEventStream(baseUrl, '/api/events.mux', signal)) {
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
        }
        void frame // (the full frame is intentionally not forwarded — only the projected request)
      }
    } catch (error) {
      if (!signal.aborted) deps.logger.warn(`approval-notifier: mux stream ended: ${String(error)}`)
    }
  }

  return {
    start(): void {
      if (abort !== null) return
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) return
      const controller = new AbortController()
      abort = controller
      void consume(baseUrl, controller.signal)
    },
    stop(): void {
      if (abort !== null) {
        abort.abort()
        abort = null
      }
    },
    async answerApproval(req: ApprovalRequest, outcome: 'allowed-once' | 'rejected'): Promise<void> {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) throw new Error('approval answer: local dsh instance is not ready')
      await respond(baseUrl, {
        rpcId: req.rpcId,
        result: { value: { sessionId: req.sessionId, approvalId: req.approvalId, outcome } },
      })
    },
    async answerQuestion(req: QuestionRequest, answer: unknown): Promise<void> {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) throw new Error('question answer: local dsh instance is not ready')
      await respond(baseUrl, {
        rpcId: req.rpcId,
        result: { value: { sessionId: req.sessionId, answer } },
      })
    },
  }
}

// Re-export for the route layer's type surface.
export type { ServerRequest }
