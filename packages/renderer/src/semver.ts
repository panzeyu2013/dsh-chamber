/**
 * SemVer 2.0 precedence —— renderer 内的单一实现（2026-12 阶段 2 单源化）。
 *
 * 口径（与 dsh-runtime / gateway 的镜像实现按同一套语义对齐；跨包不共享代码）：
 *   - 非法输入返回 null（调用方自行决定「不可比」的呈现），绝不臆造序；
 *   - build metadata（`+…`）按规范不参与优先级比较；
 *   - prerelease 方向按规范：有 prerelease < 无 prerelease；公共前缀后标识符多者更大；
 *     数字标识符按数值比较、数字标识符 < 非数字标识符、其余按 ASCII 字典序。
 *
 * 已知跨包分叉（登记，不在本批修）：packages/dsh-runtime/src/registry-metadata.ts 的
 * compareVersionsDesc 用 split(/[.-]/) 比较且未剥离 build metadata，同一版本集的
 * 「最新」结论可能与这里不同；renderer 侧以本模块为唯一口径。
 */

interface ParsedSemver {
  core: [string, string, string]
  prerelease: string[]
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER.exec(value)
  if (match === null) return null
  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareNumericIdentifier(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** SemVer 2.0 precedence；build metadata 刻意忽略；null = 至少一侧不可解析。 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumericIdentifier(left.core[index]!, right.core[index]!)
    if (compared !== 0) return compared
  }
  const leftPre = left.prerelease
  const rightPre = right.prerelease
  if (leftPre.length === 0 || rightPre.length === 0) {
    if (leftPre.length === rightPre.length) return 0
    return leftPre.length === 0 ? 1 : -1
  }
  const common = Math.min(leftPre.length, rightPre.length)
  for (let index = 0; index < common; index += 1) {
    const x = leftPre[index]!
    const y = rightPre[index]!
    if (x === y) continue
    const xNumeric = /^\d+$/u.test(x)
    const yNumeric = /^\d+$/u.test(y)
    if (xNumeric && yNumeric) return compareNumericIdentifier(x, y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  if (leftPre.length === rightPre.length) return 0
  return leftPre.length < rightPre.length ? -1 : 1
}
