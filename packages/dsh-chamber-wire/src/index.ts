/**
 * Neutral host↔client wire contracts for the chamber host domains: pure name/
 * method/argument tables shared by the in-host seed packages and the client
 * packages; one module per domain, and a new contract belongs HERE.
 */
export * from './archive-cleanup.ts'
// Page ↔ control-plane transport contract (design 26) — not a host domain, but the same
// rule applies: the frame shapes have exactly ONE definition and both sides import it.
export * from './page-channel.ts'
export * from './plugin-manifest.ts'
export * from './plugin-row.ts'
