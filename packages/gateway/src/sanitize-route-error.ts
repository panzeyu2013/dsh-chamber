/**
 * S19 error sanitization for the public runtime surface: path stripping from
 * the shared core PLUS URL userinfo/query and credential-pattern redaction
 * (mirrors the installer's internal sanitizer; it is not exported).
 */
import { sanitizeErrorText } from '@dsh-chamber/dsh-runtime'

export function sanitizeRouteError(message: string): string {
  const base = sanitizeErrorText(message)
  return base
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s]+)/giu, url => url.replace(/([?&#]).*$/u, '$1'))
    .replace(/(token|password|secret|authorization|passwd|cookie|api[_-]?key)\s*[:=]\s*[^\s&"']+/giu, '$1=[redacted]')
    .slice(0, 2_000)
}
