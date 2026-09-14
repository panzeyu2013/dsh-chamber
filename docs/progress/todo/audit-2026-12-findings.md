# 2026-12 四路审计发现台账（A1–A5）

> **性质**：审计台账，不是承诺、不是变更史。每条 = 一条已确证的发现（或标"疑似"待补证据），
> 修完 / 裁决后**直接删条**，不保留历史。确证标准的门槛 = 有实跑证据（脚本、夹具或端到端复现），
> 纯静态推断进"疑似"节。
> **来源**：A1 = task-11 状态呈现面普查（报告 `/tmp/task-11-report.md`，实跑
> `/tmp/audit-local-overlay2.mjs`、`/tmp/audit-cross-instance-rev.mjs`）；A2/A3 = task-13 判定聚合与
> 尺度错配普查（实跑 + 三个受限子代理，owner 逐条源码复核）；A4/A5 = task-12 测试接线与产物新鲜度普查；
> 对抗复核 = task-14/task-16。相关设计：design 21 §6.11、design 17 §9.4。
> **锚点漂移说明**：下列 file:line 是审计当时读到的 revision；已复核漂移的两处已在条内标注现值
> （F1 的 `localOverlayCarriesInsert` 现于 `packages/desktop/plugin-sync.ts:1030-1038`；overlay 生成
> 调用现于 `packages/control-plane/src/index.ts:623-632`）。
> **严重度**：高 = 起不来 / 数据丢失 / 永久假状态；中 = 可复现的错误结论或门禁假绿；低 = 文案 / 清理；
> 潜伏 = 前提今天不成立、条件出现即踩中。
> **状态**：已修 / 已派修(task-XX) / 未动 / 需产品裁决（"可能是有意为之"，由产品决定是否算缺陷）。
> A5（产物守卫缺口）单列一节并指向 [product-freshness-guards.md](product-freshness-guards.md)。

## A1 状态呈现面（7 条确证）

**F1 本地 chamber 行 `patched` 双向假状态** —— 高【最高爆炸半径】
- 证据：探针只读 overlay 文件 `packages/desktop/plugin-sync.ts:1030-1038`（审计时 `:1008-1016`，赋值
  `:860`）；overlay 生产端把**已在 profile patch 的行省略**、无 insert 时返回 null 且不删旧文件
  `packages/control-plane/src/index.ts:623-632`；两个挂载源 = profile `cordis.patch.yml`
  （`vendor/harness-checkout/packages/boot/app-boot/src/profile.ts:806-810`）∪ spawn `--patch`
  （`packages/control-plane/src/spawn-dsh.ts:232-236`）；呈现 `packages/dsh-chamber-client-ui-settings-connections/src/client/plugin-inventory-text.ts:711`。
  实跑双向复现：行在 profile patch 无 overlay ⇒ 徽标「未注入」而树里**有**；行只在旧 overlay 而本次
  spawn 不传 `--patch` ⇒ 徽标「已注入」而树里**没有**。
- 建议：`patched` 只答「该行是否真会出现在组合树」= overlay ∪ profile patch ∪ 本次 spawn 是否带
  `--patch`；拿不到事实退中性（沿用 T3 的诚实上限）。
- 状态：**已派修（task-20）**

**F2 安装结果无条件承诺「下次重启生效」** —— 中（需产品裁决：承诺口径）
- 证据：`PluginDialog.tsx:972/1005/1027/989-992/1069/1994` + `locales.ts:226/289/363`；反证 =
  `vendor/harness-checkout/apps/cli/src/plugin.ts:63-89`（未声明 `dsh.bundle` 的包只装成普通依赖，
  命令仍成功）⇒ 对普通库是假承诺，且与同屏已改为中性的状态格自相矛盾。
- 建议：按行分类分级承诺（bundle 层才说重启生效；plain/client 只说「已安装」）。
- 状态：未动

**F3 `materializeLive`「已安装并已重启生效」把 restart+ready 当 live** —— 中（需产品裁决：承诺口径）
- 证据：`PluginDialog.tsx:1058` + `locales.ts:301`；事实源只到「op settle + restart 被接受 + 就绪轮询 ok」
  （`packages/desktop/gateway-provider.ts:2049-2080`；`packages/renderer/src/global.d.ts:485-488` 甚至把
  `outcome.restarted` 文档化为"live now"）。上传普通库或 fiber `failed` 的插件同样得到该横幅。
- 建议：引入行级真实状态（Loader inventory）再谈 live；否则文案降级为「已应用并重启」。
- 状态：未动

**F4 `instance-version-conflict` 断言「插件版本不同」而数据无法建立该断言** —— 中-高
- 证据：判据 `client-plugin-loader.ts:206-214`（唯一输入 = 不同 source id + 不同 `rev`）→ 文案
  `host-graph.ts:791-805`；`rev` 是 per-process 随机 nonce（`vendor/…/client/modules/src/index.ts:529`、
  `:868-871`）⇒ 同版本双实例必假报，且"对齐版本"修不掉；实跑：45 个 client 行中 6 个不在
  `CHAMBER_COVERED_IDS`（`dsh-client-resources`、`ui-sidebar-right`、`ui-sidebar-documentpreview`、
  `ui-sidebar-files`、`ui-cordis`、`ui-schedule`）。测试 `packages/renderer/test/host-graph.test.ts:787-812`
  正是在钉该文案而没有版本证据。
- 建议：要么去掉"版本"断言（改为"实例提供的该行实现不同/无法比较"），要么改用真实内容事实。
- 状态：未动

**F5 同源 `restart-required` 的「另一版本」** —— 低-中
- 证据：`host-graph.ts:806-810`——同一实例重启一次（字节不变、nonce 变）即报"另一版本"；补救（重启应用）
  正确，版本前提不成立。
- 建议：文案改为"页面已加载的实现与本次启动不同"。
- 状态：未动

**F6 sidebar recheck 把 boot 会拒收的图 heal 成 `ok`** —— 中-高
- 证据：`plugin-graph-recheck.ts:198-212` 只校验 `id/url/rev` 后 `report('ok')`，而 boot 还校验
  `inject`/`external`/`immediately` 且抛错（`host-graph.ts:251-266`）；自动触发
  `dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.tsx:419-441`。实跑：`{external:42}` ⇒
  boot 抛「external must be a string array」并丢全部 extra，recheck 写回 `{"state":"ok"}` ⇒ 卡片「正常」。
- 建议：recheck 复用 boot 的同一行校验函数（单一来源），校验失败必须报 degraded 而非 ok。
- 状态：未动

**F7 ssh ④ bundle 断言用本地 `bundleLines` 判远端** —— 中
- 证据：`packages/desktop/main.ts:3521-3532`（`knownBundles = localPluginList(localDshHome, …)`）→
  `plugin-sync.ts:1329-1360`（`knownBundles.includes(name) && !bundles.includes(name)` ⇒ `verified:false`）。
  场景：本地 `foo@2`（声明 bundle）、远端装 `foo@^1.0.0`（不声明）⇒ 远端安装成功却报"校验失败"；反向则
  整段断言被跳过。
- 建议：改读远端自身 `dsh.bundle` 事实（远端 package.json 已 read）。
- 状态：未动

### A1 疑似（6 条，需补证据或当前无害）
- **S1 recheck 的 `ok` 没有"行已装载"事实**：`plugin-graph-recheck.ts:212`；`degraded-retry.ts` 大幅缩小
  可达性。需证据：retry 用尽后通道恢复且未重挂，诊断仍翻 ok。状态：未动
- **S2 `clientPluginRowLoaded` 提前为真**：`client-plugin-loader.ts:253` 在 await 前登记 id，超时墓碑也保留
  （`:281-288`）；当前无产品消费者 ⇒ 潜伏。状态：未动
- **S3 `writerReasonKey` 默认译成「身份无法核对」**：`writer-diagnosis.ts:63-74`；原始 token 旁可见 ⇒ 低。
  状态：未动
- **S4 `chamberRemoteKey` 家族级匹配**：`plugin-inventory-text.ts:145-172` 匹配任意同族 entry；当前不可达
  （mobile 是精确等价）⇒ 潜伏。状态：未动
- **S5 chamber 同步「已同步并已触发重启」不区分 restart 被拒**：`PluginDialog.tsx:883-891` +
  `gateway-provider.ts:1467-1484`（restart 被拒只 `logger.warn`，仍返回 `uploaded:true`）⇒ 低。状态：未动
- **S6 死/写-only 加载器 API 与过期注释**：`host-graph.ts:836-841` 写入无人读的 map；
  `cachedSourceClientGraph`/`clientPluginRowLoaded`/`notePluginMounted`/`clientRowSignatures` 无产品消费者。
  状态：未动（清理）

## A2 尺度错配（7 条确证）

**A2-1 ustar 100 字节名字段用 UTF-16 单元数判定** —— 高
- 证据：`packages/desktop/plugin-tarball.ts:382`（同 `:400`）`archivePath.length > 100` vs
  `header.write(name,0,'utf8')`（`:133`）。实跑：`中文目录×10/` = 49 单元 / 129 字节 ⇒ 构建与 entries 全报
  全名，gunzip 后 header 名字被截断（发出的归档 ≠ 校验的归档）。
- 建议：`Buffer.byteLength(archivePath,'utf8') > 100`（两处）+ 100/101 字节边界回归。
- 状态：**已派修（task-17）**

**A2-2 `listTgzManifest` 按归档顺序取第一个候选** —— 高
- 证据：`plugin-tarball.ts:507-531`（候选表 `:482`）返回第一个可解析 manifest，而 pnpm 装的是
  `package/package.json`（`gateway/src/routes.ts:1483-1489` 原文）。实跑：无辜名 `package.json` 在前 ⇒
  `classifyPluginPick` 返回无辜名 ⇒ 受保护判定作用在错误名字上；gateway 有真名复核，ssh/local 没有
  （消费点 `plugin-sync.ts:2353-2374`、`main.ts:3985-4061`）。
- 建议：优先 `package/package.json`，其余候选仅兜底；自称名 ≠ 安装路径名 ⇒ 响亮失败（`identity_mismatch`）。
- 状态：**已派修（task-17）**

**A2-3 gateway `tgz-scan` manifest 捕获只开不关 + oversized 粘性 + 无界** —— 高
- 证据：`packages/gateway/src/tgz-scan.ts:189-196/224-231/244`（捕获打开后追加后续每个 entry 数据区 ⇒
  `:156` JSON.parse 必 invalid）；实跑：desktop 造的合法归档只要 `package.json` 之后有文件 ⇒
  `{ok:true, manifest:null, manifestError:'invalid'}` ⇒ `routes.ts:1490-1496` 以 400 `tgz_invalid` 拒收；
  `manifestOversized` 粘性（先大后小的合法 manifest 被拒）；捕获无界（64 KiB 上传 ⇒ RSS +255 MiB）。
- 建议：entry 数据区结束即关闭捕获；oversized 只对候选生效；加上界；回归"manifest 在前 + 后续大文件"。
- 状态：**已派修（task-17）**

**A2-4 dsh-runtime `apply-phase` 用内建哨兵比 packaged semver** —— 中
- 证据：`packages/dsh-runtime/src/apply-phase.ts:256`（`targetIsBuiltin && pendingVersion !== opts.builtinVersion`）
  左 = `BUILTIN_ANCHOR_VERSION_TOKEN='builtin-anchor'`（`dsh-runtime-store.ts:233/555/586/667-741`，`:227-233`
  与 `:672-677` 明示只对 non-builtin 比 targetVersion）右 = semver。实跑：带哨兵 journal 的启动 ⇒ 每次
  failed/journal/runtimeBlocked（retryAction null ⇒ 什么都不消费）。同一等式在 `desktop/main.ts:4700-4703`、
  `gateway/runtime-manager.ts:1009-1013` 重复。
- 建议：phase 边界归一化（builtin 时不做版本相等），三处共用同一谓词。
- 状态：未动

**A2-5 `registry-metadata` prerelease 排序反了** —— 低（潜伏）
- 证据：`dsh-runtime/src/registry-metadata.ts:289-305` 的 `compareVersionsDesc` 对 prerelease 前缀对判反：
  `1.0.0-alpha` vs `1.0.0-alpha.1` 判前者更大；正确尺子在 `dsh-runtime-updater.ts:141-174`。消费点 `:235`、
  `:270-279` ⇒ 无 dist-tags 时 latest 选到更旧的。今日 npm 无前缀对 ⇒ 潜伏。
- 建议：复用 `dsh-runtime-updater` 的比较器（单一来源）。
- 状态：未动

**A2-6 `host-graph-seed` 原始字节 vs utf8 串** —— **潜伏**（Lead 已裁决，严重度下调）
- 证据：`packages/control-plane/src/host-graph-seed.ts:478` `sourceBytes.equals(Buffer.from(current))`，
  右 = `readPrivateFileNoFollow` 的 utf8 解码串（`private-file.ts:261`，`:267` 断言字节数一致）⇒ 非 UTF-8
  种子产物第二次 sync 就 throw，而该调用在每次 spawn 的 patchPath 内 ⇒ 实例起不来。
- **裁决**：当前 `HOST_PACKAGE_SEED_FILES` 只含 `package.json` + `dist/index.js`（均为文本），open-in 图标
  写在 workDir 而非种子文件；且 `readPrivateFileNoFollow` 自身对非 UTF-8 响亮失败 ⇒ **今天不会触发**。
  按"潜伏陷阱"登记：一旦有人加入二进制种子文件即踩中。
- 建议：改字节级比较（`Buffer.compare` / 保存原始 Buffer），并加一条"非 UTF-8 种子文件"回归。
- 状态：未动（潜伏）

**A2-7 controller 读原始 `pending` 而其它位置读 `effectivePending`** —— 中
- 证据：`packages/desktop/dsh-runtime-controller.ts:461-462` vs `:375-377`
  （`override-lifecycle.ts:71-75`：shellVersion 变化/invalidatedAt 置位后 effectivePending 为 null）⇒
  allowedActions 仍给 `install`，而 `install()` 静默 no-op（无 error、deps.install 0 次）。
- 建议：门与动作统一读 `effectivePending`。
- 状态：未动

## A3 聚合吞掉未检项 / 读失败当确定结论（15 条确证）

**A3-1 C12 两锚点同时漂移 ⇒ 只 note 不违规** —— 中-高（需产品裁决：未物化 note 的边界）
- 证据：`scripts/dev/verify-upstream-touchpoints.mjs:1037-1040` + `plugin-protection-gate.mjs:160-189`；
  实跑：树已物化、仅两锚点改名 ⇒ `{violations:[], notes:["C12 跳过：vendor/harness-checkout 未物化…"]}` 绿。
- 建议：以"子模块是否物化"（目录存在）而不是"锚点是否可读"决定 note/违规；两者可读性独立成违规。
- 状态：未动

**A3-2 C7 双侧声明形态同时改名 ⇒ `0===0` 绿且无 note** —— 中（需产品裁决）
- 证据：`verify-upstream-touchpoints.mjs:505-533`；实跑：单侧改名红、双侧改名绿（空列表打印 `✓`）。
- 建议：两侧解析结果任一为空即违规。
- 状态：未动

**A3-3 C10 esbuild 不可用 ⇒ 活字面量臂跳过但仍打「全部通过」** —— 中（需产品裁决）
- 证据：`verify-upstream-touchpoints.mjs:938/:956-1000/:996-997`；REQUIRED 六锚仍走 `includes`，降级的是
  未登记活字面量臂。
- 建议：skipped 臂计入 exit 码或至少把"全部通过"文案改为"部分跳过"。
- 状态：未动

**A3-4 C8 `--no-artifact-rebuild` 零受检项也 ✓** —— 低-中（需产品裁决）
- 证据：`verify-upstream-touchpoints.mjs:592-617`（artifact/src 不存在即 `continue`）却打印
  `✓ C8 生成物 mtime 新鲜（advisory 模式）`。
- 建议：零受检项显式报"0 artifacts checked"并计入 exit 码（advisory 模式可保持 0）。
- 状态：未动

**A3-5 `restore-lockfile-vendor-records --check` 四种假通过** —— 中-高
- 证据：`scripts/dev/restore-lockfile-vendor-records.mjs:171-188` + `:245-248`；实跑四种夹具（空 lockfile /
  仅头 / 无 `importers:` 段 / 记录被裁 + 链接树未物化）全 exit 0 并报"记录完整"。补偿控制 =
  `ensure-harness-vendor.mjs:217-233` 的对称差断言（更晚、另一个脚本）；`--check` 未接 CI。
- 建议：区分"确认无需修复"与"没读到可比对的事实"；把 `--check` 接进 CI。
- 状态：未动

**A3-6 `release-preflight` 未读包计入覆盖** —— 中
- 证据：`scripts/dev/release-preflight.mjs:106` `try{pkg=readJson(rel)}catch{continue}`，而 `:103` 已把该包
  计入 `packageCount` ⇒ 坏 JSON 包被跳过而文案称"across root+N packages"。
- 建议：读失败计入 mismatches（或从计数里剔除并响亮列出）。
- 状态：未动

**A3-7 `protected-plugins` 零检查与检查通过不可区分** —— 中（需产品裁决）
- 证据：`packages/control-plane/src/protected-plugins.ts:790`（`modulesDir` 缺失 ⇒ `{ok:true,checked:0}`，
  **无** `skipped`）；调用方只看 `skipped`（`desktop/main.ts:2029-2036`、`gateway/plugins-exec.ts:855-885`）。
  实测第三种：树里只有直接依赖（全 `continue`）⇒ 同样 `{ok:true,checked:0}`。
- 建议：区分"没有什么可查"（正常）与"该查的没查到"（skipped），或让调用方消费 `checked`。
- 状态：未动（需产品裁决：是否为有意口径）

**A3-8 gateway manifest 读失败 ⇒ 把合法 staged `.tgz` 当孤儿删除** —— 高【最高爆炸半径】
- 证据：`packages/gateway/src/plugins-tasks.ts:766-776`（+ `:803-821`）；读失败（超 1 MiB / 父目录 symlink /
  权限）⇒ `referenced` 空集 ⇒ `rmSync` 所有 staged 文件，只留 `removed N orphaned`。读面
  `plugins-installed.ts:141-186` 明确区分 absent/corrupt。
- 建议：读失败**绝不删**，响亮标记并跳过清理；只有成功读取且确认无引用才清理。
- 状态：**已派修（task-18）**；失效判据：读失败夹具下 staged 文件仍在、preImage 保留、日志说明跳过原因。

**A3-9 gateway journal 损坏 ⇒「已对账、无待处理」+ preImage 被清** —— 高【最高爆炸半径】
- 证据：`packages/gateway/src/plugins-journal.ts:208-229/:324-346` + `plugins-tasks.ts:740-754`；损坏
  journal 解析失败返回 `[]` ⇒ 打印"no pending operations carried over"、childPid 永不 reap，随后
  `pruneAndClean` 把丢失 op 的 preImage 当无主清理。子代理以截断 JSON 跑通。
- 建议：损坏与空可区分（原始文件留证 `.corrupt`），跳过依赖"无 pending"的一切清理。
- 状态：**已派修（task-18）**；失效判据：截断 JSON 夹具下不打印"无待处理"、preImage 仍在、原始字节留证。

**A3-10 desktop 本地 manifest 读不到 ⇒ 归 `plain` ⇒ verifyApplied 的 bundles 臂跳过** —— 中
- 证据：`packages/desktop/plugin-sync.ts:805-808`（+ `:1082-1088`、`:1376`）⇒ `appliedPlugins` 返回
  `verified:true`（调用方只在 `verified:false` 时响亮）。
- 建议：读不到就 `verified:false` + 理由（与 F2 文案分级一起修）。
- 状态：未动

**A3-11 desktop `familyNames` 空事实 ⇒ 零检查零日志** —— 中
- 证据：`packages/desktop/main.ts:2033` `if (!Array.isArray(facts.familyNames) || facts.familyNames.length === 0) return { ok: true }`；
  对照 verifier 自己把空族当**事实**（`protected-plugins.ts:769` 的 pin：空族 + 影子仍报 `outside-family`），
  gateway 侧 null 也会 warn（`plugins-exec.ts:829-883`）。
- 建议：把空族当事实跑（或至少响亮记录跳过）；与 A3-7 的口径一起裁决。
- 状态：未动

**A3-12 ssh journal 损坏 ⇒「没有可撤销的最近成功变更」** —— 低-中
- 证据：`packages/desktop/ssh-plugin-journal.ts:234-265` + `main.ts:3572-3573` + `PluginDialog.tsx:680-681`；
  模块有 warn，用户面结论与"从没成功过"混同。
- 建议：`unavailable` 加 `journal-corrupt` 通道并如实渲染。
- 状态：未动

**A3-13 `listRuntimeFailures` catch ⇒ `[]`（读失败 = 没有失败记录）** —— 中
- 证据：`packages/dsh-runtime/src/dsh-runtime-store.ts:1130`；同包其它列举区分 ENOENT
  （`:1189-1191` corrupt、`:1243-1245` 保护）。实测 chmod 000 ⇒ list=[]、summary count=0，而 sibling 仍
  corrupt/protect-all。
- 建议：errno 分类（ENOENT = 空；其余 = corrupt/unknown 并响亮）。
- 状态：未动

**A3-14 known-good 的 `.corrupt` 改名无人读 + 两个读者结论相反** —— 高
- 证据：`dsh-runtime-store.ts:993`（corrupt==missing）、`:1216`（corrupt ⇒ 保护全部）、`:1021-1024`
  （quarantine 改名 `known-good.json.corrupt` 后无人再读，随后写只含新版本的新表）⇒ 一次晋升后 1.1.1 从
  known-good 消失、`latestKnownGood=null`、`isProtectedVersion=false`、`evict keep=0` 会删它；而
  `latestKnownGood` 是 rollback target（`main.ts:4675/4685`）。子代理跑通。
- 建议：known-good 的 corrupt 走与 override 家族同一条留证 + 保护路径，或统一"corrupt 即保护"。
- 状态：未动

**A3-15 snapshot 根不是目录 ⇒ `[]` 且 `skippedReason:'none'`** —— 中
- 证据：`packages/dsh-runtime/src/snapshot-store.ts:1012-1013` + `:1085`；文档语义 `'none'` = "ran to
  completion"，而实际是"没看"。
- 建议：非目录给独立 skippedReason（unreadable/corrupt），文案不改写成"无事可做"。
- 状态：未动

### A3 疑似（13 条，需补证据）
- **S1** `release-preflight.mjs:151` 用首个 `@deepseek-ai/dsh@<ver>`、C10 用 importer specifier
  （`verify-upstream-touchpoints.mjs:770`）——今日同值。需：两个 dsh 版本且不同的锁文件夹具。
- **S2** `release-preflight.mjs:198` 统计 "consistent" 行数但不断言 5；PAIRS 清空时会以 "0 pairs" 通过。
- **S3** `preflight-vendor-pin.mjs:220-224` `catch{published=false}` 把 npm view 失败与"未发布"混同（advisory）。
- **S4** `gateway/runtime-manager.ts:940-943` 空探针数组 ⇒ `failed.length===0` ⇒ null（=全过）；对照 `:2487-2489`。
- **S5** `gateway/plugins.ts:171-186` 缓存 manifest 非 JSON ⇒ `version:null` 无日志（与"从未 sync"同值）。
- **S6** `gateway/plugins-tasks.ts:887-910/:944-947` `acceptedInRun` 先减后加的可重入计数。
- **S7** `dsh-runtime/activation-gate.ts:162-174` `expectedNames` seam：`decideVerdict([], {expectedNames:[]}) === 'pass'`（树内无调用者传 []）。
- **S8** `dsh-runtime-store.ts:1320-1321` unsafe store-prune marker ⇒ null（静默永久不执行）。
- **S9** `desktop/plugin-tarball.ts:352-353` vs `:452` package.json 两次读（folder_changed 参照第二次读；窗口可达性未知，gateway 路由 fail-closed）。
- **S10** `desktop/ssh-apply-rows.ts:222-229` 撤销分支信任 journal 里的 name（下游会再校验 ⇒ 仅困惑性报错）。
- **S11** `desktop/ssh-plugin-journal.ts:195-225` sanitizeOps 静默 continue，最新 ok 被丢弃时会把更旧的当 latest。
- **S12** `ci.yml:206-222` smoke 步接受显式 `SKIP` 并记 job 绿——文档化取舍，但"从未执行"与"执行并通过"在 run 级不可区分（STATUS 已单列）。
- **S13** `ci.yml:96` 注释称 C8 skipped build 是 "loud warning"，与 `artifact-gate.mjs:95-103`（skipped = 硬失败）矛盾——文档漂移，行为更严。

## A4 测试接线

无确证的漏登记。唯一背景项——`packages/control-plane/test/protected-plugins.test.ts` 未进 runner——**已修**：
该文件已在 `packages/control-plane/scripts/test.mjs:67/:79`（POSIX + win32 两处），头注里失效的引用也已改为
release-checklist §3（task-16 #7 复核通过）。

## A5 产物新鲜度守卫缺口

- **已加守卫**（"存在但缺当前标记 ⇒ 失败 + 重建命令"）：`packages/desktop/dist/control-plane/**`
  （`packages/desktop/scripts/control-plane-freshness.test.mjs`）、`packages/gateway/dist/**`
  （`packages/gateway/test/build-smoke.test.ts`）。
- **仍无守卫**（陈旧不会被任何测试发现）：`packages/desktop/dist/web/**`、`dist/preload.cjs`、
  `dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`、`packages/gateway/host-packages/**`
  （只有存在性断言）、vendor `allowBuilds` 锁步（`pnpm-workspace.yaml` ↔
  `packages/dsh-runtime/src/allow-builds.mjs`）、`packages/renderer/src/generated/**`。
- 产物普查表（9 行）与 8 条最小守卫建议 G1–G8（P0/P1/P2，含适用产物/成本/收益）见
  [product-freshness-guards.md](product-freshness-guards.md)；STATUS 的类级条目与失效判据见
  「产物新鲜度守卫只覆盖两个产物」。
