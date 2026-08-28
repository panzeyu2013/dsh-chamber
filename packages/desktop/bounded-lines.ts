/**
 * Incremental, bounded line assembly for child-process output. Node stream
 * chunks are arbitrary, so redaction/classification must see whole lines;
 * retaining an unterminated line without a cap would let a noisy or hostile
 * child grow the Electron main process indefinitely.
 */

export const CHILD_LINE_MAX_CHARS = 64 * 1024

export function createBoundedLineProcessor(
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxChars = CHILD_LINE_MAX_CHARS,
): (text: string) => void {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer')
  let pending = ''
  let dropping = false

  return (text: string) => {
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      const end = newline === -1 ? text.length : newline
      const fragment = text.slice(offset, end)

      if (!dropping) {
        if (pending.length + fragment.length > maxChars) {
          pending = ''
          dropping = true
          onOverflow()
        } else {
          pending += fragment
        }
      }

      if (newline === -1) return
      if (!dropping) {
        const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending
        pending = ''
        onLine(line)
      } else {
        pending = ''
        dropping = false
      }
      offset = newline + 1
    }
  }
}
