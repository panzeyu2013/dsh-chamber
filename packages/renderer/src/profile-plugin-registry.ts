/**
 * Optional profile-plugin adapter registry (design 09 §4).
 *
 * DATA ONLY. This file is the single home for concrete third-party package identities
 * consumed by `profile-plugin-adapters.ts`; the framework module and its tests must not
 * name any real package or version (the class-level mechanism is what ships, the list is
 * configuration). Each entry is one third-party client plugin that predates the
 * `ctx.get('chamberBasePath')` contract and/or keeps mutable state in its factory scope:
 *
 *   {
 *     packageId: '<npm package id exactly as it appears in <id>/client.js>',
 *     metadata: { inject: [...], name: '...' },        // Cordis metadata to re-expose
 *     baseUri: { expectedCount: N },                    // exact BARE document.baseURI count INSIDE the factory body
 *     anchorRewrites: [{ anchor, replacement }],        // only when host routes are not baseURI-derived; the anchor must live inside the factory body and replacement may use __dshChamberBasePath
 *     factoryAnchors: { open, close, closeOccurrence },  // non-default factory formatting; minified served form uses open 'factory:require=>{' and closeOccurrence 'last' for repeated short tails
 *     witnesses: ['...', '...'],                        // each exactly once in the served artifact and untouched by the rewrites (a witness inside the factory body is fine as long as no anchorRewrite overlaps it and it contains no bare document.baseURI token)
 *     reason: 'why this adapter exists and when it can be deleted',
 *     evidence: { sha256: '<published client.js sha256>', artifact: '<how to obtain it>' },  // sha256 = release re-run pin; artifact = manual retrieval note
 *   }
 *
 * PRECONDITION: the plugin factory body must not contain page-level one-time side effects
 * (customElements.define / document/window listeners / intervals / MutationObserver): the
 * wrapper re-runs the factory body per mount. Move them into apply() before registering.
 * The wrapper re-exposes ONLY apply/inject/name; any other export (provide/Config/
 * reusable/intercept/plain members/default interop) is dropped, so such plugins must not
 * be registered. Explicit exports.<name> drift is an evidence problem; a direct
 * module.exports = {...} is a warning because it cannot be enumerated statically.
 *
 * Adding an entry requires the per-adapter artifact evidence:
 *   node packages/renderer/scripts/verify-profile-plugin-adapter.mjs --package <id> --artifact <tarball|lib/client.js>
 * The evidence output goes in the PR; a version or package id must never be baked into
 * the framework module, the unit suite, the design contract or the checklists.
 *
 * Deletion: remove an entry once the plugin reads `chamberBasePath` / moves its mutable
 * state into `apply(ctx)`, or once the upstream page-prefix seam lands (design 09 §4);
 * keep the framework while any adapter remains (the class of plugin keeps appearing).
 *
 * An EMPTY registry is the normal framework-only state: the mechanism, policy, tests and
 * evidence script ship independently of any concrete package.
 */

import type { ProfilePluginAdapter } from './profile-plugin-adapters.ts'

/** Registered optional profile adapters (empty = framework-only, no package adapted). */
export const PROFILE_PLUGIN_ADAPTERS: readonly ProfilePluginAdapter[] = Object.freeze([])
