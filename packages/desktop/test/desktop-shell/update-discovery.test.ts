/**
 * update-discovery.test.ts —— 两个 GitHub Releases 发现面的锁步（审计项 2）
 *
 * updater.ts（Electron flavor）的 beta 发现与 update-headless.ts（Swift
 * sidecar flavor）的通道选择现在共用 update-discovery.ts 的唯一实现。本套
 * 用同一输入矩阵**同时**驱动两个公开面，证明它们不可能语义漂移：
 * - beta feed：updater wrapper 选出的 tag === 'v' + headless 选出的版本；
 * - 非法形状/无候选：updater 响亮抛错的那几类输入，headless 返回 null；
 * - 「本通道暂无发布物」（up-to-date）与「非空 feed 零可解析版本」（响亮
 *   error）的区分仍由 headless 调用点从共享 parseability 判据得出；
 * - 有界查询（URL/头/超时）唯一，且两侧非 2xx 各自措辞的响亮错误原样保留。
 * 纯逻辑（无网络、无 Electron）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { betaReleaseDownloadBase, resolveGithubBetaFeed } from '../../updater.ts'
import { createHeadlessUpdateController, selectLatestReleaseVersion } from '../../update-headless.ts'
import {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_RELEASES_URL,
  RELEASES_MAX_ENTRIES,
  fetchGithubReleases,
  isBoundedReleasesList,
  isParseableReleaseTag,
  selectReleaseCandidate,
} from '../../update-discovery.ts'

const logger = { log: () => {}, warn: () => {}, error: () => {} }

function release(tag: string, opts: { draft?: boolean; prerelease?: boolean } = {}) {
  return { tag_name: tag, draft: opts.draft ?? false, prerelease: opts.prerelease ?? false }
}

/** updater 的下载基址 → exact tag（前缀唯一，绝无 latest）。 */
function tagFromDownloadBase(base: string): string {
  const prefix = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`
  assert.ok(base.startsWith(prefix), '下载基址必须来自精确 tag 前缀：' + base)
  const suffix = base.slice(prefix.length)
  assert.ok(suffix.endsWith('/'), '下载基址必须以 / 结尾')
  return decodeURIComponent(suffix.slice(0, -1))
}

interface BetaFeedCase { name: string; releases: unknown[]; tag: string }

const BETA_FEEDS: BetaFeedCase[] = [
  {
    name: '混合 stable/draft/畸形条目时取 canonical beta 最大值',
    releases: [
      release('v9.0.0'),
      release('v0.2.0-beta.2', { prerelease: true }),
      release('v0.2.0-beta.99', { draft: true, prerelease: true }),
      release('0.2.0-beta.100', { prerelease: true }),
      release('v0.2.0-beta.01', { prerelease: true }),
      release('v0.2.0-beta.10', { prerelease: true }),
      release('v0.2.0-beta.11/../../latest', { prerelease: true }),
      release('v0.3.0-beta.1', { prerelease: false }),
      null,
      'x',
    ],
    tag: 'v0.2.0-beta.10',
  },
  {
    name: '大 beta 号按 BigInt 精确取最大（Number 在 >2^53 处失去精度）',
    releases: [
      release('v1.0.0-beta.9007199254740992', { prerelease: true }),
      release('v1.0.0-beta.9007199254740993', { prerelease: true }),
    ],
    tag: 'v1.0.0-beta.9007199254740993',
  },
  {
    name: 'base 数值比较（0.10.0 > 0.9.0，不是字典序）',
    releases: [
      release('v0.9.0-beta.1', { prerelease: true }),
      release('v0.10.0-beta.1', { prerelease: true }),
    ],
    tag: 'v0.10.0-beta.1',
  },
  {
    name: '数值 beta 号比较（beta.10 > beta.2 > beta.1）',
    releases: [
      release('v0.2.0-beta.1', { prerelease: true }),
      release('v0.2.0-beta.10', { prerelease: true }),
      release('v0.2.0-beta.2', { prerelease: true }),
    ],
    tag: 'v0.2.0-beta.10',
  },
]

test('锁步：同一 beta feed 上 updater wrapper 的 tag 与 headless 的版本一致', () => {
  for (const feed of BETA_FEEDS) {
    const tag = tagFromDownloadBase(betaReleaseDownloadBase(feed.releases))
    const version = selectLatestReleaseVersion(feed.releases, 'beta')
    assert.equal(tag, feed.tag, feed.name + '（updater beta wrapper）')
    assert.equal(version, feed.tag.slice(1), feed.name + '（headless selector）')
    assert.equal('v' + version, tag, feed.name + '：两个面必须选出同一个 tag')
    assert.deepEqual(
      selectReleaseCandidate(feed.releases, 'beta'),
      { tag: feed.tag, version: feed.tag.slice(1) },
      feed.name + '：共享选择器是两面唯一的选择实现',
    )
  }
})

test('锁步：无候选 / 非法形状时 updater 响亮抛错、headless 返回 null', () => {
  const noBeta = [release('v0.2.0'), release('v0.2.1')]
  assert.throws(() => betaReleaseDownloadBase(noBeta), /no published beta release/)
  assert.equal(selectLatestReleaseVersion(noBeta, 'beta'), null)
  assert.equal(selectLatestReleaseVersion(noBeta, 'stable'), '0.2.1', '同一 feed 的 stable 通道正常选择')

  const allDraft = [release('v9.9.9', { draft: true, prerelease: true })]
  assert.throws(() => betaReleaseDownloadBase(allDraft), /no published beta release/)
  assert.equal(selectLatestReleaseVersion(allDraft, 'beta'), null)

  const malformedFeeds: unknown[] = [
    null,
    {},
    'x',
    42,
    new Array(RELEASES_MAX_ENTRIES + 1).fill(release('v1.0.0-beta.1', { prerelease: true })),
  ]
  for (const malformed of malformedFeeds) {
    assert.throws(() => betaReleaseDownloadBase(malformed), /invalid GitHub releases response/)
    assert.equal(selectLatestReleaseVersion(malformed, 'beta'), null)
    assert.equal(isBoundedReleasesList(malformed), false)
  }
  // 恰 100 条仍是 per_page=100 的合法满页（上限是 100，不是 <100）。
  const fullPage = new Array(RELEASES_MAX_ENTRIES).fill(release('v1.0.0-beta.1', { prerelease: true }))
  assert.equal(isBoundedReleasesList(fullPage), true)
  assert.equal(selectLatestReleaseVersion(fullPage, 'beta'), '1.0.0-beta.1')
  assert.equal(tagFromDownloadBase(betaReleaseDownloadBase(fullPage)), 'v1.0.0-beta.1')
})

test('锁步：非空 feed 零可解析版本 → headless 响亮 error；本通道无候选 → up-to-date', async () => {
  const controller = (body: unknown) => createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch,
  })

  const allBeta = [release('v0.3.0-beta.1', { prerelease: true })]
  assert.equal(isParseableReleaseTag('v0.3.0-beta.1'), true, 'beta 形状可解析（本通道无候选 ≠ feed 异常）')
  const channelless = controller(allBeta)
  await channelless.checkNow()
  assert.equal(channelless.state().phase, 'up-to-date')

  const malformed = [release('not-a-version'), release('latest'), release('v0.2')]
  assert.deepEqual(malformed.map((entry) => isParseableReleaseTag(entry.tag_name)), [false, false, false])
  const broken = controller(malformed)
  await broken.checkNow()
  assert.equal(broken.state().phase, 'error')
  assert.match(broken.state().error ?? '', /no usable release/)

  const empty = controller([])
  await empty.checkNow()
  assert.equal(empty.state().phase, 'up-to-date', '空 feed = 确实没有发布物')
})

test('锁步：两个消费面只查共享的有界端点，非 2xx 各自措辞的响亮错误保留', async () => {
  const urls: string[] = []
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    const headers = init?.headers as unknown as Record<string, string> | undefined
    assert.equal(headers?.Accept, 'application/vnd.github+json')
    assert.ok(init?.signal instanceof AbortSignal)
    return { ok: true, status: 200, json: async () => [release('v0.2.0-beta.3', { prerelease: true })] }
  }) as unknown as typeof fetch
  const feed = await resolveGithubBetaFeed(request)
  assert.equal(feed, 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.3/')

  const controller = createHeadlessUpdateController({ version: '0.2.0-beta.2', logger, request })
  await controller.checkNow()
  assert.equal(controller.state().phase, 'available')
  assert.equal(controller.state().latestVersion, '0.2.0-beta.3')
  assert.deepEqual(urls, [GITHUB_RELEASES_URL, GITHUB_RELEASES_URL])
  assert.equal(GITHUB_RELEASES_URL, 'https://api.github.com/repos/panzeyu2013/dsh-chamber/releases?per_page=100')

  const failing = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
  await assert.rejects(resolveGithubBetaFeed(failing), /beta update discovery failed \(HTTP 503\)/)
  const failingController = createHeadlessUpdateController({ version: '0.2.2', logger, request: failing })
  await failingController.checkNow()
  assert.equal(failingController.state().phase, 'error')
  assert.match(failingController.state().error ?? '', /update check failed \(HTTP 503\)/)
})

test('共享端点的无 fetch 守卫与共享范围守卫可独立断言', async () => {
  await assert.rejects(fetchGithubReleases(undefined as unknown as typeof fetch), /update discovery is unavailable/)
  assert.equal(isBoundedReleasesList(new Array(RELEASES_MAX_ENTRIES).fill(null)), true)
  assert.equal(isBoundedReleasesList(new Array(RELEASES_MAX_ENTRIES + 1).fill(null)), false)
})
