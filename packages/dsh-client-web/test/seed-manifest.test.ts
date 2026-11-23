/**
 * node:test for the alpha.1 static-module manifest protocol (`src/seed.ts`).
 *
 * Why a real-module test: the old table was a specifier → namespace RECORD, while
 * `ClientModuleCreateOptions.staticModules` now takes `readonly DshClientModuleManifest[]`
 * ({ id, factory, meta? }). A type-only change would pass tsc while the module system
 * registers nothing by id, so this suite imports the SHIPPED seed against the boot
 * runtime fixture and pins the protocol shape (ids, factories, stable identities).
 *
 * It also pins the chamber source-state deviation: the vendor tree is consumed as
 * SOURCES by the Vite build, so `compiledModule()` must wrap a namespace with no
 * build-time `__$dsh_client_module_manifest` export instead of throwing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { getStaticModules } from '../src/seed.ts'
import { PLATFORM_MODULES } from '../src/platform.ts'

/** The require a module factory receives; the seed's factories bundle their namespace. */
const refusingRequire = (() => { throw new Error('the seed namespace must be fully bundled') }) as never

test('the static table is an array of manifests, one per platform word, in platform order', () => {
  const modules = getStaticModules()
  assert.ok(Array.isArray(modules), 'alpha.1 staticModules is a manifest ARRAY, not a specifier record')
  assert.deepEqual(modules.map(module => module.id), [...PLATFORM_MODULES],
    'one manifest per platform word, in PLATFORM_MODULES order')
  for (const module of modules) {
    assert.equal(typeof module.id, 'string')
    assert.equal(typeof module.factory, 'function', module.id + ' must carry a JS factory')
  }
})

test('every factory materializes the shell-static namespace without evaluating meta', () => {
  const modules = getStaticModules()
  for (const module of modules) {
    const exports = module.factory(refusingRequire)
    assert.equal(typeof exports, 'object', module.id + ' factory returns the namespace object')
    assert.equal(module.meta, undefined, 'the chamber source build carries no stylesheet meta')
  }
})

test('the namespace identity is the shell-static one (one instance per word, per page)', () => {
  const modules = getStaticModules()
  const first = modules.map(module => module.factory(refusingRequire))
  const second = getStaticModules().map(module => module.factory(refusingRequire))
  for (const [index, value] of first.entries()) {
    assert.equal(second[index], value, modules[index]?.id + ' must reuse the same shared identity')
  }
  // The fixture namespace includes a named export: the factory must return the
  // module's exports object, not a copy that would break require identity.
  assert.equal('Context' in (first[0] as Record<string, unknown>), true)
})

test('compiledModule wraps a source-state library instead of throwing (chamber C3 deviation)', () => {
  // dsh-client-store / dsh-client-ui-slots are the upstream compiledModule() words.
  // The fixture modules carry no __$dsh_client_module_manifest, exactly like the
  // pinned vendor sources; the local wrapper is the source-state answer.
  const modules = getStaticModules()
  for (const id of ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots']) {
    const module = modules.find(candidate => candidate.id === id)
    assert.ok(module !== undefined, id + ' must still be seeded')
    assert.equal(typeof module.factory(refusingRequire), 'object')
    assert.equal(module.meta, undefined)
  }
})
