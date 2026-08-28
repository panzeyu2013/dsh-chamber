# @dsh-chamber/dsh-client-ui-settings-connections

[English](README.md) | 中文

chamber 自研**连接设备页**设置分区插件（设计 05 §5）：向 dsh 设置面板的
`settings.section` 槽注册「连接 / Connections」入口（`id: 'connections'`，
order 30，排在 agent-presets 之后）。本分区是 chamber 连接管理器的应用内
管理面——不消费宿主帧，不触碰 dsh 运行时对象。

## 内容

- **本地实例卡**：/health 状态徽标、/api/connections 行（端口/label）、
  启动/停止（二次确认）、host 日志只读。
- **远程连接列表**：覆盖四种已交付组合（`dsh|gateway × ssh|http`），卡片展示
  label、端点、目标/传输徽标、phase，以及适用时的 systemd/日志投影；支持
  连接/断开、编辑、删除和 schema 驱动的虚线添加卡。

## 数据纪律

- 操作全走白名单 `desktop_ssh_*` IPC 与 `/api/connections`；表单收非秘密
  元数据（id/label/kind/transport/host/user/sshPort/remotePort/serviceName/
  remoteDshHome/insecureHttp/spkiPin；id 禁 `local`，端口 1–65535），并按能力
  独立显示 write-only 凭据：所有 SSH transport 可填 SSH 密码，所有 Gateway
  target 可填 token 和/或 Unicode 登录密码。add/edit 与非空凭据写统一走主进程
  `desktop_ssh_save_connection` 单事务；删除走精确 id-addressed
  `desktop_ssh_delete_connection`（不存在 id 为幂等 no-op）。legacy setter 仅 clear，
  `instances_set` 只接受当前规范化 roster 的同长度、同顺序、逐字段完全相同 no-op，
  不能 delete/add/edit/reorder。serviceName 必须匹配
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`，主进程固定执行
  `systemctl <action> -- <serviceName>`。
- secret 永不记日志、编辑时永不回填。主进程分别镜像到
  `<userData>/ssh-passwords.json` schema v2（0600 明文）与
  `gateway-secrets.json` schema v3（safeStorage 优先、诚实 0600 回退），持久
  endpoint/target binding 在注入前与 registry 复验；非空无 binding 旧文件
  fail closed 并要求重录。默认 SSH 认证仍走 ssh-agent/默认密钥。Gateway cookie
  隔离到精确 connection-target scope；generation/proof/refresh fence 阻止迟到认证结果
  注册到同 id 重建目标。配置 HTTPS SPKI pin 时，peer pin 匹配前主进程不发送登录、
  探针、HTTP 反代或 WS upgrade 的任何应用层字节。
- `~/.ssh/config` 自动发现仅投影非秘密字段（alias/hostName/user/port；
  IdentityFile/ProxyCommand/凭据永不投影），供添加表单选择填充。
- 端口语义：`remotePort` 为目标 HTTP 监听端口（SSH 的远端 loopback 目标或
  HTTP 直连端口）；`sshPort` 仅 SSH 使用且可选（null = ssh 默认/config Port）。
- 编辑 `serviceName` 或 `remoteDshHome` 是 transport + exec generation 变化：旧
  live/retry/probe 与 exec child 会被撤销，迟到日志/投影/结果不能提交到新配置。

## 样式

遵循 dsh 设计语言：CSS modules + `--dsw-alias-*` token + ui-primitives
（Button/Modal/Tooltip/Input/Pill/图标）。

## i18n

持有 `dsh-chamber.settings.connections` 字典命名空间（zh 键源；
`src/locales.ts`）。
