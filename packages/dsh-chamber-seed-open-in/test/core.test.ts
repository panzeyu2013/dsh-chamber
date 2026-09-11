/**
 * Domain tests for the chamber open-in host fork (design 20 §6).
 *
 * WHAT IS PINNED HERE — the fork's two divergences plus the wire-level domain
 * contract of `./core.ts`:
 *   1. no SSH dormancy gate (upstream returns an EMPTY catalog whenever the
 *      launch environment carries `SSH_CONNECTION`/`SSH_TTY`, which is exactly
 *      the marker chamber pins on its managed local instance);
 *   2. no route/trust layer: the untrusted inputs are a catalog id and an
 *      absolute directory, validated here before any host work.
 *
 * WHAT IS DELIBERATELY NOT RE-TESTED — upstream's own catalog/launcher/icon
 * extraction behaviour: `src/catalog.ts`, `src/resolver.ts` and `src/icons.ts`
 * are byte-identical to the pinned upstream revision (the fork gate
 * `scripts/dev/verify-upstream-touchpoints.mjs` → FORKS C1 fails on any drift),
 * and upstream covers them in its own suite. The fixtures below therefore drive
 * detection through injected platform facts (a temp "Applications" root, a temp
 * XDG data dir) and never through this machine's real applications.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_IN_APP_CATALOG } from '../src/catalog.ts'
import { OpenInAppCore, OpenInAppError, domainResult } from '../src/core.ts'
import type { OpenInAppInternals } from '../src/resolver.ts'

/** One 1×1 PNG: the smallest thing `readIconFile` accepts as an icon. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** A temp root plus the hermetic internals built on it. */
interface Fixture {
  readonly root: string
  readonly internals: OpenInAppInternals
}

/**
 * Create an isolated root and register its removal.
 * @param t - the test context (owns the cleanup).
 * @returns the root path.
 */
async function makeRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chamber-open-in-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

/**
 * A darwin host whose only application root is a temp directory: the catalog's
 * `fixed` entries (Terminal) resolve, every `macApp` entry (VS Code, Cursor, …)
 * does not, and nothing on this machine leaks into the answer.
 */
async function darwinFixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  const root = await makeRoot(t)
  const applications = join(root, 'Applications')
  await mkdir(applications, { recursive: true })
  return {
    root,
    internals: { platform: 'darwin', applicationRoots: [applications], home: root, env: {} },
  }
}

/**
 * A linux host with one installed application: `kitty` resolves through the
 * injected PATH resolver, and its icon comes from a temp XDG desktop entry
 * pointing at a real (tiny) PNG — no host command is ever run.
 */
async function linuxFixture(
  t: { after: (fn: () => Promise<void>) => void },
  options: { readonly icon: boolean } = { icon: true },
): Promise<Fixture & { readonly executable: string }> {
  const root = await makeRoot(t)
  const applications = join(root, 'applications')
  const iconPath = join(root, 'kitty.png')
  await mkdir(applications, { recursive: true })
  await writeFile(iconPath, PNG_BYTES)
  await writeFile(
    join(applications, 'kitty.desktop'),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=kitty',
      'Exec=kitty',
      ...(options.icon ? [`Icon=${iconPath}`] : ['Icon=']),
      '',
    ].join('\n'),
    'utf8',
  )
  const executable = join(root, 'bin', 'kitty')
  return {
    root,
    executable,
    internals: {
      platform: 'linux',
      applicationRoots: [],
      home: root,
      env: { XDG_DATA_HOME: root, XDG_DATA_DIRS: root, PATH: join(root, 'bin') },
    },
  }
}

/** A core over the fixture, with `kitty` as the only resolvable executable. */
function linuxCore(fixture: Fixture & { readonly executable: string }): {
  readonly core: OpenInAppCore
  calls: string[]
} {
  const calls: string[] = []
  const core = new OpenInAppCore({
    host: {
      platform: 'linux',
      resolveExecutable: async (name) => {
        calls.push(name)
        return name === 'kitty' ? fixture.executable : null
      },
    },
    internals: fixture.internals,
  })
  return { core, calls }
}

test('probe answers the platform without any host work', async (t) => {
  const fixture = await darwinFixture(t)
  let probes = 0
  const core = new OpenInAppCore({
    host: {
      platform: 'darwin',
      resolveExecutable: async () => {
        probes += 1
        return null
      },
    },
    internals: fixture.internals,
  })

  assert.deepEqual(core.probe(), { platform: 'darwin' })
  assert.equal(probes, 0, 'the activation probe must not touch the filesystem or spawn anything')
})

test('apps serves the resolved catalog in menu order', async (t) => {
  const fixture = await darwinFixture(t)
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: fixture.internals,
  })

  const { apps } = await core.apps()
  assert.ok(apps.includes('terminal'), `expected the fixed Terminal entry, got ${apps.join(',')}`)
  assert.ok(!apps.includes('vscode'), 'a macApp entry must not resolve without its bundle on disk')
  assert.deepEqual(
    apps,
    OPEN_IN_APP_CATALOG.map(app => app.id).filter(id => apps.includes(id)),
    'apps() must answer catalog order (menu order)',
  )
})

test('apps resolves the catalog on a host launched through ssh', async (t) => {
  // The regression this fork exists for: chamber pins SSH_CONNECTION on its
  // managed local instance as the directory-picker pin (design 02 §3.1/§3.9),
  // and upstream's host half answers an EMPTY catalog under that marker
  // (src/index.ts:139, resolver.ts:656-667). The fork never reads it.
  const fixture = await darwinFixture(t)
  const before = { ssh: process.env.SSH_CONNECTION, tty: process.env.SSH_TTY }
  process.env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0'
  process.env.SSH_TTY = '/dev/ttys001'
  t.after(() => {
    if (before.ssh === undefined) delete process.env.SSH_CONNECTION
    else process.env.SSH_CONNECTION = before.ssh
    if (before.tty === undefined) delete process.env.SSH_TTY
    else process.env.SSH_TTY = before.tty
  })

  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: fixture.internals,
  })
  const { apps } = await core.apps()
  assert.ok(apps.includes('terminal'), 'the SSH launch marker must not gate the catalog')
})

test('icon answers the application icon as base64 with its media type', async (t) => {
  const fixture = await linuxFixture(t)
  const { core } = linuxCore(fixture)

  const icon = await core.icon('kitty')
  assert.equal(icon.mime, 'image/png')
  assert.deepEqual(Buffer.from(icon.dataBase64, 'base64'), PNG_BYTES)
})

test('icon rejects an unknown application and an uninstalled one', async (t) => {
  const fixture = await linuxFixture(t)
  const { core } = linuxCore(fixture)

  await assert.rejects(core.icon('not-an-app'), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'unknown-app')
    return true
  })
  await assert.rejects(core.icon('vscode'), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'unavailable-app')
    return true
  })
})

test('icon reports icon-unavailable when the application ships no artwork', async (t) => {
  const fixture = await linuxFixture(t, { icon: false })
  const { core } = linuxCore(fixture)

  await assert.rejects(core.icon('kitty'), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'icon-unavailable')
    return true
  })
})

test('open launches the catalog argv with the workspace directory', async (t) => {
  const fixture = await darwinFixture(t)
  const launched: Array<{ command: string; args: readonly string[] }> = []
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: {
      ...fixture.internals,
      launch: async (command, args) => { launched.push({ command, args }) },
    },
  })

  await core.open('terminal', fixture.root)
  assert.deepEqual(launched, [{ command: 'open', args: ['-a', 'Terminal', fixture.root] }])
})

test('open rejects an unknown application before touching the path', async (t) => {
  const fixture = await darwinFixture(t)
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: fixture.internals,
  })

  await assert.rejects(core.open('not-an-app', '/'), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'unknown-app')
    return true
  })
})

test('open rejects an application that is not installed on this host', async (t) => {
  const fixture = await darwinFixture(t)
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: fixture.internals,
  })

  await assert.rejects(core.open('vscode', fixture.root), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'unavailable-app')
    return true
  })
})

test('open rejects a relative path, a missing directory and a file', async (t) => {
  const fixture = await darwinFixture(t)
  const file = join(fixture.root, 'not-a-directory')
  await writeFile(file, 'x', 'utf8')
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: fixture.internals,
  })

  const cases: ReadonlyArray<readonly [unknown, string]> = [
    ['relative/path', 'invalid-path'],
    ['', 'invalid-path'],
    [42, 'invalid-path'],
    [join(fixture.root, 'does-not-exist'), 'directory-missing'],
    [file, 'directory-missing'],
  ]
  for (const [path, code] of cases) {
    await assert.rejects(core.open('terminal', path), (error: unknown) => {
      assert.ok(error instanceof OpenInAppError)
      assert.equal(error.code, code, `path ${JSON.stringify(path)}`)
      return true
    })
  }
})

test('open refreshes a vanished launcher once and retries', async (t) => {
  const fixture = await darwinFixture(t)
  let attempts = 0
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: {
      ...fixture.internals,
      launch: async () => {
        attempts += 1
        throw Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' })
      },
    },
  })

  await assert.rejects(core.open('terminal', fixture.root), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'launch-failed')
    assert.equal(error.retryable, true)
    return true
  })
  assert.equal(attempts, 2, 'a missing executable re-resolves the entry and retries exactly once')
})

test('open does not retry a launcher that failed for another reason', async (t) => {
  const fixture = await darwinFixture(t)
  let attempts = 0
  const core = new OpenInAppCore({
    host: { platform: 'darwin', resolveExecutable: async () => null },
    internals: {
      ...fixture.internals,
      launch: async () => {
        attempts += 1
        throw new Error('launcher exited with code 3')
      },
    },
  })

  await assert.rejects(core.open('terminal', fixture.root), (error: unknown) => {
    assert.ok(error instanceof OpenInAppError)
    assert.equal(error.code, 'launch-failed')
    return true
  })
  assert.equal(attempts, 1)
})

test('domainResult carries known failures and rethrows the rest', async () => {
  const carried = await domainResult(async () => {
    throw new OpenInAppError('unknown-app', 'nope')
  })
  assert.deepEqual(carried, { ok: false, error: { code: 'unknown-app', message: 'nope' } })

  const retryable = await domainResult(async () => {
    throw new OpenInAppError('launch-failed', 'gone', true)
  })
  assert.deepEqual(retryable, { ok: false, error: { code: 'launch-failed', message: 'gone', retryable: true } })

  const ok = await domainResult(async () => ({ apps: ['finder'] }))
  assert.deepEqual(ok, { ok: true, value: { apps: ['finder'] } })

  const internal = new Error('programming failure')
  await assert.rejects(domainResult(async () => { throw internal }), (error: unknown) => error === internal)
})
