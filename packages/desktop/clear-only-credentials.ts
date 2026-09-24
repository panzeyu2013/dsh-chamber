/**
 * clear-only 凭据 IPC 的共享准入前奏：三个 legacy 凭据 setter 的**准入**逐字相同
 * （payload 取值 → 注册表存在性 → id 白名单 → 非空写入一律拒绝），各自的**清除体
 * 保持独立**——token 与 password 是相互独立的凭据，因此本模块刻意不提供布尔开关、
 * 不做 kind 分派：每个方法一个描述符，字段名与拒绝文案由调用侧显式给出（文案继续
 * 留在 `shell-ipc-connections.ts`，主进程面的文案锁按原样生效）。
 *
 * 本模块只做准入判定，绝不读写凭据存储。
 */
import { INSTANCE_ID_PATTERN } from './transport-provider.ts'

/** 一个 clear-only 方法自己的准入面（字段名/文案由调用侧描述符给出）。 */
export interface ClearOnlyDescriptor<S> {
  field: 'password' | 'token'
  refusal: string
  list: () => readonly S[]
}

/** 准入结果：`ok: false` 时 `error` 就是 handler 应返回的 `{ error }`。 */
export type ClearOnlyAdmission<S> =
  | { ok: true; id: string; spec: S; clearing: true }
  | { ok: false; error: string }

/**
 * 判定一次 clear-only 调用：只有 `null` / `''` 是清除，其余非空写入一律拒绝；校验顺序为先 id/存在性/取值类型，再 clear-only 文案；放行时回带 id 与注册表 spec。
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
