/**
 * updater 注意力（上游 apps/desktop/src/update-attention.ts 的等价物语义，§22.3.5）：
 * 每目标一次 + 焦点即清 + 窗口已聚焦时只消费闩锁不打扰。纯 node：注入 app 双
 * （dock.bounce/cancel + browser-window-focus 事件）与 flashFrame spy。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { makeController } from '../support/updater-harness.ts'

interface AttentionSpy {
  bounces: string[]
  cancelled: number[]
  flash: boolean[]
}

/** 注入 app 双 + flashFrame spy；focus() 派发 browser-window-focus（start() 里订阅）。 */
function attentionHarness(options: { focused?: () => boolean } = {}): {
  fake: ReturnType<typeof makeController>['fake']
  controller: ReturnType<typeof makeController>['controller']
  spy: AttentionSpy
  focus: () => void
} {
  const events = new EventEmitter()
  const spy: AttentionSpy = { bounces: [], cancelled: [], flash: [] }
  let bounceId = 40
  const app = {
    isPackaged: false,
    on: (event: string, handler: () => void) => { events.on(event, handler) },
    dock: {
      bounce: (type: string) => { spy.bounces.push(type); bounceId += 1; return bounceId },
      cancel: (id: number) => { spy.cancelled.push(id) },
    },
  }
  const { fake, controller } = makeController({
    deps: {
      app: app as never,
      flashFrame: (on: boolean) => { spy.flash.push(on) },
      ...(options.focused === undefined ? {} : { isWindowFocused: options.focused }),
    },
  })
  return { fake, controller, spy, focus: () => { events.emit('browser-window-focus') } }
}

test('attention: 同一已下载版本只提醒一次，聚焦清除后也不重复', async () => {
  const { fake, controller, spy, focus } = attentionHarness()
  await controller.start()
  fake.emit('update-downloaded', { version: '1.2.3' })
  assert.deepEqual(spy.bounces, ['critical'], '下载完成必须抬一次 Dock 注意力')
  assert.deepEqual(spy.flash, [true], 'win32 任务栏必须接到 flashFrame(true)')
  // 重复的 update-downloaded（同一版本）不得再打扰。
  fake.emit('update-downloaded', { version: '1.2.3' })
  assert.deepEqual(spy.bounces, ['critical'])
  assert.deepEqual(spy.flash, [true])
  // 焦点即清：取消那条 Dock 弹跳 + 停止任务栏闪烁。
  focus()
  assert.deepEqual(spy.cancelled, [41], '聚焦必须取消当前弹跳')
  assert.deepEqual(spy.flash, [true, false], '聚焦必须停止闪烁')
  // 清过之后再收到同一版本：闩锁不因清除而重置 → 仍然只有一次提醒。
  fake.emit('update-downloaded', { version: '1.2.3' })
  assert.deepEqual(spy.bounces, ['critical'])
  assert.deepEqual(spy.flash, [true, false])
})

test('attention: 新目标版本取代旧提醒（旧弹跳被撤销后重新抬一次）', async () => {
  const { fake, controller, spy } = attentionHarness()
  await controller.start()
  fake.emit('update-downloaded', { version: '1.2.3' })
  fake.emit('update-downloaded', { version: '1.2.4' })
  assert.deepEqual(spy.cancelled, [41], '旧版本的弹跳必须先撤销')
  assert.deepEqual(spy.bounces, ['critical', 'critical'], '新目标版本必须重新提醒')
  assert.deepEqual(spy.flash, [true, false, true], '旧闪烁停止、新闪烁开始')
})

test('attention: 窗口已聚焦时只消费闩锁、不打扰；之后同一版本也不再提醒', async () => {
  let focused = true
  const { fake, controller, spy } = attentionHarness({ focused: () => focused })
  await controller.start()
  fake.emit('update-downloaded', { version: '1.2.3' })
  assert.deepEqual(spy.bounces, [], '已聚焦窗口不得被打扰')
  assert.deepEqual(spy.flash, [])
  // 闩锁在聚焦检查之前落：用户离开后同一版本不再补一次打扰。
  focused = false
  fake.emit('update-downloaded', { version: '1.2.3' })
  assert.deepEqual(spy.bounces, [])
  assert.deepEqual(spy.flash, [])
})

test('attention: 注意力失败绝不反噬更新链（dock/flash 抛错只记日志）', async () => {
  const events = new EventEmitter()
  const { fake, controller } = makeController({
    deps: {
      app: {
        isPackaged: false,
        on: (event: string, handler: () => void) => { events.on(event, handler) },
        dock: {
          bounce: () => { throw new Error('dock unavailable') },
          cancel: () => { throw new Error('cancel unavailable') },
        },
      } as never,
      flashFrame: () => { throw new Error('flash unavailable') },
    },
  })
  const phases: string[] = []
  controller.subscribe((state) => { phases.push(state.phase) })
  await controller.start()
  fake.emit('update-downloaded', { version: '1.2.3' })
  assert.equal(phases.at(-1), 'downloaded', '注意力抛错不得影响相位')
  events.emit('browser-window-focus')
  assert.equal(phases.at(-1), 'downloaded')
})
