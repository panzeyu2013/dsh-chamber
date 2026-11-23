/**
 * Writer half of the `plugin:worktree/entered` interop (design 08 §4.2): the vendor
 * `appendPluginRecord` call, split from the pure payload module so the payload stays
 * testable without the host runtime.
 */
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import { ENTERED_RECORD, type EnteredWorktreeRecord } from './enter-record.ts'

/**
 * The vendor writer narrowed to the seed's needs.
 *
 * `appendPluginRecord`'s record-name parameter is constrained to `PluginRecordMap`,
 * which the EXPERIMENTAL worktree package augments for itself. This seed's program
 * cannot import that augmentation (the vendor subpath has no source-level twin in the
 * seeds' tsconfig mapping, and importing the worktree service just for a type would
 * drag the upstream service into the seed build), so the call is typed here against
 * the payload built above. The record name/payload are pinned to the vendored
 * projection by `test/enter-record.test.ts` — the runtime contract is unchanged.
 */
const writePluginRecord = appendPluginRecord as unknown as (
  session: Session,
  type: typeof ENTERED_RECORD,
  data: EnteredWorktreeRecord,
) => unknown

/**
 * Append the entered record to the Session log.
 * @param session - the Session that just entered the checkout (the host's live agent session).
 * @param record - payload from `enteredWorktreeRecord` (strict upstream shape).
 */
export function appendEnteredRecord(session: Session, record: EnteredWorktreeRecord): void {
  void writePluginRecord(session, ENTERED_RECORD, record)
}
