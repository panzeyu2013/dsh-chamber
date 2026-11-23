/**
 * Source lock for the chamber N-ctx boot deviation (`src/boot.ts`, design 09).
 *
 * alpha.1's `AppWebEntry.dispose()` disposes its module system
 * (`await this.modules?.dispose()`). Chamber's module system is PAGE-level: the first
 * shell installs it via `ensureWebModuleSystem` and every later shell adopts the same
 * instance, so one shell's dispose running the upstream line would tear down the
 * module table under every other live shell. The page teardown owns that lifetime.
 *
 * This is a source lock on purpose: a stock upstream re-sync restores the line, and
 * only a code-level lock (or a full multi-shell jsdom boot) would catch it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/boot.ts', import.meta.url), 'utf8')

/** Strip comments so the deviation NOTE that names the upstream call is not read as code. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

test('a single shell never disposes the page-level shared module system', () => {
  assert.doesNotMatch(codeOnly(source), /this\.modules\??\.dispose\(\)/u,
    'the shared module system must survive one shell dispose (page teardown owns it)')
})

test('dispose still tears down the per-shell ctx fiber before the page', () => {
  const disposeBody = source.slice(source.indexOf('async dispose(): Promise<void>'))
  assert.match(disposeBody, /await ctx\.fiber\.dispose\(\)/u,
    'the per-shell loader/plugin tree is still disposed')
  assert.ok(disposeBody.indexOf('ctx.fiber.dispose()') < disposeBody.indexOf('this.page.dispose()'),
    'the page is released after the plugin tree')
})

test('the install-or-reuse seam stays the one module-system owner', () => {
  assert.match(source, /export function ensureWebModuleSystem\(/u)
  assert.match(source, /win\.__DSH_MODULES__ = modules/u)
  assert.match(source, /const shared = win\.__DSH_MODULES__\s*\n\s*if \(shared !== undefined\) return shared/u,
    'later shells must adopt the parked page-level system, never create a second one')
})
