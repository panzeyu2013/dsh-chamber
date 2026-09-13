/**
 * 2026-09 "batch 1 — pure visual consistency" locks for this package.
 *
 * SOURCE-TEXT locks (comments stripped first, so prose can never satisfy one).
 * `rule()` matches a WHOLE selector list (a decoy compound rule cannot be
 * mistaken for the base rule); `pin()` asserts the EFFECTIVE declaration (last
 * wins) and rejects competing longhands, so a later `padding-left`/`height`
 * override fails the lock.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) { if (ch === '\n') { line = false; out += ch } else out += ' '; continue }
    if (block) { if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '; continue }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

// The CSS lives in a template literal, so its own `/* … */` comments survive the
// TypeScript comment stripper; strip them here or a comment's first colon would
// be read as the declaration separator.
const flat = stripComments(readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\s+/g, ' ')

function ruleBodies(selector: string): string | undefined {
  const bodies: string[] = []
  for (const match of flat.matchAll(/([^{}]*?)\s*\{([^{}]*)\}/g)) {
    const parts = match[1].split(/,(?![^(]*\))/).map((part) => part.trim())
    // Push the raw contents and re-join with `;`: gluing whole bodies would fuse
    // the previous body's `}` with the next declaration's property name.
    if (parts.includes(selector)) bodies.push(match[2].trim())
  }
  return bodies.length === 0 ? undefined : `{${bodies.join('; ')}}`
}

function rule(selector: string): string {
  // Cascade order: EVERY rule whose selector list contains this selector, merged
  // last-wins (see the batch-2 lock for the long form of this rationale).
  const merged = ruleBodies(selector)
  assert.notEqual(merged, undefined, `${selector} must exist as a selector`)
  return merged as string
}

function decls(body: string): [string, string][] {
  return body.slice(body.indexOf('{') + 1).split(';')
    .map((entry) => entry.trim()).filter((entry) => entry.includes(':'))
    .map((entry) => {
      const at = entry.indexOf(':')
      return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()] as [string, string]
    })
}

const COMPETING: Record<string, RegExp> = {
  border: /^border-(?!radius$)(color|style|width|top|right|bottom|left|block|inline)/,
  padding: /^padding-/,
  margin: /^margin-/,
  height: /^(?:min|max)-height$/,
  width: /^(?:min|max)-width$/,
}

function pin(item: string, selector: string, wanted: Record<string, string>): void {
  const body = rule(selector)
  for (const [property, value] of Object.entries(wanted)) {
    const hits = decls(body).filter(([name]) => name === property)
    assert.equal(hits.length > 0 ? hits[hits.length - 1][1] : undefined, value,
      `${item}: ${selector} must effectively declare ${property}: ${value}`)
    const pattern = COMPETING[property]
    if (pattern !== undefined) {
      assert.deepEqual(decls(body).filter(([name]) => pattern.test(name)).map(([n, v]) => `${n}: ${v}`), [],
        `${item}: ${selector} must not add a competing ${property} declaration`)
    }
  }
}

const artifact = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('H2: the drawer toggle is the official rail circle, in SOURCE', () => {
  pin('H2 source', '.dsh-mobile-nav-toggle', {
    width: '44px',
    height: '44px',
    'border-radius': '50%',
    'corner-shape': 'round',
  })
})

test('H2: the committed client artifact carries the same rule (source/artifact lockstep)', () => {
  // `exports["./client"]` points at lib/client.js and the gateway seeds that file
  // byte for byte, so a source-only change ships nothing. This lock is what the
  // 2026-09 batch 1 miss (a stale 12px artifact) would have caught without a
  // rebuild: it pins the SHIPPED bytes, not the source.
  assert.ok(artifact.includes('border-radius: 50%'), 'lib/client.js must ship the 50% toggle radius')
  assert.ok(artifact.includes('corner-shape: round'), 'lib/client.js must ship the paired corner-shape')
  const toggle = artifact.slice(artifact.indexOf('.dsh-mobile-nav-toggle {'), artifact.indexOf('}', artifact.indexOf('.dsh-mobile-nav-toggle {')))
  assert.equal(toggle.includes('border-radius: 12px'), false, 'the retired 12px square must not survive in the artifact')
})
