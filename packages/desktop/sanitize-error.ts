import { sanitizeErrorText as sanitizeRuntimeErrorText } from '@dsh-chamber/dsh-runtime'

/**
 * Desktop updater errors commonly include a public release URL followed by a
 * local cache path. The shared runtime sanitizer correctly redacts paths but
 * treats the URL pathname as POSIX material. Protect bounded HTTP(S) tokens
 * while applying the shared redaction, then restore them verbatim.
 */
export function sanitizeErrorText(message: string): string {
  const urls: string[] = []
  const protectedMessage = message.replace(/https?:\/\/[^\s]+/g, (url) => {
    const index = urls.push(url) - 1
    return `__DSH_PUBLIC_URL_${index}__`
  })
  const sanitized = sanitizeRuntimeErrorText(protectedMessage)
  return sanitized.replace(/__DSH_PUBLIC_URL_(\d+)__/g, (_token, rawIndex: string) => {
    const index = Number(rawIndex)
    return Number.isInteger(index) && urls[index] !== undefined ? urls[index] : '[url]'
  })
}
