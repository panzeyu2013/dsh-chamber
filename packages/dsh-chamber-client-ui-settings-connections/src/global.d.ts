/**
 * The window.dshChamber page bridge as consumed by the connections section
 * (desktop preload.cts, design 05 §3.3). Mirrors the renderer's
 * global.d.ts declaration structurally (interface merging): returns/events/
 * projections are non-secret — never a tunnel URL or credential material;
 * save_connection alone accepts transient write-only credential input.
 */

import type { DshChamberBridge } from '../../renderer/src/global.d.ts'

/**
 * The whole IPC/type face is RE-EXPORTED from the renderer's authoritative
 * global.d.ts — the single source of truth (settings-bridge pattern). A
 * structural mirror here would drift silently (2026 review T1); the
 * ipc-surface-mirror test guards the renderer side against the preload.
 * `TransportKind` is the v2 target union (`dsh | gateway`) and
 * `TransportMethod` is the orthogonal mechanism union (`ssh | http`). The gateway
 * legacy clear-only login-password setter (`set_gateway_password`) and the read-time
 * `passwordSet` projection live on the authoritative renderer surface too
 * (desktop gateway-secrets task, design 17 §7.1/§9.1) — the former
 * plugin-local seams (GatewayPasswordSurface / PasswordSetProjection) were
 * retired when they landed there. The `sshPasswordSet`/`tokenSet`/
 * `passwordSet`/`secretStorage` projections are merged by the main process
 * on `instances_get`, `instances_set`, `save_connection`, and
 * `delete_connection` results
 * (main.ts projects every registry return), so callers may rely on them in
 * every registry-returning path.
 */
export type {
  ChamberHostGraphState,
  ChamberInjectionState,
  ConnectionCredentialMutations,
  ChamberNotificationSettings,
  ChamberSettings,
  ChamberSettingsStatus,
  DesktopSshSurface,
  LocalPluginManifest,
  NpmSearchPackage,
  PluginApplyFailure,
  PluginApplyInput,
  PluginApplyResult,
  RemotePluginManifest,
  SaveConnectionResult,
  SettingsSurface,
  SshConfigDiscovery,
  SshConfigHost,
  SshExecIpcResult,
  SshInstanceInput,
  SshInstanceSpec,
  SshLocalPluginExecIpcResult,
  SshLogEntry,
  SshMaterializeResult,
  SshPhase,
  SshSeedHostGraphResult,
  SshStatusChangedPayload,
  SshStatusProjection,
  SystemResumeSurface,
  TransportKind,
  TransportMethod,
  UpdatePhase,
  UpdateState,
  UpdateSurface,
  WindowCloseBehavior,
} from '../../renderer/src/global.d.ts'

declare global {
  /**
   * The page bridge as consumed by the connections plugin — declared with the
   * FULL authoritative DshChamberBridge (imported from renderer, identical to
   * the renderer's own declaration, never a subset — 2026 round-2 review M1).
   */
  interface Window {
    dshChamber?: DshChamberBridge
  }
}

export {}
