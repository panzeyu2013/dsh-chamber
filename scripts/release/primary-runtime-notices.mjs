/**
 * 随包载荷（primary runtime）的第三方声明条目：CPython + python 发行版 + Node.js。
 * 版本只从 packages/desktop/primary-runtime-lock.json 读（载荷的唯一版本来源），
 * 供 gen-third-party-notices.mjs 拼进中英两份声明。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const LOCK_PATH = join(ROOT, 'packages/desktop/primary-runtime-lock.json')

/**
 * 载荷声明小节（纯函数，中/英同源同序）：缺锁文件时抛错（声明不能悄悄缺一段）。
 * @param language - 'zh' | 'en'。
 * @param lockPath - 锁路径（用例注入）。
 * @returns 单个 markdown 小节（含表头与许可证说明）。
 */
export function payloadNoticeSection(language, lockPath = LOCK_PATH) {
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    throw new Error('primary runtime lock unreadable: ' + lockPath + ' (' + String(error) + ')')
  }
  const packages = Object.entries(lock.pythonPackages ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
  const zh = language === 'zh'
  const header = zh
    ? ['## 随包载荷（primary runtime：CPython / python 发行版 / Node.js）', '', '| 构件 | 版本 | 许可证 |', '|---|---|---|']
    : ['## Bundled payload (primary runtime: CPython / python distributions / Node.js)', '', '| Component | Version | License |', '|---|---|---|']
  const rows = [
    zh
      ? '| `CPython`（python-build-standalone） | ' + lock.pythonVersion + ' | PSF-2.0 |'
      : '| `CPython` (python-build-standalone) | ' + lock.pythonVersion + ' | PSF-2.0 |',
    zh
      ? '| `pip`（解释器基线，随 CPython 分发） | 随 CPython | MIT |'
      : '| `pip` (interpreter baseline, ships with CPython) | with CPython | MIT |',
    zh
      ? '| `Node.js` | ' + lock.nodeVersion + ' | MIT |'
      : '| `Node.js` | ' + lock.nodeVersion + ' | MIT |',
    ...packages.map(([name, version]) => (zh
      ? '| `' + name + '`（python 发行版） | ' + version + ' | 见随包 wheel 的 dist-info METADATA |'
      : '| `' + name + '` (python distribution) | ' + version + ' | see the wheel dist-info METADATA |')),
  ]
  const note = zh
    ? ['', 'CPython、Node.js 与每个 python 发行版的完整许可证文本随载荷分发（CPython 的 LICENSE 在载荷根、各发行版（含解释器基线的 pip）在自己的 `*.dist-info/METADATA`、Node.js 随 node 归档）。版本来自 `packages/desktop/primary-runtime-lock.json`（唯一来源）。']
    : ['', 'The full license text of CPython, Node.js and of every python distribution ships inside the payload (CPython LICENSE at the payload root, each distribution (including the interpreter-baseline pip) in its own `*.dist-info/METADATA`, Node.js with the node archive). Versions come from `packages/desktop/primary-runtime-lock.json` (single source).']
  return [...header, ...rows, ...note].join('\n')
}
