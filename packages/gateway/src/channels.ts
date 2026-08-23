/**
 * Channel registry (design 17 §7): the type surface for gateway-managed
 * tunnels (frp/tailscale/zerotier — a FUTURE abstraction). `direct` (bind
 * 0.0.0.0) and `ssh` (the desktop's own ssh-provider) are NOT channels and
 * never enter ChannelKind. MVP ships NO provider: `channels[]` is always
 * empty, and liveness is never derived from persistence (S9).
 */

export type ChannelKind = 'frp' | 'tailscale' | 'zerotier' | (string & {})
export type ChannelHealth = 'unknown' | 'starting' | 'ready' | 'reconnecting' | 'failed'

export interface ChannelInstance {
  /** Channel instance id ('frp-<id>' / 'tailscale-<id>' / …), never 'direct'. */
  id: string
  label: string
  kind: ChannelKind
  /** Channel-private config (frp server/ports, tailscale hostname, …). */
  config: Record<string, string>
}

export interface ChannelProvider {
  readonly kind: ChannelKind
  start(instance: ChannelInstance): Promise<void>
  stop(instance: ChannelInstance): Promise<void>
  resolveEndpoint(instance: ChannelInstance): { baseUrl: string; headers?: Record<string, string> } | null
  probe(instance: ChannelInstance): Promise<boolean>
}

export interface ChannelListEntry {
  instance: ChannelInstance
  health: ChannelHealth
  endpoint: string | null
}

export interface ChannelRegistry {
  register(provider: ChannelProvider): void
  start(instance: ChannelInstance): Promise<void>
  stop(instance: ChannelInstance): Promise<void>
  resolve(instance: ChannelInstance): { baseUrl: string; headers?: Record<string, string> } | null
  health(instanceId: string): ChannelHealth
  list(): ChannelListEntry[]
}

/**
 * MVP channel registry: accepts providers (so the surface is stable) but ships
 * no instances — every query returns the empty/unknown projection. Liveness
 * (S9) is only ever a live probe result, so the empty registry never reports
 * anything but 'unknown' for an id it does not hold.
 */
export function createChannelRegistry(): ChannelRegistry {
  const providers = new Map<string, ChannelProvider>()
  return {
    register(provider: ChannelProvider): void {
      providers.set(provider.kind, provider)
    },
    async start(): Promise<void> {
      // No instances in MVP — a no-op (idempotent by contract).
    },
    async stop(): Promise<void> {
      // No instances in MVP.
    },
    resolve(): { baseUrl: string; headers?: Record<string, string> } | null {
      return null
    },
    health(): ChannelHealth {
      return 'unknown'
    },
    list(): ChannelListEntry[] {
      return []
    },
  }
}
