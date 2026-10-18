/**
 * updater-channel-seal.test.ts — design 11 §4: the packaged artifact states the channel
 * it was built for (electron-builder.beta.yml extraMetadata -> the app package.json the
 * runtime already reads for its version).
 *
 * ① normalizeSealedChannel accepts exactly the two canonical names and nothing else;
 * ② resolveChannel precedence: explicit env opt-in > build seal > canonical version suffix;
 * ③ the beta build config seals the key; the dev/stable manifest seals nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSealedChannel } from '../../updater.ts'
import { makeController } from '../support/updater-harness.ts'

const pkgDir = join(import.meta.dirname, '..', '..')

test('① normalizeSealedChannel: only the two canonical channel names are a seal', () => {
  assert.equal(normalizeSealedChannel('stable'), 'stable')
  assert.equal(normalizeSealedChannel('beta'), 'beta')
  const rejected: unknown[] = [undefined, null, '', 'beta ', 'BETA', 'nightly', 'latest', 0, 1, true, {}, []]
  for (const bad of rejected) {
    assert.equal(normalizeSealedChannel(bad), null, 'must not seal: ' + String(bad))
  }
})

test('② resolveChannel precedence: env opt-in > build seal > version suffix', () => {
  // Hermetic by construction: every case clears the ambient DSH_CHAMBER_UPDATE_CHANNEL
  // (the harness restores the developer's own value afterwards), so a local beta opt-in
  // can never turn the "no seal / no env" expectations red.
  const noEnv = { DSH_CHAMBER_UPDATE_CHANNEL: '' }
  const channelOf = (
    version: string,
    sealed?: 'stable' | 'beta' | null,
    env: Record<string, string> = noEnv,
  ): string =>
    makeController({ version, env, ...(sealed !== undefined ? { sealedChannel: sealed } : {}) }).controller.state().channel

  // The seal is the artifact fact: it beats the version suffix in BOTH directions.
  assert.equal(channelOf('1.2.3', 'beta'), 'beta', 'a stable-numbered artifact sealed beta queries beta')
  assert.equal(channelOf('1.2.3-beta.2', 'stable'), 'stable', 'a beta-numbered artifact sealed stable queries stable')
  // No seal: the canonical suffix decides (dev, and the unsealed Swift flavor).
  assert.equal(channelOf('1.2.3-beta.2'), 'beta')
  assert.equal(channelOf('1.2.3'), 'stable')
  assert.equal(channelOf('1.2.3', null), 'stable')
  // The explicit opt-in stays the strongest signal and can only ADD beta (never remove it).
  assert.equal(channelOf('1.2.3', null, { DSH_CHAMBER_UPDATE_CHANNEL: 'beta' }), 'beta')
  assert.equal(channelOf('1.2.3', 'stable', { DSH_CHAMBER_UPDATE_CHANNEL: 'beta' }), 'beta')
  assert.equal(
    channelOf('1.2.3-beta.2', 'beta', { DSH_CHAMBER_UPDATE_CHANNEL: 'stable' }),
    'beta',
    'a non-beta env value never removes beta (unchanged pre-seal semantics)',
  )
})

test('③ the beta build config seals extraMetadata; the dev/stable manifest carries no key', () => {
  const betaYml = readFileSync(join(pkgDir, 'electron-builder.beta.yml'), 'utf8')
  assert.match(betaYml, /extraMetadata:/)
  assert.match(betaYml, /dshChamberUpdateChannel: beta/)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    dshChamberUpdateChannel?: unknown
    build?: { extraMetadata?: Record<string, unknown> }
  }
  assert.equal(manifest.dshChamberUpdateChannel, undefined, 'the dev manifest must not seal a channel')
  assert.equal(
    manifest.build?.extraMetadata?.dshChamberUpdateChannel,
    undefined,
    'the stable build config must not seal a channel',
  )
  // Wiring lock (the seal is useless if main never reads it): the packaged manifest key
  // must reach createUpdateController through normalizeSealedChannel.
  const mainSource = readFileSync(join(pkgDir, 'main.ts'), 'utf8')
  assert.ok(
    mainSource.includes('sealedChannel: normalizeSealedChannel(desktopManifest.dshChamberUpdateChannel)'),
    'main.ts must pass the sealed manifest channel into the update controller',
  )
  assert.ok(
    mainSource.includes('dshChamberUpdateChannel?: unknown'),
    'main.ts must declare the sealed key on the manifest it already parses',
  )
})
