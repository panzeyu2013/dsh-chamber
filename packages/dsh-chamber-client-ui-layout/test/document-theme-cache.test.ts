/**
 * Source theme cache + cold-boot priming tests (W3 切源体验, plain node:test, no DOM).
 *
 * Locks: (a) the pure priming decision, (b) a cold/unmounted target is primed with
 * its last-known palette, (c) a never-seen target falls back to the last palette
 * actually applied, (d) a MOUNTED target is never cross-written, (e) priming is
 * de-duplicated per activation, (f) provisional snapshots never enter the cache,
 * (g) a reclaimed view keeps its palette for the next cold open, and (h) omitting
 * the cache keeps the pre-2026-12 behavior byte-for-byte.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createSourceThemeCache, decidePrime } from "../src/client/theme-cache.ts"
import { createDocumentThemeProjector, type DocumentThemeEnvironment } from "../src/client/document-theme.ts"

function environment(active?: string): DocumentThemeEnvironment & {
  writes: string[]
  setActive: (sourceId: string | undefined) => void
  listeners: number
} {
  const writes: string[] = []
  const listeners = new Set<(sourceId: string | undefined) => void>()
  let current = active
  return {
    writes,
    get listeners() { return listeners.size },
    getActiveSource: () => current,
    onActiveSource: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    apply: snapshot => { writes.push((snapshot as { active: { id: string } }).active.id) },
    setActive: sourceId => {
      current = sourceId
      for (const listener of [...listeners]) listener(current)
    },
  }
}

const snapshot = (id: string) => ({ active: { id } }) as never

test("the pure priming decision covers self, mounted, cached, fallback and de-dup", () => {
  const base = { active: "ssh" as string | undefined, self: "local", hasCached: false, activeMounted: false, primedFor: undefined as string | undefined, hasFallback: false }
  assert.equal(decidePrime({ ...base, active: undefined }), "self")
  assert.equal(decidePrime({ ...base, active: "local" }), "self")
  assert.equal(decidePrime(base), "none", "no cache and no fallback: nothing to prime with")
  assert.equal(decidePrime({ ...base, hasFallback: true }), "fallback")
  assert.equal(decidePrime({ ...base, hasCached: true, hasFallback: true }), "cached")
  assert.equal(decidePrime({ ...base, hasCached: true, activeMounted: true }), "none", "a mounted target repaints itself")
  assert.equal(decidePrime({ ...base, hasCached: true, primedFor: "ssh" }), "none", "one prime per activation")
})

test("a cold switch to a previously seen source primes its last-known palette", () => {
  const cache = createSourceThemeCache()
  const env = environment("local")
  const local = createDocumentThemeProjector("local", env, { cache })
  local.project(snapshot("light"))
  assert.deepEqual(env.writes, ["light"])

  const remote = createDocumentThemeProjector("ssh", env, { cache })
  remote.project(snapshot("dark"))
  remote.dispose()
  assert.deepEqual(env.writes, ["light"], "a hidden view never repaints the document")

  env.setActive("ssh")
  assert.deepEqual(env.writes, ["light", "dark"], "the cold target is primed with its own palette")
})

test("a never-seen cold target falls back to the last palette actually applied", () => {
  const cache = createSourceThemeCache()
  const env = environment("local")
  const local = createDocumentThemeProjector("local", env, { cache })
  local.project(snapshot("light"))
  env.setActive("never-seen")
  assert.deepEqual(env.writes, ["light", "light"], "the document never stays on an unknown palette")
})

test("a mounted target is not cross-written by hidden views", () => {
  const cache = createSourceThemeCache()
  const env = environment("local")
  const local = createDocumentThemeProjector("local", env, { cache })
  local.project(snapshot("light"))
  const remote = createDocumentThemeProjector("ssh", env, { cache })
  remote.project(snapshot("dark"))
  env.setActive("ssh")
  assert.deepEqual(env.writes, ["light", "dark"], "only the active view writes on activation")
})

test("priming is de-duplicated across hidden instances", () => {
  const cache = createSourceThemeCache()
  const env = environment("local")
  const local = createDocumentThemeProjector("local", env, { cache })
  const other = createDocumentThemeProjector("other", env, { cache })
  local.project(snapshot("light"))
  other.project(snapshot("other-palette"))
  const remote = createDocumentThemeProjector("ssh", env, { cache })
  remote.project(snapshot("dark"))
  remote.dispose()
  env.setActive("ssh")
  assert.deepEqual(env.writes, ["light", "dark"], "exactly one hidden instance primes the cold target")
})

test("provisional snapshots are never remembered as a source palette", () => {
  const cache = createSourceThemeCache()
  const env = environment("local")
  const local = createDocumentThemeProjector("local", env, { cache })
  local.project(snapshot("light"))
  const remote = createDocumentThemeProjector("ssh", env, { cache, isSettled: () => false })
  remote.project(snapshot("provisional"))
  remote.dispose()
  assert.equal(cache.snapshotOf("ssh"), undefined)
  env.setActive("ssh")
  assert.deepEqual(env.writes, ["light", "light"], "the provisional palette was not primed")
})

test("a reclaimed view keeps its palette for the next cold open", () => {
  const cache = createSourceThemeCache()
  const env = environment("local")
  // Production topology: the local view stays mounted, so exactly one live
  // listener is left to prime a reclaimed target.
  const local = createDocumentThemeProjector("local", env, { cache })
  local.project(snapshot("light"))
  const remote = createDocumentThemeProjector("ssh", env, { cache, isSettled: () => true })
  remote.project(snapshot("dark"))
  remote.dispose()
  assert.equal(cache.snapshotOf("ssh") !== undefined, true)
  assert.equal(cache.isMounted("ssh"), false)
  env.setActive("ssh")
  assert.deepEqual(env.writes, ["light", "dark"])
})

test("omitting the cache keeps the legacy behavior (compatibility lock)", () => {
  const env = environment("local")
  const local = createDocumentThemeProjector("local", env)
  const remote = createDocumentThemeProjector("ssh", env)
  local.project(snapshot("light"))
  remote.project(snapshot("dark"))
  assert.deepEqual(env.writes, ["light"])
  env.setActive("ssh")
  assert.deepEqual(env.writes, ["light", "dark"])
})
