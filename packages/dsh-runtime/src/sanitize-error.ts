/**
 * Error-text path redaction shared by the desktop main-process modules (design
 * 16 §6 — extracted verbatim from updater.ts so the same redaction contract
 * covers every error text that may ride a renderer projection).
 *
 * Redact absolute paths (e.g. the updater cache dir, which electron-updater
 * embeds in some error messages) from the error text that rides the renderer
 * projection — the projection stays path-free (design 11 §7 non-secret
 * contract); the full detail stays in the main-process log. Covers Windows
 * drive paths and POSIX absolute paths rooted at any component (2026-08
 * review: broadened from the fixed root list — /opt, /usr/local, /Library,
 * /run, /root etc. all carry path material too). The POSIX branch uses a
 * lookbehind so a URL's `//host/...` (the non-secret feed/release URL) is
 * NOT mangled — only real path tokens are redacted; the Windows branch
 * rejects `x://` (a scheme, e.g. `https://` — the drive letter is followed
 * by TWO slashes) so URLs survive it too. `file://` is the exception: its
 * authority/path is local filesystem material, so the entire token is
 * removed before the generic URL-preserving path rules run.
 *
 * `keep` holds the caller's own non-secret vocabulary out of the redaction: the
 * POSIX branch matches `word/word` from INSIDE a token, so a registered RPC
 * method name (`commands/execute`, `session/canOpenWorkspacePath`, …) would ride
 * the renderer projection as `commands[path]` and lose the method that failed —
 * the 2026-09 acceptance round read exactly that mangled form while hunting a
 * quarantined fresh install. Passing the vocabulary restores only those literals;
 * every path and URL rule above still applies to the rest of the message.
 * @param message - the error text to redact.
 * @param keep - literal non-secret tokens to preserve verbatim (default: none).
 * @returns the redacted message with the kept tokens restored.
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
    .replace(/(?<![:/])\/(?:[^\s/]+(?:[/\\][^\s]*)?)/g, '[path]')
  if (held.length === 0) return redacted
  return redacted.replace(/__DSH_KEEP_(\d+)__/g, (token, rawIndex: string) => held[Number(rawIndex)] ?? token)
}
