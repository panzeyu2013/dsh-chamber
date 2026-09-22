/**
 * Type face for the four chamber client-plugin entries the renderer boots
 * (sidebar, layout, git, open-in).
 *
 * Each real entry is typechecked by its own package program
 * (`typecheck:sidebar` / `:layout` / `:git` / `:open-in`), where its own
 * vendor ambient declarations are the only ones in the program. Pulling their
 * sources into the root program instead mixes four different loose vendor faces
 * for the same modules and breaks the program. The root tsconfig paths map the
 * `/client` specifiers here, so the renderer registers the plugins through this
 * narrow consumption face (the same loose `inject`/`apply` seam the ambient
 * block in `src/vendor-modules.d.ts` documents) and the package programs stay
 * authoritative for their internals.
 */
export declare const inject: string[]
export declare function apply(ctx: any): void
