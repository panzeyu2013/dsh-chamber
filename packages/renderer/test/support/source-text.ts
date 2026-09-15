/**
 * Shared helpers for the renderer's source-text wiring locks.
 *
 * `App.tsx` renders the whole shell and cannot be imported by a node test, so
 * several test files assert against its SOURCE TEXT. A lock that matches raw
 * source can be satisfied by a comment — precisely the failure mode the locks
 * exist to prevent, because the comments next to the code describe the very
 * invariant being pinned (2026-09 round-3 W4-12 precedent:
 * `packages/dsh-chamber-client-ui-sidebar/test/plugin-kernel/panel-wiring.test.ts`).
 *
 * {@link stripComments} therefore blanks every line/block comment (preserving
 * newlines, so positions and line shapes survive) while leaving string,
 * template and regex literals untouched, and {@link normalize} collapses
 * whitespace so a formatting change cannot break a semantic lock.
 */
export { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
