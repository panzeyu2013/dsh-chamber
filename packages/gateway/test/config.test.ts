/**
 * Gateway config unit tests (design 17 §3.1): the S1 exposure guard, host
 * validation, tls pairing, auth-kind resolution, and the CLI-to-config option
 * mapping. (Written structure-correct; run with `node --test`.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayConfigError, parseGatewayConfig } from '../src/config.ts'

const STATE = '/tmp/dsh-gateway-state'
const DSH = '/tmp/dsh-workspace'
const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct-horse-battery'
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const DIST_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const DIST_INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const BUILD = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

function ensureGatewayBuild(): void {
  // The gateway test command intentionally runs before the CI build step. A
  // clean checkout therefore has no ignored dist/ tree yet, but this test
  // also covers the packaged CLI's --version contract. Build both bundle
  // entrypoints on demand so the source test does not depend on a developer's
  // previous local build.
  if (existsSync(DIST_CLI) && existsSync(DIST_INDEX)) return
  execFileSync(process.execPath, [BUILD], { cwd: PACKAGE_DIR, stdio: 'inherit' })
}

test('S1: a non-loopback bind without auth is a config error', () => {
  assert.throws(
    () => parseGatewayConfig({ host: '0.0.0.0' }, STATE, DSH),
    GatewayConfigError,
  )
})

test('a loopback bind with no auth resolves kind none', () => {
  const config = parseGatewayConfig({ host: '127.0.0.1' }, STATE, DSH)
  assert.equal(config.plane.host, '127.0.0.1')
  assert.equal(config.auth.kind, 'none')
})

test('S1: loopback behind a public origin or trusted proxy still requires auth', () => {
  assert.throws(
    () => parseGatewayConfig({ host: '127.0.0.1', publicOrigin: 'https://gateway.example' }, STATE, DSH),
    /without authentication/,
  )
  assert.throws(
    () => parseGatewayConfig({ host: '127.0.0.1', trustedProxies: ['127.0.0.1'] }, STATE, DSH),
    /without authentication/,
  )
})

test('S1 override: --no-auth permits an anonymous external bind', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', allowAnonymousExternal: true }, STATE, DSH)
  assert.equal(config.auth.kind, 'none')
  assert.equal(config.allowAnonymousExternal, true)
  assert.equal(config.plane.host, '0.0.0.0')
})

test('S1 override: also permits anonymous loopback behind a public origin or trusted proxy', () => {
  assert.doesNotThrow(
    () => parseGatewayConfig({ host: '127.0.0.1', publicOrigin: 'https://gateway.example', allowAnonymousExternal: true }, STATE, DSH),
  )
  assert.doesNotThrow(
    () => parseGatewayConfig({ host: '127.0.0.1', trustedProxies: ['127.0.0.1'], allowAnonymousExternal: true }, STATE, DSH),
  )
})

test('S1 override with a credential still resolves the credential kind (flag is inert)', () => {
  const withPassword = parseGatewayConfig({ host: '0.0.0.0', uiPassword: PASSWORD, allowAnonymousExternal: true }, STATE, DSH)
  assert.equal(withPassword.auth.kind, 'password')
  const withToken = parseGatewayConfig({ host: '0.0.0.0', apiToken: TOKEN, allowAnonymousExternal: true }, STATE, DSH)
  assert.equal(withToken.auth.kind, 'token')
})

test('0.0.0.0 + api-token resolves kind token', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', apiToken: TOKEN }, STATE, DSH)
  assert.equal(config.auth.kind, 'token')
  assert.equal(config.auth.token, TOKEN)
})

test('0.0.0.0 + ui-password resolves kind password', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', uiPassword: PASSWORD }, STATE, DSH)
  assert.equal(config.auth.kind, 'password')
  assert.equal(config.auth.password, PASSWORD)
})

test('password and token compose instead of shadowing the bearer credential', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', uiPassword: PASSWORD, apiToken: TOKEN }, STATE, DSH)
  assert.equal(config.auth.kind, 'password+token')
  assert.equal(config.auth.password, PASSWORD)
  assert.equal(config.auth.token, TOKEN)
})

test('public/cors origins and trusted proxy peers are canonicalized and validated', () => {
  const config = parseGatewayConfig({
    uiPassword: PASSWORD,
    publicOrigin: 'https://gateway.example',
    corsOrigins: ['https://client.example', 'capacitor://localhost', 'openchamber-ui://app'],
    trustedProxies: ['127.0.0.1', '::1'],
  }, STATE, DSH)
  assert.equal(config.publicOrigin, 'https://gateway.example')
  assert.deepEqual(config.corsOrigins, ['https://client.example', 'capacitor://localhost', 'openchamber-ui://app'])
  assert.deepEqual(config.trustedProxies, ['127.0.0.1', '::1'])
  assert.throws(() => parseGatewayConfig({ publicOrigin: 'https://gateway.example/path' }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ corsOrigins: ['null'] }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ trustedProxies: ['proxy.local'] }, STATE, DSH), GatewayConfigError)
})

test('an invalid host is a config error', () => {
  assert.throws(() => parseGatewayConfig({ host: 'example.com' }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ host: '::1' }, STATE, DSH), GatewayConfigError)
})

test('an invalid port is a config error', () => {
  assert.throws(() => parseGatewayConfig({ port: 0 }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ port: 70000 }, STATE, DSH), GatewayConfigError)
})

test('--dsh-port sets the managed dsh port base (design 17 §3 server override)', () => {
  const cfg = parseGatewayConfig({ dshPort: 30800 }, STATE, DSH)
  assert.equal(cfg.plane.dshPort, 30800)
  // absent = default (not set)
  assert.equal(parseGatewayConfig({}, STATE, DSH).plane.dshPort, undefined)
})

test('gateway serve forwards --dsh-port into config validation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-cli-dsh-port-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dsh = join(root, 'dsh')
  mkdirSync(join(dsh, 'apps', 'cli', 'src'), { recursive: true })
  writeFileSync(join(dsh, 'apps', 'cli', 'src', 'bin.ts'), '')
  const invalidStateDir = join(root, 'state-is-a-file')
  writeFileSync(invalidStateDir, '')

  // Correct forwarding rejects 65536 as a usage/config error (exit 2) before
  // construction touches the deliberately invalid state path. If the flag is
  // dropped, store construction instead fails as a runtime error (exit 1).
  const env = { ...process.env }
  delete env.DSH_GATEWAY_DSH_PORT
  const result = spawnSync(process.execPath, [
    CLI,
    'serve',
    '--dsh-path', dsh,
    '--state-dir', invalidStateDir,
    '--dsh-port', '65536',
  ], { encoding: 'utf8', env, timeout: 10_000 })
  assert.equal(result.status, 2, result.stderr)
})

test('gateway CLI exposes the installed package version for installer health proof', () => {
  ensureGatewayBuild()
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
  for (const entry of [CLI, DIST_CLI]) {
    const result = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, `${entry}: ${result.stderr}`)
    assert.equal(result.stdout.trim(), manifest.version, entry)
  }
})

test('gateway CLI validates the highest-priority env dsh path even with a valid --dsh-path anchor', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-cli-env-anchor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const anchor = join(root, 'valid-anchor')
  mkdirSync(join(anchor, 'apps', 'cli', 'src'), { recursive: true })
  writeFileSync(join(anchor, 'apps', 'cli', 'src', 'bin.ts'), '')
  const invalidEnv = join(root, 'invalid-env-override')
  const env = { ...process.env, DSH_GATEWAY_DSH_PATH: invalidEnv }
  const result = spawnSync(process.execPath, [CLI, 'serve', '--dsh-path', anchor], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  })
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, new RegExp(invalidEnv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('DSH_GATEWAY_DSH_PORT env sets the managed dsh port base', () => {
  const before = process.env.DSH_GATEWAY_DSH_PORT
  process.env.DSH_GATEWAY_DSH_PORT = '30801'
  try {
    assert.equal(parseGatewayConfig({}, STATE, DSH).plane.dshPort, 30801)
  } finally {
    if (before === undefined) delete process.env.DSH_GATEWAY_DSH_PORT
    else process.env.DSH_GATEWAY_DSH_PORT = before
  }
})

test('an invalid dsh port is a config error', () => {
  assert.throws(() => parseGatewayConfig({ dshPort: 0 }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ dshPort: 70000 }, STATE, DSH), GatewayConfigError)
  const before = process.env.DSH_GATEWAY_DSH_PORT
  process.env.DSH_GATEWAY_DSH_PORT = 'not-a-number'
  try {
    assert.throws(() => parseGatewayConfig({}, STATE, DSH), GatewayConfigError)
  } finally {
    if (before === undefined) delete process.env.DSH_GATEWAY_DSH_PORT
    else process.env.DSH_GATEWAY_DSH_PORT = before
  }
})

test('--tls-cert and --tls-key must be paired', () => {
  assert.throws(() => parseGatewayConfig({ tlsCert: '/c.pem' }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ tlsKey: '/k.pem' }, STATE, DSH), GatewayConfigError)
})

test('a paired tls cert+key is rejected (HTTPS server not implemented)', () => {
  assert.throws(() => parseGatewayConfig({ tlsCert: '/c.pem', tlsKey: '/k.pem' }, STATE, DSH), GatewayConfigError)
})

test('an empty password is rejected (not a credential)', () => {
  assert.throws(() => parseGatewayConfig({ uiPassword: '' }, STATE, DSH), GatewayConfigError)
})

test('an empty token is rejected (not a credential)', () => {
  assert.throws(() => parseGatewayConfig({ apiToken: '' }, STATE, DSH), GatewayConfigError)
})

test('weak browser and bearer credentials are rejected before exposure', () => {
  assert.throws(() => parseGatewayConfig({ uiPassword: 'short' }, STATE, DSH), /12-1024/)
  assert.throws(() => parseGatewayConfig({ apiToken: 'predictable' }, STATE, DSH), /32-4096/)
})
