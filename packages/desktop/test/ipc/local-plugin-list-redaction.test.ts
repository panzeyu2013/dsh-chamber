/**
 * LOCAL_PLUGIN_LIST handler projection (design 13 §7.0): the renderer-bound
 * IPC response is the REDACTED manifest. Materialize-class dependency values
 * (file:/link:/relative/absolute/`~/`) and the rows[].spec channel are masked
 * with MATERIALIZED_VALUE_MASK before the response leaves the main process;
 * registry values pass through untouched. The main-process-internal read stays
 * full (the mutation leaf, resolveLocalMaterializeDirectory and the seed paths
 * keep consuming localPluginList directly).
 *
 * Behavioral, not a source-text anchor: the test registers the real
 * registerLocalPluginHandlers body against a fake registrar and invokes the
 * real LOCAL_PLUGIN_LIST handler over a real temp profile.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import { MATERIALIZED_VALUE_MASK, sshProtectionFacts, type LocalPluginManifest } from '../../plugin-sync.ts'
import { registerLocalPluginHandlers } from '../../shell-ipc-plugins-local.ts'
import { tempDir } from '../plugins/plugin-sync-fixtures.ts'

function writeProfile(root: string): void {
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'file-dep': 'file:/Users/local/pkg',
      'link-dep': 'link:../sibling',
      'registry-dep': '^1.2.3',
      'url-dep': 'https://example.com/dep.tgz',
    },
    dsh: { profile: { bundles: [] } },
  }, undefined, 2))
}

test('desktop_local_plugin_list: the IPC response masks local-path dependency values (design 13 §7.0)', () => {
  const root = tempDir('dsh-local-list-redact-')
  writeProfile(root)
  const handlers = new Map<string, (payload: unknown) => unknown>()
  registerLocalPluginHandlers({
    deps: {
      ipc: {
        handle: (channel: string, handler: (payload: unknown) => unknown) => {
          handlers.set(channel, handler)
        },
      },
      ctx: { localDshHome: root },
    },
    localProtectionFacts: () => sshProtectionFacts(),
  } as unknown as Parameters<typeof registerLocalPluginHandlers>[0])
  const handler = handlers.get(IPC_CHANNELS.LOCAL_PLUGIN_LIST)
  assert.notEqual(handler, undefined, 'the local plugin list channel is registered')
  const response = handler!(undefined) as { ok: true; manifest: LocalPluginManifest }
  assert.equal(response.ok, true)
  // Local-path VALUES are masked on both channels.
  assert.equal(response.manifest.dependencies['file-dep'], MATERIALIZED_VALUE_MASK)
  assert.equal(response.manifest.dependencies['link-dep'], MATERIALIZED_VALUE_MASK)
  const fileRow = response.manifest.rows.find(row => row.name === 'file-dep')
  assert.equal(fileRow?.spec, MATERIALIZED_VALUE_MASK, 'rows[].spec is the second masking channel')
  // Registry / URL values are untouched (masking must not alter the diff model).
  assert.equal(response.manifest.dependencies['registry-dep'], '^1.2.3')
  assert.equal(response.manifest.dependencies['url-dep'], 'https://example.com/dep.tgz')
})
