/**
 * clear-only 凭据 IPC 的共享准入前奏（2026-12 单源化，ARCH-IMPL-025）。
 *
 * 三个 legacy 凭据 setter（desktop_ssh_set_password / desktop_gateway_set_token /
 * desktop_gateway_set_password）的**准入**逐字相同：payload 取值 → 注册表存在性 →
 * id 白名单 → 「非空写入一律拒绝」。各自的**清除体保持独立**——design 17 §2.3 明确
 * token 与 password 是相互独立的凭据，因此本模块刻意不提供布尔开关、不做 kind 分派：
 * 每个方法一个描述符，字段名与拒绝文案由调用侧显式给出（文案继续留在
 * `shell-ipc-connections.ts`，主进程面的文案锁按原样生效）。
 *
 * 本模块只做准入判定，绝不读写凭据存储。
 */
import { INSTANCE_ID_PATTERN } from './transport-provider.ts'

/** 一个 clear-only 方法自己的准入面。 */
export interface ClearOnlyDescriptor<S> {
  /** payload 里承载凭据取值的字段（token 与 password 各自独立）。 */
  field: 'password' | 'token'
  /** 非空写入的拒绝文案（调用侧提供，保持主进程面的字面文案）。 */
  refusal: string
  /** 读当前实例注册表（注入以便单测；主进程传 `() => sm.listInstances()`）。 */
  list: () => readonly S[]
}

/** 准入结果：`ok: false` 时 `error` 就是 handler 应返回的 `{ error }`。 */
export type ClearOnlyAdmission<S> =
  | { ok: true; id: string; spec: S; clearing: true }
  | { ok: false; error: string }

/**
 * 判定一次 clear-only 调用：只有 `null` / `''` 是清除，其余非空写入一律拒绝。
 * 校验顺序与旧实现一致（先 id/存在性/取值类型，再 clear-only 文案）。
 * @param descriptor - 该方法自己的字段 / 文案 / 注册表读取。
 * @param payload - IPC payload（解构语义与旧实现一致）。
 * @returns 放行（含 id 与注册表 spec）或 `{ error }`。
 */
export function admitClearOnly<S extends { id: string }>(
  descriptor: ClearOnlyDescriptor<S>,
  payload: unknown,
): ClearOnlyAdmission<S> {
  const { id, [descriptor.field]: value } = payload as Record<string, unknown> & { id?: unknown }
  const spec = typeof id === 'string' ? descriptor.list().find(instance => instance.id === id) : undefined
  if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
    || (value !== null && typeof value !== 'string')) {
    return { ok: false, error: 'invalid or unknown instance id' }
  }
  if (value !== null && value !== '') return { ok: false, error: descriptor.refusal }
  return { ok: true, id, spec, clearing: true }
}
