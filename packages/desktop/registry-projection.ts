/**
 * Registry read-time projection type (design 17 §2.3/§9.1), extracted from
 * shell-core.ts (R4 P7 type-cycle break): both shell-core.ts (the projection
 * functions) and shell-assembly-ctx.ts (publishRegistryTransition's return
 * shape) reference it, so it cannot live in either without recreating a type
 * cycle. Leaf module: never import shell-core.ts or a shell-ipc-* registrar.
 */
import type { TransportInstanceSpec } from './transport-provider.ts';
import type { gatewaySecretStorageMode } from './gateway-provider.ts';

export type ProjectedRegistryInstance = TransportInstanceSpec & {
  sshPasswordSet: boolean
  tokenSet: boolean
  passwordSet: boolean
  secretStorage: ReturnType<typeof gatewaySecretStorageMode>
  /** 非秘密投影：凭据镜像由 Electron flavor 以 safeStorage 写出，本
   *  Electron-free 进程无壳 Keychain 适配器、无法解密（文件原地保留、条目
   *  fail closed）。renderer 据此给出「跨 flavor 凭据不可读」的精确提示。 */
  secretStorageUnreadable?: boolean
}
