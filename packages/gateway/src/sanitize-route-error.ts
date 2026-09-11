/**
 * S19 error sanitization for the public runtime surface: path stripping from
 * the shared core PLUS URL userinfo/query and credential-pattern redaction.
 * ("not exported" note removed 2026 audit: the installer's internal
 * sanitizer — sanitizeInstallerOutput — has been exported from the shared
 * core and is consumed by the plugin executor; this route layer mirrors it.)
 */
import { sanitizeErrorText } from '@dsh-chamber/dsh-runtime'

/**
 * @param message - the error text to redact.
 * @param keep - the caller's own non-secret vocabulary, preserved verbatim
 *   (forwarded to {@link sanitizeErrorText}). This exists because of the
 *   unknown-package refusal: a scoped package name (`@dsh-chamber/dsh-…`)
 *   reads as POSIX path material to the redactor, so without the token the
 *   400 answered `unsyncable package "@dsh-chamber[path]` — losing the single
 *   fact the message was added for (2026-09 audit). Paths and credentials in
 *   the rest of the message are still redacted.
 */
export function sanitizeRouteError(message: string, keep: readonly string[] = []): string {
  const base = sanitizeErrorText(message, keep)
  return base
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s]+)/giu, url => url.replace(/([?&#]).*$/u, '$1'))
    .replace(/(token|password|secret|authorization|passwd|cookie|api[_-]?key)\s*[:=]\s*[^\s&"']+/giu, '$1=[redacted]')
    .slice(0, 2_000)
}
