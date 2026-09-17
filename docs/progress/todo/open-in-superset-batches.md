# todo · open-in：超集分批（S1/S2/S3）与降级留档形态

> 状态：**fork & supersede 已落地**（2026-09-11 裁决 → design 20 定稿 → 实施完成）。契约与落地形态见
> `docs/design/20-open-in-registry.md`（§4 契约、§6 host 包与八处接线、§8 文件清单、§9 验证门）。
> **实机验收清单与实施后的开放项登记在 `docs/progress/STATUS.md`**（design 20 §1 的指向）；
> 本文只保留**未排期**的超集分批、明确不做的边界与两份降级留档形态。

## 1. 超集分批（S1/S2/S3 未排期；S4 不做）

每批独立 PR 粒度、每批带自己的测试、**不引入新运行时依赖**。2026-09-11 复核把原 S1–S4 重排优先级并收窄：

- **S1 远程 provider 家族**：主进程注册表加 Insiders / Cursor / Windsurf / JetBrains Gateway / `ssh://` 终端
  ——每个 provider 只「构造 URL 交 OS」，不启动进程；每个新增项需一次实机 scheme 语义验证（本机目前只注册了
  `Visual Studio Code → [vscode]` 与 `iTerm → […, ssh, …]`）。
- **S2 远程文件级打开**：远程来源允许文件路径（纯 URL 构造，不经 host 包）；本地仍**目录限定**。
- **S3 收窄为「复制路径」**（唯一保留的非启动出口）：在侧栏既有的复制模式上暴露工作区/会话路径——会话行数据已带
  `cwd`（`sidebar/src/shared/instance-api.ts` 的 `SessionRow.cwd?`），侧栏既有 `HoverCard` 已支持 `copyText`
  （今天只复制会话标题，`ServerSection.tsx:2073`；该行本体 `:2027`）⇒ **零新 IPC、零新依赖、纯渲染层**。
  「复制 `ssh user@host` / 复制 VS Code 深链」**不做**（形态见 §3 附录 A，日后需要照此实施）。
- **S4 多入口：不做**（2026-09-11 裁决，理由已登记 STATUS）：header 按钮与目标会话同排相邻，侧栏入口边际价值有限；
  会话行的动作**已集中在 kebab 菜单**（重命名/分叉/归档，`ServerSection.tsx:1952-1977`），新增侧栏入口要么与该菜单重复、
  要么推翻它——**不要把「会话行刻意没有 kebab」当理由**（该行自 T2a 起就有 kebab；今天刻意无 kebab 的是 worktree 派生的
  workspace 行，`:1288-1290`）。快捷键缺基建（vendor 无 keybinding 注册表，只有聊天输入框自己的 keymap），自建
  document 级监听还要处理「哪个 entry 是活跃视图」与 chord 冲突。若日后要做，形态见 §3 附录 B。

## 2. 边界（不做，登记在 design 20 §7.3）

- 远端宿主侧打开（需要 ssh/http cookie 注入 + UI 明示，与「远程只用 vscode 部分」的契约冲突）；
- fork 官方 catalog 再扩**本地**应用集合之外的本地执行面（例如「在终端里打开」的本地实现）；
- 主进程自行枚举本机应用（重开 Batch 3 Phase 2 关闭的红线）。

## 3. 附录：S3 / S4 完整形态（降级留档，未排期）

> 保留 2026-09-11 复核时的代码调研结论，供日后需要时直接实施，不必重新摸底。现状证据（复核时实测）：
> 全仓 chamber 代码 `navigator.clipboard` / `writeText` **零调用者**（`main.ts:5699-5713` 只是放行了
> `clipboard-sanitized-write` 权限）；`execCommand(copy)` 仅出现在 gateway 的独立安装页（`gateway/src/routes.ts:960`）；
> 上游官方客户端只有一处槽位注册（`conversation.session.header.utilities`，id `open-in-app`，order -10），
> 无剪贴板、无「无可用应用」出口（`controller.ts:39`：读取失败 ⇒ 空列表 ⇒ 完全不渲染按钮）⇒
> **S3/S4 都是新增能力，不是「官方有而我们缺」**。

### 附录 A · S3 全量形态（若要做「复制 ssh 命令 / 复制深链」）

- 事实面：渲染层**拿不到** ssh 目标——`ChamberServerAggregate`（`sidebar/shared/aggregate-store.ts`）只有
  `id/rawId/kind/transport/label`，无 host/user/port；per-entry ctx 只有 instance id / transport / basePath /
  fingerprint。`ssh user@host` 与 `vscode://vscode-remote/ssh-remote+<host><path>` 的构造都只在主进程
  （`deep-link.ts` 的 `buildVscodeRemoteUrl`）。
- 因此正确形态是**在既有 open-in IPC 面上加一个只返回文本的方法**，而不是把 host/user/port 抛给渲染层再拼 URL
  （那会造出第二份 URI 逻辑，违反「绝不手写平行副本」纪律）：
  `link({appId, instanceId, path, sourceFingerprint}) → {ok:true, kind:url|ssh|path, text}`，通道命名沿用
  `ipc-events.ts` 的 `OPEN_IN_APPS` / `OPEN_IN` 族。
- 实现必须**原样复用** `runOpenInLaunch`（`desktop/open-in.ts:194+`）的前 5 步（appId 白名单 → instanceId 校验 →
  路径校验（local Windows 感知 / remote POSIX）→ remoteCapable 门 → 可用性复核），第 6 步从 `provider.open` 换成
  返回文本；并加一条测试断言「link 路径从不调用 provider.open」（零执行面）。`kind:url` 是否带 `newWindow` 参数
  需产品裁决（倾向不带）。
- 客户端：视图模型需要新增**第三类结局**（可复制的出口），门控按 reason 精细区分——有具体路径 + 该来源无法启动
  （`transport-not-ssh` / `unknown-source`）才出复制项，「本地实例坏了」仍必须隐藏；出口落在既有官方 `ui-primitives`
  `Menu`（现状：open-in 菜单 = `open/autoFocus/dense/selection="fill"/align="end"` + `items: MenuItem{id,label,icon}[]`，
  主按钮与 chevron 按钮组成 anchor；chamber 自有的 `AccessibleAppMenu` 三件套已删除，只留 N-ctx 归属守卫
  `src/client/instance-view-guard.ts`）——复制项就是该 `items` 数组的一员，走同一个 `onSelect` 分发与同一套可访问性
  语义，文案进本包自己的 typed 字典；剪贴板被拒时把文本显示成可选中输入框（不静默失败）。
- 验收：纯函数（reason→出口映射、门控不被放宽）；管线（link 与 launch 同一组拒绝分支）；IPC 面锁步
  （`ipc-surface-mirror`）；实机两条（粘贴结果、无应用来源下按钮位置）。

### 附录 B · S4 全量形态（若日后要做多入口）

- 现状：launch 面被关在 per-entry 的 `apply(ctx)` 内（经 `injected()` 交给 header 组件），插件外部无句柄；侧栏是
  **页级**插件，已有页级桥 `chamberBridge`（`sidebar/shared/aggregate-store.ts`，生产者是各 entry ctx）。
- 架构核心 = **per-entry 面注册表**：`publishOpenInFace(sourceId, face)` / `getOpenInFace(sourceId)`，在 `apply(ctx)`
  发布、`ctx.effect` 卸载时撤销；面里带该 entry 的 `sourceFingerprint`（精确启动证明永远绑定 entry，绝不读页面级
  「最新名册」）。落点二选一：**(a)** 侧栏既有 `sidebar/shared` 入口（本仓已有跨包导入先例，且带
  `assertSingletonModule` 单例纪律，倾向选它）；**(b)** open-in 包自己的页级入口（归属清晰，但新增「侧栏依赖功能插件」
  的包依赖方向）。
- 入口优先级：**① 工作区头 kebab**（`ServerSection.tsx:1613-1628` 的 workspace 行菜单 + `:1585` 的 `+`「新建会话」
  已给出菜单与动作词汇，改动最小、不碰 parity）→ ② 会话行行菜单/右键（能力最有价值，但会话行已有 kebab 菜单，
  这里不是「新建菜单」而是「复用或加手势」，加不加待产品裁决）→ ③ 快捷键（只对**活跃** entry 生效；不要每个
  entry ctx 各注册一个监听）。
- 无论哪条入口都必须复用同一组门（合并视图模型 ≥1 可用项；该行属于有具体路径的工作区），并走同一个客户端适配器 →
  `runOpenInLaunch` → provider，**不允许**侧栏另建直接 IPC 短路；报告语义与 header 一致。
- 验收：注册表发布/撤销/按 id 取用；门控（无路径、无可用项时菜单不出现）；一条「第二入口与 header 走同一适配器实例」
  的断言（防平行实现）；实机（菜单位置与拖拽手势不冲突、chord 不与输入框冲突、N-ctx 下只在活跃来源生效）。
