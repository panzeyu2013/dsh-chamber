#!/usr/bin/env node
/**
 * verify-shim-payload-shape.mjs —— shim ↔ preload payload-shape lockstep (G22).
 *
 * The existing locks stop one level short of the wire contract:
 *   - bridge-shim-surface.test.ts locks method names, channel names and the
 *     top-level 4+9 surface;
 *   - ipc-surface-mirror.test.ts locks two specific payloads (save/delete).
 * A payload drift between preload.cts (Electron) and bridge-shim.poc.js (Swift)
 * is then invisible: the Swift side would send `{ id }` where main now expects
 * `{ previousId }` and both suites stay green.
 *
 * This gate parses every namespace member of both surfaces and compares, per
 * method, the invoke payload SHAPE as written at the call site — absent/null
 * (no payload), a direct expression, or an object literal's exact key set. Push
 * members are compared on their channel plus the presence of a subscriber
 * argument. The committed bridge-manifest.json is the channel authority: every
 * method channel must be in the manifest, and every manifest invoke channel
 * must be exposed by a method (except the internal hydration channel).
 *
 * It is static text parsing on purpose: no runtime dependency, no surface
 * execution, the same discipline as bridge-shim-surface.test.ts. Changing a
 * payload shape on one side without the other fails here, and the failure names
 * the method and both shapes.
 *
 * Usage:
 *   node scripts/gates/verify-shim-payload-shape.mjs
 */

import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The internal hydration channel: no namespace method exposes it. */
export const INTERNAL_INVOKE_CHANNELS = new Set(['dsh-chamber:info'])

/**
 * The frozen surface totals (G34). The per-member comparison only proves that
 * the members it FOUND agree; a silently removed member (an emptied namespace,
 * a dropped row in one block) shrank the corpus without failing anything. These
 * counts are the pin, so adding or removing a member is a deliberate two-file
 * edit (surface + this table) and the failure names the namespace that lost a
 * row. Counts are per `FACTORY_TO_NAMESPACE` namespace.
 */
export const EXPECTED_SURFACE = {
  namespaces: 9,
  members: 68,
  invoke: 60,
  push: 8,
  perNamespace: {
    badge: 1,
    deepLink: 3,
    desktopSsh: 34,
    notifications: 5,
    openIn: 2,
    runtime: 13,
    settings: 3,
    systemResume: 1,
    update: 6,
  },
}

/**
 * Assert observed surface totals against the pin. Pure and injectable so a
 * removed member can be simulated without editing the real sources.
 * @param {{ namespaces: number, members: number, invoke?: number, push?: number, perNamespace?: Record<string, number> }} observed - counts from one arm.
 * @param {typeof EXPECTED_SURFACE} [expected] - the pin.
 * @returns observed counts (for chaining).
 */
export function assertSurfaceCounts(observed, expected = EXPECTED_SURFACE) {
  const problems = []
  const report = (what, got, want) => problems.push(String(what) + ' ' + String(got) + ' != ' + String(want))
  if (observed.namespaces !== expected.namespaces) report('namespaces', observed.namespaces, expected.namespaces)
  if (observed.members !== expected.members) report('members', observed.members, expected.members)
  if (observed.invoke !== undefined && observed.invoke !== expected.invoke) report('invoke members', observed.invoke, expected.invoke)
  if (observed.push !== undefined && observed.push !== expected.push) report('push members', observed.push, expected.push)
  if (observed.perNamespace !== undefined) {
    for (const [namespace, count] of Object.entries(expected.perNamespace)) {
      if (observed.perNamespace[namespace] !== count) {
        report('namespace ' + namespace + ' members', observed.perNamespace[namespace] ?? 'missing', count)
      }
    }
    for (const namespace of Object.keys(observed.perNamespace)) {
      if (!Object.prototype.hasOwnProperty.call(expected.perNamespace, namespace)) {
        problems.push('unexpected namespace ' + namespace)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error('shim surface member totals drifted (G34): ' + problems.join('; '))
  }
  return observed
}

/** preload factory → exposed namespace name (the mapping that cannot be guessed
 *  from the surface type: NotificationSurface → notifications). */
export const FACTORY_TO_NAMESPACE = {
  desktopSshApi: 'desktopSsh',
  updateApi: 'update',
  settingsApi: 'settings',
  systemResumeApi: 'systemResume',
  openInApi: 'openIn',
  deepLinkApi: 'deepLink',
  runtimeApi: 'runtime',
  notificationsApi: 'notifications',
  badgeApi: 'badge',
}

/** preload factory declarations: `function <name>Api(): <Surface> {`. */
const PRELOAD_FACTORY = /function ([A-Za-z_$][A-Za-z0-9_$]*)\(\)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\{/gu

// ---------------------------------------------------------------------------
// Runtime arm (G22 residual): execute the injected shim in node:vm, drive every
// namespace member, and compare the emitted envelope payload key-by-key with
// the preload.cts call sites.
// ---------------------------------------------------------------------------

/** The placeholder the Swift injector must replace with the per-window token. */
export const NATIVE_TOKEN_PLACEHOLDER = '__DSH_CHAMBER_NATIVE_TOKEN__'

/** A fresh 32-hex (128-bit) native-channel token, matching BridgeShimInjector. */
export function makeNativeToken() {
  return randomBytes(16).toString('hex')
}

/**
 * Replace the token placeholder with a concrete token, mirroring
 * BridgeShimInjector.injectNativeToken: a source that still contains the
 * placeholder after replacement is a fail-closed injection bug.
 * @param {string} shimText - bridge-shim.poc.js source.
 * @param {string} token - 32-hex token.
 * @returns {string} injected source.
 */
export function injectShimToken(shimText, token) {
  const injected = String(shimText ?? '').split(NATIVE_TOKEN_PLACEHOLDER).join(token)
  if (injected.includes(NATIVE_TOKEN_PLACEHOLDER)) {
    throw new Error('shim source still contains the native token placeholder after injection')
  }
  if (!/^[0-9a-f]{32}$/.test(String(token ?? ''))) {
    throw new Error(`native channel token must be 32 lowercase hex, got ${JSON.stringify(token)}`)
  }
  return injected
}

/**
 * Execute the shim in an isolated node:vm context with a fake
 * `window.webkit.messageHandlers.dshChamber` bridge.
 *
 * The harness exposes the facts the runtime arm needs: every posted envelope,
 * the console sink, the public surface, and the token-guarded native reply/emit
 * entry points (`reply` / `emit` / `rehydrate` — exactly the globals Swift
 * evaluates).
 * @param {{ shimText: string, token?: string, onEnvelope?: (message: object, api: object) => void }} input - execution inputs.
 * @returns {{ envelopes: object[], warnings: string[], errors: string[], sandbox: object, surface: () => object | null, reply: Function, emit: Function, rehydrate: Function }} harness.
 */
export function createShimHarness({ shimText, token = makeNativeToken(), onEnvelope } = {}) {
  const envelopes = []
  const warnings = []
  const errors = []
  const sandbox = {
    window: null,
    console: {
      log: () => {},
      warn: (...args) => { warnings.push(args.map(String).join(' ')) },
      error: (...args) => { errors.push(args.map(String).join(' ')) },
    },
    setTimeout,
    clearTimeout,
  }
  sandbox.window = sandbox
  vm.createContext(sandbox, { name: 'bridge-shim' })
  const api = {
    envelopes,
    warnings,
    errors,
    sandbox,
    surface: () => (sandbox.dshChamber === undefined ? null : sandbox.dshChamber),
    reply(id, result, error) {
      sandbox.__dshChamberResolve(token, id, result === undefined ? null : result, error === undefined ? null : error)
    },
    emit(event, payload) {
      sandbox.__dshChamberEmit(token, event, payload === undefined ? null : payload)
    },
    rehydrate() {
      sandbox.__dshChamberRehydrateInfo(token)
    },
  }
  sandbox.webkit = {
    messageHandlers: {
      dshChamber: {
        postMessage(message) {
          envelopes.push(message)
          if (onEnvelope !== undefined) onEnvelope(message, api)
        },
      },
    },
  }
  vm.runInContext(injectShimToken(shimText, token), sandbox, { filename: 'bridge-shim.poc.js' })
  return api
}

/** The canned native reply for one channel (the runtime arm's default responder). */
export function defaultRuntimeReply(message, info = {}) {
  if (message.method === 'dsh-chamber:info') return { result: info }
  if (message.method === 'dsh-chamber:open-in-apps') return { result: { apps: [] } }
  return { result: {} }
}

/**
 * Run the shim and answer its info hydration synchronously so the public
 * surface is exposed, then return the harness (with `surface()` non-null).
 * @param {{ shimText: string, token?: string, info?: object, respond?: (message: object) => { result?: unknown, error?: string } }} input - inputs.
 * @returns {Promise<object>} harness.
 */
export async function runShimRuntime({ shimText, token = makeNativeToken(), info = {}, respond } = {}) {
  const harness = createShimHarness({
    shimText,
    token,
    onEnvelope: (message, api) => {
      const reply = respond === undefined ? defaultRuntimeReply(message, info) : respond(message)
      if (reply !== undefined) api.reply(message.id, reply.result, reply.error)
    },
  })
  const deadline = Date.now() + 2_000
  while (harness.surface() === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  if (harness.surface() === null) {
    throw new Error('shim never exposed its public surface after the info reply')
  }
  return harness
}

/**
 * List the factories the preload declares (used to fail closed when a new
 * namespace appears without a mapping entry).
 * @param {string} preloadText - preload.cts content.
 * @returns {string[]} factory names in source order.
 */
export function extractFactoryNames(preloadText) {
  return [...String(preloadText ?? '').matchAll(PRELOAD_FACTORY)].map(match => match[1])
}

/**
 * Slice the body of a preload factory: `function <name>() { ... }` up to the
 * first column-0 closing brace (same extraction as the surface test).
 * @param {string} preloadText - preload.cts content.
 * @param {string} factory - factory name.
 * @returns {string} block text.
 */
export function preloadApiBlock(preloadText, factory) {
  const match = String(preloadText ?? '').match(
    new RegExp('function ' + factory + '\\(\\)[^{]*\\{([\\s\\S]*?)\\n\\}', 'm'),
  )
  if (match === null) throw new Error('preload.cts has no function ' + factory + '() block')
  return match[1]
}

/**
 * Slice a shim namespace block: `  var <ns> = { ... }` up to the 2-space closer.
 * @param {string} shimText - bridge-shim.poc.js content.
 * @param {string} namespace - namespace name.
 * @returns {string} block text.
 */
export function shimNamespaceBlock(shimText, namespace) {
  const match = String(shimText ?? '').match(
    new RegExp('^  var ' + namespace + ' = \\{([\\s\\S]*?)\\n  \\}', 'm'),
  )
  if (match === null) throw new Error('bridge-shim.poc.js has no var ' + namespace + ' = { } block')
  return match[1]
}

/**
 * Split a namespace block into member spans keyed by member name: each span
 * starts at a 4-space-indented `name:` line and runs to the next one.
 * @param {string} blockText - namespace block body.
 * @returns {Map<string, string>} member name → span text.
 */
export function extractMemberSpans(blockText) {
  const spans = new Map()
  let current = null
  for (const line of String(blockText ?? '').split('\n')) {
    const match = line.match(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/)
    if (match !== null) {
      current = match[1]
      spans.set(current, [])
    }
    if (current !== null) spans.get(current).push(line)
  }
  const out = new Map()
  for (const [name, lines] of spans) out.set(name, lines.join('\n'))
  return out
}

/** shim PUSH_EVENTS table → { CONSTANT: channel }. */
export function shimPushEvents(shimText) {
  const match = String(shimText ?? '').match(/var PUSH_EVENTS = \{([\s\S]*?)\n  \}/)
  if (match === null) throw new Error('bridge-shim.poc.js has no PUSH_EVENTS table')
  const table = {}
  for (const line of match[1].split('\n')) {
    const row = line.match(/^ {4}([A-Za-z0-9_]+): '([^']+)',?$/)
    if (row !== null) table[row[1]] = row[2]
  }
  return table
}

/**
 * Find the member's wire call. preload uses `ipcRenderer.invoke|on('<ch>'...)`;
 * shim uses `invoke('<ch>'...)` or `subscribe(PUSH_EVENTS.KEY, handler)`.
 * @param {string} memberText - member span.
 * @param {string} side - 'preload' | 'shim'.
 * @param {Record<string, string>} [pushEvents] - shim PUSH_EVENTS table.
 * @returns {{ channel: string, after: string, kind: 'invoke' | 'push' } | null} call facts.
 */
export function parseMemberCall(memberText, side, pushEvents = {}) {
  const text = String(memberText ?? '')
  if (side === 'preload') {
    const match = text.match(/ipcRenderer\.(invoke|on)\('([^']+)'/)
    if (match === null) return null
    return {
      channel: match[2],
      after: text.slice((match.index ?? 0) + match[0].length),
      kind: match[1] === 'on' ? 'push' : 'invoke',
    }
  }
  const invoke = text.match(/\binvoke\('([^']+)'/)
  if (invoke !== null) {
    return {
      channel: invoke[1],
      after: text.slice((invoke.index ?? 0) + invoke[0].length),
      kind: 'invoke',
    }
  }
  const subscribe = text.match(/\bsubscribe\(PUSH_EVENTS\.([A-Za-z0-9_]+)/)
  if (subscribe === null) return null
  const channel = pushEvents[subscribe[1]]
  if (channel === undefined) return null
  return {
    channel,
    after: text.slice((subscribe.index ?? 0) + subscribe[0].length),
    kind: 'push',
  }
}

/** Matching close brace for an object literal starting at `text[0] === '{'`. */
function matchingBrace(text) {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The payload shape written after a channel literal.
 *   `)`                    → no payload (preload)
 *   `, null)`              → no payload (shim's explicit null)
 *   `, { a, b: b })`       → object with key set [a, b]
 *   `, instances)`         → direct expression 'instances'
 * @param {string} after - text right after the channel string literal.
 * @returns {{ kind: 'none' } | { kind: 'direct', expression: string } | { kind: 'keys', keys: string[] }} shape.
 */
export function parsePayloadShape(after) {
  const text = String(after ?? '').replace(/^\s*/u, '')
  if (!text.startsWith(',')) return { kind: 'none' }
  const expression = text.slice(1).replace(/^\s*/u, '')
  if (expression.startsWith('null')) return { kind: 'none' }
  if (!expression.startsWith('{')) {
    const token = expression.match(/^[^\s,)]+/u)
    return { kind: 'direct', expression: token === null ? '' : token[0] }
  }
  const end = matchingBrace(expression)
  if (end === -1) throw new Error('unbalanced object literal in payload: ' + expression.slice(0, 80))
  // Keep the closing brace: the last key's lookahead needs it (a single-key
  // object body with the brace sliced off has nothing to anchor against).
  const body = expression.slice(1, end + 1)
  const keys = []
  for (const match of body.matchAll(/(?:^|[,{])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[:,}])/gu)) {
    keys.push(match[1])
  }
  return { kind: 'keys', keys: keys.sort() }
}

/** Stable, comparison-visible rendering of one shape. */
export function describeShape(shape) {
  if (shape.kind === 'none') return 'no-payload'
  if (shape.kind === 'direct') return 'direct:' + shape.expression
  return 'keys:{' + shape.keys.join(', ') + '}'
}

/**
 * Compare every namespace member's payload shape across the two surfaces.
 * @param {{ preloadText: string, shimText: string, manifest: object }} input - surface sources + manifest.
 * @returns {{ checked: number, mismatches: string[], missingFromManifest: string[], unexposedManifestChannels: string[], namespaces: number, perNamespace: Record<string, number> }} verdict.
 */
export function comparePayloadShapes({ preloadText, shimText, manifest }) {
  const factories = extractFactoryNames(preloadText)
  const expectedFactories = Object.keys(FACTORY_TO_NAMESPACE).sort()
  if (JSON.stringify([...factories].sort()) !== JSON.stringify(expectedFactories)) {
    throw new Error(
      'preload API factories drifted from the namespace mapping: ' + factories.join(', '),
    )
  }
  const manifestInvoke = new Set((manifest.invoke ?? []).map(entry => entry.channel))
  const manifestPush = new Set((manifest.push ?? []).map(entry => entry.channel))
  const pushEvents = shimPushEvents(shimText)
  const mismatches = []
  const preloadInvokeChannels = new Set()
  const shimInvokeChannels = new Set()
  const perNamespace = {}
  let checked = 0
  let namespaces = 0

  for (const factory of factories) {
    const namespace = FACTORY_TO_NAMESPACE[factory]
    const preloadMembers = extractMemberSpans(preloadApiBlock(preloadText, factory))
    const shimMembers = extractMemberSpans(shimNamespaceBlock(shimText, namespace))
    const preloadNames = [...preloadMembers.keys()]
    const shimNames = [...shimMembers.keys()]
    // G34: counted from the PRELOAD block (the Electron surface authority);
    // a namespace whose block lost a row changes this count even when both
    // sides lost it together, which the per-member comparison cannot see.
    namespaces += 1
    perNamespace[namespace] = preloadMembers.size
    if (JSON.stringify([...shimNames].sort()) !== JSON.stringify([...preloadNames].sort())) {
      mismatches.push(namespace + ': method set differs (preload=[' + preloadNames.join(', ') + '] shim=[' + shimNames.join(', ') + '])')
      continue
    }
    for (const name of preloadNames) {
      const preloadCall = parseMemberCall(preloadMembers.get(name), 'preload')
      const shimCall = parseMemberCall(shimMembers.get(name), 'shim', pushEvents)
      if (preloadCall === null || shimCall === null) {
        mismatches.push(namespace + '.' + name + ': one side has no parseable channel call')
        continue
      }
      checked += 1
      if (preloadCall.channel !== shimCall.channel) {
        mismatches.push(namespace + '.' + name + ': channel ' + preloadCall.channel + ' != ' + shimCall.channel)
        continue
      }
      const isPush = name.startsWith('on')
      if (isPush) {
        if (preloadCall.kind !== 'push' || shimCall.kind !== 'push') {
          mismatches.push(namespace + '.' + name + ': push member must subscribe on both surfaces')
        } else if (!manifestPush.has(preloadCall.channel)) {
          mismatches.push(namespace + '.' + name + ': push channel ' + preloadCall.channel + ' is not in bridge-manifest.json')
        }
        continue
      }
      preloadInvokeChannels.add(preloadCall.channel)
      shimInvokeChannels.add(shimCall.channel)
      if (!manifestInvoke.has(preloadCall.channel)) {
        mismatches.push(namespace + '.' + name + ': invoke channel ' + preloadCall.channel + ' is not in bridge-manifest.json')
      }
      const preloadShape = parsePayloadShape(preloadCall.after)
      const shimShape = parsePayloadShape(shimCall.after)
      if (describeShape(preloadShape) !== describeShape(shimShape)) {
        mismatches.push(
          namespace + '.' + name + ' (' + preloadCall.channel + '): payload shape '
          + describeShape(preloadShape) + ' (preload) != ' + describeShape(shimShape) + ' (shim)',
        )
      }
    }
  }

  const methodInvokeChannels = new Set([...preloadInvokeChannels, ...shimInvokeChannels])
  const missingFromManifest = [...methodInvokeChannels].filter(channel => !manifestInvoke.has(channel))
  const unexposedManifestChannels = [...manifestInvoke].filter(
    channel => !methodInvokeChannels.has(channel) && !INTERNAL_INVOKE_CHANNELS.has(channel),
  )
  return { checked, mismatches, missingFromManifest, unexposedManifestChannels, namespaces, perNamespace }
}

/**
 * The preload call-site facts per namespace member, keyed `namespace.member`:
 * channel, invoke/push kind, and the payload shape as written after the channel.
 * @param {string} preloadText - preload.cts content.
 * @param {string} shimText - bridge-shim.poc.js content (PUSH_EVENTS table).
 * @returns {Map<string, { channel: string, kind: 'invoke' | 'push', shape: object }>} facts.
 */
export function preloadMemberCalls(preloadText, shimText) {
  const factories = extractFactoryNames(preloadText)
  const pushEvents = shimPushEvents(shimText)
  const calls = new Map()
  for (const factory of factories) {
    const namespace = FACTORY_TO_NAMESPACE[factory]
    if (namespace === undefined) continue
    const members = extractMemberSpans(preloadApiBlock(preloadText, factory))
    for (const [name, span] of members) {
      const call = parseMemberCall(span, 'preload')
      if (call === null) continue
      calls.set(namespace + '.' + name, {
        channel: call.channel,
        kind: name.startsWith('on') ? 'push' : 'invoke',
        shape: parsePayloadShape(call.after),
      })
    }
  }
  return calls
}

/**
 * Does a runtime payload value satisfy the key-by-key shape parsed from the
 * preload call site? `none` = null/undefined, `direct` = any non-object (or an
 * array) expression value, `keys` = a plain object with exactly those keys.
 * @param {{ kind: 'none' } | { kind: 'direct', expression: string } | { kind: 'keys', keys: string[] }} shape - expected shape.
 * @param {unknown} payload - value the shim posted.
 * @returns {boolean} verdict.
 */
export function payloadShapeMatches(shape, payload) {
  if (shape.kind === 'none') return payload === null || payload === undefined
  if (shape.kind === 'direct') {
    return payload !== null && payload !== undefined && (typeof payload !== 'object' || Array.isArray(payload))
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  return JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(shape.keys)
}

/** Stable rendering of a runtime payload value for failure messages. */
export function describeRuntimePayload(payload) {
  if (payload === null || payload === undefined) return 'no-payload'
  if (Array.isArray(payload)) return 'direct:array(' + payload.length + ')'
  if (typeof payload === 'object') return 'keys:{' + Object.keys(payload).sort().join(', ') + '}'
  return 'direct:' + typeof payload
}

/**
 * Valid push payloads per channel, so the runtime arm can prove a subscription
 * is really wired (the validating listeners drop malformed deliveries loudly on
 * purpose). Passthrough channels take any object.
 */
export const PUSH_PAYLOAD_FIXTURES = {
  'desktop_ssh_status_changed': { id: 'local', status: { status: 'ready' } },
  'desktop_ssh_instances_changed': { removedIds: [], retiredIds: [] },
  'dsh-chamber:settings-changed': { settings: {}, supported: {} },
  'dsh-chamber:notification-open': { sourceId: 'local', sourceFingerprint: 'local', sessionId: 'session', deliveryId: 1, attempt: 1 },
  'dsh-chamber:deep-link-intent': { instanceId: 'local', path: '/', sourceFingerprint: 'local', deliveryId: 1, attempt: 1 },
  'dsh-chamber:runtime-state-changed': { phase: 'idle' },
  'dsh-chamber:system-resume': { timestamp: 1 },
  'dsh-chamber:update-state-changed': { phase: 'idle' },
}

/** Arguments for one invoke member: enough for the shim's payload literals. */
function argsForMember(name, fn, shape) {
  if (shape.kind === 'direct') return [['gate-instance']]
  const arity = typeof fn.length === 'number' && fn.length > 0 ? fn.length : 1
  const args = Array.from({ length: arity }, (_value, index) => 'arg' + index)
  if (name === 'gateway_plugin_apply') return [args[0], { add: [], remove: [], deferRestart: true }]
  if (name === 'plugin_apply') return [args[0], { add: [], remove: [], restart: true }]
  return args
}

/**
 * Execute the injected shim, drive EVERY namespace member, and compare the
 * emitted postMessage envelopes key-by-key against the preload.cts call sites.
 * @param {{ preloadText: string, shimText: string, token?: string }} input - sources + optional token.
 * @returns {Promise<{ checked: number, invoked: number, subscribed: number, mismatches: string[], namespaces: number, perNamespace: Record<string, number> }>} verdict.
 */
export async function compareRuntimePayloads({ preloadText, shimText, token = makeNativeToken() } = {}) {
  const expected = preloadMemberCalls(preloadText, shimText)
  const harness = await runShimRuntime({ shimText, token })
  const surface = harness.surface()
  const mismatches = []
  const seen = new Set()
  const perNamespace = {}
  let invoked = 0
  let subscribed = 0
  let namespaces = 0
  for (const namespace of [...new Set(Object.values(FACTORY_TO_NAMESPACE))].sort()) {
    const members = surface[namespace]
    if (members === null || typeof members !== 'object') {
      mismatches.push(namespace + ': namespace missing from the runtime surface')
      continue
    }
    // G34: the runtime surface's own per-namespace row count, so a member the
    // shim stopped exposing cannot hide behind the per-member comparison.
    namespaces += 1
    perNamespace[namespace] = Object.keys(members).length
    for (const [name, member] of Object.entries(members)) {
      const key = namespace + '.' + name
      const call = expected.get(key)
      if (call === undefined) {
        mismatches.push(key + ': runtime member has no preload.cts call site')
        continue
      }
      seen.add(key)
      if (typeof member !== 'function') {
        mismatches.push(key + ': runtime member is not a function')
        continue
      }
      if (call.kind === 'push') {
        const received = []
        const unsubscribe = member((value) => { received.push(value) })
        if (typeof unsubscribe !== 'function') {
          mismatches.push(key + ': subscribe did not return an unsubscribe function')
          continue
        }
        const fixture = PUSH_PAYLOAD_FIXTURES[call.channel]
        harness.emit(call.channel, fixture === undefined ? {} : fixture)
        if (received.length !== 1) {
          mismatches.push(key + ' (' + call.channel + '): emitted push did not reach the subscriber')
        }
        unsubscribe()
        subscribed += 1
        continue
      }
      const before = harness.envelopes.length
      let pending
      try {
        pending = member(...argsForMember(name, member, call.shape))
      } catch (error) {
        mismatches.push(key + ': threw before posting — ' + String(error instanceof Error ? error.message : error))
        continue
      }
      if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') pending.catch(() => {})
      const envelope = harness.envelopes[before]
      if (envelope === undefined) {
        mismatches.push(key + ': invoke posted no envelope')
        continue
      }
      invoked += 1
      if (envelope.method !== call.channel) {
        mismatches.push(key + ': runtime channel ' + String(envelope.method) + ' != preload ' + call.channel)
        continue
      }
      if (!payloadShapeMatches(call.shape, envelope.payload)) {
        mismatches.push(
          key + ' (' + call.channel + '): runtime payload ' + describeRuntimePayload(envelope.payload)
          + ' != preload ' + describeShape(call.shape),
        )
      }
    }
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) mismatches.push(key + ': preload call site never driven on the runtime surface')
  }
  return { checked: seen.size, invoked, subscribed, mismatches, namespaces, perNamespace }
}

/**
 * Drive the shim's TOTAL-FAILURE branch: reject all 1 + INFO_MAX_ATTEMPTS info
 * invokes and require the public surface to still appear with the four scalars
 * null (T-12 parity with preload.cts's failure branch).
 * @param {{ shimText: string, token?: string, attempts?: number, retryMs?: number }} input - inputs.
 * @returns {Promise<{ attempts: number, scalars: Record<string, null>, namespaces: string[], warnings: string[] }>} observed facts.
 */
export async function runShimFailureBranch({ shimText, token = makeNativeToken(), attempts = 11, retryMs = 50 } = {}) {
  const harness = createShimHarness({ shimText, token })
  const answered = new Set()
  const deadline = Date.now() + attempts * retryMs + 3_000
  while (harness.surface() === null && Date.now() < deadline) {
    for (const envelope of harness.envelopes) {
      if (envelope.method === 'dsh-chamber:info' && !answered.has(envelope.id)) {
        answered.add(envelope.id)
        harness.reply(envelope.id, null, 'ipc_not_ready')
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  const surface = harness.surface()
  if (surface === null) {
    throw new Error('shim failure branch never exposed the public surface after ' + answered.size + ' rejected info attempt(s)')
  }
  const scalars = {}
  for (const key of ['controlPlaneUrl', 'dshVersion', 'version', 'platform']) {
    if (surface[key] !== null) {
      throw new Error('failure branch exposed scalar ' + key + ' = ' + JSON.stringify(surface[key]) + ', expected null (T-12)')
    }
    scalars[key] = null
  }
  const namespaces = [...new Set(Object.values(FACTORY_TO_NAMESPACE))].sort().filter((namespace) => {
    return surface[namespace] !== null && typeof surface[namespace] === 'object'
  })
  if (namespaces.length !== EXPECTED_SURFACE.namespaces) {
    throw new Error('failure branch exposed ' + namespaces.length + ' namespace(s), expected ' + EXPECTED_SURFACE.namespaces)
  }
  if (harness.warnings.length === 0) {
    throw new Error('failure branch did not warn (a silent null surface is not the preload degradation contract)')
  }
  return { attempts: answered.size, scalars, namespaces, warnings: harness.warnings }
}

/**
 * Run the shim, then inject the SAME source a second time in the same context:
 * the installed marker (P-19) must make the second copy a no-op — no extra
 * envelope, the same internal entry points, the same public surface.
 * @param {{ shimText: string, token?: string }} input - inputs.
 * @returns {Promise<{ marker: boolean, extraEnvelopes: number, sameResolve: boolean, sameSurface: boolean, conflicts: string[] }>} facts.
 */
export async function assertShimReinjectionNoop({ shimText, token = makeNativeToken() } = {}) {
  const harness = createShimHarness({
    shimText,
    token,
    onEnvelope: (message, api) => {
      api.reply(message.id, { controlPlaneUrl: 'http://127.0.0.1:1', dshVersion: 'gate', version: 'gate', platform: 'darwin' })
    },
  })
  await new Promise((resolveTick) => setImmediate(resolveTick))
  const first = {
    envelopes: harness.envelopes.length,
    resolve: harness.sandbox.__dshChamberResolve,
    surface: harness.surface(),
  }
  vm.runInContext(injectShimToken(shimText, token), harness.sandbox, { filename: 'bridge-shim.poc.js' })
  await new Promise((resolveTick) => setImmediate(resolveTick))
  const second = {
    envelopes: harness.envelopes.length,
    resolve: harness.sandbox.__dshChamberResolve,
    surface: harness.surface(),
  }
  const conflicts = []
  if (harness.sandbox.__dshChamberShimInstalled !== true) conflicts.push('installed marker missing after the first injection')
  if (second.envelopes !== first.envelopes) conflicts.push('re-injection posted ' + (second.envelopes - first.envelopes) + ' new envelope(s)')
  if (second.resolve !== first.resolve) conflicts.push('re-injection replaced __dshChamberResolve')
  if (second.surface !== first.surface) conflicts.push('re-injection replaced the public surface')
  if (first.surface === null) conflicts.push('the first injection never exposed the public surface')
  return {
    marker: harness.sandbox.__dshChamberShimInstalled === true,
    extraEnvelopes: second.envelopes - first.envelopes,
    sameResolve: second.resolve === first.resolve,
    sameSurface: second.surface === first.surface,
    conflicts,
  }
}

function read(file) {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

async function main() {
  const preloadText = read('packages/desktop/preload.cts')
  const shimText = read('macos/Sources/DSHChamberPoc/Resources/bridge-shim.poc.js')
  let verdict
  try {
    verdict = comparePayloadShapes({
      preloadText,
      shimText,
      manifest: JSON.parse(read('packages/desktop/bridge-manifest.json')),
    })
  } catch (error) {
    console.error('shim payload shape: FAILED — ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }
  if (verdict.mismatches.length > 0) {
    console.error('shim payload shape: ' + verdict.mismatches.length + ' mismatch(es) across ' + verdict.checked + ' member(s):')
    for (const mismatch of verdict.mismatches) console.error('  - ' + mismatch)
    return 1
  }
  if (verdict.missingFromManifest.length > 0 || verdict.unexposedManifestChannels.length > 0) {
    console.error('shim payload shape: manifest coverage mismatch')
    for (const channel of verdict.missingFromManifest) console.error('  - method channel not in manifest: ' + channel)
    for (const channel of verdict.unexposedManifestChannels) console.error('  - manifest invoke channel has no method: ' + channel)
    return 1
  }
  if (verdict.checked === 0) {
    console.error('shim payload shape: no member parsed — a gate that scans nothing has not passed')
    return 1
  }
  // G34: the per-member comparison above proves the members that were FOUND
  // agree; the pin proves none of them vanished from both sides together.
  try {
    assertSurfaceCounts({
      namespaces: verdict.namespaces,
      members: verdict.checked,
      perNamespace: verdict.perNamespace,
    })
  } catch (error) {
    console.error('shim payload shape: ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }

  // Runtime arm (G22 residual): execute the injected shim and drive every
  // namespace member; compare each emitted postMessage payload key-by-key with
  // the preload.cts call site, then pin the failure branch and the
  // re-injection no-op. Static text agreement already passed above.
  let runtime
  let failure
  let reinjection
  try {
    runtime = await compareRuntimePayloads({ preloadText, shimText })
    failure = await runShimFailureBranch({ shimText })
    reinjection = await assertShimReinjectionNoop({ shimText })
  } catch (error) {
    console.error('shim payload shape (runtime): FAILED — ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }
  if (runtime.mismatches.length > 0) {
    console.error('shim payload shape (runtime): ' + runtime.mismatches.length + ' mismatch(es) across ' + runtime.checked + ' member(s):')
    for (const mismatch of runtime.mismatches) console.error('  - ' + mismatch)
    return 1
  }
  // G34: same pin against the executed surface — including the invoke/push
  // split, so a subscriber silently reclassified as an invoker is caught too.
  try {
    assertSurfaceCounts({
      namespaces: runtime.namespaces,
      members: runtime.checked,
      invoke: runtime.invoked,
      push: runtime.subscribed,
      perNamespace: runtime.perNamespace,
    })
  } catch (error) {
    console.error('shim payload shape (runtime): ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }
  const runtimeProblems = []
  if (failure.attempts !== 11) {
    runtimeProblems.push('failure branch made ' + failure.attempts + ' info attempt(s), expected 11 (1 + INFO_MAX_ATTEMPTS)')
  }
  runtimeProblems.push(...reinjection.conflicts)
  if (runtimeProblems.length > 0) {
    console.error('shim payload shape (runtime): FAILED')
    for (const problem of runtimeProblems) console.error('  - ' + problem)
    return 1
  }
  console.log('shim payload shape: ' + verdict.checked + ' member(s) match preload ↔ shim (invoke payload keys + channels, manifest-locked)')
  console.log(
    'shim runtime: ' + runtime.checked + ' member(s) executed in node:vm (' + runtime.invoked + ' invoke / '
    + runtime.subscribed + ' push) with payloads equal to the preload call sites; failure branch exposed null scalars after '
    + failure.attempts + ' rejections; re-injection is a no-op',
  )
  return 0
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) process.exit(await main())
