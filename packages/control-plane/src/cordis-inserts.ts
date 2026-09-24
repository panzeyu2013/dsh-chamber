/**
 * The cordis loader patch-entry format — single source of truth for the overlay entries.
 *
 * The dsh app-boot `--patch` overlay and a bundle's cordis.patch.yml share one format:
 * a top-level YAML array of loader patch entries. Two shapes are rendered here:
 *   - the `insert` bundle, mounting new rows (renderCordisInserts);
 *   - the id-targeted non-insert row, configuring or disabling a row an earlier layer
 *     mounted (renderCordisDisablePatches / renderCordisOverlay).
 * Consumers: control-plane host-graph-seed.ts (local overlay) and desktop plugin-sync.ts
 * (remote cordis.patch.yml merge); only render/parse/conflict classification is centralized
 * here, message wording and fold semantics stay there.
 *
 * Invariants: renderCordisInserts output is the canonical wire bytes, byte-identical across
 * consumers (id-targeted shapes are ADDITIVE); it is the single validation point (syntax
 * whitelist + unique ids/names) and THROWS on invalid input. Parsing ignores YAML comments
 * but never guesses: an unsupported shape is caught by the raw scalar counts and fails loud,
 * and a non-insert row never contributes an insert identity.
 */

/** One loader insert row (`- insert:` → `- id` / `name`). */
export interface CordisInsert {
  id: string
  name: string
}

/** The id/name whitelists enforced by the renderers: plain loader ids, `@dsh-chamber/...`
 *  package names for inserts, and a scoped UPSTREAM package name for disable rows (which
 *  target a bundle-mounted row, never the chamber insert namespace). */
const INSERT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const INSERT_NAME_PATTERN = /^@dsh-chamber\/[a-zA-Z0-9._-]+$/
const DISABLE_NAME_PATTERN = /^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/

/**
 * Render the canonical loader overlay for the given rows: `- insert:` plus one row per
 * entry, the exact format the dsh CLI's `--patch` overlay and a bundle's cordis.patch.yml
 * share. Validation: at least one row, every id/name on the whitelist, no duplicate id or
 * name (a duplicate would make the next boot reject the ids or double-mount a Remote).
 * Throws on invalid input.
 */
export function renderCordisInserts(inserts: readonly CordisInsert[]): string {
  if (inserts.length === 0) throw new Error('cordis insert render: overlay requires at least one row')
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const entry of inserts) {
    if (!INSERT_ID_PATTERN.test(entry.id) || !INSERT_NAME_PATTERN.test(entry.name)) {
      throw new Error(`cordis insert render: invalid overlay row ${JSON.stringify(entry)}`)
    }
    if (ids.has(entry.id) || names.has(entry.name)) {
      throw new Error(`cordis insert render: duplicate overlay row ${JSON.stringify(entry)}`)
    }
    ids.add(entry.id)
    names.add(entry.name)
  }
  return `- insert:\n${inserts.map(entry => `    - id: ${entry.id}\n      name: '${entry.name}'\n`).join('')}`
}

/**
 * One id-targeted non-insert overlay row, rendered as `- id: … / name: … / disabled: true`.
 *
 * Frozen-pin semantics: the loader destructures {id, insert, name, ...overrides}, looks the
 * entry up by id, warns and skips when `name` differs from the mounted row's package, and
 * copies every override — so an unmatched or name-mismatched row is a per-entry WARNING,
 * never a boot failure. `disabled` makes the loader refuse to init the row, so the target
 * package is never imported.
 */
export interface CordisDisablePatch {
  /** The loader entry id of the row to disable. */
  readonly id: string
  /** Exact package-name guard. Required even though the loader makes it optional: a naked
   *  id-targeted disable could also hit a future unrelated row that inherited the id. */
  readonly name: string
}

/**
 * Render id-targeted disable rows: one top-level YAML mapping per patch. Validation: the
 * loader-id charset, a scoped upstream package name, and no duplicate target id. Duplicated
 * package names across different ids are legal patches and allowed.
 */
export function renderCordisDisablePatches(disables: readonly CordisDisablePatch[]): string {
  const ids = new Set<string>()
  for (const entry of disables) {
    if (!INSERT_ID_PATTERN.test(entry.id) || !DISABLE_NAME_PATTERN.test(entry.name)) {
      throw new Error(`cordis disable render: invalid overlay row ${JSON.stringify(entry)}`)
    }
    if (ids.has(entry.id)) {
      throw new Error(`cordis disable render: duplicate overlay row ${JSON.stringify(entry)}`)
    }
    ids.add(entry.id)
  }
  return disables.map(entry => `- id: ${entry.id}\n  name: '${entry.name}'\n  disabled: true\n`).join('')
}

/**
 * Render one complete overlay patch list from its live rows: the `insert` bundle first
 * (when any), then the id-targeted disable rows — the order the loader applies them in, so
 * a disable supersedes a row a bundle or user layer mounted before this overlay.
 *
 * Validation: at least one row overall, and no disable may target an id this same overlay
 * inserts. A disable-only overlay is legal (the local seed reuses a user-owned insert row
 * and still carries the disable).
 */
export function renderCordisOverlay(
  inserts: readonly CordisInsert[],
  disables: readonly CordisDisablePatch[] = [],
): string {
  if (inserts.length === 0 && disables.length === 0) {
    throw new Error('cordis overlay render: overlay requires at least one row')
  }
  const insertIds = new Set(inserts.map(entry => entry.id))
  for (const disable of disables) {
    if (insertIds.has(disable.id)) {
      throw new Error(`cordis overlay render: disable row ${JSON.stringify(disable)} targets a row this overlay inserts`)
    }
  }
  return (inserts.length > 0 ? renderCordisInserts(inserts) : '') + renderCordisDisablePatches(disables)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Count an exact loader scalar while ignoring YAML comments. Loader ids and package names
 * are global within the composed Cordis config, so an exact scalar anywhere counts toward
 * the conflict decision.
 */
export function fieldCount(existing: string, field: 'id' | 'name', value: string): number {
  const searchable = existing.split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .map(line => line.replace(/\s+#.*$/u, ''))
    .join('\n')
  const escaped = escapeRegExp(value)
  const trailing = field === 'id' ? '[a-zA-Z0-9_.-]' : '[a-zA-Z0-9_.@/-]'
  const pattern = new RegExp(`\\b${field}:\\s*(?:'${escaped}'|"${escaped}"|${escaped})(?!${trailing})`, 'gu')
  return searchable.match(pattern)?.length ?? 0
}

/** One parsed loader row: every direct id/name scalar under one insert row. */
export interface ParsedInsertRow {
  readonly ids: string[]
  readonly names: string[]
}

function yamlScalar(raw: string): string | undefined {
  const value = raw.trim().replace(/,$/u, '').trim()
  const single = value.match(/^'([^']*)'$/u)
  if (single !== null) return single[1]
  const double = value.match(/^"([^"\\]*)"$/u)
  if (double !== null) return double[1]
  return /^[a-zA-Z0-9_.@/-]+$/u.test(value) ? value : undefined
}

function addLoaderField(row: ParsedInsertRow, text: string): void {
  const field = text.trim().match(/^(id|name)\s*:\s*(.*?)\s*$/u)
  if (field === null) return
  const value = yamlScalar(field[2]!)
  if (value === undefined) return
  const values = field[1] === 'id' ? row.ids : row.names
  values.push(value)
}

/** Split a flat flow mapping without treating quoted/nested commas as fields. */
function splitFlowFields(content: string): string[] {
  const fields: string[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  let escaped = false
  let depth = 0
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false
      else if (quote === '"' && char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      fields.push(content.slice(start, index))
      start = index + 1
    }
  }
  fields.push(content.slice(start))
  return fields
}

function flowLoaderRow(mapping: string): ParsedInsertRow {
  const row: ParsedInsertRow = { ids: [], names: [] }
  const content = mapping.trim().replace(/^\{/u, '').replace(/\}$/u, '')
  for (const field of splitFlowFields(content)) addLoaderField(row, field)
  return row
}

/** Parse direct mapping elements of an inline `insert: [...]` array. */
function inlineInsertRows(text: string): ParsedInsertRow[] {
  const rows: ParsedInsertRow[] = []
  const open = text.indexOf('[')
  if (open < 0) return rows
  let quote: "'" | '"' | undefined
  let escaped = false
  let bracketDepth = 0
  let braceDepth = 0
  let mappingStart = -1
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false
      else if (quote === '"' && char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '[') bracketDepth += 1
    else if (char === ']') {
      bracketDepth -= 1
      if (bracketDepth === 0) break
    } else if (char === '{') {
      if (bracketDepth === 1 && braceDepth === 0) mappingStart = index
      braceDepth += 1
    } else if (char === '}') {
      braceDepth -= 1
      if (bracketDepth === 1 && braceDepth === 0 && mappingStart >= 0) {
        rows.push(flowLoaderRow(text.slice(mappingStart, index + 1)))
        mappingStart = -1
      }
    }
  }
  return rows
}

/**
 * Parse only direct sequence mappings under a block `insert:` key; deeper config mappings
 * are deliberately ignored, and a sibling beginning with `- name:` ends the previous row.
 * Inline flow rows are supported only as direct elements of that insert array; any target
 * scalar in an unsupported shape is caught by the raw counts and fails loud rather than
 * being mistaken for an exact loader identity.
 */
export function parseLoaderRows(existing: string): ParsedInsertRow[] {
  const text = existing.split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .map(line => line.replace(/\s+#.*$/u, ''))
    .join('\n')
  const lines = text.split('\n')
  const rows: ParsedInsertRow[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const insert = line.match(/^(\s*)-\s+insert\s*:\s*(.*)$/u)
    if (insert === null) continue
    const insertIndent = insert[1]!.length
    if (insert[2]!.trimStart().startsWith('[')) {
      rows.push(...inlineInsertRows(lines.slice(index).join('\n')))
      continue
    }
    if (insert[2]!.trimStart().startsWith('{')) {
      rows.push(flowLoaderRow(insert[2]!.trim()))
      continue
    }
    let rowIndent: number | undefined
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!
      if (candidate.trim() === '') continue
      const indent = candidate.match(/^\s*/u)![0].length
      if (indent <= insertIndent) break
      const sequence = candidate.match(/^(\s*)-\s+(.*)$/u)
      if (sequence === null) continue
      if (rowIndent === undefined) rowIndent = sequence[1]!.length
      if (sequence[1]!.length !== rowIndent) continue
      const row: ParsedInsertRow = { ids: [], names: [] }
      const first = sequence[2]!.trim()
      if (first.startsWith('{') && first.endsWith('}')) {
        rows.push(flowLoaderRow(first))
        continue
      }
      addLoaderField(row, first)
      for (let next = cursor + 1; next < lines.length; next += 1) {
        const continuation = lines[next]!
        if (continuation.trim() === '') continue
        const continuationIndent = continuation.match(/^\s*/u)![0].length
        if (continuationIndent <= rowIndent) break
        if (continuationIndent === rowIndent + 2) addLoaderField(row, continuation.trim())
      }
      rows.push(row)
    }
  }
  return rows
}

/** Match an id/name pair only when both fields belong to one loader row. */
export function hasExactInsert(existing: string, insert: CordisInsert): boolean {
  return parseLoaderRows(existing).some(row => row.ids.length === 1
    && row.names.length === 1
    && row.ids[0] === insert.id
    && row.names[0] === insert.name)
}

/** The conflict classes between an existing patch and one desired insert. */
export type InsertConflictKind =
  /** An exact row exists but id/name counts are off, or either scalar is duplicated — appending
   *  would break the next host boot. */
  | 'duplicate-identity'
  /** The loader id is present but bound to a different package. */
  | 'id-bound'
  /** The package name is present but mounted under a different loader id. */
  | 'name-bound'

/**
 * Classify how an existing patch conflicts with one desired insert; null when the insert can
 * be folded in safely (exactly one exact row, or no trace of either scalar). Only the fact is
 * centralized here; the two consumers keep their own message wording.
 */
export function insertConflict(existing: string, insert: CordisInsert): InsertConflictKind | null {
  const exact = hasExactInsert(existing, insert)
  const idCount = fieldCount(existing, 'id', insert.id)
  const nameCount = fieldCount(existing, 'name', insert.name)
  if (exact && idCount === 1 && nameCount === 1) return null
  if (exact || idCount > 1 || nameCount > 1) return 'duplicate-identity'
  if (idCount > 0) return 'id-bound'
  if (nameCount > 0) return 'name-bound'
  return null
}
