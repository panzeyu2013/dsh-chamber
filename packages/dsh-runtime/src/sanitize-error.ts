/**
 * Error-text path redaction shared by the desktop main-process modules — one contract for
 * every error text that may ride a renderer projection.
 *
 * Absolute paths (POSIX, Windows drive and UNC shares) are removed so the projection stays
 * path-free; full detail stays in the main-process log. The POSIX branch's lookbehind keeps a
 * URL's `//host` but still redacts the PATHNAME (`https://github.com[path]`); the Windows
 * branch rejects `x://` so a scheme is never read as a drive path; the UNC branch keys on the
 * leading double backslash. `file://` is the exception: its authority/path is local
 * filesystem material, so the whole token is removed before the generic path rules run.
 *
 * `keep` preserves the caller's own non-secret vocabulary: the POSIX branch matches
 * `word/word` from INSIDE a token, so a registered RPC method name (`commands/execute`)
 * would ride the projection as `commands[path]`, losing the method that failed.
 */
export function sanitizeErrorText(message: string, keep: readonly string[] = []): string {
  const held: string[] = []
  let masked = message
  for (const token of keep.filter((entry) => entry !== '').sort((a, b) => b.length - a.length)) {
    if (!masked.includes(token)) continue
    const index = held.push(token) - 1
    masked = masked.split(token).join(`__DSH_KEEP_${index}__`)
  }
  const redacted = masked
    .replace(/\bfile:\/\/[^\s"'<>]*/giu, '[path]')
    .replace(/(?:[A-Za-z]:[\\/](?![/]))[^\s]*/g, '[path]')
    // UNC shares carry a user path just like a drive path and match none of the rules above;
    // they get their own leading-double-backslash rule (which also covers the extended-length
    // form), running BEFORE the POSIX rule so a UNC token is eaten whole.
    .replace(/\\\\[^\s"'<>]*/g, '[path]')
    .replace(/(?<![:/])\/(?:[^\s/]+(?:[/\\][^\s]*)?)/g, '[path]')
  if (held.length === 0) return redacted
  return redacted.replace(/__DSH_KEEP_(\d+)__/g, (token, rawIndex: string) => held[Number(rawIndex)] ?? token)
}
