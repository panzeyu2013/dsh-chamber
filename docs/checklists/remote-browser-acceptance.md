# Remote Browser 验收清单（design 28）

状态：开放项清单；自动化证据与真机步骤分开。不要在本文件记录版本号、批次日志或已完成的叙事。

## 0. 前置

- 当前 pin 的 vendor 树已填充（`vendor/harness-checkout` 非空）。
- `node_modules` 已安装；锁文件与 workspace 一致。
- 有一个可用的 SSH 源（dsh + ssh），或按 B/C/D 使用临时本地夹具。
- 只对 dsh + ssh 源出现入口；local/http/gateway 不出现。

## A. 自动化（Linux，已可在本仓库跑）

~~~sh
node --test packages/desktop/test/forward/*.test.ts
node scripts/gates/verify-test-wiring.mjs
node scripts/gates/verify-no-dead-exports.mjs
node scripts/gates/verify-import-cycles.mjs
node scripts/gates/verify-file-budgets.mjs
node scripts/gates/verify-package-boundaries.mjs
node scripts/gates/verify-shim-payload-shape.mjs
node scripts/gates/verify-md-links.mjs
~~~

- `forward-real-ssh.test.ts`：临时 sshd + 真实 `ssh -N -L` + alias HTTP 取回 + release；key-auth，Linux/root。
- `forward-spawn.test.ts`：真实 spawn + `/proc` start-time + ledger + 幂等 stop。
- `forward-windows.test.ts`：CIM/CommandLineToArgvW 纯解析；真实 Windows 见 C。
- 期望：全部绿；非 Linux/非 root 的 real-ssh 用例自动 skip。

## B. Askpass（真机/特权环境）

本仓库的 Linux 测试环境 `/etc/shadow` 只读，不能在自动测试里安全建临时密码账户；用一次性主机或容器执行：

1. 用一次性用户/容器启动 sshd：`PasswordAuthentication yes`、`UsePAM yes`、仅监听 127.0.0.1，临时 authorized_keys 不需要。
2. 让 askpass 脚本只回显测试密码；`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force` 经 launcher 的 lease env 注入。
3. 请求一个 remote loopback 端口的 forward；期望 bound，alias URL 可取回测试 HTTP body。
4. release 后：子进程退出、ledger 清空、askpass lease 释放恰好一次；无密码/URL 进日志环。
5. 测试结束删除临时用户/容器；不得改真实 `/etc/shadow`。

## C. Windows（真机）

1. 真实 `ssh` + 密钥/agent 源；确认 launcher 的 `spawn` 为 `shell:false`、`detached:false`、`pgid:null`。
2. 启动 forward；确认 CIM 查询得到 `CreationDate`/完整 `CommandLine`，ledger 的 start-time 与 probe 三元匹配。
3. 关闭应用后重启：reaper 只 kill 证出身份的子进程；无法证明身份时保留记录、0 kill。
4. release/quit：`taskkill /PID <pid> /T /F`，无 Job Object；子进程树无孤儿。
5. ACL 复核失败时 fail-closed（不杀）。
6. 若任一不成立，记录为 Windows 实机阻塞；不要用纯逻辑测试替代。

## D. macOS（真机）

1. 启动 forward；确认 alias 绑定、HTTP 取回。
2. kill -9 应用后重启：`ps` argv 无法逐字还原时 reaper **不杀**、保留 ledger（设计 28 的 fail-closed 取舍）；确认没有误杀。
3. release/quit：POSIX 进程组 TERM→KILL 生效。
4. 如需让 macOS 具备自动回收，先单独评审 exact-argv 适配器（不要以“近似 argv”替换）。

## E. S2 GUI 走查

1. 右栏指南/标签只在一个 dsh+ssh 源出现；local/http/gateway 不出现；缺 `sidebarRightTabs` 时诚实缺席。
2. 地址栏公网 URL → 系统浏览器；无 forward。
3. 地址栏 `http://127.0.0.1:<port>/path` → ensure forward → 系统浏览器 alias URL；https 透传并给证书警告。
4. 两 source 同端口：各自 alias；cookie 探针隔离；不存在共享 127.0.0.1。
5. 端口冲突 → ephemeral；stale/重开；console 关闭不杀；退出回收。
6. 错误/上限/no-bridge/空态/a11y（role=alert/status）可见。
7. per-port 确认：5173 确认后，5174 再次弹窗；同端口不再弹；dialog 期间 retarget 返回
   `confirmation_late` 且没有新 listener。
8. 官方 `ui-sidebar-browser` 未同时出现；若加载，走 F。

## F. 官方行 skip（vendor 证据）

1. 在当前 pin 的 `bundle/*/cordis.patch.yml` 与 web profile 中确认 `ui-sidebar-browser` 行是否加载。
2. 若加载：把该行加入 covered/skip 家族③，补 design 09 §3.5 和 host-graph 负例；不要只靠不同 kind 掩盖重复入口。
3. 若不加载：保留 TODO/证据指针；`upstream-touchpoints` 的 not-applicable 不是证据。
4. 无 vendor 树时不得声称已验证。

## G. 构建/锁文件

~~~sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm run typecheck:browser
pnpm run build:renderer
pnpm run build:preload
pnpm run build:sidecar
pnpm run test:swift      # darwin
pnpm run test:macos      # darwin
pnpm run check:full
~~~

期望：锁文件无 diff；新包/chunk budget 通过；bridge manifest 56/9/65；surface 11/63/54/9；packaging closure 95；GUI walkthrough 通过。

## 验收记录

- 在 `docs/progress/STATUS.md` 只保留仍开放的项；完成项移入设计/发布记录。
- 每条失败给出：命令、平台、源类型、错误码、是否 fail-closed、是否阻塞发布。
