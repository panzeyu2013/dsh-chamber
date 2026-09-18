/**
 * packaging-manifest-lockstep.test.mjs —— 打包清单同源锁步门禁（2026-12 P10）
 *
 * 手工维护的清单会漂移，而漂移的后果都不在本地：
 *  ① HOST_PACKAGES（packages/desktop/scripts/build-sidecar.mjs）——决定 .app
 *     内 Swift 装配的 seed 源与注入 flag；
 *  ② control-plane 的 DEFAULT_HOST_*_PACKAGE_SOURCE_DIR——dev/CI 缺省源；
 *  ③ root package.json 的 build:host-packages 构建链——构建顺序与包名；
 *  ④ build-host-graph-package.mjs 的 HOST_PACKAGE_BUILD_ROWS——Electron 侧拷贝；
 *  ⑤ macos AppDelegate.swift 的 (--host-*-dir, 包名) 行——Swift 装配态注入。
 * 另外 extraResources 过滤器必须与 VENDOR_DSH_FILES / PNPM_BIN_FILES 同源
 * （Electron 与 Swift 两条装配腿必须同一个过滤器）。
 *
 * 全部断言来自源码解析/导入，不执行构建，因此 ubuntu 腿也能跑；
 * 由 root package.json 的 test:upgrade-tools 运行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_PACKAGE_BUILD_ROWS } from '../../packages/desktop/scripts/build-host-graph-package.mjs'
import {
  HOST_PACKAGES,
  PNPM_BIN_FILES,
  VENDOR_DSH_FILES,
} from '../../packages/desktop/scripts/build-sidecar.mjs'
import { MODES } from '../gates/run-checks.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8')
const rootPkg = JSON.parse(read('package.json'))
const desktopPkg = JSON.parse(read('packages/desktop/package.json'))

test('host 包清单五处同源：build-sidecar / control-plane 常量 / 构建链 / Electron 行集 / AppDelegate', () => {
  const names = HOST_PACKAGES.map((host) => host.name)

  // ② control-plane 缺省源常量（dev/CI 与打包态注入的同一批包）。
  const constants = [...read('packages/control-plane/src/index.ts').matchAll(
    /export const DEFAULT_HOST_([A-Z_]+)_PACKAGE_SOURCE_DIR = join\(REPO_ROOT, 'packages', '([^']+)'\)/g,
  )].map((match) => match[2]).sort()
  assert.deepEqual(constants, [...names].sort(),
    'control-plane 的 DEFAULT_HOST_*_PACKAGE_SOURCE_DIR 必须与 HOST_PACKAGES 同集')

  // ③ root build:host-packages 链：四个 build:host-* 脚本 → 四个包，顺序一致。
  const chain = [...(rootPkg.scripts['build:host-packages'] ?? '').matchAll(/pnpm run (build:host-[a-z-]+)/g)]
  const chainPackages = chain.map(([, script]) => {
    const match = /pnpm --filter (@dsh-chamber\/[a-z-]+) run build/.exec(rootPkg.scripts[script] ?? '')
    assert.ok(match, `${script} 必须构建恰好一个 @dsh-chamber 包`)
    return match[1].replace('@dsh-chamber/', '')
  })
  assert.deepEqual(chainPackages, names,
    'root build:host-packages 必须构建 HOST_PACKAGES 的全部四个包且顺序一致')

  // ④ Electron 侧拷贝行集。
  assert.deepEqual(HOST_PACKAGE_BUILD_ROWS.map((row) => path.basename(row.sourceDir)), names,
    'build-host-graph-package 的行集必须与 HOST_PACKAGES 同集且同序')

  // ⑤ Swift AppDelegate 的装配态注入行（flag + 包名）。
  const appDelegate = [...read('macos/Sources/DSHChamber/AppDelegate.swift').matchAll(
    /\("(--host-[a-z-]+-dir)", "([^"]+)"\)/g,
  )].map(([, flag, name]) => ({ arg: flag.slice(2), name }))
  assert.deepEqual(appDelegate, HOST_PACKAGES.map(({ name, arg }) => ({ arg, name })),
    'AppDelegate 的 --host-*-dir 行必须与 HOST_PACKAGES 的 flag/包名逐一对应')

  // 每个源目录的 manifest 名必须是 @dsh-chamber/<dir>（两腿都按目录名取包）。
  for (const name of names) {
    const manifest = JSON.parse(read(`packages/${name}/package.json`))
    assert.equal(manifest.name, `@dsh-chamber/${name}`)
  }
})

test('extraResources 过滤器与 build-sidecar 的 VENDOR_DSH_FILES / PNPM_BIN_FILES 同源', () => {
  const entry = (from) => {
    const found = (desktopPkg.build.extraResources ?? []).find((resource) => resource.from === from)
    assert.ok(found, `packages/desktop/package.json extraResources 必须保留 from=${from}`)
    return found
  }
  assert.deepEqual(entry('vendor/dsh').filter, VENDOR_DSH_FILES,
    'vendor/dsh 的清单三件过滤器必须等于 VENDOR_DSH_FILES')
  assert.deepEqual(entry('vendor/dsh/node_modules').filter, ['**/*'],
    'vendor/dsh/node_modules 是唯一无界半边，清单半边由上一断言钉住')
  assert.deepEqual(entry('node_modules/pnpm').filter,
    ['package.json', ...PNPM_BIN_FILES.map((file) => `bin/${file}`), 'dist/**/*'],
    'pnpm 的 package.json + bin/pnpm.{cjs,mjs} + dist 过滤器必须等于 PNPM_BIN_FILES 派生集')
})

test('run-checks 的 macOS/Swift 腿只在 darwin 追加（ubuntu 腿绝不跑 plutil/codesign 套件）', () => {
  const darwin = process.platform === 'darwin'
  assert.equal(MODES.tests.includes('test:macos'), darwin,
    'check:tests 必须在 darwin 上复现 ci.yml test-macos 的 test:macos 入口')
  assert.equal(MODES.full.includes('test:macos'), darwin, 'check:full 同上')
  assert.ok(!MODES.static.includes('test:macos'), 'static 腿无平台条件，不得混入 macOS 套件')
  assert.ok(!MODES.typecheck.includes('test:macos'), 'typecheck 腿不得混入 macOS 套件')
  assert.equal(rootPkg.scripts['test:macos'], 'pnpm --filter @dsh-chamber/desktop run test:macos',
    'root test:macos 必须转发到 desktop 的 MACOS_FILES 入口')
})
