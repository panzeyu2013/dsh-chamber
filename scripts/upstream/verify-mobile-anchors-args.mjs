/**
 * Argument contract for `scripts/upstream/verify-mobile-anchors.mjs`
 * （纯函数，无 I/O、无 process —— 与 `verify-upstream-touchpoints-args.mjs`
 * 同一套拆法：顶层门脚本不可被测试 import，参数面单独成模块才能做负例）。
 *
 * 为什么参数面要闭合：本门会读**仓库之外**的上游锚点树（几万个文件里的一小撮），
 * 一个拼错的 flag（`--anchor-rooot`、`--simulate-rename main` 少了 `=`）如果被
 * 静默忽略，调用者以为「改名实验证明门禁有效」，实际跑的是默认模式且全绿——
 * 与 verify-upstream-touchpoints.mjs 一致：用法错误
 * 响亮失败（exit 2），绝不静默跑默认模式。
 */

/** 用法错误的退出码（门的硬失败用 1）。 */
export const USAGE_EXIT_CODE = 2

/** 锚点根候选（按序取第一个真的含 `node_modules/@deepseek-ai` 的）。 */
export const DEFAULT_ANCHOR_ROOTS = [
  // 本机 gateway 形态的上游锚（本任务指定的输入；别的机器上通常不存在 ⇒ fail-soft）
  '/root/.dsh-chamber/gateway/dsh-anchor',
  // 运行时线（desktop 自带 dsh 树物化后才有）
  'packages/desktop/vendor/dsh',
]

/** 用法文本的单一来源（`--help` 与用法错误共用）。 */
export const VERIFY_MOBILE_ANCHORS_USAGE = `verify-mobile-anchors — 移动插件锚点上游保鲜门（docs/checklists/upstream-touchpoints.md §4）

用法：
  node scripts/upstream/verify-mobile-anchors.mjs [--anchor-root <dir>] [--require-anchor-root] [--list]
  node scripts/upstream/verify-mobile-anchors.mjs --simulate-rename <old>=<new> [--simulate-rename …]
  node scripts/upstream/verify-mobile-anchors.mjs --help

选项：
  --anchor-root <dir>        上游锚点根（须含 node_modules/@deepseek-ai/**/lib/*.js
                             与 dsh-web-frontend/dist/assets/index-*.css）。
                             默认先读环境变量 DSH_MOBILE_ANCHOR_ROOT，再按
                             ${DEFAULT_ANCHOR_ROOTS.join(' → ')}
                             取第一个存在者。
  --simulate-rename <a>=<b>  自测开关：把上游产物里的 token a 在**内存里**改成 b
                             （不写盘），用于证明门禁会因锚点改名而 exit 1。可重复。
  --require-anchor-root      严格模式：把所有「其实什么都没查」的路径改为 exit 1——
                             ① 锚点根缺失 ② 无 client 产物 ③ 插件源码抽不到
                             ④ pin 身份不可判定（仓内 lockfile 或锚点树 package.json 读不到）；
                             并要求锚点树的 dsh-web-frontend 版本与仓内 pin 一致（不一致同样
                             exit 1，lockfile 的 peer 后缀会被剥掉）。缺 shell 产物
                             （bundle/CSS）同样算语料不完整。升级流程
                             （docs/checklists/upstream-touchpoints.md §7 第 7 步之后）必须带它跑：
                             不带时「CI 上正常跳过」与「其实什么都没查」无法区分。
                             与 --simulate-rename 互斥（后者能凭空造证据）。
  --list                     打印从本包源码抽到的锚点表（含分类与证据计数）。
  --help, -h                 打印本用法并 exit 0。

退出码：
  0  全部通过（或非严格模式下的 fail-soft 跳过 / --help）
  1  data-* / role / slot 锚点没有**写入形**发射点、最小断言集缺口，或严格模式下的
     四条「什么都没查」路径 + 版本不符
  2  用法错误（未知参数 / --simulate-rename 缺 '=' / 它与 --require-anchor-root 同用等）
`

/** `--simulate-rename <old>=<new>` 的纯解析（两侧都不得为空）。 */
export function parseRenameSpec(spec) {
  const at = spec.indexOf('=')
  if (at <= 0 || at === spec.length - 1) return null
  return { from: spec.slice(0, at), to: spec.slice(at + 1) }
}

/**
 * 解析 argv（`process.argv.slice(2)`）。
 *
 * 参数面故意很小且闭合：`--anchor-root`、`--simulate-rename`（可重复）、
 * `--require-anchor-root`、`--list`、`--help`/`-h`。`--help` 优先于一切（标准 CLI
 * 行为）；其余任何未知参数/位置参数/重复 flag/缺值都进 `errors`，调用方打印用法并
 * exit 2。
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env - 只用 `DSH_MOBILE_ANCHOR_ROOT`。
 * @returns {{help: boolean, list: boolean, anchorRoot: string|null, requireAnchorRoot: boolean, renames: Array<{from: string, to: string}>, errors: string[]}}
 */
export function parseVerifyMobileAnchorsArgs(argv, env = {}) {
  const errors = []
  let help = false
  let list = false
  let requireAnchorRoot = false
  let anchorRoot = typeof env.DSH_MOBILE_ANCHOR_ROOT === 'string' && env.DSH_MOBILE_ANCHOR_ROOT !== ''
    ? env.DSH_MOBILE_ANCHOR_ROOT
    : null
  let sawAnchorRoot = false
  const renames = []
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, list, anchorRoot, requireAnchorRoot, renames, errors }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--list') {
      if (list) errors.push(`重复的 --list（第 ${index + 1} 个参数）`)
      list = true
      continue
    }
    if (argument === '--require-anchor-root') {
      if (requireAnchorRoot) errors.push(`重复的 --require-anchor-root（第 ${index + 1} 个参数）`)
      requireAnchorRoot = true
      continue
    }
    if (argument === '--anchor-root') {
      const value = argv[index + 1]
      if (sawAnchorRoot) { errors.push(`重复的 --anchor-root（第 ${index + 1} 个参数）`); index += 1; continue }
      if (value === undefined || value.startsWith('-')) { errors.push('--anchor-root 需要一个目录值'); break }
      anchorRoot = value
      sawAnchorRoot = true
      index += 1
      continue
    }
    if (argument === '--simulate-rename') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) { errors.push('--simulate-rename 需要 <old>=<new>'); break }
      const parsed = parseRenameSpec(value)
      if (parsed === null) { errors.push(`--simulate-rename 形态非法：${value}（需要 <old>=<new>，两侧非空）`); break }
      renames.push(parsed)
      index += 1
      continue
    }
    errors.push(argument.startsWith('-')
      ? `未知参数 ${argument}（已知：--anchor-root, --simulate-rename, --require-anchor-root, --list, --help）`
      : `不接受位置参数 ${argument}`)
  }
  // 自测开关与严格模式互斥：`--simulate-rename a=b` 能把产物里被改掉的名字**改回来**，
  // 于是在严格模式下能凭空造出「上游仍在发射」的证据：
  // 改名后的树 + `--simulate-rename <新名>=<原名>` ⇒ 严格模式 exit 0）。严格模式必须
  // 只对真实产物下判断，因此这个组合是用法错误（exit 2）。
  if (requireAnchorRoot && renames.length > 0) {
    errors.push('--simulate-rename 不能与 --require-anchor-root 同时使用：自测开关会在内存里改写产物，'
      + '严格模式必须只判真实产物（要自测请单跑不带 --require-anchor-root 的那条）')
  }
  return { help, list, anchorRoot, requireAnchorRoot, renames, errors }
}
