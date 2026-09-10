/**
 * Wiring contract for the sidebarRight self-heal (2026-09-10, design 09 §3.2).
 *
 * `App.tsx` cannot be imported by a node test (it renders the whole shell) and
 * the three layers live in three different files, so this is the SAME
 * source-text contract pattern the repo already uses for App-level wiring
 * (`app-purged-memory-wiring.test.ts`, sidebar `producer-purged-wiring.test.ts`):
 * a green run proves the SHAPE, not the behaviour — the behaviour is covered by
 * `host-graph.test.ts` (serving gate + degrade reporting), `shell.test.ts`
 * (degrade settle, probe republish, gate threading) and
 * `degraded-retry.test.ts` (the once-per-ready-epoch decision).
 *
 * Pinned here because each of these links is a silent no-op when it goes
 * missing: the gate never reaches the fetch, the probe's verdict never reaches
 * the App, or the App never re-boots — and the user is back to a mount whose
 * conversation view never registers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the App arms the serving gate, and it reaches the instance shell', () => {
  const app = read('../src/App.tsx')
  // the gate is bounded by the SINGLE boot budget, never a hand-written number
  assert.match(app, /const SERVING_WAIT_MS = BOOT_TIMEOUT_MS/, 'the gate must reuse the boot budget')
  assert.match(app, /const waitForServing = useCallback\(\(instanceId: string\): Promise<boolean> => \{/)
  assert.match(app, /const phase = serversPhaseRef\.current\[instanceId\]/, 'the gate reads the phase mirror')
  assert.match(app, /waitForServing=\{waitForServing\}/, 'InstanceView must receive the gate')
  const view = read('../src/components/InstanceView.tsx')
  assert.match(view, /waitForServing\?: \(instanceId: string\) => Promise<boolean>/)
  assert.match(view, /bootInstanceShell\(instanceId, basePath, el, setShell, sourceFingerprint, transport, \{ waitForServing \}\)/)
})

test('the phase mirror is written in an effect and feeds the bounded gate', () => {
  const app = read('../src/App.tsx')
  const mirror = /useEffect\(\(\) => \{\s*serversPhaseRef\.current = Object\.fromEntries\(servers\.map\(server => \[server\.id, server\.phase\]\)\)\s*\}, \[servers\]\)/
  assert.match(app, mirror, 'the mirror is effect-written (never during render) and tracks servers')
  assert.match(app, /const deadline = Date\.now\(\) \+ SERVING_WAIT_MS/)
  assert.match(app, /if \(Date\.now\(\) >= deadline\) \{ resolve\(false\); return \}/, 'the gate must time out, not hang')
})

test('a degraded mount is re-booted once per ready epoch by the App', () => {
  const app = read('../src/App.tsx')
  assert.match(app, /const plan = planDegradedRetries\(\{/)
  assert.match(app, /\.filter\(\(\[, state\]\) => state\.degraded !== null\)/, 'only degraded mounts are considered')
  assert.match(app, /phaseOf: \(instanceId\) => phases\[instanceId\]/)
  assert.match(app, /retried: degradedRetriedRef\.current/)
  assert.match(app, /degradedRetriedRef\.current = plan\.retried/, 'the marks must be carried into the next pass')
  assert.match(app, /for \(const instanceId of plan\.retry\) next\[instanceId\] = \(next\[instanceId\] \?\? 0\) \+ 1/, 'the self-heal drives the same retry token the user retry uses')
})

test('the entry probe reports a missed required service through the shell seam', () => {
  const entry = read('../src/chamber-entry.ts')
  assert.match(entry, /const reportBootDegraded = \(ctx as \{ chamberReportBootDegraded\?: \(message: string\) => void \}\)/)
  assert.match(entry, /degradedSeam\(message\)/, 'the 5s verdict must reach the seam, not only the console')
  const shell = read('../src/shell.ts')
  assert.match(shell, /ctx\.provide\('chamberReportBootDegraded', reportRequiredServicesMissing\)/)
  assert.match(shell, /reportSettledDegrade\(instanceId, \{ kind: 'required-services-missing', message \}\)/)
  assert.match(shell, /const next: ShellState = \{ \.\.\.holder\.lastState, degraded: fact \}/, 'a post-settle verdict republishes through onState')
})

test('the degrade fact travels with every settled ShellState', () => {
  const shell = read('../src/shell.ts')
  assert.match(shell, /degraded: ShellDegradedFact \| null/)
  assert.match(shell, /graphUnavailable === null\s*\?\s*null\s*:\s*\{ kind: 'graph-unavailable', message: graphUnavailable \}/)
  assert.match(shell, /onGraphUnavailable: \(message\) => \{ if \(mayPublish\(\)\) graphUnavailable = message \}/)
  assert.match(shell, /\.\.\.\(options\.waitForServing === undefined \? \{\} : \{ waitForServing: options\.waitForServing \}\)/)
})
