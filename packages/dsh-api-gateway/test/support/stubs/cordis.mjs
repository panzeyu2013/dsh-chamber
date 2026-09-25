/**
 * Minimal cordis surface for the client-invocation behaviour suite.
 *
 * `src/client/index.ts` imports `Service` at runtime and registers every service
 * through `ctx.reflect.provide(name, service)`; the lifecycle capabilities it
 * uses (`ctx.get`, `ctx.effect`, `ctx.plugin`, `ctx.reflect`) are supplied by
 * that suite's fake Context. The vendor checkout ships cordis source only (no
 * built `lib/`, which the package exports point at), and loading the whole
 * framework would pull further unbuilt vendor leaves, so this stub keeps exactly
 * the registration seam the fork depends on.
 */
export class Service {
  constructor(ctx, name) {
    this.ctx = ctx
    this.name = name
    ctx.reflect.provide(name, this)
  }
}
