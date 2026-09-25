/**
 * The window.dshChamber page bridge as consumed by the connections section
 * (desktop preload.cts, design 05 §7.4). Mirrors the renderer's
 * global.d.ts declaration structurally (interface merging): returns/events/
 * projections are non-secret — never a tunnel URL or credential material;
 * save_connection alone accepts transient write-only credential input.
 */

import type { DshChamberBridge } from '@dsh-chamber/renderer/global.d.ts'

/**
 * The retained IPC/type face is RE-EXPORTED from the renderer's authoritative
 * global.d.ts, consumed through its single declared face
 * (@dsh-chamber/renderer/global.d.ts) — the single source of truth
 * (settings-bridge pattern). A
 * structural mirror here would drift silently; the
 * ipc-surface-mirror test guards the renderer side against the preload.
 * `TransportKind` is the v2 target union (`dsh | gateway`) and
 * `TransportMethod` is the orthogonal mechanism union (`ssh | http`). The gateway
 * clear-only login-password setter (`set_gateway_password`) and the read-time
 * `passwordSet` projection live on the authoritative renderer surface too
 * (desktop gateway-secrets task, design 17 §7.1/§9.1). The `sshPasswordSet`/`tokenSet`/
 * `passwordSet`/`secretStorage` projections are merged by the main process
 * on `instances_get`, `save_connection`, and
 * `delete_connection` results
 * (main.ts projects every registry return), so callers may rely on them in
 * every registry-returning path.
 *
 * The user plugin WRITE types (apply/materialize/undo/npm-search/local add) were
 * retired with the write surfaces (D1); only the plugin READ face
 * (LocalPluginManifest / RemotePluginManifest) and chamber provisioning
 * (SshSeedHostGraphResult / GatewayPluginSyncIpcResult) are re-exported.
 */
export type {
  // Registry-driven chamber projection (design 13 §6): the per-package state
  // list — re-export the authoritative renderer types, never a local mirror.
  ChamberHostPackageState,
  ChamberInjectionState,
  ConnectionCredentialMutations,
  GatewayPluginSyncIpcResult,
  ChamberNotificationSettings,
  ChamberSettings,
  ChamberSettingsStatus,
  DesktopSshSurface,
  LocalPluginManifest,
  RemotePluginManifest,
  SaveConnectionResult,
  SettingsSurface,
  SshConfigDiscovery,
  SshConfigHost,
  SshExecIpcResult,
  SshInstanceInput,
  SshInstanceSpec,
  SshLogEntry,
  SshPasswordSubmission,
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
} from '@dsh-chamber/renderer/global.d.ts'

declare global {
  /**
   * The page bridge as consumed by the connections plugin — declared with the
   * FULL authoritative DshChamberBridge (imported from renderer, identical to
   * the renderer's own declaration, never a subset).
   */
  interface Window {
    dshChamber?: DshChamberBridge
  }
}

export {}
