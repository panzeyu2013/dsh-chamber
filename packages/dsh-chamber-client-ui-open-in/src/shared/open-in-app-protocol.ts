/**
 * Local mirror of the official host open-in-app route contract
 * (`@deepseek-ai/dsh-host-open-in-app/shared`, dsh-v0.1.5-alpha.2 — 逐字一致，alpha.1→alpha.2 未动).
 *
 * The chamber open-in plugin cannot depend on the vendor host package (it is
 * a browser-side client plugin and the host half ships inside the instance),
 * so the three route paths and their payload shapes are mirrored here. They
 * are a contract-mirror: a fork/vendor upgrade that renames or reshapes a
 * route must update this file and the registry row in
 * `docs/checklists/upstream-touchpoints.md` §4 (verified by
 * `verify-upstream-touchpoints.mjs` C1-style byte comparison of the literals
 * below against the vendor `shared.ts`).
 */

/** GET route serving the probed application ids. */
export const OPEN_IN_APP_APPS_ROUTE = '/open-in-app/apps'

/** GET prefix serving one PNG bundle icon per application id. */
export const OPEN_IN_APP_ICON_PREFIX = '/open-in-app/icon'

/** POST route launching one application on one workspace directory. */
export const OPEN_IN_APP_OPEN_ROUTE = '/open-in-app/open'

/** Apps-route response: catalog ids probed as installed, in menu order. */
export interface OpenInAppAppsPayload {
  readonly apps: readonly string[]
}

/** Open-route request body. */
export interface OpenInAppOpenPayload {
  readonly app: string
  readonly path: string
}
