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
- **Remote connection roster**: all four shipped target/transport combinations
  (`dsh|gateway × ssh|http`), with label, endpoint, target/transport badges,
  phase, systemd/log projections where applicable, connect/disconnect, edit,
  delete, and a dashed add card opening the schema-driven modal form.

## Data discipline

- All operations ride the allowlisted `desktop_ssh_*` IPC and
  `/api/connections`. The form accepts non-secret metadata
  (id/label/kind/transport/host/user/sshPort/remotePort/serviceName/
  remoteDshHome/insecureHttp/spkiPin; id whitelist excludes `local`, ports
  1–65535) plus write-only credentials selected independently by capability:
  an SSH password for every SSH transport, and a Gateway token and/or Unicode
  login password for every Gateway target. Add/edit and nonempty credential
  writes use the single main-owned `desktop_ssh_save_connection` transaction;
  deletion uses exact id-addressed `desktop_ssh_delete_connection` (an absent
  id is an idempotent no-op). Legacy setters are clear-only and `instances_set`
  accepts only the exact unchanged normalized current roster; it cannot delete,
  add, edit, or reorder anything. serviceName must match
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`; main executes the fixed argv
  `systemctl <action> -- <serviceName>`.
- Secrets are never logged or prefilled. Main mirrors SSH passwords in
  `<userData>/ssh-passwords.json` schema v2 (fixed 0600 plaintext mirror) and
  Gateway credentials in `gateway-secrets.json` schema v3 (safeStorage when
  available, honest 0600 fallback), with durable endpoint/target bindings
  rechecked against the registry before injection. Nonempty unbound legacy
  files fail closed and require re-entry. Default SSH authentication remains
  ssh-agent/default keys. Gateway cookies are isolated to the exact connection
  and target scope; generation/proof/refresh fences prevent late authentication
  results from registering a recreated target. With an HTTPS SPKI pin, main
  sends no login, probe, HTTP-proxy, or WS-upgrade application byte before the
  peer pin matches.
- `~/.ssh/config` auto-discovery projects only non-secret fields
  (alias/hostName/user/port; IdentityFile/ProxyCommand/credentials are never
  projected) for the add-form's select-and-fill.
- Port semantics: `remotePort` is the target HTTP listen port (the remote
  loopback destination for SSH or direct endpoint port for HTTP); `sshPort`
  is SSH-only and optional (null = ssh default/config Port).
- Editing `serviceName` or `remoteDshHome` is a transport-and-exec generation
  change: old live/retry/probe work and exec children are cancelled, and late
  logs/projections/results cannot cross into the new configuration.

## Styling

The dsh design language: CSS modules + `--dsw-alias-*` tokens + ui-primitives
(Button/Modal/Tooltip/Input/Pill/icons).

## i18n

Owns the `dsh-chamber.settings.connections` dictionary namespace (zh key
source; `src/locales.ts`).
