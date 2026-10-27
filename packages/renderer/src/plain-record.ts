/** 纯记录判定单一来源 = wire 叶的 isPlainRecord（排除 null / 数组 / 类实例）。
 *  facts 解析、通知落盘解析与完成账本共用这一份；本文件只保留具名面，
 *  避免 renderer 内再次长出第二实现。 */
export { isPlainRecord } from '@dsh-chamber/dsh-chamber-client-core/json-guards'
