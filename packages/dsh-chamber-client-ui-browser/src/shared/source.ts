/**
 * Remote Browser source gate — "which chamber source may show the Browser tab?"
 *
 * The entry exists for every source that can open an address in the system
 * browser: the local instance and every remote source reached over SSH (dsh or
 * gateway). Only a plain-HTTP source is excluded — it carries no SSH tunnel, so
 * its remote-loopback leg would have no transport.
 *
 * The kind is derived from the source id exactly as the renderer already does it
 * (packages/renderer/src/transport-source.ts):
 *
 *   - `local`      → the local instance: no forward leg, every address opens on
 *                     this machine;
 *   - `dsh-<id>`   → dsh kind (forward leg through the source's ssh tunnel);
 *   - `gateway-<id>` → gateway kind (same ssh tunnel; the gateway only fronts
 *                     the dsh host, so its loopback services forward the same
 *                     way).
 *
 * `mayForward` is the capability bit the launcher branches on: the forward
 * section, the poll and the address plan all read it, so none of them can drift
 * from this table.
 *
 * The raw-instance-id grammar mirrors desktop transport-provider.ts and
 * open-in capabilities.ts byte for byte (browser packages cannot import the
 * desktop/renderer authorities). Keep the three copies equal.
 *
 * Pure: no DOM, no Node APIs, no imports. Runs directly under Node type
 * stripping (see test/source).
 *
 * The boot fingerprint is deliberately NOT validated with
 * @dsh-chamber/dsh-chamber-wire/forward's guard: that one is a loose check for
 * untrusted IPC payloads, while this file pins the boot facts themselves
 * (64-hex for a remote source, the literal `local` for the local instance).
 * The 64-hex shape mirrors
 * @dsh-chamber/dsh-chamber-client-ui-open-in/src/shared/capabilities.ts.
 */

/** The registry kind a chamber source id encodes. */
export type BrowserSourceKind = 'dsh' | 'gateway' | 'local'

/** The transports that can show the entry (`http` is excluded). */
export type BrowserTransport = 'local' | 'ssh'

/** A chamber source the Browser launcher may serve. */
export interface BrowserSource {
  /** Chamber view id (`dsh-<id>` / `gateway-<id>` / the literal `local`). */
  sourceId: string
  /** Raw registry/instance id (`local` for the local instance). */
  instanceId: string
  /** Derived registry kind. */
  kind: BrowserSourceKind
  /** Boot transport word, narrowed to the two that qualify. */
  transport: BrowserTransport
  /** Whether this source has a remote-loopback forward leg (ssh sources only). */
  mayForward: boolean
}

interface SourcePrefix {
  readonly prefix: string
  readonly kind: 'dsh' | 'gateway'
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
/** The local instance's boot fingerprint is the literal word (shell.ts provides it). */
const LOCAL_FINGERPRINT = 'local'

/**
 * Parse a chamber source id + transport word into the launcher's source.
 *
 * @param value - the boot context's instance/source id (untrusted).
 * @param transport - the boot context's transport word (untrusted).
 * @returns the source, or null for any malformed / http input.
 */
export function parseBrowserSource(value: unknown, transport: unknown): BrowserSource | null {
  if (typeof value !== 'string' || (transport !== 'local' && transport !== 'ssh')) return null
  if (value === 'local') {
    if (transport !== 'local') return null
    return {
      sourceId: 'local',
      instanceId: 'local',
      kind: 'local',
      transport: 'local',
      mayForward: false,
    }
  }
  for (const entry of SOURCE_PREFIXES) {
    if (!value.startsWith(entry.prefix)) continue
    if (transport !== 'ssh') return null
    const instanceId = value.slice(entry.prefix.length)
    if (!INSTANCE_ID.test(instanceId)) return null
    return {
      sourceId: value,
      instanceId,
      kind: entry.kind,
      transport: 'ssh',
      mayForward: true,
    }
  }
  return null
}

/**
 * The apply() gate: every source except a plain-HTTP one.
 *
 * @param value - the boot context's instance/source id.
 * @param transport - the boot context's transport word.
 * @returns the source, or null (the plugin must then register NOTHING).
 */
export function resolveBrowserEntry(value: unknown, transport: unknown): BrowserSource | null {
  return parseBrowserSource(value, transport)
}

/**
 * Whether a source has a remote-loopback forward leg. `source.mayForward` is the
 * contract the launcher model and the panel read; this predicate names the same
 * fact for the boot-fingerprint rule and the shared source-gate table, so the
 * two readings cannot diverge.
 */
export function sourceMayForward(source: BrowserSource): boolean {
  return source.mayForward
}

/**
 * Validate the immutable boot-bound source proof that every forward call carries
 * (main verifies it before acting, so a retargeted source rejects old tabs).
 *
 * @param source - the parsed source.
 * @param value - the boot context's fingerprint (untrusted).
 * @returns the fingerprint, or null when it has the wrong shape.
 */
export function parseBrowserSourceFingerprint(source: BrowserSource, value: unknown): string | null {
  if (!sourceMayForward(source)) return value === LOCAL_FINGERPRINT ? LOCAL_FINGERPRINT : null
  return typeof value === 'string' && FINGERPRINT.test(value) ? value : null
}
