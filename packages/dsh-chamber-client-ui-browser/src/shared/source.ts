/**
 * Remote Browser source gate — "which chamber source may show the Browser tab?"
 *
 * Report v4 decision 2: the entry exists ONLY for a dsh-kind source reached
 * over SSH. No extra boot fact is introduced — the kind is derived from the
 * source id exactly as the renderer already does it
 * (packages/renderer/src/transport-source.ts):
 *
 *   - `dsh-<id>`  → dsh kind;
 *   - `gateway-<id>` → gateway kind (never a forward target);
 *   - `local`      → the local instance (never a forward target).
 *
 * Transport must be exactly `ssh`: a dsh instance reached over plain HTTP has
 * no tunnel to forward through, and a gateway deployment is excluded even when
 * its transport word is ssh.
 *
 * The raw-instance-id grammar mirrors desktop transport-provider.ts and
 * open-in capabilities.ts byte for byte (browser packages cannot import the
 * desktop/renderer authorities). Keep the three copies equal.
 *
 * Pure: no DOM, no Node APIs, no imports. Runs directly under Node type
 * stripping (see test/source).
 *
 * TODO(W0/pin): the fingerprint format (`^[a-f0-9]{64}$`) mirrors
 * @dsh-chamber/dsh-chamber-client-ui-open-in/src/shared/capabilities.ts. When
 * the forward wire contract lands in @dsh-chamber/dsh-chamber-wire, import the
 * single guard instead of keeping a second copy.
 */

/** The registry kind a chamber source id encodes. */
export type BrowserSourceKind = 'dsh' | 'gateway'

/** A chamber source the Browser launcher may serve. */
export interface BrowserSource {
  /** Chamber view id (`dsh-<id>` / `gateway-<id>`). */
  sourceId: string
  /** Raw registry/instance id. */
  instanceId: string
  /** Derived registry kind; only `dsh` is eligible for a forward. */
  kind: BrowserSourceKind
}

interface SourcePrefix {
  readonly prefix: string
  readonly kind: BrowserSourceKind
}

const SOURCE_PREFIXES: readonly SourcePrefix[] = [
  { prefix: 'dsh-', kind: 'dsh' },
  { prefix: 'gateway-', kind: 'gateway' },
]

// Mirrors desktop transport-provider.ts INSTANCE_ID_PATTERN and open-in
// capabilities.ts INSTANCE_ID; the negative lookahead keeps `dsh-local` from
// masquerading as the privileged local instance.
const INSTANCE_ID = /^(?!local$)[A-Za-z0-9_-]{1,64}$/u
const FINGERPRINT = /^[a-f0-9]{64}$/u

/**
 * Parse a chamber source id + transport word into the launcher's source.
 *
 * @param value - the boot context's instance/source id (untrusted).
 * @param transport - the boot context's transport word (untrusted).
 * @returns the source, or null for any malformed / non-ssh input.
 */
export function parseBrowserSource(value: unknown, transport: unknown): BrowserSource | null {
  if (typeof value !== 'string' || transport !== 'ssh') return null
  for (const entry of SOURCE_PREFIXES) {
    if (!value.startsWith(entry.prefix)) continue
    const instanceId = value.slice(entry.prefix.length)
    if (!INSTANCE_ID.test(instanceId)) return null
    return {
      sourceId: value,
      instanceId,
      kind: entry.kind,
    }
  }
  return null
}

/**
 * The apply() gate: dsh kind AND ssh transport, nothing else.
 *
 * @param value - the boot context's instance/source id.
 * @param transport - the boot context's transport word.
 * @returns the eligible source, or null (the plugin must then register NOTHING).
 */
export function resolveBrowserEntry(value: unknown, transport: unknown): BrowserSource | null {
  const source = parseBrowserSource(value, transport)
  return source !== null && source.kind === 'dsh' ? source : null
}

/**
 * Whether a source may request forwards (dsh kind). Kept as a named predicate so
 * the launcher model and the apply() gate cannot drift.
 */
export function isBrowserEligible(source: BrowserSource): boolean {
  return source.kind === 'dsh'
}

/**
 * Validate the immutable boot-bound source proof that every forward call carries
 * (main verifies it before acting, so a retargeted source rejects old tabs).
 *
 * @param source - the parsed source (always remote here).
 * @param value - the boot context's fingerprint (untrusted).
 * @returns the fingerprint, or null when it has the wrong shape.
 */
export function parseBrowserSourceFingerprint(source: BrowserSource, value: unknown): string | null {
  if (!isBrowserEligible(source)) return null
  return typeof value === 'string' && FINGERPRINT.test(value) ? value : null
}
