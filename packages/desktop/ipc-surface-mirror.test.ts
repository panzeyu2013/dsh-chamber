/**
 * IPC surface mirror lockstep tests (2026 audit L3): the bridge types are
 * hand-mirrored across packages/desktop/preload.cts (the surface contract),
 * packages/renderer/src/global.d.ts and the settings-connections plugin's
 * global.d.ts (interface merging requires identical shapes). A structural
 * comparison of METHOD sets AND FIELD sets turns a silent drift into a loud
 * test failure — the field check catches shape drift inside helper types
 * (e.g. a missing `chamber` / `gitWorktree` / `notifications` field).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/** The balanced-brace block of one interface/type declaration. For union
 *  aliases (`type X = | {…} | {…}`) the block spans ALL members: after a
 *  depth-0 closing brace, a `|` continuation keeps the scan going. */
function interfaceBlock(source: string, typeName: string): string {
  // Word-boundary anchored: `ChamberSettings` must not prefix-match
  // `ChamberSettingsStatus`.
  const start = source.search(new RegExp(`\\binterface ${typeName}\\b`))
  const startType = start === -1 ? source.search(new RegExp(`\\btype ${typeName}\\b`)) : start
  assert.notEqual(startType, -1, `${typeName} not found in the source`)
  const open = source.indexOf('{', startType)
  assert.notEqual(open, -1, `${typeName} has no opening brace`)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        // Union continuation: a `|` right after the brace means more members.
        let j = i + 1
        while (j < source.length && /\s/.test(source[j])) j += 1
        if (source[j] === '|') continue
        end = i
        break
      }
    }
  }
  assert.notEqual(end, -1, `${typeName} has no closing brace`)
  return source.slice(open + 1, end)
}

/** Strip block + line comments so comment prose cannot pollute the scans.
 *  Line comments are stripped only at line START (after optional indentation)
 *  — a `//` inside a string literal must survive (2026 review hardening). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
}

/** Extract the sorted method names of one interface block. */
function interfaceMethodNames(source: string, interfaceName: string): string[] {
  const names: string[] = []
  for (const line of stripComments(interfaceBlock(source, interfaceName)).split('\n')) {
    const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\(/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names.sort()
}

/** Extract the sorted field names of one interface/type block (covers union
 *  member shapes like `| { ok: true; packages: [...] }`). */
function interfaceFieldNames(source: string, typeName: string): string[] {
  const fields = new Set<string>()
  for (const line of stripComments(interfaceBlock(source, typeName)).split('\n')) {
    const global = /\b([a-zA-Z_][a-zA-Z0-9_]*)\??:/g
    let match: RegExpExecArray | null
    while ((match = global.exec(line)) !== null) fields.add(match[1])
  }
  return [...fields].sort()
}

/** Extract `name: type` signatures of one FLAT interface (one field per line).
 *  Type-sensitive (M2): a `version: string` → `string | null` drift fails.
 *  The OPTIONALITY marker is part of the compared signature (round-2 review
 *  A3): a required↔optional drift of e.g. `restartFailureText` between
 *  updater.ts and the renderer mirror must fail, so the pushed signature is
 *  `name?:type` for an optional field and `name:type` for a required one.
 *  Union-shaped types must use interfaceFieldNames (member shapes are
 *  single-line here, but the type text is not comparable across formats). */
function interfaceFieldSignatures(source: string, typeName: string): string[] {
  const signatures: string[] = []
  for (const raw of stripComments(interfaceBlock(source, typeName)).split('\n')) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(\??):\s*(.+)$/.exec(raw.trim())
    if (match === null) continue
    let type = match[3].replace(/[,;]\s*$/, '').replace(/\s+/g, ' ').trim()
    // preload names PluginApplyFailure inline; the client mirrors name it —
    // structurally equivalent, normalize for the text comparison.
    type = type.replace(/\bPluginApplyFailure\[\]/g, '{ spec: string; error: string }[]')
    signatures.push(`${match[1]}${match[2]}:${type}`)
  }
  return signatures.sort()
}

/** Extract normalized single-line METHOD signatures (`name(params): Return`)
 *  of an interface. Type-sensitive (L3): a return-type or parameter drift
 *  fails where method-NAME-only comparisons cannot see it. Multi-line method
 *  declarations would silently escape the scan, so any non-empty line that is
 *  not a single-line method is surfaced LOUDLY (interfaces in this codebase
 *  keep methods single-line by discipline). */
function interfaceMethodSignatures(source: string, typeName: string): string[] {
  const signatures: string[] = []
  for (const raw of stripComments(interfaceBlock(source, typeName)).split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)\s*:\s*(.+)$/.exec(trimmed)
    if (match === null) {
      throw new Error(
        `${typeName} has a non-single-line member the signature guard cannot see: "${trimmed}"`,
      )
    }
    const params = match[2].replace(/\s+/g, ' ').trim()
    const result = match[3].replace(/[,;]\s*$/, '').replace(/\s+/g, ' ').trim()
    signatures.push(`${match[1]}(${params}):${result}`)
  }
  return signatures.sort()
}

// ---------------------------------------------------------------------------
// 2026-12 review P2: the five surfaces that had NEITHER a golden nor a mirror
// comparison (systemResume / openIn / deepLink / notifications / badge) join
// the same golden + signature matrix as ssh/update/settings/runtime.
//
// These surfaces are the only ones whose mirrors name their inline payloads
// differently (preload declares `NotificationOpenRequest`, the renderer spells
// the same callback object out inline), so the shared helpers above cannot
// compare them: `interfaceMethodSignatures` is documented flat-single-line-only
// and would throw on the renderer's multi-line literal. The helpers below
// normalize away exactly that surface-syntax difference — and nothing else:
//   * a locally declared named type is expanded to its declaration, so a named
//     alias and its inline mirror compare equal;
//   * an inline `{…}` object literal's members are sorted, and its `;` and
//     newline separators are unified, so field ORDER is not part of the contract;
//   * PARAMETER NAMES are dropped (TypeScript's structural typing ignores them,
//     and the renderer deliberately names the notification click listener
//     `listener` where preload says `callback`); parameter TYPES stay ordered.
//  Every other difference — a method removed/renamed, a parameter type, a
//  return type, a field added/removed/retyped — still fails (see the
//  self-honesty test below).
// ---------------------------------------------------------------------------

/** Locally declared interfaces and type aliases of one source file, mapped to
 *  their inline text form (`{ member; member }` / union literal). */
function localTypeDeclarations(source: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const match of source.matchAll(/\binterface ([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    declarations.set(match[1], `{ ${splitMembers(stripComments(interfaceBlock(source, match[1]))).join('; ')} }`)
  }
  for (const match of source.matchAll(/\btype ([A-Za-z_][A-Za-z0-9_]*) =([^\n]*)/g)) {
    const body = match[2].trim()
    // An object-shaped alias opens a block on its own line — reuse the balanced
    // scan so nested members survive; every other alias is a single-line union.
    declarations.set(match[1], body === '' || body.startsWith('{')
      ? `{ ${splitMembers(stripComments(interfaceBlock(source, match[1]))).join('; ')} }`
      : body)
  }
  return declarations
}

/** Replace every locally declared type reference in `text` by its declaration
 *  (`NotificationKind` → `'complete' | …`), recursively, cycle-safe. */
function expandLocalTypes(text: string, declarations: Map<string, string>, seen: Set<string> = new Set()): string {
  let out = text
  for (const [name, body] of declarations) {
    if (seen.has(name) || !new RegExp(`\\b${name}\\b`).test(out)) continue
    const nested = new Set([...seen, name])
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), () => expandLocalTypes(body, declarations, nested))
  }
  return out
}

/** Canonical type text: inline object literals get sorted, `;`-unified members
 *  (innermost first, so nesting survives) and all whitespace collapses. */
function canonicalTypeText(text: string): string {
  let out = text
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/\{([^{}]*)\}/g, (_all, inner: string) => {
      const members = inner.split(/[;\n]/).map(member => member.replace(/\s+/g, ' ').trim()).filter(member => member !== '')
      return `{ ${members.sort().join('; ')} }`
    })
    if (next === out) break
    out = next
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Split on a separator that sits outside every bracket pair. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if ('{([<'.includes(char)) depth += 1
    else if ('})]>'.includes(char)) depth -= 1
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** Split an interface/type-literal block into member declarations. A boundary
 *  is a newline or `;` at bracket depth 0 — so a multi-line inline object
 *  literal stays part of its own member instead of being mis-read as two. */
function splitMembers(block: string): string[] {
  const members: string[] = []
  let depth = 0
  let current = ''
  for (const char of block) {
    if ('{([<'.includes(char)) depth += 1
    else if ('})]>'.includes(char)) depth -= 1
    if (depth <= 0 && (char === '\n' || char === ';')) {
      if (current.trim() !== '') members.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') members.push(current.trim())
  return members
}

/** One normalized method declaration: parameter TYPES in order (names are not
 *  part of a structural contract) plus the return type. */
interface SurfaceMethodEntry {
  name: string
  parameters: string[]
  result: string
}

/** Normalized method declarations of one block: `;`/newline-separated members
 *  with named types expanded and inline literals canonicalized. A non-method
 *  member is surfaced LOUDLY (never skipped). */
function blockMethodEntries(source: string, block: string): SurfaceMethodEntry[] {
  const declarations = localTypeDeclarations(source)
  const entries: SurfaceMethodEntry[] = []
  for (const member of splitMembers(stripComments(block))) {
    const name = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(member)
    if (name === null) {
      throw new Error(`non-method member the surface signature guard cannot compare: "${member}"`)
    }
    const open = member.indexOf('(', name[1].length)
    let depth = 0
    let close = -1
    for (let i = open; i < member.length; i += 1) {
      if (member[i] === '(') depth += 1
      else if (member[i] === ')') {
        depth -= 1
        if (depth === 0) { close = i; break }
      }
    }
    const rest = close === -1 ? '' : member.slice(close + 1).trim()
    if (!rest.startsWith(':')) {
      throw new Error(`${name[1]} has no single-line parameter list / return type: "${member}"`)
    }
    entries.push({
      name: name[1],
      parameters: splitTopLevel(member.slice(open + 1, close), ',').map(parameter => {
        const named = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\??\s*:\s*([\s\S]+)$/.exec(parameter)
        return canonicalTypeText(expandLocalTypes(named === null ? parameter : named[2], declarations))
      }),
      result: canonicalTypeText(expandLocalTypes(rest.slice(1).trim(), declarations)),
    })
  }
  return entries
}

/** Normalized signatures of the methods declared in one block: `name(T1, T2): R`. */
function blockMethodSignatures(source: string, block: string): string[] {
  return blockMethodEntries(source, block)
    .map(entry => `${entry.name}(${entry.parameters.join(', ')}): ${entry.result}`)
    .sort()
}

/** Normalized method signatures of a named interface/type-literal declaration. */
function surfaceMethodSignatures(source: string, typeName: string): string[] {
  return blockMethodSignatures(source, interfaceBlock(source, typeName))
}

/** Normalized `name?: T` field signatures of one block (named types expanded,
 *  inline literals canonicalized — so `kind: NotificationKind` and the
 *  renderer's inline union compare equal). */
function blockFieldSignatures(source: string, block: string): string[] {
  const declarations = localTypeDeclarations(source)
  const signatures: string[] = []
  for (const member of splitMembers(stripComments(block))) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(\??)\s*:\s*([\s\S]+)$/.exec(member)
    if (match === null) throw new Error(`non-field member the payload guard cannot compare: "${member}"`)
    signatures.push(`${match[1]}${match[2]}: ${canonicalTypeText(expandLocalTypes(match[3], declarations))}`)
  }
  return signatures.sort()
}

/** Normalized field signatures of a named interface/type-literal declaration. */
function typeFieldSignatures(source: string, typeName: string): string[] {
  return blockFieldSignatures(source, interfaceBlock(source, typeName))
}

/** The balanced `{…}` block following the first occurrence of `marker`. */
function blockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `marker not found in the source: ${marker}`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced block after marker: ${marker}`)
}

/** Normalized body text of a single-line `type X = …` alias (union literals
 *  such as UpdatePhase), for exact cross-file comparisons. */
function typeAliasBody(source: string, typeName: string): string {
  const start = source.search(new RegExp(`\\btype ${typeName}\\b`))
  assert.notEqual(start, -1, `type ${typeName} not found`)
  const lineEnd = source.indexOf('\n', start)
  const line = source.slice(start, lineEnd === -1 ? source.length : lineEnd)
  const eq = line.indexOf('=')
  assert.notEqual(eq, -1, `type ${typeName} has no '=' on its line`)
  return line.slice(eq + 1).replace(/\s+/g, ' ').trim()
}

const preload = readFileSync(join(ROOT, 'packages/desktop/preload.cts'), 'utf8')
const renderer = readFileSync(join(ROOT, 'packages/renderer/src/global.d.ts'), 'utf8')
const settings = readFileSync(join(ROOT, 'packages/dsh-chamber-client-ui-settings-connections/src/global.d.ts'), 'utf8')
const rendererApp = readFileSync(join(ROOT, 'packages/renderer/src/App.tsx'), 'utf8')

test('system-resume channel name stays in lockstep across all three sites (H2)', async () => {
  // The desktop side is single-sourced in ipc-events.ts (main.ts imports it);
  // preload.cts is a self-contained single-file build (build-preload.mjs) and
  // cannot import the shared constant — the literal is duplicated on purpose.
  // The renderer App layer re-dispatches the same IPC push as a window event.
  // Pin all three sites to the same string so a rename can never drift
  // silently. The preload assertion is anchored on the ACTUAL subscription
  // call (not a bare includes) so the literal cannot hide in a comment.
  const { SYSTEM_RESUME_EVENT } = await import('./ipc-events.ts')
  assert.ok(
    preload.includes(`ipcRenderer.on('${SYSTEM_RESUME_EVENT}'`),
    'preload.cts no longer subscribes with the same system-resume channel literal as ipc-events.ts',
  )
  assert.ok(
    rendererApp.includes(`new Event('${SYSTEM_RESUME_EVENT}')`),
    'App.tsx no longer re-dispatches the same system-resume window event as ipc-events.ts',
  )
})

const transportProvider = readFileSync(join(ROOT, 'packages/desktop/transport-provider.ts'), 'utf8')
const connectionSave = readFileSync(join(ROOT, 'packages/desktop/connection-save.ts'), 'utf8')
const desktopMain = readFileSync(join(ROOT, 'packages/desktop/main.ts'), 'utf8')

test('renderer connection target/input/spec mirrors desktop v2 fields including S23', () => {
  assert.match(renderer, /export type TransportKind = 'dsh' \| 'gateway'/, 'renderer target kind must be the normalized v2 union')
  assert.deepEqual(
    interfaceFieldNames(renderer, 'SshInstanceInput'),
    interfaceFieldNames(transportProvider, 'TransportInstanceInput'),
    'renderer input mirror drifted from desktop transport input',
  )
  const projectionFields = new Set(['sshPasswordSet', 'tokenSet', 'passwordSet', 'secretStorage', 'sourceFingerprint'])
  assert.deepEqual(
    interfaceFieldNames(renderer, 'SshInstanceSpec').filter(field => !projectionFields.has(field)),
    interfaceFieldNames(transportProvider, 'TransportInstanceSpec'),
    'renderer normalized spec mirror drifted from desktop transport spec',
  )
  for (const field of projectionFields) {
    assert.ok(interfaceFieldNames(renderer, 'SshInstanceSpec').includes(field), `renderer spec missing ${field}`)
  }
  assert.deepEqual(
    interfaceFieldNames(preload, 'SshInstanceSpec'),
    [...projectionFields].sort(),
    'preload connection projection markers drifted from the renderer contract',
  )
  assert.match(desktopMain, /sshPasswordSet:\s*instance\.transport === 'ssh'\s*&&\s*getSshPassword\(instance\.id\) !== null/,
    'main must project SSH password existence without its value')
})

test('DesktopSshSurface stays in lockstep across preload / renderer mirrors (L3)', () => {
  const authoritative = interfaceMethodNames(preload, 'DesktopSshSurface')
  assert.deepEqual(interfaceMethodNames(renderer, 'DesktopSshSurface'), authoritative, 'renderer global.d.ts mirror drifted')
})

test('UpdateSurface and SettingsSurface match their GOLDEN baselines (L3 golden guard)', () => {
  assert.deepEqual(interfaceMethodNames(preload, 'UpdateSurface'),
    ['check', 'download', 'onChanged', 'openReleasePage', 'restartAndInstall', 'state'].sort())
  assert.deepEqual(interfaceMethodNames(preload, 'SettingsSurface'), ['get', 'onChanged', 'set'].sort())
})

test('DesktopSshSurface matches the GOLDEN baseline — a method deleted from ALL mirrors still fails (L3 golden guard)', () => {
  // Snapshot of the authoritative surface (regenerate deliberately when a
  // method is genuinely removed; a synchronized three-way deletion otherwise
  // stays green in the pairwise comparison above).
  const golden = [
    'config_list', 'connect', 'delete_connection', 'disconnect', 'gateway_plugin_apply', 'gateway_plugin_materialize', 'gateway_plugin_sync', 'instances_get', 'instances_set',
    'is_active', 'local_plugin_add', 'local_plugin_add_file', 'local_plugin_list',
    'local_plugin_remove', 'logs', 'logs_clear', 'npm_search', 'onInstancesChanged',
    'onStatusChanged', 'plugin_apply', 'plugin_list', 'plugin_materialize_add',
    'plugin_materialize_add_pick', 'restart_service', 'reverify', 'seed_host_graph',
    'save_connection', 'set_gateway_password', 'set_gateway_token', 'set_password', 'start_service',
    'status', 'stop_service', 'ssh_plugin_undo',
  ].sort()
  assert.deepEqual(interfaceMethodNames(preload, 'DesktopSshSurface'), golden, 'DesktopSshSurface drifted from the golden baseline')
})

test('RuntimeSurface matches the GOLDEN baseline across preload and renderer mirrors (L3 golden guard)', () => {
  // The renderer's runtime-management.ts is the authoritative contract; the
  // preload duplicates the interface (single-file build) and the renderer
  // global.d.ts re-exports it. A method removed from ALL mirrors still fails
  // against this golden.
  const runtimeManagement = readFileSync(join(ROOT, 'packages/renderer/src/runtime-management.ts'), 'utf8')
  const golden = [
    'applyNow', 'check', 'cleanupVersion', 'clearFailure', 'install', 'onChanged',
    'recoverMetadata', 'resetBuiltin', 'restart', 'restorePreRollback', 'retryApply',
    'retryRestore', 'state',
  ].sort()
  assert.deepEqual(interfaceMethodNames(preload, 'RuntimeSurface'), golden, 'preload RuntimeSurface drifted from the golden baseline')
  assert.deepEqual(interfaceMethodNames(runtimeManagement, 'RuntimeSurface'), golden, 'renderer runtime-management RuntimeSurface drifted from the golden baseline')
  assert.match(renderer, /RuntimeSurface[\s\S]*?}\s*from '\.\/runtime-management\.ts'/, 'renderer global.d.ts must re-export the runtime surface')
})

test('main-owned connection transaction is wired through the preload without returning credentials', () => {
  const credentialFields = interfaceFieldSignatures(connectionSave, 'ConnectionCredentialMutations')
  assert.deepEqual(interfaceFieldSignatures(preload, 'ConnectionCredentialMutations'), credentialFields,
    'preload credential mutations drifted from the main transaction')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'ConnectionCredentialMutations'), credentialFields,
    'renderer credential mutations drifted from the main transaction')
  assert.deepEqual(interfaceFieldNames(renderer, 'SaveConnectionResult'), interfaceFieldNames(preload, 'SaveConnectionResult'),
    'save_connection result drifted across preload/renderer')
  assert.match(preload, /save_connection:\s*\(previousId, input, credentials\)\s*=>\s*ipcRenderer\.invoke\('desktop_ssh_save_connection',\s*\{ previousId, input, credentials \}\)/)
  assert.match(desktopMain, /ipcMain\.handle\(IPC_CHANNELS\.SSH_SAVE_CONNECTION/)
  assert.match(desktopMain, /canonicalizeTransportInstanceInput\(candidate\)/,
    'the save IPC must honor the typed optional transport through canonical v1/v2 normalization')
  assert.match(
    desktopMain,
    /gatewaySessionOriginForUrl\(\s*readyUrl,\s*spec\.spkiPin \?\? undefined,\s*spec\.transport === 'ssh' \? gatewayTunnelAuthority\(spec\.remotePort\) : undefined,\s*gatewaySessionScopeForConnection\(spec\),\s*\)/,
    'save_connection session invalidation must key SSH gateway sessions by the tunneled destination authority, never an SSH alias',
  )
  assert.doesNotMatch(interfaceBlock(renderer, 'SaveConnectionResult'), /sshPassword|gatewayToken|gatewayPassword/,
    'save result must never return credential values')
})

test('legacy credential setters are clear-only, deletion is exact-id, and instances_set is no-op-only in main', () => {
  for (const signature of [
    'set_password(id: string, password: null)',
    'set_gateway_token(id: string, token: null)',
    'set_gateway_password(id: string, password: null)',
  ]) {
    assert.match(preload, new RegExp(signature.replace(/[()]/g, '\\$&')))
    assert.match(renderer, new RegExp(signature.replace(/[()]/g, '\\$&')))
  }
  assert.match(desktopMain, /desktop_ssh_set_password is clear-only/)
  assert.match(desktopMain, /desktop_gateway_set_token is clear-only/)
  assert.match(desktopMain, /desktop_gateway_set_password is clear-only/)
  assert.match(preload, /delete_connection:\s*id\s*=>\s*ipcRenderer\.invoke\('desktop_ssh_delete_connection',\s*\{ id \}\)/)
  assert.match(desktopMain, /ipcMain\.handle\(IPC_CHANNELS\.SSH_DELETE_CONNECTION/)
  assert.match(desktopMain, /deleteConnectionTransaction\(/)
  assert.match(desktopMain, /desktop_ssh_instances_set: only an exact unchanged no-op roster is allowed/)
})

test('gateway ready registration and session invalidation use exact connection scope and fail-closed auth decisions', () => {
  assert.match(desktopMain, /gatewaySessionScopeForConnection\(registered\)/)
  assert.match(desktopMain, /gatewayRegistrationAuthHeaders\(token, password !== null, cookie, authProof\)/)
  assert.match(desktopMain, /if \(!auth\.ok\)[\s\S]*gateway session changed before proxy registration; re-authenticating/)
  assert.match(desktopMain, /invalidateScope\(gatewaySessionScopeForConnection\(spec\)\)/)
  assert.doesNotMatch(desktopMain, /invalidateAuthority\(/, 'remote Host authority is not a credential/session owner')
})

test('UpdateSurface and SettingsSurface stay in lockstep across preload and renderer mirrors (L3)', () => {
  for (const surface of ['UpdateSurface', 'SettingsSurface']) {
    assert.deepEqual(
      interfaceMethodNames(renderer, surface),
      interfaceMethodNames(preload, surface),
      `${surface} renderer mirror drifted`,
    )
    // Method NAMES alone cannot see a return-type/parameter drift — compare
    // full normalized signatures too (2026-12 review L1). preload.cts is the
    // surface contract; renderer global.d.ts must mirror it byte-for-byte in
    // shape. Both are also checked against their golden baselines above.
    assert.deepEqual(
      interfaceMethodSignatures(renderer, surface),
      interfaceMethodSignatures(preload, surface),
      `${surface} renderer mirror method signatures drifted`,
    )
  }
})

// ---------------------------------------------------------------------------
// 2026-12 review P2: the five bridge surfaces that had NEITHER a golden NOR a
// mirror comparison. `preload.cts` ↔ `renderer/src/global.d.ts` is the same
// hand-mirrored contract as ssh/update/settings/runtime, but a drift here was
// invisible: a renamed `badge.set`, a dropped `deepLink.ack`, a retyped
// `openIn.open` argument or a widened notification payload all type-checked in
// both packages. They now pass through the full matrix — golden method sets for
// BOTH mirrors, normalized signature lockstep, and a payload golden that also
// catches a drift synchronized across both mirrors.
// ---------------------------------------------------------------------------

/** The five surfaces this section owns (the rest are covered above). */
const P2_SURFACES = ['SystemResumeSurface', 'OpenInSurface', 'DeepLinkSurface', 'NotificationSurface', 'BadgeSurface']

/** Payload declarations the five surfaces are built from. The preload side is
 *  authoritative and declares all four; the renderer spells the notification
 *  click payload (NotificationOpenRequest) inline inside `onOpen` — that leg is
 *  covered by the surface signature matrix below, and this golden covers the
 *  named leg plus every payload name the renderer does declare. */
const P2_PAYLOAD_GOLDEN: Record<string, string[]> = {
  OpenInAppInfo: ['available: boolean', 'displayKind: string', 'id: string', 'remoteCapable: boolean'],
  DeepLinkIntent: ['attempt: number', 'deliveryId: number', 'instanceId: string', 'path: string', 'sourceFingerprint: string'],
  NotificationRequest: [
    'body: string', "kind: 'complete' | 'ask' | 'request' | 'test'", 'requireHidden: boolean',
    'sessionId: string', 'sourceFingerprint: string', 'sourceId: string', 'title: string',
  ],
  NotificationOpenRequest: ['attempt: number', 'deliveryId: number', 'sessionId: string', 'sourceFingerprint: string', 'sourceId: string'],
}

test('the five remaining surfaces match their GOLDEN method baselines in BOTH mirrors (P2 golden guard)', () => {
  const golden: Record<string, string[]> = {
    SystemResumeSurface: ['onResume'],
    OpenInSurface: ['apps', 'open'],
    DeepLinkSurface: ['ack', 'onIntent', 'ready'],
    NotificationSurface: ['ack', 'notify', 'onOpen', 'ready'],
    BadgeSurface: ['set'],
  }
  for (const surface of P2_SURFACES) {
    const expected = [...golden[surface]].sort()
    assert.deepEqual(interfaceMethodNames(preload, surface), expected,
      `preload.cts ${surface} drifted from the golden baseline`)
    // The renderer leg is deliberately checked against the SAME golden: a
    // method deleted from both mirrors in one commit still fails here.
    assert.deepEqual(interfaceMethodNames(renderer, surface), expected,
      `renderer global.d.ts ${surface} drifted from the golden baseline`)
  }
})

test('the five remaining surfaces keep identical normalized signatures across preload and renderer (P2 — type-sensitive drift guard)', () => {
  for (const surface of P2_SURFACES) {
    const authoritative = surfaceMethodSignatures(preload, surface)
    assert.ok(authoritative.length > 0, `${surface} produced no comparable signature — the guard would pass vacuously`)
    assert.deepEqual(surfaceMethodSignatures(renderer, surface), authoritative,
      `${surface} renderer mirror drifted from the preload contract (parameter types / return type / inline payload shape)`)
  }
  // The bridge itself is part of the same contract: a surface exposed on one
  // side and forgotten on the other must fail loudly.
  const bridgeFields = interfaceFieldSignatures(preload, 'DshChamberBridge')
  assert.deepEqual(
    interfaceFieldSignatures(renderer, 'DshChamberBridge'),
    bridgeFields,
    'DshChamberBridge field set drifted across the preload/renderer mirrors',
  )
  for (const surface of P2_SURFACES) {
    assert.ok(bridgeFields.some(field => field.endsWith(`:${surface}`)),
      `DshChamberBridge must expose ${surface}`)
  }
})

test('the open-in / deep-link / notification payloads pin their exact field signatures (P2 — golden + mirror)', () => {
  const declaresNamedType = (source: string, name: string) =>
    new RegExp(`\\b(?:interface|type) ${name}\\b`).test(source)
  for (const [name, expected] of Object.entries(P2_PAYLOAD_GOLDEN)) {
    assert.deepEqual(typeFieldSignatures(preload, name), expected, `${name} drifted from the golden baseline`)
    if (declaresNamedType(renderer, name)) {
      assert.deepEqual(typeFieldSignatures(renderer, name), expected,
        `${name} renderer mirror drifted from the golden baseline`)
    }
  }
})

test('the surface signature helper itself detects drift and tolerates the mirror syntax differences (P2 self-honesty)', () => {
  // Before trusting the matrix above, pin what it can and cannot see: a
  // synchronized rewrite must never slip through the normalizations.
  const surface = (body: string) => `interface P { v: string }\ninterface S {\n${body}\n}`
  const baseline = surface([
    "  doThing(payload: P, mode: 'x' | 'y'): Promise<{ ok: true } | { ok: false; error: string }>",
    '  onEvent(callback: (p: P) => void): () => void',
  ].join('\n'))
  const signatures = (source: string) => surfaceMethodSignatures(source, 'S')
  assert.deepEqual(signatures(baseline), [
    "doThing({ v: string }, 'x' | 'y'): Promise<{ ok: true } | { error: string; ok: false }>",
    'onEvent((p: { v: string }) => void): () => void',
  ])
  // 1. A method removed, 2. renamed.
  const withoutOnEvent = surface("  doThing(payload: P, mode: 'x' | 'y'): Promise<{ ok: true } | { ok: false; error: string }>")
  assert.notDeepEqual(signatures(withoutOnEvent), signatures(baseline), 'a removed method must fail')
  assert.notDeepEqual(signatures(baseline.replace('onEvent', 'onEventX')), signatures(baseline), 'a renamed method must fail')
  // 3. Parameter type, 4. return type, 5. payload field type drift.
  const driftedParameter = surface([
    "  doThing(payload: P, mode: 'x' | 'z'): Promise<{ ok: true } | { ok: false; error: string }>",
    '  onEvent(callback: (p: P) => void): () => void',
  ].join('\n'))
  assert.notDeepEqual(signatures(driftedParameter), signatures(baseline), 'a parameter union drift must fail')
  assert.notDeepEqual(signatures(baseline.replace('Promise<{ ok: true } | { ok: false; error: string }>', 'Promise<boolean>')), signatures(baseline),
    'a return type drift must fail')
  assert.notDeepEqual(signatures(baseline.replace('interface P { v: string }', 'interface P { v: number }')), signatures(baseline),
    'a payload field type drift must fail')
  // 6. Field ORDER inside an inline literal is not part of the contract…
  const reordered = surface([
    "  doThing(payload: P, mode: 'x' | 'y'): Promise<{ ok: true } | { error: string; ok: false }>",
    '  onEvent(callback: (p: P) => void): () => void',
  ].join('\n'))
  assert.deepEqual(signatures(reordered), signatures(baseline), 'field order must not be part of the compared signature')
  // …nor is the parameter NAME (the renderer names the notification click
  // listener `listener` where preload says `callback`), nor is a named alias vs
  // the same shape spelled inline across lines (the actual renderer mirror).
  const renamedParam = baseline.replace('callback:', 'listener:')
  assert.deepEqual(signatures(renamedParam), signatures(baseline), 'parameter names are not part of a structural contract')
  const inlineMultiLine = surface([
    "  doThing(payload: P, mode: 'x' | 'y'): Promise<{ ok: true } | {",
    '    error: string',
    '    ok: false',
    '  }>',
    '  onEvent(listener: (p: {',
    '    v: string',
    '  }) => void): () => void',
  ].join('\n'))
  assert.deepEqual(signatures(inlineMultiLine), signatures(baseline),
    'a named alias and its inline multi-line mirror must compare equal')
  // 7. A non-method member is surfaced loudly instead of being skipped.
  assert.throws(() => signatures(surface('  v: string')), /non-method member/)
})

test("the open-in plugin's private bridge face stays a structural subset of the renderer OpenInSurface (P2)", () => {
  // packages/dsh-chamber-client-ui-open-in/src/shared/coordinator.ts declares
  // its own loose `window.dshChamber.openIn` face on purpose (the plugin stays
  // out of the renderer's global Window augmentation merge and re-validates the
  // IPC answer through parseOpenInApps). A local face is only safe while it
  // keeps tracking the public one: a preload change to OpenInSurface.open's
  // arity/types would silently pass the plugin's typecheck, because nothing
  // else in this repo relates the two declarations. Pin the relationship here
  // (a re-export from the renderer types was rejected: it would pull the whole
  // renderer global augmentation into the plugin's program, which is exactly
  // what the local face exists to avoid).
  const coordinator = readFileSync(
    join(ROOT, 'packages/dsh-chamber-client-ui-open-in/src/shared/coordinator.ts'),
    'utf8',
  )
  const privateEntries = blockMethodEntries(coordinator, blockAfter(coordinator, 'openIn?:'))
  const publicEntries = blockMethodEntries(renderer, interfaceBlock(renderer, 'OpenInSurface'))
  assert.deepEqual(
    privateEntries.map(entry => entry.name).sort(),
    publicEntries.map(entry => entry.name).sort(),
    'the plugin bridge face no longer mirrors the OpenInSurface method set',
  )
  for (const entry of privateEntries) {
    const publicEntry = publicEntries.find(candidate => candidate.name === entry.name)
    assert.deepEqual(entry.parameters, publicEntry?.parameters,
      `OpenInBridgeSurface.${entry.name} parameter types drifted from OpenInSurface.${entry.name}`)
    // Documented looseness, pinned so it stays DELIBERATE: the plugin never
    // trusts a typed IPC answer, it parses the unknown result itself.
    assert.equal(entry.result, 'Promise<unknown>',
      `OpenInBridgeSurface.${entry.name} must keep consuming the raw IPC answer (Promise<unknown>)`)
  }
})

test('UpdateState and UpdatePhase stay locked between updater.ts and the renderer mirror (L3)', () => {
  // preload.cts imports UpdateState/UpdatePhase from updater.ts (type-only,
  // erased at build), so the DESKTOP side cannot drift; the renderer
  // global.d.ts hand-mirrors them for the settings plugins and nothing used
  // to guard the pair (2026-12 review L2). Field signatures are type-
  // sensitive; the phase union is compared as normalized alias text.
  const updater = readFileSync(join(ROOT, 'packages/desktop/updater.ts'), 'utf8')
  assert.deepEqual(
    interfaceFieldSignatures(renderer, 'UpdateState'),
    interfaceFieldSignatures(updater, 'UpdateState'),
    'renderer UpdateState mirror drifted from updater.ts',
  )
  assert.equal(
    typeAliasBody(renderer, 'UpdatePhase'),
    typeAliasBody(updater, 'UpdatePhase'),
    'renderer UpdatePhase union drifted from updater.ts',
  )
})

test('interfaceFieldSignatures compares the OPTIONALITY marker — a required↔optional drift fails (A3)', () => {
  // The signature helper itself must be self-honest: before round-2 review A3
  // the `\??` was matched but DROPPED, so a `restartFailureText: string` vs
  // `restartFailureText?: string` drift between updater.ts and the renderer
  // mirror passed silently. Pin the property directly on the helper.
  const required = 'interface X {\n  restartFailureText: string\n}'
  const optional = 'interface X {\n  restartFailureText?: string\n}'
  assert.notDeepEqual(
    interfaceFieldSignatures(required, 'X'),
    interfaceFieldSignatures(optional, 'X'),
    'a required↔optional drift must fail the signature comparison',
  )
  assert.deepEqual(
    interfaceFieldSignatures(optional, 'X'),
    ['restartFailureText?:string'],
    'the optionality marker is part of the compared signature',
  )
  assert.deepEqual(
    interfaceFieldSignatures(required, 'X'),
    ['restartFailureText:string'],
    'a required field keeps the unmarked signature',
  )
})

test('the plugin-manifest projections carry identical FIELD SETS across all three mirrors (L3 — shape drift guard)', () => {
  // preload names them Ssh*; the client mirrors drop the prefix.
  const remotePairs: Array<[string, string, string]> = [
    ['SshRemotePluginManifest', 'RemotePluginManifest', 'RemotePluginManifest'],
    ['SshLocalPluginManifest', 'LocalPluginManifest', 'LocalPluginManifest'],
  ]
  for (const [preloadName, rendererName] of remotePairs) {
    const fields = interfaceFieldNames(preload, preloadName)
    assert.ok(fields.includes('chamber'), `${preloadName} must carry the chamber field`)
    assert.deepEqual(interfaceFieldNames(renderer, rendererName), fields, `${rendererName} mirror drifted`)
  }
})

test('the IPC result unions carry identical FIELD SETS across the mirrors that name them (L3 — union shape drift guard)', () => {
  // Named aliases exist on both sides: preload Ssh* vs client mirrors.
  const aliasPairs: Array<[string, string, string]> = [
    ['SshMaterializeResult', 'SshMaterializeResult', 'SshMaterializeResult'],
    // SshSeedHostGraphResult carries NO cancelled arm: the main-process seed
    // handler has no confirmation dialog or picker to dismiss (design 21 §7
    // open item) — included here so a cancelled widening drifts loudly.
    ['SshSeedHostGraphResult', 'SshSeedHostGraphResult', 'SshSeedHostGraphResult'],
    ['SshLocalPluginExecIpcResult', 'SshLocalPluginExecIpcResult', 'SshLocalPluginExecIpcResult'],
    ['GatewayPluginSyncIpcResult', 'GatewayPluginSyncIpcResult', 'GatewayPluginSyncIpcResult'],
    ['GatewayPluginApplyIpcResult', 'GatewayPluginApplyIpcResult', 'GatewayPluginApplyIpcResult'],
    ['GatewayPluginMaterializeIpcResult', 'GatewayPluginMaterializeIpcResult', 'GatewayPluginMaterializeIpcResult'],
    ['SshPluginUndoIpcResult', 'SshPluginUndoIpcResult', 'SshPluginUndoIpcResult'],
  ]
  for (const [preloadName, rendererName] of aliasPairs) {
    const fields = interfaceFieldNames(preload, preloadName)
    assert.deepEqual(interfaceFieldNames(renderer, rendererName), fields, `${rendererName} renderer mirror drifted`)
  }
  // GatewayPluginSyncIpcResult (design 21 §6.5; the IPC-side twin of
  // gateway-provider's same-named sync result, deliberately suffixed) is a
  // discriminated ok-union whose member set is exact by construction:
  // uploaded/skipped live ONLY on the ok:true arm, error ONLY on ok:false
  // (no cancelled/wider shapes).
  assert.deepEqual(
    interfaceFieldNames(preload, 'GatewayPluginSyncIpcResult'),
    ['error', 'ok', 'skipped', 'uploaded'],
    'gateway_plugin_sync result union must remain exact',
  )
  // GatewayPluginApplyIpcResult (design 21 §6.5, plan Phase 4.6): the
  // batch+cancelled union — cancelled ONLY on the ok:true cancelled member,
  // installed/removed/restarted/deferred ONLY on the completed member,
  // partial/error ONLY on the ok:false member. A producer/consumer contract
  // mistake (e.g. partial silently dropped, or cancelled widened into a
  // completion) must fail here.
  assert.deepEqual(
    interfaceFieldNames(preload, 'GatewayPluginApplyIpcResult'),
    ['cancelled', 'deferred', 'error', 'installed', 'ok', 'partial', 'removed', 'restarted'],
    'gateway_plugin_apply result union must remain exact',
  )
  assert.deepEqual(
    interfaceFieldNames(preload, 'GatewayPluginMaterializeIpcResult'),
    ['cancelled', 'deferred', 'error', 'ok', 'outcome'],
    'gateway_plugin_materialize result union must remain exact',
  )
  // The materialize executed-outcome shape is exact too: executed/restarted
  // only — the 202-settle parity fields the main handler projects.
  assert.deepEqual(
    interfaceFieldNames(preload, 'GatewayPluginMaterializeOutcome'),
    ['executed', 'restarted'],
    'gateway_plugin_materialize outcome must remain exact',
  )
  // The partial-outcome summary shape is itself exact: installed/removed
  // only, matching the main-handler projection.
  assert.deepEqual(
    interfaceFieldNames(preload, 'GatewayPluginApplyPartial'),
    ['installed', 'removed'],
    'gateway_plugin_apply partial summary must remain exact',
  )
  // The apply input shape is exact too (deferRestart optional; main
  // re-validates the boolean-ness).
  assert.deepEqual(
    interfaceFieldNames(preload, 'GatewayPluginApplyInput'),
    ['add', 'deferRestart', 'remove'],
    'gateway_plugin_apply input must remain exact',
  )
  // SshPluginApplyIpcResult is a NAMED alias in preload only; the client
  // mirrors inline it into the plugin_apply signature. plugin_apply has no
  // picker or other cancellation path; widening it with a cancelled member
  // would hide a producer/consumer contract mistake.
  const applyFields = interfaceFieldNames(preload, 'SshPluginApplyIpcResult')
  assert.deepEqual(applyFields, ['error', 'ok', 'result'], 'plugin_apply result union must remain exact')
  // SshPluginUndoIpcResult (design 21 §6.4 ssh undo journal IPC): exact
  // member shapes — cancelled only on its own ok:true member, undone
  // (kind/name + the optional restarted/ready/readyNote "not fully
  // effective" projection) only on the completed member, unavailable only
  // on the ok:false member. Widening any arm (e.g. dropping unavailable, or
  // adding a spec projection that would leak a remote file: path) must fail
  // here.
  assert.deepEqual(
    interfaceFieldNames(preload, 'SshPluginUndoIpcResult'),
    ['cancelled', 'error', 'kind', 'name', 'ok', 'ready', 'readyNote', 'restarted', 'unavailable', 'undone'],
    'ssh_plugin_undo result union must remain exact',
  )
})

test('the apply-result and notification/sessionTodo settings shapes are type-identical across mirrors (L3 — type-sensitive drift guard)', () => {
  // PluginApplyResult: preload names it SshPluginApplyResult; clients drop the prefix.
  const applyResult = interfaceFieldSignatures(preload, 'SshPluginApplyResult')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'PluginApplyResult'), applyResult, 'renderer PluginApplyResult drifted')
  // ChamberNotificationSettings (nested under ChamberSettings.notifications).
  const notificationSettings = interfaceFieldSignatures(preload, 'ChamberNotificationSettings')
  assert.deepEqual(
    interfaceFieldSignatures(renderer, 'ChamberNotificationSettings'),
    notificationSettings,
    'ChamberNotificationSettings preload/renderer drifted',
  )
  // ChamberSessionTodoSettings (nested under ChamberSettings.sessionTodo).
  const sessionTodoSettings = interfaceFieldSignatures(preload, 'ChamberSessionTodoSettings')
  assert.deepEqual(
    interfaceFieldSignatures(renderer, 'ChamberSessionTodoSettings'),
    sessionTodoSettings,
    'ChamberSessionTodoSettings preload/renderer drifted',
  )
})

test('flat shared interfaces are TYPE-identical across preload and renderer (L3 — not just field names)', () => {
  for (const name of ['ChamberHostPackageState', 'ChamberSettings']) {
    const authoritative = interfaceFieldSignatures(preload, name)
    assert.deepEqual(interfaceFieldSignatures(renderer, name), authoritative, `${name} renderer type drift`)
  }
  const remoteManifest = interfaceFieldSignatures(preload, 'SshRemotePluginManifest')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'RemotePluginManifest'), remoteManifest, 'RemotePluginManifest renderer type drift')
  const localManifest = interfaceFieldSignatures(preload, 'SshLocalPluginManifest')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'LocalPluginManifest'), localManifest, 'LocalPluginManifest renderer type drift')
})

test('the desktop chamber-settings store mirrors preload\'s settings types (L3 — the manual-mirror leg)', () => {
  // preload ↔ renderer is guarded above; the desktop AUTHORITATIVE store
  // (chamber-settings.ts) is a documented MANUAL mirror of the same shapes
  // (the notifications discipline extended to sessionTodo/vscode keys) with
  // NO automated guard of its own — a field/type drift there would pass
  // silently until a settings round-trip breaks. Guard it with the same
  // type-sensitive signature comparison. ChamberSettingsStatus is excluded:
  // its `supported` member is a nested object literal (signature extraction
  // is flat-interface only) — its flat top-level field names are covered by
  // interfaceFieldNames below.
  const store = readFileSync(join(ROOT, 'packages/desktop/chamber-settings.ts'), 'utf8')
  for (const typeName of ['ChamberSettings', 'ChamberNotificationSettings', 'ChamberSessionTodoSettings']) {
    assert.deepEqual(
      interfaceFieldSignatures(store, typeName),
      interfaceFieldSignatures(preload, typeName),
      `chamber-settings.ts store drifted from preload: ${typeName}`,
    )
  }
  assert.deepEqual(
    interfaceFieldNames(store, 'ChamberSettingsStatus'),
    interfaceFieldNames(preload, 'ChamberSettingsStatus'),
    'chamber-settings.ts ChamberSettingsStatus top-level fields drifted from preload',
  )
})

test('settings-connections re-exports the whole IPC face from the renderer (single source of truth, L3)', () => {
  // T1 (2026 review): the settings plugin no longer structurally mirrors the
  // IPC types — it re-exports them from the renderer's authoritative
  // global.d.ts. Assert the re-export statement covers the critical names.
  const start = settings.indexOf('export type {')
  assert.ok(start !== -1, 'settings-connections must re-export the IPC face')
  const exportBlock = settings.slice(start, settings.indexOf("} from '../../renderer/src/global.d.ts'", start))
  for (const name of ['ConnectionCredentialMutations', 'DesktopSshSurface', 'SaveConnectionResult', 'SshInstanceSpec', 'SshStatusProjection', 'ChamberSettings', 'PluginApplyResult']) {
    assert.ok(exportBlock.includes(name), `settings-connections must re-export ${name}`)
  }
})

test('ChamberInjectionState / ChamberHostPackageState / ChamberSettings stay in lockstep (L3 — shape drift guard)', () => {
  // ChamberInjectionState union: ok/packages/error must match.
  assert.deepEqual(interfaceFieldNames(preload, 'ChamberInjectionState'), interfaceFieldNames(renderer, 'ChamberInjectionState'), 'ChamberInjectionState preload/renderer drifted')
  assert.deepEqual(interfaceFieldNames(preload, 'ChamberHostPackageState'), interfaceFieldNames(renderer, 'ChamberHostPackageState'), 'ChamberHostPackageState preload/renderer drifted')
  assert.deepEqual(interfaceFieldNames(renderer, 'ChamberSettings'), interfaceFieldNames(preload, 'ChamberSettings'), 'ChamberSettings preload/renderer drifted')
})

// ---------------------------------------------------------------------------
// B8: channel-name lockstep (string-level guard). The main side registers
// every channel through the IPC_CHANNELS constants in ipc-events.ts (single
// source of truth); the preload CANNOT import that module (build-preload.mjs
// self-contained single-file contract), so its literals are duplicated on
// purpose. These tests assert the two sides can never drift:
//   main-side  ipcMain.handle  set  ==  preload-side ipcRenderer.invoke set
//   main-side  webContents.send set ==  preload-side ipcRenderer.on    set
// and that every preload literal is a known IPC_CHANNELS value (so a rename
// in the constants fails loudly on the preload side too).
// ---------------------------------------------------------------------------

const { IPC_CHANNELS } = await import('./ipc-events.ts')

/** main.ts is the sole IPC registration owner. Keeping one executable owner
 * avoids a second, unimported handler implementation drifting beside it. */
const MAIN_SIDE_FILES = ['main.ts']

function mainSideSource(): string {
  return MAIN_SIDE_FILES
    .map(file => readFileSync(join(ROOT, 'packages/desktop', file), 'utf8'))
    .join('\n')
}

/** Collect the channel names of one main-side registration/send call: the
 *  argument is either an IPC_CHANNELS constant reference (resolved against
 *  the imported constants) or a raw quoted literal (a regression the guard
 *  must also surface — the constant set is the source of truth). */
function collectMainChannels(source: string, call: 'ipcMain.handle' | 'webContents.send'): string[] {
  const channels = new Set<string>()
  const pattern = new RegExp(`${call}\\(\\s*(?:IPC_CHANNELS\\.([A-Z][A-Z0-9_]*)|'([^']*)'|"([^"]*)")`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] !== undefined) {
      const key = match[1] as keyof typeof IPC_CHANNELS
      assert.ok(key in IPC_CHANNELS, `main-side code references an unknown IPC_CHANNELS member: ${match[1]}`)
      channels.add(IPC_CHANNELS[key])
    } else {
      // A raw literal on the main side: still pinned by the equality checks
      // below, but the constants are the source of truth — loud here too.
      channels.add(match[2] !== undefined ? match[2] : match[3])
    }
  }
  return [...channels].sort()
}

/** Collect the preload-side channel literals of one ipcRenderer call. */
function collectPreloadChannels(source: string, call: 'invoke' | 'on'): string[] {
  const channels = new Set<string>()
  const pattern = new RegExp(`ipcRenderer\\.${call}\\(\\s*'([^']*)'`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) channels.add(match[1])
  return [...channels].sort()
}

const mainHandleChannels = collectMainChannels(mainSideSource(), 'ipcMain.handle')
const mainSendChannels = collectMainChannels(mainSideSource(), 'webContents.send')
const preloadInvokeChannels = collectPreloadChannels(preload, 'invoke')
const preloadOnChannels = collectPreloadChannels(preload, 'on')

test('every ipcMain.handle channel is an IPC_CHANNELS constant (B8 — no raw main-side literals)', () => {
  const mainSource = mainSideSource()
  const rawLiteral = /ipcMain\.handle\(\s*'([^']*)'|ipcMain\.handle\(\s*"([^"]*)"/.exec(mainSource)
  assert.equal(rawLiteral, null, `main-side ipcMain.handle must use IPC_CHANNELS constants, found raw literal: ${rawLiteral?.[1] ?? rawLiteral?.[2]}`)
})

test('the main-side handle channel set EQUALS the preload invoke channel set (B8)', () => {
  assert.deepEqual(mainHandleChannels, preloadInvokeChannels, 'ipcMain.handle channels drifted from the preload invoke channels')
})

test('the main-side send channel set EQUALS the preload on channel set (B8 — pushes can never drift)', () => {
  assert.deepEqual(mainSendChannels, preloadOnChannels, 'webContents.send channels drifted from the preload on channels')
})

test('every preload channel literal is a known IPC_CHANNELS value (B8 — constants are the single source)', () => {
  const known = new Set<string>(Object.values(IPC_CHANNELS))
  for (const channel of [...preloadInvokeChannels, ...preloadOnChannels]) {
    assert.ok(known.has(channel), `preload references a channel that is not in IPC_CHANNELS: ${channel}`)
  }
})

// ---------------------------------------------------------------------------
// design 19 §3.7: badge wiring pin. The badge IPC handler has no direct unit
// seam (registration + toggle reconcile + quit clear live in main.ts glue),
// so the three load-bearing call shapes are pinned as source assertions — a
// rename, a dropped call, or an un-gated reconcile fails loudly here.
// ---------------------------------------------------------------------------

test('badge wiring is pinned: handler registration + toggle-gated reconcile + quit clear (design 19 §3.7)', () => {
  const mainSource = mainSideSource()
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.BADGE_COUNT, trustedIpc/, 'BADGE_COUNT handler must stay registered')
  // 设置切换收敛仅在实际携带 badgeEnabled 键时执行（无关设置变更不重发）。
  assert.match(mainSource, /validated\.patch\.notifications\?\.badgeEnabled !== undefined/, 'reconcile must stay gated on badgeEnabled flips only')
  assert.match(mainSource, /reconcileBadgeCount\(\)/, 'toggle reconcile call must stay wired')
  assert.match(mainSource, /if \(pendingBadgeCount !== null\)/, 'quit-time clear guard must stay')
  assert.match(mainSource, /app\.setBadgeCount\(0\)/, 'quit-time clear must stay a real native call')
})
