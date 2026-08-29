import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeManagedDshEnv } from '../../control-plane/src/spawn-dsh.ts'

test('managed dsh child environment strips every gateway credential/config variable', () => {
  const source = {
    PATH: '/bin',
    DSH_GATEWAY_PASSWORD: 'password-secret',
    DSH_GATEWAY_TOKEN: 'token-secret',
    DSH_GATEWAY_PUBLIC_ORIGIN: 'https://gateway.example',
    dsh_gateway_mixed_case_secret: 'windows-secret',
    DSH_CHAMBER_STATE: '/state',
  }
  assert.deepEqual(sanitizeManagedDshEnv(source), {
    PATH: '/bin',
    DSH_CHAMBER_STATE: '/state',
  })
  // Pure copy: sanitizing a child environment never mutates the gateway's own
  // process environment object.
  assert.equal(source.DSH_GATEWAY_TOKEN, 'token-secret')
  assert.equal(source.dsh_gateway_mixed_case_secret, 'windows-secret')
})
