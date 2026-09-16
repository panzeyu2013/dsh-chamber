/**
 * Vendor-contract lockstep for the page-language ownership fix (design 06 §4.6
 * 「页面语言归属」; registry row: docs/checklists/upstream-touchpoints.md §4).
 *
 * `locale-ownership.ts` is correct only because of facts it MIRRORS from two
 * pinned vendor packages, and no other gate in this repository reads them:
 *
 *  1. `@deepseek-ai/dsh-client-locale` still provides the `locale` service and
 *     installs its face into the slot service (`installLocale`) — the two doors
 *     `resolveLocaleFace` opens;
 *  2. that plugin still binds the settings namespace literal `'locale'` through
 *     `settingsScope.bind({ namespace: LOCALE_SETTINGS_NAMESPACE })` — the scope
 *     identity the hook binds;
 *  3. it subscribes its document writer to its own face BEFORE the immediate
 *     `sync()` that follows `provide` — the ordering that lets the mount hook
 *     restore the activation write in the SAME synchronous task;
 *  4. `@deepseek-ai/dsh-client-ui-settings` still starts a per-namespace scope at
 *     status `'loading'` exactly when the host has not answered and settles to
 *     `'ready'` / `'unavailable'` — the hook's settled gate is
 *     `status !== 'loading'`.
 *
 * Drift in (4) silently RE-INTRODUCES the reported flicker (an unresolved
 * provisional treated as settled) with every fake-driven test still green; drift
 * in (3) weakens the same-task restore to a backstop microtask. Both are pin-bump
 * events, so they are pinned here against the vendor SOURCE (read-only, like the
 * roster audit in test/lifecycle/required-extra-rows.test.ts).
 *
 * Anchors are identifier- and literal-level and whitespace-agnostic on purpose:
 * the source in the pinned tree is what CI reads, and this spec must survive
 * formatting. A MISSING vendor tree (submodule not bootstrapped) is a loud
 * failure, not a skip — the anchors ARE the contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalize, stripComments } from '../support/source-text.ts'

/** `vendor/harness-packages/@deepseek-ai/` — the pinned, read-only vendor tree. */
const VENDOR_ROOT = fileURLToPath(
  new URL('../../../../vendor/harness-packages/@deepseek-ai/', import.meta.url),
)

/**
 * The package's CLIENT source as one comment-free, whitespace-normalized
 * projection. The client subtree (or `src` when the package has no split) is
 * walked recursively, so the anchors do not depend on a file name.
 * @param packageId - the `@deepseek-ai/*` package directory under the vendor root.
 * @returns the projection to match the mirrored anchors against.
 */
function vendorClientProjection(packageId: string): string {
  const root = join(VENDOR_ROOT, packageId)
  assert.ok(
    existsSync(root),
    `${packageId}: vendor tree missing at ${root} — bootstrap it with scripts/dev/ensure-harness-vendor.mjs`,
  )
  const srcRoot = join(root, 'src')
  const clientRoot = existsSync(join(srcRoot, 'client')) ? join(srcRoot, 'client') : srcRoot
  assert.ok(existsSync(clientRoot), `${packageId}: no client source under ${clientRoot}`)
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests') continue
        walk(path)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue
      files.push(path)
    }
  }
  walk(clientRoot)
  // 共享契约常量住在 src/ 顶层、而不是 src/client 里：`locale-settings.ts` 定义
  // LOCALE_SETTINGS_NAMESPACE（client 与 host 两侧同读），只走 src/client 会漏掉本
  // 文件镜像的命名空间锚（2026-12 合并 server-name-flash 后实测的漂移）。顶层只取
  // *.ts/*.tsx，不下潜 src/locales/ 等纯文案目录。
  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue
    const path = join(srcRoot, entry.name)
    if (!files.includes(path)) files.push(path)
  }
  assert.ok(files.length > 0, `${packageId}: no client source files under ${clientRoot}`)
  return normalize(stripComments(files.map(path => readFileSync(path, 'utf8')).join('\n')))
}

test('the locale plugin still publishes the faces the ownership hook reads', () => {
  const locale = vendorClientProjection('dsh-client-locale')
  // Door 1: the service name resolveLocaleFace asks cordis for.
  assert.match(locale, /provide\s*\(\s*['"]locale['"]/, 'the `locale` service name the hook reads')
  // Door 2: the slot-installed face (read through slots.hostFace().locale).
  assert.match(locale, /slots\s*\.\s*installLocale\s*\(/, 'the slot-installed locale face')
  // The namespace identity the hook binds its settings scope with.
  assert.match(
    locale,
    /LOCALE_SETTINGS_NAMESPACE\s*=\s*['"]locale['"]/,
    "the namespace literal 'locale' mirrored by locale-ownership.ts",
  )
  assert.match(
    locale,
    // 泛型实参可有可无（当前 pin 是 bind<LocaleSettings>({ namespace: … })）：锚只钉
    // 「把 LOCALE_SETTINGS_NAMESPACE 传进 settingsScope.bind」这条事实。
    /settingsScope\s*\.\s*bind\s*(?:<[^>]*>)?\s*\(\s*\{\s*namespace\s*:\s*LOCALE_SETTINGS_NAMESPACE/,
    'the settingsScope.bind({ namespace }) shape the hook assumes',
  )
})

test('the locale plugin still subscribes before its immediate document write', () => {
  const locale = vendorClientProjection('dsh-client-locale')
  const subscribeAt = locale.search(/locale\s*\.\s*subscribe\s*\(\s*sync\s*\)/)
  assert.ok(subscribeAt >= 0, 'apply() must register its document writer as a face subscriber')
  // The immediate sync() right after that registration is the write the mount
  // hook restores in the same synchronous task: the hook installs after
  // apply(), so the subscriber (and the write) must come first.
  const afterSubscribe = locale.slice(subscribeAt)
  const immediateSyncAt = afterSubscribe.search(/\bsync\s*\(\s*\)/)
  assert.ok(
    immediateSyncAt >= 0 && immediateSyncAt < 300,
    'an immediate sync() must follow the subscription (the same-task restore window)',
  )
  // The document-global write and the tag mapping documentLanguageFor mirrors.
  assert.match(locale, /documentElement\s*\.\s*lang\s*=/, 'the document-global write this fix owns')
  assert.match(
    locale,
    /===\s*['"]zh['"]\s*\?\s*['"]zh-CN['"]/,
    "the zh -> zh-CN mapping mirrored by documentLanguageFor",
  )
})

test('the settings scope still reports loading only while the host has not answered', () => {
  const settings = vendorClientProjection('dsh-client-ui-settings')
  assert.match(
    settings,
    /status\s*:\s*persistence\s*===\s*['"]host['"]\s*\?\s*['"]loading['"]\s*:\s*['"]unavailable['"]/,
    "'loading' must mean the host has not answered (the settled gate is status !== 'loading')",
  )
  assert.match(settings, /draft\s*\.\s*status\s*=\s*['"]ready['"]/, 'the settled status the hook accepts')
  assert.match(
    settings,
    /draft\s*\.\s*status\s*=\s*['"]unavailable['"]/,
    'the terminal status the hook treats as settled (a host with no locale namespace)',
  )
})
