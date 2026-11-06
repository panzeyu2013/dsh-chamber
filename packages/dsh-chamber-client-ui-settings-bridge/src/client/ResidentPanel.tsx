/**
 * 「性能与内存」只读组（设置 → 客户端；D3）。
 *
 * 三个只读面：常驻来源表（label / 状态 / 隐藏时长 / DOM 节点 + 手动释放）、系统内存
 * 读数（settings 投影的可选 system，D4）、页面 JS 堆（performance.memory，Chromium
 * 近似）。固定声明「每壳字节内存不可得（单 renderer 架构）」——N 个壳共用一个
 * document，平台只给整页/整进程读数，任何「每壳字节」都是编的。
 *
 * 数据面：client-core 的 residentBridge（D2 页面级单例）——面板打开时 subscribe 并
 * requestRefresh 一次（DOM 节点数只在有订阅者时采集）、卸载撤销，**不轮询数据面**；settings.get()
 * 打开时读一次（system 只在该响应里）；面板打开期间有一个 1s 显示时钟，只重算隐藏时长格式化。
 * 已释放行由快照 sources 携带（释放后转「已释放」而不是消失）；设置面目标来源的释放动作显示
 * 「面板正在使用」提示而不是按钮。手动释放
 * 是两击 in-place 确认（3s 窗），不用 window.confirm、不引 Modal（多壳同文档 + 面板
 * token 面；与 DshRuntimeSection 的确认纪律同向，但这里不需要完整决策层）。
 *
 * 纯投影全部在 resident-panel-model.ts（真值表单测）；本文件只做订阅/定时器的 React
 * 生命周期与 t(...) 映射。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { residentBridge } from '@dsh-chamber/dsh-chamber-client-core'
import type { ChamberSettingsStatus } from '../ambient/settings-bridge.d.ts'
import type { SettingsBridgeKey } from '../locales.ts'
import { getSettingsStatus } from './settings-store.ts'
import {
  NO_RELEASE_ARM, decodeResidentSnapshot, lastReleaseView, pageHeapView, releaseArmRemainingMs,
  releaseClick, residentRowViews, systemMemoryView,
  type ReleaseArmState, type ResidentSnapshotView,
} from './resident-panel-model.ts'
import css from './SettingsShell.module.css'
import panelCss from './ResidentPanel.module.css'

/** 释放请求在途的兜底撤除窗：requestRelease 是 fire-and-forget，桥不一定回事实
 *  （来源已释放 / 已消失）；不兜底会让按钮永久停在「释放中…」。 */
const RELEASE_BUSY_SAFETY_MS = 2_000

/** 设置壳绑定的翻译（参数化键）；与 GeneralView 的 GeneralTranslate 同形。 */
type ResidentTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/** residentBridge 的订阅/快照面按值直取（同一页面单例）；快照以 unknown 进入纯解码，
 *  不把发布端形状带进本组件。 */
const subscribeResident = (listener: () => void): (() => void) => residentBridge.subscribe(listener)
const getResidentSnapshot = (): unknown => residentBridge.get()

/** settings 投影的可选 system（D4）：只有 settings-get 响应携带；缺省 = 不可得。 */
function systemOf(status: ChamberSettingsStatus | null): unknown {
  if (status === null) return null
  return status.system
}

/** performance.memory 非标准（TS DOM lib 不声明）：Chromium/Electron 有、WebKit 没有。 */
function readPageHeap(): unknown {
  if (typeof performance === 'undefined') return null
  return (performance as unknown as { memory?: unknown }).memory
}

/** 单调钟（ms）：D2 契约里的 lastActiveAt 是**单调钟**毫秒，回退算隐藏时长必须用同一
 *  时基；performance.now() 缺席的宿主（测试/极老环境）才回退 Date.now()。 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export function ResidentPanel({ t }: { t: ResidentTranslate }) {
  // 常驻快照：打开时挂订阅、卸载撤销；useSyncExternalStore 要求 getSnapshot 返回
  // 稳定引用（D2 的 publish 同引用守卫 + get 返回当前快照）。
  const rawSnapshot = useSyncExternalStore(subscribeResident, getResidentSnapshot, getResidentSnapshot)
  const snapshot: ResidentSnapshotView = useMemo(() => decodeResidentSnapshot(rawSnapshot), [rawSnapshot])
  // 设置投影：先用页面已水合的 store，打开时再补一次 settings.get()（system 只随该响应
  // 下发；不订阅、不轮询——读数是打开瞬间的快照，capturedAt 由宿主给）。
  const [systemRaw, setSystemRaw] = useState<unknown>(() => systemOf(getSettingsStatus()))
  const [arm, setArm] = useState<ReleaseArmState>(NO_RELEASE_ARM)
  const [releasingId, setReleasingId] = useState<string | null>(null)
  const [releaseRequested, setReleaseRequested] = useState(false)
  // 本次释放请求的时刻（单调时基，与 D2 的 lastRelease.at 同源）：旧释放事实不得误清新请求。
  const requestedAtRef = useRef(0)
  // 显示时钟：隐藏时长由 lastActiveAt + now 现算，需在面板打开期间前进；它只重算格式化文案，
  // 不读 residentBridge/settings 数据面（与「不轮询数据面」不冲突）。
  const [displayNow, setDisplayNow] = useState(() => monotonicNow())
  // 页面 JS 堆：打开时读一次（性能面板不是轮询面；重新打开设置即重新读）。
  const [pageHeap] = useState<unknown>(() => readPageHeap())

  // 面板打开即请求一次带 DOM 计数的快照：发布端只在有面板订阅者时采集节点数（性能预算），
  // 订阅本身不触发发布，故这里补一帧。
  useEffect(() => { residentBridge.requestRefresh() }, [])

  // 面板打开期间的显示时钟（1s）：只驱动隐藏时长的格式化，不触发任何数据读取。
  useEffect(() => {
    const timer = setInterval(() => { setDisplayNow(monotonicNow()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [])

  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.dshChamber?.settings
    if (api === undefined) return
    let cancelled = false
    void api.get()
      .then((status) => { if (!cancelled) setSystemRaw(systemOf(status)) })
      .catch(() => { /* 读取失败 = 不可得；绝不制造假读数 */ })
    return () => { cancelled = true }
  }, [])

  // arm 窗到期即撤（按剩余毫秒排一个精确定时器；不做轮询）。
  useEffect(() => {
    if (arm.armedId === null) return
    const timer = setTimeout(() => { setArm(NO_RELEASE_ARM) }, releaseArmRemainingMs(arm, Date.now()))
    return () => { clearTimeout(timer) }
  }, [arm])

  // 在途释放的兜底撤除（桥不回事实时按钮不能永久禁用）。
  useEffect(() => {
    if (releasingId === null) return
    const timer = setTimeout(() => { setReleasingId(null) }, RELEASE_BUSY_SAFETY_MS)
    return () => { clearTimeout(timer) }
  }, [releasingId])

  // 桥回报**不早于本次请求**的同 id 释放事实 → 立即撤除 busy（安全定时器只兜「事实不来」的路径）。
  // 只比对 sourceId 会让同源上一次释放的旧事实误清新请求的「释放中…」。
  useEffect(() => {
    if (releasingId === null) return
    const release = snapshot.lastRelease
    if (release !== undefined && release.sourceId === releasingId && release.at >= requestedAtRef.current) {
      setReleasingId(null)
    }
  }, [snapshot, releasingId])

  const rows = useMemo(() => residentRowViews({
    sources: snapshot.sources,
    releasingId,
    armedId: arm.armedId,
    // 隐藏时长用 live lastActiveAt + 显示时钟现算；纯函数不持有时钟，渲染期取一次。
    now: displayNow,
  }), [snapshot, releasingId, arm, displayNow])

  const onReleaseClick = useCallback((id: string) => {
    const outcome = releaseClick(arm, id, Date.now())
    setArm(outcome.next)
    setReleaseRequested(false)
    if (outcome.action !== 'release') return
    requestedAtRef.current = monotonicNow()
    setReleasingId(id)
    setReleaseRequested(true)
    residentBridge.requestRelease(id)
  }, [arm])

  const systemView = systemMemoryView(systemRaw)
  const heapView = pageHeapView(pageHeap)
  const lastRelease = lastReleaseView(snapshot)
  return (
    <div className={css.generalGroup}>
      <h3 className={css.generalGroupTitle}>{t('generalGroupPerformanceMemory')}</h3>

      {rows.length === 0 ? (
        <p className={css.generalHint}>{t('generalResidentEmpty')}</p>
      ) : (
        <div className={panelCss.residentTableWrap}>
          <table className={panelCss.residentTable}>
            <thead>
              <tr>
                <th scope="col">{t('generalResidentColumnSource')}</th>
                <th scope="col">{t('generalResidentColumnState')}</th>
                <th scope="col">{t('generalResidentColumnHidden')}</th>
                <th scope="col">{t('generalResidentColumnDom')}</th>
                <th scope="col">{t('generalResidentColumnAction')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className={panelCss.residentSourceCell}>{row.labelText}</th>
                  <td>{t(row.stateKey)}</td>
                  <td>{row.hiddenForText !== '' ? row.hiddenForText : '—'}</td>
                  <td>{row.domNodesText !== '' ? row.domNodesText : '—'}</td>
                  <td className={panelCss.residentActionCell}>
                    {row.settingsTarget ? (
                      <span className={css.generalHint}>{t('generalResidentSettingsTarget')}</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={row.releaseDisabled}
                        onClick={() => { onReleaseClick(row.id) }}
                      >
                        {row.busy
                          ? t('generalResidentReleasing')
                          : row.armed ? t('generalResidentReleaseConfirm') : t('generalResidentRelease')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={css.generalHint}>{t('generalResidentReleaseHint')}</p>
      {lastRelease !== undefined && (
        <p className={css.generalHint} role="status">
          {t('generalResidentLastRelease', { label: lastRelease.label, reason: t(lastRelease.reasonKey) })}
        </p>
      )}
      {releaseRequested && (
        <p className={css.generalHint} role="status">{t('generalResidentReleaseRequested')}</p>
      )}

      <h4 className={panelCss.memoryTitle}>{t('generalResidentMemoryTitle')}</h4>
      <div className={panelCss.memoryGrid}>
        <div className={panelCss.memoryRow}>
          <span className={panelCss.memoryLabel}>{t('generalResidentSystemLabel')}</span>
          <span className={panelCss.memoryValue}>
            {systemView.kind === 'available' ? (
              <>
                {t('generalResidentSystemAvailable', { available: systemView.available, total: systemView.total })}
                {' · '}
                {t('generalResidentSystemSource', { source: t(systemView.sourceKey) })}
              </>
            ) : t('generalResidentUnavailable')}
          </span>
        </div>
        <div className={panelCss.memoryRow}>
          <span className={panelCss.memoryLabel}>{t('generalResidentPageHeapLabel')}</span>
          <span className={panelCss.memoryValue}>
            {heapView.kind === 'available'
              ? t('generalResidentPageHeapValue', { used: heapView.used, limit: heapView.limit })
              : t('generalResidentUnavailable')}
          </span>
        </div>
      </div>
      <p className={panelCss.memoryNote}>{t('generalResidentPerShellNote')}</p>
    </div>
  )
}
