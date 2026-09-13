/**
 * Argument contract for `scripts/dev/verify-upstream-touchpoints.mjs`
 * (2026-12 review P2, pure — no I/O, no process access, so it is unit-testable
 * on its own; the gate script itself is a top-level program and cannot be
 * imported by a test).
 *
 * WHY THIS EXISTS: the gate runs C1/C3–C10 on EVERY invocation, and its default
 * (non-`--no-artifact-rebuild`) mode rebuilds the committed host/mobile bundles
 * IN PLACE and then restores them. Before this module, any argument the script
 * did not recognize (`--no-artifact-rebuid` — one missing letter, a `--tag`
 * typo, an editor's `--`) was silently ignored: the run reported green while
 * having performed a full write-and-restore of generated artifacts. A typo must
 * therefore be a LOUD usage error, never a silent full run.
 *
 * The accepted surface is deliberately tiny and closed: `--no-artifact-rebuild`,
 * `--tags <old> <new>`, `--help`/`-h`. Anything else — including a bare
 * positional, a repeated flag or a `--flag=value` form — is an error, because
 * every one of them means the caller believes something is happening that
 * is not.
 */

/** Exit code for a usage error (process failures use 1). */
export const USAGE_EXIT_CODE = 2

/** The single source of the script's usage text (`--help` and usage errors). */
export const VERIFY_USAGE = `verify-upstream-touchpoints — 上游触点保鲜门（C1/C3–C10；docs/checklists/upstream-touchpoints.md 的机器侧）

用法：
  node scripts/dev/verify-upstream-touchpoints.mjs [--no-artifact-rebuild]
  node scripts/dev/verify-upstream-touchpoints.mjs --tags <old> <new>
  node scripts/dev/verify-upstream-touchpoints.mjs --help

选项：
  --no-artifact-rebuild   C8 退回 mtime advisory（**不写盘**）。CI 在 install
                          前跑此模式；凡是不能承受就地重建-还原的环境都应显式
                          带这个参数。
  --tags <old> <new>      额外输出 C2：上游两个 tag 间三 fork 面的重放差异
                          （advisory；需要 vendor/harness-checkout 子模块）。
  --help, -h              打印本用法并 exit 0（不跑任何门、不写盘）。

默认模式（无参数）：跑 C1/C3–C10，其中 C8 会**就地重建并原样还原**提交态生成物
（host dist ×3 + dsh-runtime dist + mobile dist/lib 四件）——这是唯一会写盘的路径。

退出码：
  0  全部通过（或 --help）
  1  有门硬失败
  2  用法错误（未知参数 / --tags 缺参数等）；用法错误不会先跑门
`

/** Accepted flags, in the order the usage text documents them. */
const KNOWN_FLAGS = new Set(['--no-artifact-rebuild', '--tags', '--help', '-h'])

/**
 * Parse and validate the gate's argv (WITHOUT the leading node/script entries).
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ help: boolean, noArtifactRebuild: boolean, tags: [string, string] | null, errors: string[] }}
 *   `help` short-circuits everything else (standard CLI behavior: `--help`
 *   wins even next to an invalid argument). `errors` is empty when the call is
 *   valid; the caller prints the usage text and exits with USAGE_EXIT_CODE for
 *   every entry it contains.
 */
export function parseVerifyArgs(argv) {
  const errors = []
  let noArtifactRebuild = false
  let tags = null
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, noArtifactRebuild, tags, errors }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--no-artifact-rebuild') {
      if (noArtifactRebuild) errors.push(`重复的 --no-artifact-rebuild（第 ${index + 1} 个参数）`)
      noArtifactRebuild = true
      continue
    }
    if (argument === '--tags') {
      if (tags !== null) {
        errors.push(`重复的 --tags（第 ${index + 1} 个参数）`)
        index += 2
        continue
      }
      const values = argv.slice(index + 1, index + 3)
      if (values.length < 2 || values.some((value) => value.startsWith('-'))) {
        // A missing value used to fall through to a plain full run: the caller
        // asked for the tag report and silently got everything else instead.
        errors.push(`--tags 需要恰好两个 tag 值（得到 ${values.length === 0 ? '无' : values.join(' ')}）`)
        break
      }
      tags = [values[0], values[1]]
      index += 2
      continue
    }
    // Anything left is either an unknown flag or a bare positional; both mean
    // the invocation does not do what its author thinks it does.
    errors.push(argument.startsWith('-')
      ? `未知参数 ${argument}（已知：${[...KNOWN_FLAGS].join(', ')}）`
      : `不接受位置参数 ${argument}（--tags 的两个 tag 值必须紧跟 --tags）`)
  }
  return { help: false, noArtifactRebuild, tags, errors }
}
