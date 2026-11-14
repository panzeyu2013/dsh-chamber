/**
 * I-4 lock: `sidebar.workspaces` stays DECLARED but never rendered.
 *
 * WHY: the official ui-workspace registers into that hole through `slots.inject`;
 * revoking the declaration would not throw — an undeclared hole simply never runs the
 * inject callback (the `register` inside it is what throws on an undeclared child) —
 * but it would drop the official registrant and any third-party injection silently.
 * chamber renders its own multi-source browsing region instead, so the hole must never
 * be CALLED — a call would mount the official workspace UI over the chamber list. This
 * lock makes an accidental render call or a silent removal of the declaration fail
 * loudly, and records the accepted deviation (design 24 §1 / design 05 §2.2.1) so the
 * decision is not re-litigated.
 *
 * Second lock in this file (rc.3 alignment): the sidebar declares the upstream
 * `sidebar.session.action` HOC layer and renders it exactly once from the New
 * Session row, passing the row content as `children`. The runtime passthrough
 * (no occupant => content unchanged) is the upstream HocOutlet contract; the
 * owner-side guarantee locked here is that the call site always passes
 * `children` and that no other New Session entry adopts the hole.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const slots = stripComments(read('../../src/client/contract/slots.ts'))
// The RUNTIME children table is what the official registrant resolves against; the type
// declaration alone would keep this lock green while registration throws.
const runtime = stripComments(read('../../src/client/index.ts'))
// Every shell source, not one file: renderSlot calls live in more than one component.
const clientDir = fileURLToPath(new URL('../../src/client', import.meta.url))
const shell = readdirSync(clientDir, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.tsx'))
  .map(name => stripComments(readFileSync(join(clientDir, name), 'utf8')))
  .join('\n')

test('sidebar.workspaces is declared for registrant compatibility but never rendered', () => {
  assert.match(slots, /'sidebar\.workspaces': \{/, 'the declaration must stay: revoking it silently drops the official registrant')
  assert.match(slots, /owner: \{ wide: boolean; expandSidebar: \(\) => void \}/, 'the owner type stays wire-compatible with the official declaration')
  assert.match(runtime, /'sidebar\.workspaces': \{ kind: 'single', scope: 'root' \}/,
    'the RUNTIME children table must keep the hole too (the registrant inside resolves against it)')
  assert.doesNotMatch(shell, /'sidebar\.workspaces'/, 'the chamber shell must never call the hole (its own multi-source list owns the region)')
  const calls = [...shell.matchAll(/renderSlot\(\s*'([^']+)'/g)].map(match => match[1])
  assert.ok(calls.length > 0, 'the rendered-slot list must be extractable, otherwise this lock is vacuous')
  assert.equal(calls.includes('sidebar.workspaces'), false, 'no render call may be added later')
})

test('the seat transfer keeps leading/hover declared and never adopts trailing', () => {
  // vendor patch 13 deletes the upstream three-row declaration (ui-workspace/src/client/index.ts),
  // so THIS registration is the only declarer. Losing either row silently stops the official
  // occupant's slots.inject (e.g. ui-schedule's schedule-mark) with no error.
  assert.match(runtime, /'sidebar\.session\.row\.leading': \{ kind: 'list', scope: 'root' \}/,
    'the leading row must stay declared (patch 13 removed the upstream declaration)')
  assert.match(runtime, /'sidebar\.session\.row\.hover': \{ kind: 'list', scope: 'root' \}/,
    'the hover row must stay declared (patch 13 removed the upstream declaration)')
  assert.doesNotMatch(slots, /'sidebar\.session\.row\.trailing'/,
    'trailing is deliberately not adopted (design 06 §10 / design 09 §3.6): declaring it without a renderer would strand occupants')
  assert.doesNotMatch(runtime, /'sidebar\.session\.row\.trailing'/,
    'the runtime children table must not adopt trailing either')
})

test('sidebar.session.action is declared as an rc.3 HOC layer and rendered once with its row content', () => {
  // rc.3 同步：上游 ui-sidebar 新增的通用扩展槽（当前占用者 = optional 包
  // deepseek-chat-import 的导入入口）。两处声明缺一不可：SlotMap 是型别面，运行时
  // children 表才是 registrant 的解析目标——只留型别会让 slots.inject 永久等待（静默
  // 缺席、不报错；与上面 `sidebar.workspaces` 同一失效形态）。
  assert.match(slots, /'sidebar\.session\.action': \{ kind: 'hoc'; scope: 'root'; owner: SidebarSessionActionOwnerProps \}/,
    'the SlotMap row must keep the hoc kind, root scope and the owner share type')
  assert.match(slots, /export interface SidebarSessionActionOwnerProps \{\s*wide: boolean\s*\}/,
    'the owner share stays { wide } (the row renders against the column state)')
  assert.match(slots, /\| 'sidebar\.session\.action'/,
    'the root props slot union must include the hole (renderSlot is typed from it)')
  assert.match(runtime, /'sidebar\.session\.action': \{ kind: 'hoc', scope: 'root' \}/,
    'the RUNTIME children table must declare the hole, or the occupant’s inject waits forever')
  assert.match(read('../../../../types/vendor-modules.d.ts'),
    /renderSlot: \(hole: H, props\?: any, opts\?: \{[\s\S]{0,260}?children\?: ReactNode/,
    'the loose ambient seam must accept { children } for hoc keys (the vendor HocRenderOpts face)')

  // 唯一渲染点 = New-session 行。owner 侧对「无 occupant 时原样渲染」的充分条件就是
  // children 恒在场：上游 HOC 契约里省略 children = 层环绕空内容（按钮会消失）。
  //
  // 计数只认 key（引号/空白/参数换行都不得绕过唯一性锁），调用形态随后单独断言；
  // 否则把 `{ wide }` 改成多行格式化就能让计数为 0，唯一性锁会静默跳过。
  const calls = [...shell.matchAll(/renderSlot\(\s*['"]sidebar\.session\.action['"]/g)]
  assert.equal(calls.length, 1, 'the New-session line renders the HOC layer exactly once (key count, format-tolerant)')
  const callAt = calls[0]?.index ?? -1
  assert.notEqual(callAt, -1, 'the render call must be extractable, otherwise this lock is vacuous')
  const call = shell.slice(callAt, callAt + 2400)
  assert.match(call, /renderSlot\(\s*['"]sidebar\.session\.action['"]\s*,\s*\{\s*wide\s*\}\s*,\s*\{/,
    'the layer is rendered with the column state as its owner props')
  assert.match(call, /children:\s*\(/,
    'the layer must receive the row content as children (omitting it renders the layers around nothing)')
  assert.match(call, /<Tooltip[\s\S]{0,500}?<button[\s\S]{0,900}?className=\{css\.newSession\}/,
    'children must carry the shell’s Tooltip + New-session button unchanged')

  // 行容器是 outlet 的**直接父级**（变异实证：容器改名、或 outlet 移出容器都必须红）：
  // outlet 必须紧接在唯一的 <div className={css.newSessionRow}> 内。否则运行时行 div
  // 丢失 display:flex/gap，occupant 控件与按钮的并排/纵排几何静默失效，而 visual-lock
  // 只读 CSS 文件不会红。
  const rowContainers = [...shell.matchAll(/css\.newSessionRow/g)]
  assert.equal(rowContainers.length, 1,
    'exactly one `.newSessionRow` container usage (a rename or a second wrapper defeats the row geometry)')
  assert.match(
    shell,
    /<div\s+className=\{css\.newSessionRow\}>\s*\{?\s*renderSlot\(\s*['"]sidebar\.session\.action['"]/,
    'the HOC outlet must be the direct child of the `.newSessionRow` container (moving it out silently drops the row flex geometry)',
  )

  // 单入口：另三处 New Session（字标按钮 / shell.leading 窗口 chrome / 工作区 +）与上游
  // 同形不装饰该槽（上游 HeaderLeadingControls 也不装饰），避免误判漏做或重复入口。
  assert.doesNotMatch(stripComments(read('../../src/client/SidebarLeadingControls.tsx')), /'sidebar\.session\.action'/,
    'the hidden-sidebar window chrome stays undecorated (upstream HeaderLeadingControls parity)')
  assert.doesNotMatch(stripComments(read('../../src/client/ServerSection.tsx')), /'sidebar\.session\.action'/,
    'the workspace "+" entry is not an HOC site')
})
