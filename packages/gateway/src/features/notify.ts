/**
 * Approval/question notifier (design 17 §8.3): consumes the dsh answerable
 * events and forwards them to a caller; answers flow back through the 0.1.2
 * `$events/result` Remote RPC.
 *
 * dsh 0.1.2 wire (review-round2 P1-1 fixed): the `events.mux` downlink WS
 * (server-request frames) and the `POST /api/respond` client-response surface
 * were REMOVED upstream. Answerables now arrive on the forwarded `$events`
 * Remote stream over `/api/remote.mux`:
 *   - open frame `{type:'open',streamId,endpoint:'$events',payload:{args:{}}}`;
 *   - a `ready` frame carrying the `clientId` bound to this stream generation;
 *   - `waterfall` frames for `approval/request` (request fields
 *     `{toolName, callId?, reason?}`) and `user-questions/request`
 *     (`{sessionId?, questions}`) — the eventId is the answerable id;
 * Answers are sent as the unary Remote `$events/result` with
 * `{args:{clientId,eventId,outcome}}` (outcome `{kind:'result',value}`).
 * The old host-driven `approval/resolved`/`question/resolved` events are NOT
 * forwarded on the new wire; resolution is therefore answer-driven (the
 * resolved callbacks fire after a successful answer).
 */

import { RpcBusinessError, call, type Logger } from '@dsh-chamber/control-plane'
import {
  openRemoteStream,
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  type RemoteEventDownlinkFrame,
} from './remote-stream.ts'

export interface ApprovalRequest {
  /** Agent identity projected by the host (session-scoped agent of the ask). */
  sessionId: string
  /** The Remote eventId of the pending waterfall — the answer correlates on it. */
  approvalId: string
  /** The $events stream clientId bound to this delivery generation. */
  clientId: string
  toolName: string
  reason?: string
  callId?: string
}

export interface QuestionRequest {
  sessionId: string
  /** The Remote eventId of the pending waterfall. */
  questionId: string
  /** The $events stream clientId bound to this delivery generation. */
  clientId: string
  /** AskUserQuestionItem[] (dsh-user-questions vocabulary). */
  questions: unknown[]
}

export interface ApprovalNotifier {
  /** Open (or wait for) the $events stream; reconnects until stopped. */
  start(): void
  /** Close the stream + release the AbortController. */
  stop(): void
  answerApproval(req: ApprovalRequest, outcome: 'allowed-once' | 'rejected'): Promise<void>
  answerQuestion(req: QuestionRequest, answer: unknown): Promise<void>
}

/** The dsh host rejected the event result (unknown clientId/eventId or an
 * invalid outcome). Callers must keep their local pending row. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createApprovalNotifier(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  onApproval(req: ApprovalRequest): void
  onQuestion(req: QuestionRequest): void
  onApprovalResolved?(sessionId: string, approvalId: string): void
  onQuestionResolved?(questionId: string): void
  /** Mux replay is the pending baseline; discard the previous generation. */
  onGenerationStart?(): void
  openRemoteStream?: (
    baseUrl: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>
  callDsh?: typeof call
  reconnectDelayMs?: number
}): ApprovalNotifier {
  let abort: AbortController | null = null
  let lifecycleEpoch = 0
  const openStream = deps.openRemoteStream ?? openRemoteStream
  const callDsh = deps.callDsh ?? call
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
    let clientId: string | null = null
    try {
      for await (const value of openStream(baseUrl, REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_EVENT_STREAM_PAYLOAD, signal)) {
        if (epoch !== lifecycleEpoch) return
        const frame = value as RemoteEventDownlinkFrame
        if (!isRecord(frame)) continue
        if (frame.type === 'ready') {
          clientId = typeof frame.clientId === 'string' ? frame.clientId : null
          continue
        }
        if (clientId === null) continue // no ready frame yet — cannot answer anyway
        if (frame.type === 'waterfall' && typeof frame.event === 'string' && typeof frame.eventId === 'string') {
          const request = isRecord(frame.request) ? frame.request : {}
          if (frame.event === 'approval/request' && typeof request.toolName === 'string') {
            deps.onApproval({
              sessionId: String(frame.agentId ?? ''),
              approvalId: frame.eventId,
              clientId,
              toolName: request.toolName,
              ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
              ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
            })
          } else if (frame.event === 'user-questions/request' && Array.isArray(request.questions)) {
            deps.onQuestion({
              // The 0.1.2 frame has no sessionId field — the agentId is the
              // session identity (review-round8b P2 dead-read removal).
              sessionId: String(frame.agentId ?? ''),
              questionId: frame.eventId,
              clientId,
              questions: request.questions as unknown[],
            })
          }
          // Other waterfall events are not answerable by this notifier.
        }
        // ready/emit/cancel frames carry no answerable request — ignored.
      }
    } catch (error) {
      if (!signal.aborted) deps.logger.warn(`approval-notifier: $events stream ended: ${String(error)}`)
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

  /** Send one `$events/result` unary and classify host rejection as terminal. */
  async function sendResult(
    baseUrl: string,
    req: { clientId: string; approvalId?: string; questionId?: string },
    outcome: { kind: 'result'; value: unknown },
  ): Promise<void> {
    const eventId = req.approvalId ?? req.questionId ?? ''
    try {
      const { result } = await callDsh(baseUrl, REMOTE_EVENT_RESULT_ENDPOINT, {
        args: { clientId: req.clientId, eventId, outcome },
      })
      if (result.ok !== true) {
        // The unary envelope carries the error slot when ok=false; the
        // fallback covers hosts that only answer the status (round8b).
        const reason = result.error !== undefined
          ? `${String(result.error.code)}: ${String(result.error.message)}`
          : 'host rejected the event result'
        throw new AnswerRejectedError(reason)
      }
    } catch (error) {
      if (error instanceof AnswerRejectedError) throw error
      if (error instanceof RpcBusinessError) {
        throw new AnswerRejectedError(`${error.code}: ${error.message}`)
      }
      throw error
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
      await sendResult(baseUrl, req, { kind: 'result', value: outcome })
      // 0.1.2 wire: no host-driven approval/resolved event is forwarded —
      // resolution is answer-driven.
      deps.onApprovalResolved?.(req.sessionId, req.approvalId)
    },
    async answerQuestion(req: QuestionRequest, answer: unknown): Promise<void> {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) throw notReadyError('question answer')
      await sendResult(baseUrl, req, { kind: 'result', value: answer })
      deps.onQuestionResolved?.(req.questionId)
    },
  }
}
