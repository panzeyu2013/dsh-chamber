# @dsh-chamber/dsh-client-ui-settings-bridge

English | [中文](README.zh.md)

Chamber's self-built **settings shell** plugin (design discussion 2026-08): it
registers the 设置 / Settings shell into the `sidebar.settings` slot at a
LOWER priority (`-1`) than the official SettingsRoot registration, so the
official shell is shadowed — never conflicted: the official entry stays on
the ledger and its `settings.*` children declarations remain valid.

## Behavior

- A server dropdown over the selected instance; the panel mounts a
  **per-instance child cordis context** (fake connection + the official
  settings plugin subset) and renders the target instance's official
  settings sections — the bridge only proxies the existing
  settings/credentials/llm RPC surface.
- A fixed chamber-global **Connections** nav entry renders the
  settings-connections section from the chamber packages.
- Config facts stay on the target host: no chamber-side persistence, no new
  control-plane API.

## i18n

Owns the `dsh-chamber.settings.bridge` dictionary namespace (zh key source;
`src/locales.ts`); binds the `dsh-chamber.settings.connections` namespace for
the embedded connections section.
