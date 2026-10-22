/**
 * Neutral host↔client wire contracts for the chamber host domains: pure name/
 * method/argument tables shared by the in-host seed packages and the client
 * packages; one module per domain, and a new contract belongs HERE.
 */
export * from './archive-cleanup.ts'
// Proxy ⇄ client network-budget contract (design 27): the ONE derivation of the
// upload/header/call budgets both the control-plane proxy and the page client
// import, so their ordering inequality cannot drift.
export * from './net-budget.ts'
// Page ↔ control-plane transport contract (design 26) — not a host domain, but the same
// rule applies: the frame shapes have exactly ONE definition and both sides import it.
export * from './page-channel.ts'
export * from './plugin-manifest.ts'
export * from './plugin-row.ts'
