/**
 * 已安装 dsh 运行树的 upstream client-plugin 闭包抽样。
 *
 * 症状：安装树里丢一个上游 client-plugin 包（>260 长路径、Defender 中断的 NSIS
 * 安装、手工删改），应用照常启动，只是复合首屏少一行——sidebarRight 的唯一
 * provider 是 `@deepseek-ai/dsh-client-ui-sidebar-right`，缺它时前端只记一条
 * 降级事实、永久 pending，而构建/打包/启动三处门禁全绿。
 *
 * 本模块是 afterPack 打包断言的**安装期镜像**：
 * `packages/desktop/scripts/after-pack-adhoc-sign.mjs` 的
 * `PACKAGED_CLIENT_CLOSURE_SAMPLE` 证"构建树带齐了"，这里证"用户机器上装出来的
 * 那棵树还在"。两处抽样的包名列表由本文件的单测锁步（after-pack 的测试反向
 * import 本模块，见 scripts/after-pack-adhoc-sign.test.mjs）。
 *
 * 纯模块（node:fs only、无 Electron），sidecar node 可直接跑单测；main.ts 启动时
 * 调用一次、缺件大声 console.error 但绝不阻断启动——与 Windows ACL 收紧同一纪律。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 抽样包（workspace 相对、POSIX 形态）：sidebarRight 行的唯一 provider
 * （`dsh-client-ui-sidebar-right`）加上它首屏注入的 resources / chat 两包。
 */
export const RUNTIME_CLIENT_CLOSURE_SAMPLE: readonly string[] = Object.freeze([
  'node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/package.json',
  'node_modules/@deepseek-ai/dsh-client-resources/package.json',
  'node_modules/@deepseek-ai/dsh-client-ui-chat/package.json',
])

/** 控制面 spawn 的唯一入口（`node <workspace>/node_modules/@deepseek-ai/dsh/lib/bin.js`）。 */
export const RUNTIME_DSH_BIN_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/** 一次抽样要证存在的全部条目（稳定顺序：先入口，再 client-plugin 闭包）。 */
export const RUNTIME_CLOSURE_REQUIRED: readonly string[] = Object.freeze([
  RUNTIME_DSH_BIN_ENTRY,
  ...RUNTIME_CLIENT_CLOSURE_SAMPLE,
])

export interface RuntimeClientClosureVerdict {
  ok: boolean
  /** workspace 相对路径（POSIX 形态），缺失即列出；ok 时为 []。 */
  missing: string[]
}

/**
 * 断言 workspaceDir（`<resources>/vendor/dsh`）携带完整抽样。
 *
 * fail-closed：workspaceDir 为 null/空（打包态连内建树路径都没解析到）同样返回
 * 全量 missing，不得静默判过；调用方据此打印可行动的 console.error。
 * `exists` 是测试接缝（与 win-acl.ts 同款），默认真实 fs。
 */
export function verifyRuntimeClientClosure(
  workspaceDir: string | null | undefined,
  options: { exists?: (file: string) => boolean } = {},
): RuntimeClientClosureVerdict {
  if (typeof workspaceDir !== 'string' || workspaceDir === '') {
    return { ok: false, missing: [...RUNTIME_CLOSURE_REQUIRED] }
  }
  const exists = options.exists ?? existsSync
  const missing = RUNTIME_CLOSURE_REQUIRED.filter((entry) => !exists(path.join(workspaceDir, entry)))
  return { ok: missing.length === 0, missing }
}
