import { REQUIRED_ACTIVATION_PROBES, sanitizeErrorText as sanitizeRuntimeErrorText } from '@dsh-chamber/dsh-runtime'

/**
 * Desktop updater errors commonly include a public release URL followed by a
 * local cache path. The shared runtime sanitizer correctly redacts paths but
 * treats the URL pathname as POSIX material. Protect bounded HTTP(S) tokens
 * while applying the shared redaction, then restore them verbatim.
 *
 * The registered activation-probe method names ride along as kept tokens: they
 * are RPC vocabulary rather than path material, and this second pass would
 * otherwise republish a probe failure as `commands[path]` — the 2026-09
 * acceptance round lost the failing method that way while diagnosing a
 * quarantined fresh install.
 */
export function sanitizeErrorText(message: string): string {
  const urls: string[] = []
  const protectedMessage = message.replace(/https?:\/\/[^\s]+/g, (url) => {
    const index = urls.push(url) - 1
    return `__DSH_PUBLIC_URL_${index}__`
  })
  const sanitized = sanitizeRuntimeErrorText(protectedMessage, REQUIRED_ACTIVATION_PROBES)
  return sanitized.replace(/__DSH_PUBLIC_URL_(\d+)__/g, (_token, rawIndex: string) => {
    const index = Number(rawIndex)
    return Number.isInteger(index) && urls[index] !== undefined ? urls[index] : '[url]'
  })
}
