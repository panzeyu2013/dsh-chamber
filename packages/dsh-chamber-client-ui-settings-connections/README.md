# @dsh-chamber/dsh-client-ui-settings-connections

English | [中文](README.zh.md)

Chamber's self-built **Connections** settings section plugin (design 05 §5): it
registers the 连接 / Connections entry into the dsh settings panel's
`settings.section` slot (`id: 'connections'`, order 30, after agent-presets).
The section is the chamber connection manager's in-app administration face —
no host frames, no dsh runtime objects.

## Content

- **Local instance card**: /health status badge, the /api/connections row
  (port/label), start/stop (with confirmation), and read-only host logs.
- **Remote host roster**: cards with label + user@host:port, phase badge,
  tunnel localPort, serviceName, logSummary; connect/disconnect, on-demand
  systemd start/stop/query, a logs modal (logs / logs_clear), edit, delete,
  and a dashed "add host" card opening the modal form.

## Data discipline

- All operations ride the existing `desktop_ssh_*` IPC and
  `/api/connections`; the form accepts non-secret metadata
  (id/label/host/user/sshPort/remotePort/serviceName — id whitelist
  `^[a-zA-Z0-9_-]+$`, ports 1–65535) plus an **optional SSH password**
  (design 05 §8, plaintext-file fallback): forwarded via
  `desktop_ssh_set_password` to the main process, which holds it in memory
  and mirrors it to `<userData>/ssh-passwords.json` (0600, atomic write) so
  auto-connect works after restart — never logged, never prefilled on edit
  (the stored value never returns to the renderer). Default authentication
  stays the system ssh-agent / default keys.
- `~/.ssh/config` auto-discovery projects only non-secret fields
  (alias/hostName/user/port; IdentityFile/ProxyCommand/credentials are never
  projected) for the add-form's select-and-fill.
- Port semantics: `remotePort` is the dsh web listen port on the remote
  `127.0.0.1` (the tunnel target, required); `sshPort` is optional (null =
  ssh default 22 / config Port).

## Styling

The dsh design language: CSS modules + `--dsw-alias-*` tokens + ui-primitives
(Button/Modal/Tooltip/Input/Pill/icons).

## i18n

Owns the `dsh-chamber.settings.connections` dictionary namespace (zh key
source; `src/locales.ts`).
