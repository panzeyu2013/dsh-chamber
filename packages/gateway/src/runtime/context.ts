/**
 * Shared runtime module context: the immutable construction facts every runtime
 * cluster reads (exactly one copy — the manager builds this object once) plus
 * the two handles whose live state crosses cluster boundaries: the resolution
 * facts and the write fence.
 *
 * Each module's deps interface extends this with its OWN narrow inputs
 * (projection setters, action guards, the startup driver, its private
 * constants); the manager composes every module call as
 * `{ ...runtimeContext, ...moduleOwn }`, so the shared tuple is never
 * re-listed per module. Mutable projection facts stay manager-owned and reach
 * modules only through explicit getter/setter hooks.
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
