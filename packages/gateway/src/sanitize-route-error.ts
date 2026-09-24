/** Error sanitization for the public runtime surface: shared-core path stripping PLUS URL
 * userinfo/query and credential-pattern redaction. */
import { sanitizeErrorText } from '@dsh-chamber/dsh-runtime'

/**
 * @param keep - the caller's own non-secret vocabulary, preserved verbatim and
 *   forwarded to {@link sanitizeErrorText}. Needed for the unknown-package
 *   refusal: without the scoped name (`@dsh-chamber/dsh-…`) the redactor eats it
 *   as POSIX path material, losing the fact the 400 exists to carry.
 */
export function sanitizeRouteError(message: string, keep: readonly string[] = []): string {
  const base = sanitizeErrorText(message, keep)
  return base
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s]+)/giu, url => url.replace(/([?&#]).*$/u, '$1'))
    .replace(/(token|password|secret|authorization|passwd|cookie|api[_-]?key)\s*[:=]\s*[^\s&"']+/giu, '$1=[redacted]')
    .slice(0, 2_000)
}
