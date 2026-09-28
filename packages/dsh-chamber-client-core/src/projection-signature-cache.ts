/**
 * 投影签名的两级身份缓存（性能 A1/A2）：
 * serversProjectionSignature 是整 fleet 的 JSON 序列化，App 发布闸与每个挂载壳的订阅闸都要算，
 * 一次可渲染变更的实机成本是 1+2N 次全量序列化（real 档每次约 417 KB）。本模块在不改纯函数的前提下加两层：
 *  - rememberServersProjectionSignature：App 把为**发布的那一个数组**算出的签名记下来，订阅侧对同一数组
 *    再比签名就是 O(1)（数组不可变是既有契约：chamberBridge.publish 的同引用去重注释已明文依赖它）；
 *  - 每来源片段：单来源 JSON 与整 fleet 序列化里的该元素逐字节一致（数组序列化就是元素 JSON 逗号拼接），
 *    片段按**来源对象身份**缓存——各 store 都是 identity-preserving，未变来源直接复用。
 */

import type { ChamberServerAggregate } from './aggregate-store.ts'
import { serversProjectionSignature } from './derive.ts'

const rememberedProjectionSignatures = new WeakMap<object, string>()

/** 每来源片段的缓存容器；与 derive 的按来源投影缓存（renderer host/servers.ts）配对使用。 */
export interface ChamberProjectionSignatureCache {
  readonly fragments: Map<ChamberServerAggregate, string>
}

export function createChamberProjectionSignatureCache(): ChamberProjectionSignatureCache {
  return { fragments: new Map() }
}

/** 只应由发布路径调用：把签名绑定到它描述的那个数组对象上。 */
export function rememberServersProjectionSignature(
  servers: readonly ChamberServerAggregate[],
  signature: string,
): void {
  rememberedProjectionSignatures.set(servers, signature)
}

/** 单来源片段：单元素签名去掉外层方括号；返回值与整 fleet 序列化的对应元素逐字节一致。 */
function sourceFragment(server: ChamberServerAggregate, cache: ChamberProjectionSignatureCache): string {
  let fragment = cache.fragments.get(server)
  if (fragment === undefined) {
    fragment = serversProjectionSignature([server]).slice(1, -1)
    cache.fragments.set(server, fragment)
  }
  return fragment
}

/**
 * 发布闸／订阅闸共用的签名入口：先查已记录签名（O(1)），否则按来源身份缓存只序列化变化的来源。
 * 不传 cache 时退化为纯函数（等价于 serversProjectionSignature）。
 */
export function cachedServersProjectionSignature(
  servers: readonly ChamberServerAggregate[],
  cache?: ChamberProjectionSignatureCache,
): string {
  const remembered = rememberedProjectionSignatures.get(servers)
  if (remembered !== undefined) return remembered
  if (cache === undefined) return serversProjectionSignature(servers)
  if (servers.length === 0) return '[]'
  const parts: string[] = []
  for (const server of servers) parts.push(sourceFragment(server, cache))
  // 来源消失后片段不再可能命中，随投影裁剪，避免按来源数以外的方式增长。
  if (cache.fragments.size > servers.length) {
    const live = new Set<ChamberServerAggregate>(servers)
    for (const key of [...cache.fragments.keys()]) if (!live.has(key)) cache.fragments.delete(key)
  }
  return '[' + parts.join(',') + ']'
}
