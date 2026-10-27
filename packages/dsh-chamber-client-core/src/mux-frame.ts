/**
 * Browser-side face of the host mux wire contracts in the neutral wire package
 * (@dsh-chamber/dsh-chamber-wire/mux-frame): the remote.mux path, the $events
 * endpoint, the one-shot follow payload, and the privacy-whitelisted goal
 * projection / activation-edge parsers.
 *
 * HARD DISCIPLINE: this file declares nothing. A wire-face change updates this name
 * list and nothing else. No `export *`: verify-no-dead-exports resolves named
 * re-exports only.
 */
export {
  FOLLOW_MAX_MESSAGES,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_STREAM_MUX_PATH,
  buildSessionFollowPayload,
  parseGoalActivationFact,
  parseProjectedGoalFact,
} from '@dsh-chamber/dsh-chamber-wire/mux-frame'
export type { GoalActivationFact } from '@dsh-chamber/dsh-chamber-wire/mux-frame'
