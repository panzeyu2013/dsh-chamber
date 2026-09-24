import { PROBE_TEXT_KEEP_TOKENS, sanitizeErrorText as sanitizeRuntimeErrorText } from '@dsh-chamber/dsh-runtime'

/**
 * Updater errors carry a public release URL next to a local cache path; the
 * shared runtime sanitizer redacts paths but treats the URL pathname as POSIX
 * material. Protect bounded HTTP(S) tokens across the shared redaction, then
 * restore them verbatim.
 *
 * Probe method names ride along as kept tokens (PROBE_TEXT_KEEP_TOKENS): they
 * are RPC vocabulary, not
 * path material, and a required-set-only list would republish a probe failure
 * as `commands[path]` while losing the failing method name.
 */
export function sanitizeErrorText(message: string): string {
  const urls: string[] = []
  const protectedMessage = message.replace(/https?:\/\/[^\s]+/g, (url) => {
    const index = urls.push(url) - 1
    return `__DSH_PUBLIC_URL_${index}__`
  })
  const sanitized = sanitizeRuntimeErrorText(protectedMessage, PROBE_TEXT_KEEP_TOKENS)
  return sanitized.replace(/__DSH_PUBLIC_URL_(\d+)__/g, (_token, rawIndex: string) => {
    const index = Number(rawIndex)
    return Number.isInteger(index) && urls[index] !== undefined ? urls[index] : '[url]'
  })
}
