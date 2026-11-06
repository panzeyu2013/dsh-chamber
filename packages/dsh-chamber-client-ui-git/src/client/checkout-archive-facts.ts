/**
 * Client-side facts for the optional archive step: fetch the source's session
 * rows and build the checkout's archive closure. Kept out of the component so
 * the dialog-open preview and the confirm-time re-plan share one computation.
 *
 * The archive SET is read from the mounted aggregate when the host actually
 * projected it (`archiveSetKnown === true`); the unary fallback's set is
 * explicitly unknown, so it is never used to claim "already archived".
 */
import {
  chamberBridge, fetchInstanceSnapshot, getInstanceClient,
} from '@dsh-chamber/dsh-chamber-client-core'
import { planCheckoutArchive } from '../shared/checkout-archive.ts'

/** What the archive checkbox knows at one point in time. */
export interface CheckoutArchiveFacts {
  readonly state: 'loading' | 'ready' | 'error'
  readonly ids?: readonly string[]
  readonly count?: number
  /** True when the aggregate projected the authoritative archive set. */
  readonly known?: boolean
  readonly titles?: readonly { readonly sessionId: string; readonly title?: string }[]
  readonly error?: string
}

/** The fresh plan consumed by the confirm path. */
export interface CheckoutArchivePlanFacts {
  readonly ids: readonly string[]
  readonly count: number
  readonly known: boolean
  readonly titles: readonly { readonly sessionId: string; readonly title?: string }[]
}

/**
 * Fetch the session rows and plan one checkout's archive closure.
 * @param sourceId - the source whose unary client is used.
 * @param checkoutPath - the checkout row's canonical path.
 * @param signal - aborts the unary when the dialog is superseded/unmounted.
 * @throws the transport/unary failure (the caller localizes it).
 */
export async function fetchCheckoutArchiveFacts(
  sourceId: string,
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<CheckoutArchivePlanFacts> {
  const instance = await fetchInstanceSnapshot(getInstanceClient(sourceId), signal)
  const server = chamberBridge.getServers().find(candidate => candidate.id === sourceId)
  const archived = server?.archiveSetKnown === true
    ? new Set((server.archivedSessions ?? []).map(row => row.sessionId))
    : undefined
  const plan = planCheckoutArchive(
    instance.sessions.map(session => ({
      sessionId: session.sessionId,
      ...(session.workingDirectory === undefined ? {} : { workingDirectory: session.workingDirectory }),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
      ...(session.title === undefined ? {} : { title: session.title }),
    })),
    checkoutPath,
    archived,
  )
  return { ids: plan.toArchive, count: plan.toArchive.length, known: archived !== undefined, titles: plan.titles }
}
