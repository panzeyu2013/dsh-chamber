/**
 * The shared scripts-toolbox CLI entry epilogue (scripts/lib/cli.mjs).
 *
 * The two packaging entries (build-sidecar / build-swift-app) carried the same
 * epilogue; its behavior is the contract this file pins — usage block on --help
 * (exit 0), the tool runs otherwise, and any throw becomes
 * `[<label>] 失败：<message>` + exit 1.
 *
 * Run directly: node scripts/lib/cli.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { isCliEntry, runCliTool } from './cli.mjs'

const harness = (overrides = {}) => {
  const log = []
  const error = []
  const exits = []
  const calls = []
  return {
    log, error, exits, calls,
    options: {
      label: 'demo',
      usage: ['用法：demo.mjs [--help]'],
      parse: argv => (argv.includes('--help') ? { help: true } : { help: false, argv }),
      run: options => { calls.push(options) },
      log: line => log.push(line),
      error: line => error.push(line),
      exit: code => { exits.push(code) },
      ...overrides,
    },
  }
}

test('--help prints the usage block, never runs the tool, and exits 0', async () => {
  const h = harness()
  await runCliTool({ ...h.options, argv: ['--help'] })
  assert.deepEqual(h.log, ['用法：demo.mjs [--help]'])
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.exits, [0])
  assert.deepEqual(h.error, [])
})

test('a successful run calls the tool once with the parsed options and exits normally', async () => {
  const h = harness()
  await runCliTool({ ...h.options, argv: ['--out', 'dist'] })
  assert.deepEqual(h.calls, [{ help: false, argv: ['--out', 'dist'] }])
  assert.deepEqual(h.exits, [])
  assert.deepEqual(h.log, [])
})

test('a thrown Error becomes [label] 失败：message + exit 1', async () => {
  const h = harness({ run: () => { throw new Error('--out 缺少取值') } })
  await runCliTool(h.options)
  assert.deepEqual(h.error, ['[demo] 失败：--out 缺少取值'])
  assert.deepEqual(h.exits, [1])
})

test('a thrown non-Error is stringified the same way', async () => {
  const h = harness({ parse: () => { throw 42 } })
  await runCliTool(h.options)
  assert.deepEqual(h.error, ['[demo] 失败：42'])
  assert.deepEqual(h.exits, [1])
})

test('isCliEntry: true only for the module that IS argv[1]', () => {
  const selfUrl = new URL('./cli.mjs', import.meta.url).href
  assert.equal(isCliEntry(selfUrl, fileURLToPath(new URL('./cli.mjs', import.meta.url))), true)
  assert.equal(isCliEntry(selfUrl, fileURLToPath(new URL('./test-manifest.mjs', import.meta.url))), false)
  assert.equal(isCliEntry(selfUrl, undefined), false)
})
