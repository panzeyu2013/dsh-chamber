/**
 * The cordis loader `insert` row format — single source of truth for the
 * `- insert:` overlay entries (A2 cross-package protocol single-sourcing).
 *
 * The dsh app-boot `--patch` overlay and a bundle's cordis.patch.yml share
 * one format: a top-level YAML array of loader patch entries
 * (`- insert:\n    - id: <id>\n      name: '<pkg>'\n`, @deepseek-ai/
 * dsh-app-boot loadOverlayPatches). Two implementations previously re-derived
 * this shape and its parsing/conflict logic:
 *   - control-plane host-graph-seed.ts (renderPatchOverlay + profileLoaderRows
 *     family — the local `--patch` overlay seed);
 *   - desktop plugin-sync.ts (renderCordisInserts + cordisLoaderRows family —
 *     the remote cordis.patch.yml seed merge).
 * This module owns the shared primitives; the two consumers keep their own
 * message wording and fold semantics (computeCordisPatchUpdate's
 * deterministic rewrite / append / fail-loud) and only the render / parse /
 * conflict classification is centralized here.
 *
 * Invariants:
 * - renderCordisInserts output is the canonical wire bytes: `- insert:` then
 *   one `    - id: <id>\n      name: '<name>'\n` line per row — byte-identical
 *   across every consumer (the cross-package contract test pins it).
 * - renderCordisInserts is the single validation point for desired rows
 *   (syntax whitelist + unique ids/names); it THROWS on invalid input (both
 *   callers either pre-validate or let the throw surface as their fail-loud).
 * - parsing ignores YAML comments but never guesses: an unsupported shape is
 *   caught by the raw scalar counts and fails loud rather than being mistaken
 *   for an exact loader identity.
 * - `result.ok`-style strictness does not exist here: hasExactInsert /
 *   insertConflict classify only id/name identity facts; message wording is
 *   the callers' own.
 */

/** One loader insert row (`- insert:` → `- id` / `name`). */
export interface CordisInsert {
  id: string
  name: string
}

/** The id/name whitelists enforced by renderCordisInserts (chamber package
 *  rows: plain loader ids, `@dsh-chamber/...` package names). */
const INSERT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const INSERT_NAME_PATTERN = /^@dsh-chamber\/[a-zA-Z0-9._-]+$/

/**
 * Render the canonical loader overlay for the given rows: a top-level YAML
 * array of loader patch entries (`- insert:` + one row per entry), the exact
 * format the dsh CLI's `--patch <path>` overlay and a bundle's
 * cordis.patch.yml share (@deepseek-ai/dsh-app-boot loadOverlayPatches).
 *
 * Validation point for desired rows: at least one row, every id/name on the
 * whitelist, and no duplicate id or name — a duplicate would make the next
 * host boot reject the loader ids or double-mount a Remote. Throws on
 * invalid input (the callers' fail-loud surface).
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Count an exact loader scalar while ignoring YAML comments. Loader ids and
 * package names are global within the composed Cordis config, so an exact
 * scalar anywhere (block or flow style) counts toward the conflict decision.
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
 * Parse only direct sequence mappings under a block `insert:` key. This
 * deliberately ignores deeper config mappings, and a sibling beginning with
 * `- name:` ends the previous row just as `- id:` does. Inline flow rows are
 * supported only when they are direct elements of that insert array; any
 * target scalar in an unsupported YAML shape is caught by the raw counts and
 * fails loud rather than being mistaken for an exact loader identity.
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
  /** An exact row exists but id/name counts are off, or either scalar is
   *  duplicated (a same-id/different-name or same-name/different-id row, or a
   *  duplicated exact row) — appending would break the next host boot. */
  | 'duplicate-identity'
  /** The loader id is present but bound to a different package. */
  | 'id-bound'
  /** The package name is present but mounted under a different loader id. */
  | 'name-bound'

/**
 * Classify how an existing patch conflicts with one desired insert; null when
 * the insert can be folded in safely (exactly one exact row, or no trace of
 * either scalar). The classification is shared by host-graph-seed.ts
 * (missingHostPackageInserts — throws with its message wording) and
 * plugin-sync.ts (computeCordisPatchUpdate — returns its error wording);
 * only the fact is centralized here.
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
