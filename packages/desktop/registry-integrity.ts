import { createHash, timingSafeEqual } from 'node:crypto'

type IntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512'

interface ParsedIntegrity {
  algorithm: IntegrityAlgorithm
  digests: Buffer[]
}

const ALGORITHM_STRENGTH: Record<IntegrityAlgorithm, number> = {
  sha256: 256,
  sha384: 384,
  sha512: 512,
}

const DIGEST_LENGTH: Record<IntegrityAlgorithm, number> = {
  sha256: 32,
  sha384: 48,
  sha512: 64,
}

/**
 * Parse an npm Subresource Integrity string and retain only the strongest
 * supported algorithm. This follows SRI downgrade resistance: a matching
 * weaker digest cannot rescue a mismatching stronger digest.
 */
function parseIntegrity(raw: unknown): ParsedIntegrity | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 4096) return null
  const parsed: Array<{ algorithm: IntegrityAlgorithm; digest: Buffer }> = []
  for (const token of raw.trim().split(/\s+/)) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token)
    if (match === null) continue
    const algorithm = match[1] as IntegrityAlgorithm
    const encoded = match[2]
    const digest = Buffer.from(encoded, 'base64')
    if (digest.length !== DIGEST_LENGTH[algorithm]) continue
    // Buffer.from(base64) is deliberately forgiving. Re-encode to reject
    // malformed/truncated encodings that it would otherwise silently accept.
    if (digest.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) continue
    parsed.push({ algorithm, digest })
  }
  if (parsed.length === 0) return null
  const strongest = parsed.reduce((best, item) => (
    ALGORITHM_STRENGTH[item.algorithm] > ALGORITHM_STRENGTH[best.algorithm] ? item : best
  )).algorithm
  return {
    algorithm: strongest,
    digests: parsed.filter((item) => item.algorithm === strongest).map((item) => item.digest),
  }
}

export function isSupportedIntegrity(raw: unknown): raw is string {
  return parseIntegrity(raw) !== null
}

/** Incremental verifier used while streaming a registry tarball to disk. */
export function createIntegrityVerifier(raw: string): {
  update: (chunk: Uint8Array) => void
  assertMatch: () => void
} {
  const parsed = parseIntegrity(raw)
  if (parsed === null) throw new Error('registry tarball 缺少可用的 sha256/sha384/sha512 integrity')
  const hash = createHash(parsed.algorithm)
  let finished = false
  return {
    update(chunk) {
      if (finished) throw new Error('integrity verifier already finalized')
      hash.update(chunk)
    },
    assertMatch() {
      if (finished) throw new Error('integrity verifier already finalized')
      finished = true
      const actual = hash.digest()
      if (!parsed.digests.some((expected) => (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      ))) {
        throw new Error(`registry tarball integrity mismatch (${parsed.algorithm})`)
      }
    },
  }
}
