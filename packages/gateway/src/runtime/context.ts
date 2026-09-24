/**
 * Shared runtime module context: the immutable construction facts every runtime
 * cluster reads (built once by the manager) plus the two live handles that cross
 * cluster boundaries: the resolution facts and the write fence. Each module's
 * deps extend this with its own inputs and compose as `{ ...runtimeContext,
 * ...moduleOwn }`; mutable projection facts stay manager-owned and hook-only.
 */
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import type { RuntimeWorkspaceFacts } from './workspace-facts.ts'
import type { RuntimeWriteFence } from './write-fence.ts'

export interface RuntimeModuleContext {
  plane: PlaneHandle
  platform: NodeJS.Platform
  baseDir: string
  envPath: string | null
  facts: RuntimeWorkspaceFacts
  writeFence: RuntimeWriteFence
}
