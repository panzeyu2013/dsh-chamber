/**
 * Startup upstream plugin rows — planner/renderer unit suite (Swift single-Node scope).
 *
 * Covers the Swift implementation contract (swift-impl-contract.md):
 *   - planStartupPluginRows: two independent resource gates (primary-runtime payload /
 *     office-skills assets + the ACTIVE workspace installs the plugin package), the
 *     platform/arch pin, the payload Node passed when present (payload python-only →
 *     omitted, process.execPath fallback), the workspace CLI present→path / absent→
 *     `cli: false` decision, the pnpm SOURCE layout (apps/cli/node_modules) next to the
 *     installed layout, the user-profile reuse skip, and the absent-capabilities /
 *     relative-root edges;
 *   - renderStartupPluginInserts: golden bytes of the second top-level `- insert:`
 *     patch object, YAML single-quote escaping, and every loud rejection (allowlist,
 *     config key whitelist, required keys, absolute/control-free values, duplicates).
 *
 * Pure node (node:fs/node:path + the local parser): runs under
 * `node --experimental-strip-types packages/control-plane/test/plugins/startup-plugin-rows.test.ts`
 * without node_modules.
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  STARTUP_PLUGIN_ROWS,
  planStartupPluginRows,
  renderStartupPluginInserts,
  type StartupPluginRow,
} from '../../src/startup-plugin-rows.ts'
import type { PlanStartupPluginRowsInput } from '../../src/startup-plugin-rows.ts'

const WORKSPACE_DEPS = STARTUP_PLUGIN_ROWS.workspaceDependencies
const OFFICE_SKILLS = STARTUP_PLUGIN_ROWS.officeSkills

const OFFICE_SKILL_NAMES = [
  'office',
  'office-docx',
  'office-pptx',
  'office-xlsx',
  'office-render',
  'office-recalculate',
  'office-export-pdf',
] as const

type WorkspaceLayout = 'installed' | 'source'

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cp-startup-rows-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(absolutePath: string, content = ''): void {
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

/** The workspace package anchor of a layout: installed runtime tree vs pnpm source tree. */
function packageAnchor(workspacePath: string, layout: WorkspaceLayout): string {
  return layout === 'installed'
    ? join(workspacePath, 'node_modules')
    : join(workspacePath, 'apps', 'cli', 'node_modules')
}

/** Write one scoped package (package.json only) under a workspace anchor. */
function writeWorkspacePackage(anchor: string, packageName: string): void {
  const [scope, name] = packageName.split('/')
  write(join(anchor, scope as string, name as string, 'package.json'), JSON.stringify({ name: packageName }))
}

interface FixtureOptions {
  /** Default 'installed'; 'source' puts every package under <workspace>/apps/cli/node_modules. */
  layout?: WorkspaceLayout
  /** Default true: write both workspace package manifests. */
  workspaceDependenciesPackage?: boolean
  skillOfficePackage?: boolean
  /** Default true: write <anchor>/@deepseek-ai/libreoffice-kit/lib/cli.js. */
  libreofficeKitCli?: boolean
  /** Default true: create the primary-runtime payload dir. */
  primaryRuntime?: boolean
  /** `null` omits runtime.json; a string replaces the default manifest. */
  runtimeJson?: string | null
  /** Default true: dependencies/python/bin/python3 file + lib/python3.12/site-packages dir. */
  pythonPayload?: boolean
  /** Default true: the payload carries dependencies/node/bin/node (Swift full payload). */
  payloadNode?: boolean
  /** Default true: create the seven skill dirs + office/references/sidecar.md. */
  officeSkills?: boolean
  /** Skip one skill's SKILL.md (the assets tree is then incomplete). */
  missingSkill?: string
}

interface Fixture {
  root: string
  workspacePath: string
  dshHome: string
  primaryRuntimeDir: string
  officeSkillsDir: string
  cliPath: string
  capabilities: { primaryRuntimeDir: string; officeSkillsDir: string }
}

function buildFixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const layout = options.layout ?? 'installed'
  const root = tempDir(t)
  const workspacePath = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  const primaryRuntimeDir = join(root, 'primary-runtime')
  const officeSkillsDir = join(root, 'office-skills')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  const anchor = packageAnchor(workspacePath, layout)
  // Real pnpm SOURCE layouts hoist libreoffice-kit into the skill package's own
  // node_modules; installed trees expose it directly under the workspace anchor.
  const cliPath = layout === 'source'
    ? join(anchor, '@deepseek-ai', 'dsh-skill-office', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
    : join(anchor, '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')

  if (options.workspaceDependenciesPackage !== false) writeWorkspacePackage(anchor, WORKSPACE_DEPS.name)
  if (options.skillOfficePackage !== false) writeWorkspacePackage(anchor, OFFICE_SKILLS.name)
  if (options.libreofficeKitCli !== false) write(cliPath, 'export {}\n')

  if (options.primaryRuntime !== false) {
    const runtimeJson = options.runtimeJson === undefined
      ? JSON.stringify({ platform: process.platform, arch: process.arch, components: { python: '3.12.14' } })
      : options.runtimeJson
    if (runtimeJson !== null) write(join(primaryRuntimeDir, 'runtime.json'), runtimeJson)
    if (options.pythonPayload !== false) {
      write(join(primaryRuntimeDir, 'dependencies', 'python', 'bin', 'python3'), '#!/usr/bin/env python3\n')
      mkdirSync(join(primaryRuntimeDir, 'dependencies', 'python', 'lib', 'python3.12', 'site-packages'), { recursive: true })
    }
    if (options.payloadNode !== false) {
      write(join(primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node'), '#!/usr/bin/env node\n')
    }
  }

  if (options.officeSkills !== false) {
    for (const skillName of OFFICE_SKILL_NAMES) {
      if (skillName === options.missingSkill) continue
      write(join(officeSkillsDir, skillName, 'SKILL.md'), `---\ndescription: ${skillName}\n---\n`)
    }
    write(join(officeSkillsDir, 'office', 'references', 'sidecar.md'), '# sidecar\n')
  }

  return {
    root,
    workspacePath,
    dshHome,
    primaryRuntimeDir,
    officeSkillsDir,
    cliPath,
    capabilities: { primaryRuntimeDir, officeSkillsDir },
  }
}

function plan(fixture: Fixture, overrides: Partial<PlanStartupPluginRowsInput> = {}): StartupPluginRow[] {
  return planStartupPluginRows({
    capabilities: fixture.capabilities,
    workspacePath: fixture.workspacePath,
    dshHome: fixture.dshHome,
    profilePatch: null,
    ...overrides,
  })
}

function identityOf(identity: { readonly id: string; readonly name: string }) {
  return { id: identity.id, name: identity.name }
}

// ---------------------------------------------------------------------------
// planner
// ---------------------------------------------------------------------------

test('planner: a complete Swift payload + assets emits both rows (installed workspace layout)', t => {
  const fixture = buildFixture(t)
  const rows = plan(fixture)
  assert.deepEqual(rows, [
    {
      ...identityOf(WORKSPACE_DEPS),
      config: {
        source: fixture.primaryRuntimeDir,
        root: join(fixture.dshHome, 'dsh-runtimes', 'dsh-primary-runtime'),
      },
    },
    {
      ...identityOf(OFFICE_SKILLS),
      config: {
        assetRoot: fixture.officeSkillsDir,
        node: join(fixture.primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node'),
        cli: fixture.cliPath,
      },
    },
  ])
})

test('planner: the pnpm SOURCE layout (apps/cli/node_modules) is a first-class workspace anchor', t => {
  const fixture = buildFixture(t, { layout: 'source' })
  const rows = plan(fixture)
  assert.deepEqual(rows.map(row => row.id), [WORKSPACE_DEPS.id, OFFICE_SKILLS.id],
    'source-layout dev workspaces must not silently miss the rows')
  const office = rows.find(row => row.id === OFFICE_SKILLS.id)
  assert.ok(office !== undefined)
  assert.equal(office!.config.cli, fixture.cliPath)
  assert.ok(fixture.cliPath.includes(join('apps', 'cli', 'node_modules')), fixture.cliPath)
  assert.ok(fixture.cliPath.includes(join('dsh-skill-office', 'node_modules')), fixture.cliPath)
})

test('planner: source layout without the package-internal kit CLI becomes cli: false', t => {
  const fixture = buildFixture(t, { layout: 'source', libreofficeKitCli: false })
  const rows = plan(fixture)
  const office = rows.find(row => row.id === OFFICE_SKILLS.id)
  assert.ok(office !== undefined)
  assert.equal(office!.config.cli, false, 'missing kit must be an explicit disabled capability')
})

test('planner: a missing runtime.json drops only the workspace-dependencies row (warned)', t => {
  const fixture = buildFixture(t, { runtimeJson: null })
  const warns: string[] = []
  const rows = plan(fixture, { warn: message => warns.push(message) })
  assert.deepEqual(rows.map(row => row.id), [OFFICE_SKILLS.id], 'the office row is independently gated')
  assert.equal(Object.hasOwn(rows[0]!.config, 'node'), false, 'a payload without runtime.json contributes no node')
  assert.ok(warns.some(message => message.includes(WORKSPACE_DEPS.id)), warns.join(' | '))
  assert.ok(warns.some(message => message.includes(WORKSPACE_DEPS.id) && message.includes('runtime.json is missing')), warns.join(' | '))
  assert.ok(warns.some(message => message.includes(OFFICE_SKILLS.id) && message.includes('node')), warns.join(' | '))
})

test('planner: a platform/arch mismatch drops the workspace-dependencies row', t => {
  const otherPlatform = process.platform === 'darwin' ? 'linux' : 'darwin'
  const fixture = buildFixture(t, {
    runtimeJson: JSON.stringify({ platform: otherPlatform, arch: process.arch }),
  })
  const warns: string[] = []
  const rows = plan(fixture, { warn: message => warns.push(message) })
  assert.deepEqual(rows.map(row => row.id), [OFFICE_SKILLS.id])
  assert.equal(Object.hasOwn(rows[0]!.config, 'node'), false,
    'office must not receive a node from a payload claiming another platform/arch')
  assert.ok(warns.some(message => message.includes('targets') && message.includes(process.platform)), warns.join(' | '))
})

test('planner: a payload without python3 or site-packages drops the workspace-dependencies row', t => {
  const missingPython = buildFixture(t, { pythonPayload: false })
  const pythonWarns: string[] = []
  const pythonRows = plan(missingPython, { warn: message => pythonWarns.push(message) })
  assert.deepEqual(pythonRows.map(row => row.id), [OFFICE_SKILLS.id])
  assert.ok(pythonWarns[0]!.includes('python3 is not a file'), pythonWarns[0])

  const hollow = buildFixture(t)
  rmSync(join(hollow.primaryRuntimeDir, 'dependencies', 'python', 'lib'), { recursive: true, force: true })
  const hollowWarns: string[] = []
  const hollowRows = plan(hollow, { warn: message => hollowWarns.push(message) })
  assert.deepEqual(hollowRows.map(row => row.id), [OFFICE_SKILLS.id])
  assert.ok(hollowWarns[0]!.includes('no pythonX.Y/site-packages directory'), hollowWarns[0])
})

test('planner: one missing office SKILL.md drops only the office row (no half assets)', t => {
  const fixture = buildFixture(t, { missingSkill: 'office-export-pdf' })
  const warns: string[] = []
  const rows = plan(fixture, { warn: message => warns.push(message) })
  assert.deepEqual(rows.map(row => row.id), [WORKSPACE_DEPS.id], 'the workspace-dependencies row is independently gated')
  assert.equal(warns.length, 1)
  assert.ok(warns[0]!.includes('office-export-pdf'), warns[0])
  assert.ok(warns[0]!.includes('SKILL.md is missing'), warns[0])
})

test('planner: a missing workspace CLI becomes the explicit cli: false (operations disabled)', t => {
  const fixture = buildFixture(t, { libreofficeKitCli: false })
  const rows = plan(fixture)
  const office = rows.find(row => row.id === OFFICE_SKILLS.id)
  assert.ok(office !== undefined)
  assert.equal(office!.config.cli, false)
  assert.equal(office!.config.node, join(fixture.primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node'),
    'the payload Node is still passed: only the Kit CLI is disabled')
})

test('planner: a python-only payload omits node (skill-office falls back to process.execPath)', t => {
  const fixture = buildFixture(t, { payloadNode: false })
  const rows = plan(fixture)
  const office = rows.find(row => row.id === OFFICE_SKILLS.id)
  assert.ok(office !== undefined)
  assert.equal(Object.hasOwn(office!.config, 'node'), false)
  assert.equal(office!.config.cli, fixture.cliPath)
})

test('planner: rows already mounted by the user profile patch are reused (skipped with a log)', t => {
  const fixture = buildFixture(t)
  const profilePatch = [
    '- insert:',
    `    - id: ${WORKSPACE_DEPS.id}`,
    `      name: '${WORKSPACE_DEPS.name}'`,
    '    - id: user-office-skills',
    `      name: '${OFFICE_SKILLS.name}'`,
    '',
  ].join('\n')
  const logs: string[] = []
  const rows = plan(fixture, { profilePatch, log: message => logs.push(message) })
  assert.deepEqual(rows, [], 'a duplicated loader identity would fail the next boot')
  assert.equal(logs.length, 2)
  assert.ok(logs.every(message => message.includes('already mounted by the user profile patch')))
})

test('planner: absent capabilities emit no row and no diagnostic', t => {
  const fixture = buildFixture(t)
  const logs: string[] = []
  const warns: string[] = []
  const rows = planStartupPluginRows({
    workspacePath: fixture.workspacePath,
    dshHome: fixture.dshHome,
    profilePatch: null,
    log: message => logs.push(message),
    warn: message => warns.push(message),
  })
  assert.deepEqual(rows, [])
  assert.deepEqual(logs, [])
  assert.deepEqual(warns, [])
})

test('planner: a workspace installing neither package drops both rows (warned)', t => {
  const fixture = buildFixture(t, {
    layout: 'source',
    workspaceDependenciesPackage: false,
    skillOfficePackage: false,
  })
  const warns: string[] = []
  const rows = plan(fixture, { warn: message => warns.push(message) })
  assert.deepEqual(rows, [])
  assert.equal(warns.length, 2)
  assert.ok(warns.some(message => message.includes(WORKSPACE_DEPS.name)), warns.join(' | '))
  assert.ok(warns.some(message => message.includes(OFFICE_SKILLS.name)), warns.join(' | '))
  assert.ok(warns.every(message => message.includes('does not install')), warns.join(' | '))
})

test('planner: relative capability roots throw (programming error, never a silent skip)', t => {
  const fixture = buildFixture(t)
  assert.throws(
    () => planStartupPluginRows({
      capabilities: { primaryRuntimeDir: 'primary-runtime' },
      workspacePath: fixture.workspacePath,
      dshHome: fixture.dshHome,
      profilePatch: null,
    }),
    /primaryRuntimeDir must be an absolute path/,
  )
  assert.throws(
    () => planStartupPluginRows({
      capabilities: { officeSkillsDir: '../office-skills' },
      workspacePath: fixture.workspacePath,
      dshHome: fixture.dshHome,
      profilePatch: null,
    }),
    /officeSkillsDir must be an absolute path/,
  )
})

test('planner: a relative workspacePath is diagnosed and emits nothing (no cwd-relative accident)', t => {
  const fixture = buildFixture(t)
  const warns: string[] = []
  const rows = planStartupPluginRows({
    capabilities: fixture.capabilities,
    workspacePath: 'relative/workspace',
    dshHome: fixture.dshHome,
    profilePatch: null,
    warn: message => warns.push(message),
  })
  assert.deepEqual(rows, [])
  assert.equal(warns.length, 1)
  assert.ok(warns[0]!.includes('workspacePath is not an absolute path'), warns[0])
})

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

test('renderer: golden bytes — the second top-level insert object, fixed key order, trailing newline', t => {
  const fixture = buildFixture(t)
  const expected = [
    '- insert:',
    `    - id: ${WORKSPACE_DEPS.id}`,
    `      name: '${WORKSPACE_DEPS.name}'`,
    '      config:',
    `        source: '${fixture.primaryRuntimeDir}'`,
    `        root: '${join(fixture.dshHome, 'dsh-runtimes', 'dsh-primary-runtime')}'`,
    `    - id: ${OFFICE_SKILLS.id}`,
    `      name: '${OFFICE_SKILLS.name}'`,
    '      config:',
    `        assetRoot: '${fixture.officeSkillsDir}'`,
    `        node: '${join(fixture.primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node')}'`,
    `        cli: '${fixture.cliPath}'`,
    '',
  ].join('\n')
  const text = renderStartupPluginInserts(plan(fixture))
  assert.equal(text, expected)
  assert.ok(text.endsWith('\n'))
})

test('renderer: a missing CLI row renders the literal cli: false', t => {
  const fixture = buildFixture(t, { libreofficeKitCli: false })
  const text = renderStartupPluginInserts(plan(fixture))
  assert.ok(text.includes(`        assetRoot: '${fixture.officeSkillsDir}'\n`), text)
  assert.ok(text.includes('        cli: false\n'), text)
})

test('renderer: zero rows render the empty string (no overlay block at all)', () => {
  assert.equal(renderStartupPluginInserts([]), '')
})

test('renderer: single-quoted YAML scalars double an embedded quote', () => {
  const text = renderStartupPluginInserts([{
    ...identityOf(WORKSPACE_DEPS),
    config: { source: "/tmp/o'brien/runtime", root: '/tmp/root' },
  }])
  assert.ok(text.includes("        source: '/tmp/o''brien/runtime'\n"), text)
})

test('renderer: invalid rows throw (allowlist, config keys, required keys, values, duplicates)', () => {
  const validConfig = { source: '/tmp/runtime', root: '/tmp/root' }
  const invalid: Array<[string, StartupPluginRow | StartupPluginRow[], RegExp]> = [
    ['unknown id', { id: 'chamber-other', name: '@deepseek-ai/other', config: {} }, /not on the allowlist/],
    ['wrong name', { ...identityOf(WORKSPACE_DEPS), name: '@deepseek-ai/not-the-tool', config: validConfig }, /must be named/],
    ['unknown config key', { ...identityOf(WORKSPACE_DEPS), config: { ...validConfig, extra: '/tmp/x' } }, /config key 'extra' is not allowed/],
    ['missing required key', { ...identityOf(WORKSPACE_DEPS), config: { source: '/tmp/runtime' } }, /missing required key 'root'/],
    ['relative value', { ...identityOf(WORKSPACE_DEPS), config: { source: 'runtime', root: '/tmp/root' } }, /must be an absolute path/],
    ['control character', { ...identityOf(WORKSPACE_DEPS), config: { source: '/tmp/a\nb', root: '/tmp/root' } }, /contains a control character/],
    ['false outside cli', { ...identityOf(WORKSPACE_DEPS), config: { source: '/tmp/runtime', root: false } }, /may only be a string or cli: false/],
    ['duplicate row', [
      { ...identityOf(WORKSPACE_DEPS), config: validConfig },
      { ...identityOf(WORKSPACE_DEPS), config: validConfig },
    ], /duplicate overlay row/],
  ]
  for (const [label, rows, pattern] of invalid) {
    assert.throws(
      () => renderStartupPluginInserts(Array.isArray(rows) ? rows : [rows]),
      pattern,
      label,
    )
  }
})
