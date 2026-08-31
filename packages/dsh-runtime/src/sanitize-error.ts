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
 */
export function sanitizeErrorText(message: string): string {
  return message
    .replace(/\bfile:\/\/[^\s"'<>]*/giu, '[path]')
    .replace(/(?:[A-Za-z]:[\\/](?![/]))[^\s]*/g, '[path]')
    .replace(/(?<![:/])\/(?:[^\s/]+(?:[/\\][^\s]*)?)/g, '[path]')
}
