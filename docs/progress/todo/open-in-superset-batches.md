# todo · open-in：超集分批（S1/S2/S3）与降级留档形态

> 状态：fork & supersede已落地（裁决→design 20定稿→实施完成）。契约/落地见
> `docs/design/20-open-in-registry.md`（§4契约、§6 host包与八处接线、§8文件清单、§9验证门）；实机验收与实施后开放项在
> `docs/progress/STATUS.md`（design 20 §1指向）。本文只留未排期超集分批、不做的边界与两份降级留档形态。

## 1. 超集分批（S1/S2/S3 未排期；S4 不做）

每批独立PR、各自测试、不引入新运行时依赖。复核重排优先级并收窄：

- S1远程provider家族：主进程注册表加Insiders/Cursor/Windsurf/JetBrains Gateway/`ssh://` 终端——只构造URL交OS、不启动进程；每项需实机scheme语义验证（本机现只注册 `Visual Studio Code → [vscode]` 与 `iTerm → […, ssh, …]`）。
- S2远程文件级打开：远程来源允许文件路径（纯URL构造，不经host包）；本地仍目录限定。
- S3收窄为「复制路径」（唯一保留的非启动出口）：侧栏既有复制模式上暴露工作区/会话路径——会话行已带 `cwd`（`sidebar/src/shared/instance-api.ts` 的 `SessionRow.cwd?`），既有 `HoverCard` 支持 `copyText`（现只复制会话标题，`ServerSection.tsx:2073`；该行本体 `:2027`）⇒ 零新IPC、零新依赖、纯渲染层。「复制 `ssh user@host`/复制VS Code深链」不做（见 §3附录A）。
- S4多入口：不做（裁决，理由登记STATUS）：header按钮与目标会话同排相邻，侧栏入口边际价值有限；会话行动作已集中在kebab菜单（重命名/分叉/归档，`ServerSection.tsx:1952-1977`），新增入口要么重复要么推翻它——不要把「会话行刻意没有kebab」当理由（该行自T2a起就有kebab；刻意无kebab的是worktree派生的workspace行，`:1288-1290`）。快捷键缺基建（vendor无keybinding注册表，只有聊天输入框keymap），自建document级监听还要处理「哪个entry是活跃视图」与chord冲突；日后做见 §3附录B。

## 2. 边界（不做，登记在 design 20 §7.3）

- 远端宿主侧打开（需ssh/http cookie注入 + UI明示，与「远程只用vscode部分」契约冲突）；
- fork官方catalog再扩本地应用集合之外的本地执行面（如「在终端里打开」的本地实现）；
- 主进程自行枚举本机应用（重开Batch 3 Phase 2关闭的红线）。

## 3. 附录：S3 / S4 完整形态（降级留档，未排期）

> 复核实测证据：全仓chamber代码 `navigator.clipboard`/`writeText` 零调用者（`main.ts:5699-5713` 只是放行 `clipboard-sanitized-write` 权限）；`execCommand(copy)` 仅出现于gateway独立安装页（`gateway/src/routes.ts:960`）；上游官方客户端只有一处槽位注册（`conversation.session.header.utilities`，id `open-in-app`，order -10），无剪贴板、无「无可用应用」出口（`controller.ts:39`：读取失败 ⇒ 空列表 ⇒ 不渲染按钮）⇒ S3/S4都是新增能力，不是「官方有而我们缺」。

### 附录 A · S3 全量形态（若要做「复制 ssh 命令 / 复制深链」）

- 事实面：渲染层拿不到ssh目标——`ChamberServerAggregate`（`sidebar/shared/aggregate-store.ts`）只有 `id/rawId/kind/transport/label`，无host/user/port；per-entry ctx只有instance id/transport/basePath/fingerprint。`ssh user@host` 与 `vscode://vscode-remote/ssh-remote+<host><path>` 的构造只在主进程（`deep-link.ts` 的 `buildVscodeRemoteUrl`）。
- 正确形态：在既有open-in IPC面上加只返回文本的方法，不把host/user/port抛给渲染层再拼URL（会造成第二份URI逻辑，违反「绝不手写平行副本」）：`link({appId, instanceId, path, sourceFingerprint}) → {ok:true, kind:url|ssh|path, text}`，通道命名沿用 `ipc-events.ts` 的 `OPEN_IN_APPS`/`OPEN_IN` 族。
- 必须原样复用 `runOpenInLaunch`（`desktop/open-in.ts:194+`）前5步（appId白名单→instanceId校验→路径校验（local Windows感知/remote POSIX）→ remoteCapable门→可用性复核），第6步由 `provider.open` 改返回文本；加测试断言「link路径从不调用provider.open」（零执行面）。`kind:url` 是否带 `newWindow` 需产品裁决（倾向不带）。
- 客户端：视图模型加第三类结局（可复制出口），门控按reason精细区分——有具体路径 + 来源无法启动（`transport-not-ssh`/`unknown-source`）才出复制项，「本地实例坏了」仍隐藏；出口落在官方 `ui-primitives` `Menu`（open-in菜单 = `open/autoFocus/dense/selection="fill"/align="end"` + `items: MenuItem{id,label,icon}[]`，主按钮与chevron组成anchor；chamber自有 `AccessibleAppMenu` 三件套已删，只留N-ctx归属守卫 `src/client/instance-view-guard.ts`）——复制项是 `items` 一员，走同一 `onSelect` 与可访问性语义，文案进本包typed字典；剪贴板被拒时显示成可选中输入框（不静默失败）。
- 验收：纯函数（reason→出口映射、门控不放宽）；管线（link与launch同一组拒绝分支）；IPC面锁步（`ipc-surface-mirror`）；实机两条（粘贴结果、无应用来源下按钮位置）。

### 附录 B · S4 全量形态（若日后要做多入口）

- 现状：launch面关在per-entry `apply(ctx)` 内（经 `injected()` 交给header），插件外部无句柄；侧栏是页级插件，已有页级桥 `chamberBridge`（`sidebar/shared/aggregate-store.ts`，生产者是各entry ctx）。
- 架构核心 = per-entry面注册表：`publishOpenInFace(sourceId, face)`/`getOpenInFace(sourceId)`，在 `apply(ctx)` 发布、`ctx.effect` 卸载时撤销；面带该entry的 `sourceFingerprint`（精确启动证明绑定entry，不读页面级「最新名册」）。落点二选一：(a) 侧栏既有 `sidebar/shared` 入口（已有跨包导入先例 + `assertSingletonModule` 单例纪律，倾向）；(b) open-in包自己的页级入口（归属清晰，但新增「侧栏依赖功能插件」方向）。
- 入口优先级：① 工作区头kebab（`ServerSection.tsx:1613-1628` workspace行菜单 + `:1585` 的 `+`「新建会话」已给菜单与动作词汇，改动最小、不碰parity）→ ② 会话行行菜单/右键（能力最有价值，但已有kebab；是「复用或加手势」而非新建菜单，待产品裁决）→ ③ 快捷键（只对活跃entry生效；不要每entry ctx各注册监听）。
- 任何入口都必须复用同一组门（合并视图模型 ≥1可用项；该行属于有具体路径的工作区），走同一个客户端适配器→`runOpenInLaunch`→provider，不允许侧栏另建IPC短路；报告语义与header一致。
- 验收：注册表发布/撤销/按id取用；门控（无路径、无可用项时菜单不出现）；「第二入口与header走同一适配器实例」断言（防平行实现）；实机（菜单位置与拖拽手势不冲突、chord不与输入框冲突、N-ctx下只在活跃来源生效）。
