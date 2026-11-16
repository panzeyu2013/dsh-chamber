/**
 * New Session row geometry lock (rc.3 sync: the `sidebar.session.action` HOC slot).
 *
 * The shell's New-session button and any occupant's controls share ONE flex row;
 * the renderer inserts its `display: contents` `[data-slot]` anchor between the
 * row and the content, so the row's flex children are the buttons themselves and
 * no wrapper box joins the row. These values are what lets an occupant's square
 * control (36px rail / 38px wide, e.g. deepseek-chat-import's import trigger) sit
 * beside the button; they follow upstream rc.3's layout but keep chamber's own
 * rhythm (2px inset / 12px below).
 *
 * Two upstream rules are deliberately NOT copied: the `.railIn …` entrance
 * animation selectors (chamber retired the whole entrance-animation group; see
 * `sidebar-entrance-visibility.test.ts`) and the Windows
 * `[data-windows-titlebar]` row margin (that leg is frozen and the copy is
 * archived). A bare `.newSessionRow > *` rule is
 * forbidden too: it only matches the renderer's boxless anchor, so it would look
 * wired while animating nothing (upstream's own sidebar-styles spec locks this).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../../src/client/SidebarRoot.module.css', import.meta.url), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 *
 * The lock must read the block that actually wins the cascade. A selector declared
 * twice (a later block overrides the first) or declared inside an at-rule (a
 * conditional override the single-map lock cannot model) refuses loudly instead of
 * silently reading the wrong declaration; the guard itself is self-tested below so it
 * cannot rot into a vacuous lock.
 * @param source - stylesheet text (comments are stripped for parsing).
 * @param selector - exact selector text (one part of a comma list).
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(source: string, selector: string): Map<string, string> | undefined {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // Spans of at-rule blocks (`@media { … }`): a matching rule inside one is conditional.
  const atRules: Array<[number, number]> = []
  for (const header of withoutComments.matchAll(/@[a-z-]+[^{}]*\{/gu)) {
    const open = (header.index ?? 0) + header[0].length - 1
    let depth = 0
    for (let at = open; at < withoutComments.length; at += 1) {
      if (withoutComments[at] === '{') depth += 1
      else if (withoutComments[at] === '}') {
        depth -= 1
        if (depth === 0) {
          atRules.push([header.index ?? 0, at])
          break
        }
      }
    }
  }
  const blocks: Array<Map<string, string>> = []
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectorList = match[1] ?? ''
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const at = match.index ?? 0
    if (atRules.some(([start, end]) => at > start && at < end)) {
      throw new Error(`selector ${selector} is declared inside an at-rule; a conditional override cannot be locked by one declaration map`)
    }
    const found = new Map<string, string>()
    for (const part of (match[2] ?? '').split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    blocks.push(found)
  }
  if (blocks.length > 1) {
    throw new Error(`selector ${selector} is declared ${blocks.length} times; a later block wins the cascade and this lock would read the wrong one`)
  }
  return blocks[0]
}

test('the CSS helper refuses duplicate and at-rule declarations (lock integrity self-test)', () => {
  // The guard must be provable on synthetic text, otherwise a future stylesheet edit can
  // turn every geometry assertion below into a read of a dead block.
  assert.equal(declarations('.a { gap: 6px; }', '.a')?.get('gap'), '6px')
  assert.equal(declarations('.a { gap: 6px; }', '.b'), undefined, 'an absent selector still answers undefined')
  assert.throws(() => declarations('.a { gap: 6px; } .a { gap: 20px; }', '.a'), /declared 2 times/u,
    'a later duplicate wins the cascade, so the lock must refuse instead of reading the first block')
  assert.throws(() => declarations('@media (min-width: 100px) { .a { gap: 20px; } }', '.a'), /inside an at-rule/u,
    'a conditional override is invisible to a single-map lock')
  assert.throws(() => declarations('.a, .b { gap: 6px; } .b { gap: 4px; }', '.b'), /declared 2 times/u,
    'comma-list membership counts as a declaration of the selector')
  assert.equal(declarations('.a,\n .b { gap: 6px; }', '.b')?.get('gap'), '6px', 'a newline inside the selector list still parses')
})

test('the New Session row is one flex row with chamber rhythm and a growable button', () => {
  const row = declarations(css, '.newSessionRow')
  assert.ok(row !== undefined, '.newSessionRow must exist: the HOC slot needs a row (without one the button leaves its column slot)')
  assert.equal(row.get('flex'), 'none', 'the row is a fixed block in the column, it does not grow with the region')
  assert.equal(row.get('display'), 'flex')
  assert.equal(row.get('align-items'), 'center')
  assert.equal(row.get('gap'), '6px', 'an occupant control sits 6px beside the button (upstream rc.3 row gap)')
  assert.equal(row.get('margin'), '0 2px 12px', 'chamber rhythm: 2px horizontal inset, 12px below (own geometry)')

  const button = declarations(css, '.newSession')
  assert.ok(button !== undefined, '.newSession must exist')
  assert.equal(button.get('flex'), '1 1 auto', 'the button takes the width the occupant leaves')
  assert.equal(button.get('min-width'), '0', 'a min-content floor would push the occupant control out of the row')
  assert.equal(button.get('margin'), '0', 'the ROW owns the outside rhythm now (a button margin would double it)')
  assert.equal(button.get('height'), '38px', 'the wide bar keeps its 38px capsule')
  assert.equal(button.get('container-type'), 'inline-size', 'the label mask still resolves 100cqw against the button')
})

test('the rail stacks an occupant’s controls under the 36px icon control', () => {
  const row = declarations(css, '.collapsed .newSessionRow')
  assert.ok(row !== undefined, '.collapsed .newSessionRow must exist: the rail is a column again')
  assert.equal(row.get('flex-direction'), 'column')
  assert.equal(row.get('align-items'), 'flex-start')
  assert.equal(row.get('gap'), '4px')
  assert.equal(row.get('margin'), '0 0 12px', 'the rail keeps its bottom rhythm and no horizontal inset')

  const button = declarations(css, '.collapsed .newSession')
  assert.ok(button !== undefined, '.collapsed .newSession must exist')
  assert.equal(button.get('flex'), 'none', 'a plain 36px control, not a growable row item')
  assert.equal(button.get('width'), '36px')
  assert.equal(button.get('height'), '36px')
  assert.equal(button.get('margin'), '0', 'the row owns the rail rhythm too')
  assert.equal(button.has('align-self'), false, 'the row\'s align-items owns the rail anchor (a leftover align-self would restate it)')
})

test('no bare star, entrance animation or frozen-leg rule may reach the slot anchor', () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // `.newSessionRow > *` matches the renderer's boxless display:contents anchor, so
  // such a selector animates/hides nothing while looking wired.
  assert.doesNotMatch(withoutComments, /\.newSessionRow\s*>\s*\*/u,
    'a bare star under the row only matches the boxless anchor — never wire it')
  // Chamber retired its entrance-animation group; the row carries no animation.
  assert.doesNotMatch(withoutComments, /\.newSessionRow[^{}]*\{[^}]*animation:/u,
    'the row keeps no entrance animation (chamber has none to begin with)')
  assert.doesNotMatch(withoutComments, /\[data-windows-titlebar\][^{}]*\.newSessionRow/u,
    'the Windows titlebar row margin is frozen-leg upstream, deliberately not copied')
})
