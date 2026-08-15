# @dsh-chamber/dsh-client-ui-settings-connections

[English](README.md) | 中文

chamber 自研**连接设备页**设置分区插件（设计 05 §5）：向 dsh 设置面板的
`settings.section` 槽注册「连接 / Connections」入口（`id: 'connections'`，
order 30，排在 agent-presets 之后）。本分区是 chamber 连接管理器的应用内
管理面——不消费宿主帧，不触碰 dsh 运行时对象。

## 内容

- **本地实例卡**：/health 状态徽标、/api/connections 行（端口/label）、
  启动/停止（二次确认）、host 日志只读。
- **远程主机列表**：卡片含 label + user@host:port、phase 徽标、隧道
  localPort、serviceName、logSummary；连接/断开、按需 systemd 起停/查询、
  日志 Modal（logs / logs_clear）、编辑、删除，以及虚线「添加主机」卡 →
  Modal 表单。

## 数据纪律

- 操作全走现有 `desktop_ssh_*` IPC 与 `/api/connections`；表单收非秘密
  元数据（id/label/host/user/sshPort/remotePort/serviceName——id 白名单
  `^[a-zA-Z0-9_-]+$`，端口 1–65535）外加**可选 SSH 密码**（05 §8 例外，
  明文文件兜底）：经 `desktop_ssh_set_password` 转发主进程（内存 +
  `<userData>/ssh-passwords.json` 明文镜像，0600 原子写，重启后自动连接
  可用）——永不记录、编辑时永不回填（存值永不回传 renderer）。默认认证
  仍走系统 ssh-agent/默认密钥。
- `~/.ssh/config` 自动发现仅投影非秘密字段（alias/hostName/user/port；
  IdentityFile/ProxyCommand/凭据永不投影），供添加表单选择填充。
- 端口语义：`remotePort` 为远端 127.0.0.1 上 dsh web 监听端口（隧道目标，
  必填）；`sshPort` 可选（null = ssh 默认 22 / config Port）。

## 样式

遵循 dsh 设计语言：CSS modules + `--dsw-alias-*` token + ui-primitives
（Button/Modal/Tooltip/Input/Pill/图标）。

## i18n

持有 `dsh-chamber.settings.connections` 字典命名空间（zh 键源；
`src/locales.ts`）。
