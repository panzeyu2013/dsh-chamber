/**
 * 三种凭据「清除」动作的共享实现（M9 单源化，ARCH-IMPL-027）。
 *
 * 三个回调（SSH 密码 / 网关 token / 网关登录密码）此前是逐字同形的 useCallback：
 * bridge 判空 → clear-only 调用（取值恒为 null，凭据永不进 renderer）→ 失败只置
 * formError，成功则清空该维度的草稿字段、把实例行与编辑目标的「已设置」投影翻回
 * false。差异只有三项，故用**描述符**表达（method / draftKey / projectionKey），
 * 不引入布尔开关。
 */
import type { DesktopSshSurface, SshInstanceSpec } from '../global.d.ts'
import type { HostDraft } from './connection-form.ts'

/** 三个清除动作的全部差异。 */
export interface ClearCredentialTarget {
  /** DesktopSshSurface 上的 clear-only 方法名（非空写入由 save_connection 独占）。 */
  method: 'set_password' | 'set_gateway_token' | 'set_gateway_password'
  /** 成功后清空的草稿字段（值不回读；直接置空串）。 */
  draftKey: 'password' | 'gatewayToken' | 'gatewayPassword'
  /** 成功后翻回 false 的「已设置」投影字段（实例行与编辑目标各一份）。 */
  projectionKey: 'sshPasswordSet' | 'tokenSet' | 'passwordSet'
}

export const CLEAR_SSH_PASSWORD: ClearCredentialTarget = {
  method: 'set_password', draftKey: 'password', projectionKey: 'sshPasswordSet',
}
export const CLEAR_GATEWAY_TOKEN: ClearCredentialTarget = {
  method: 'set_gateway_token', draftKey: 'gatewayToken', projectionKey: 'tokenSet',
}
export const CLEAR_GATEWAY_PASSWORD: ClearCredentialTarget = {
  method: 'set_gateway_password', draftKey: 'gatewayPassword', projectionKey: 'passwordSet',
}

/** 组件注入的状态写入面（React setter 的结构化最小类型，便于纯单测）。 */
export interface ClearCredentialDeps {
  bridge: DesktopSshSurface | null
  editing: SshInstanceSpec | 'new' | null
  setDraft: (update: (prev: HostDraft | null) => HostDraft | null) => void
  setInstances: (update: (prev: SshInstanceSpec[]) => SshInstanceSpec[]) => void
  setEditing: (update: (prev: SshInstanceSpec | 'new' | null) => SshInstanceSpec | 'new' | null) => void
  setFormError: (error: string | null) => void
}

/**
 * 清除一个凭据维度。bridge 或编辑目标缺失即 no-op；失败只置 formError（不改状态）；
 * 成功则清空该维度草稿字段、翻转实例行与编辑目标的「已设置」投影，并清空 formError。
 * @param target - 该维度的 method / draftKey / projectionKey。
 * @param deps - 组件侧注入的 bridge 与三个状态写入面。
 */
export async function clearCredential(target: ClearCredentialTarget, deps: ClearCredentialDeps): Promise<void> {
  const { bridge, editing } = deps
  if (bridge === null || editing === null || editing === 'new') return
  const result = await bridge[target.method](editing.id, null)
  if ('error' in result) {
    deps.setFormError(result.error)
    return
  }
  deps.setDraft(prev => (prev === null ? prev : { ...prev, [target.draftKey]: '' }))
  deps.setInstances(prev => prev.map(instance => instance.id === editing.id
    ? { ...instance, [target.projectionKey]: false }
    : instance))
  deps.setEditing(prev => (prev === null || prev === 'new'
    ? prev
    : { ...prev, [target.projectionKey]: false }))
  deps.setFormError(null)
}
