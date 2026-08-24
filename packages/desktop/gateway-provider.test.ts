/**
 * gateway-provider unit tests (design 17 §7): the write-only token
 * store (0600 atomic mirror, corrupt-preserve fail-loud, never readable by
 * the renderer), token validation, host pattern, and the HTTP failure
 * classification that drives terminal-vs-transient connect verdicts.
 *
 * AGENTS.md listed gateway-provider as covered by test:desktop for a long
 * time with no test file — this closes that gap. The https identity probe
 * (verifyGatewayEndpoint) is NOT covered here (needs a TLS server); its
 * classification logic is, through gatewayHttpFailureIsTerminal.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureGatewayTokenStore,
  DEFAULT_GATEWAY_PORT,
  GATEWAY_HOST_PATTERN,
  gatewayHttpFailureIsTerminal,
  gatewayTokenValidationError,
  getGatewayToken,
  setGatewayToken,
} from './gateway-provider.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'

test('token store persists to and reloads from the plaintext file (0600, atomic)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-token-'))
  const file = join(dir, 'gateway-tokens.json')
  try {
    assert.equal(configureGatewayTokenStore(file), null, 'missing file = first run, no notice')
    setGatewayToken('t-token-1', TOKEN)
    setGatewayToken('t-token-2', `${TOKEN}2`)
    assert.ok(existsSync(file), 'file is written on the first set')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'token file is 0600')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stored.schemaVersion, 1)
    assert.equal(stored.tokens['t-token-1'], TOKEN)
    // The store reloads the file into memory.
    assert.equal(configureGatewayTokenStore(file), null)
    assert.equal(getGatewayToken('t-token-1'), TOKEN)
    assert.equal(getGatewayToken('t-token-2'), `${TOKEN}2`)
    // Clearing removes the entry and rewrites the mirror.
    setGatewayToken('t-token-1', null)
    assert.equal(getGatewayToken('t-token-1'), null)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).tokens['t-token-1'], undefined)
  } finally {
    setGatewayToken('t-token-1', null)
    setGatewayToken('t-token-2', null)
    configureGatewayTokenStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt token file is preserved as *.corrupt and fails loudly, never silently empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-token-corrupt-'))
  const file = join(dir, 'gateway-tokens.json')
  try {
    writeFileSync(file, 'not json at all')
    const notice = configureGatewayTokenStore(file)
    assert.notEqual(notice, null, 'a corrupt file returns a loud notice')
    assert.match(notice ?? '', /\.corrupt/)
    assert.ok(existsSync(`${file}.corrupt`), 'the corrupt bytes are preserved')
    assert.equal(existsSync(file), false, 'the original is renamed away')
    assert.equal(getGatewayToken('anything'), null, 'the store is empty, but that is loud, not silent')

    // A well-formed file with an INVALID entry (too short / non-ASCII /
    // reserved id) is equally corrupt.
    const file2 = join(dir, 'gateway-tokens-2.json')
    writeFileSync(file2, JSON.stringify({ schemaVersion: 1, tokens: { 't-bad': 'short' } }))
    assert.notEqual(configureGatewayTokenStore(file2), null)
    assert.ok(existsSync(`${file2}.corrupt`))

    const file3 = join(dir, 'gateway-tokens-3.json')
    writeFileSync(file3, JSON.stringify({ schemaVersion: 1, tokens: { 't-bad': `${'a'.repeat(32)}中` } }))
    assert.notEqual(configureGatewayTokenStore(file3), null, 'non-visible-ASCII tokens are refused on load')
  } finally {
    configureGatewayTokenStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gatewayTokenValidationError mirrors the main-process gate', () => {
  assert.equal(gatewayTokenValidationError(null), null)
  assert.equal(gatewayTokenValidationError(''), null)
  assert.equal(gatewayTokenValidationError(TOKEN), null)
  assert.match(gatewayTokenValidationError('short') ?? '', /at least 32/)
  assert.match(gatewayTokenValidationError(`${TOKEN}中`) ?? '', /visible ASCII/)
  assert.match(gatewayTokenValidationError('a'.repeat(4097)) ?? '', /limited to 4096/)
})

test('gatewayHttpFailureIsTerminal classifies deterministic vs transient statuses', () => {
  // Deterministic client/protocol evidence: terminal.
  assert.equal(gatewayHttpFailureIsTerminal(401), true)
  assert.equal(gatewayHttpFailureIsTerminal(403), true)
  assert.equal(gatewayHttpFailureIsTerminal(404), true)
  assert.equal(gatewayHttpFailureIsTerminal(200), true, 'a non-probe 2xx is not the required dsh envelope')
  // Explicitly transient statuses.
  assert.equal(gatewayHttpFailureIsTerminal(408), false)
  assert.equal(gatewayHttpFailureIsTerminal(425), false)
  assert.equal(gatewayHttpFailureIsTerminal(429), false)
  assert.equal(gatewayHttpFailureIsTerminal(500), false)
  assert.equal(gatewayHttpFailureIsTerminal(502), false)
  assert.equal(gatewayHttpFailureIsTerminal(503), false)
  // Outside the HTTP status space: not a real answer.
  assert.equal(gatewayHttpFailureIsTerminal(0), false)
  assert.equal(gatewayHttpFailureIsTerminal(700), false)
})

test('GATEWAY_HOST_PATTERN rejects embedded ports and accepts bare/IPv6 hosts', () => {
  assert.equal(GATEWAY_HOST_PATTERN.test('gw.example.com'), true)
  assert.equal(GATEWAY_HOST_PATTERN.test('192.168.1.10'), true)
  assert.equal(GATEWAY_HOST_PATTERN.test('[2001:db8::1]'), true)
  // A colon inside the host would silently override the URL port — refused.
  assert.equal(GATEWAY_HOST_PATTERN.test('gw.example.com:8443'), false)
  assert.equal(GATEWAY_HOST_PATTERN.test(''), false)
  assert.equal(GATEWAY_HOST_PATTERN.test('https://gw.example.com'), false)
})

test('DEFAULT_GATEWAY_PORT is 443', () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 443)
})

test('the token store dir has no stray files after a full lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-token-clean-'))
  const file = join(dir, 'gateway-tokens.json')
  try {
    configureGatewayTokenStore(file)
    setGatewayToken('t-clean-1', TOKEN)
    setGatewayToken('t-clean-1', null)
    assert.deepEqual(readdirSync(dir), ['gateway-tokens.json'], 'no .tmp residue after write-through clears')
  } finally {
    configureGatewayTokenStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
