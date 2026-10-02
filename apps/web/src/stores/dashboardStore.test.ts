import type { ElysianEvent } from '@elysian/contracts'
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import * as resourceMetrics from '../adapters/mock/resourceMetrics'
import { resetMockHistory } from '../adapters/mock/resourceMetrics'
import { onStreamEvent, useEventStreamStore } from './eventStreamStore'
import { mergeResourceSampleIntoWindow, useDashboardStore } from './dashboardStore'

function resetStores() {
  resetMockHistory()
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  useDashboardStore.setState({
    status: 'idle',
    refreshing: false,
    range: '5m',
    resources: undefined,
    errorMessage: undefined,
  })
}

/** 让事件流经 store 的正规通路（connect → listeners）发出一个事件。 */
function emit(event: ElysianEvent): void {
  useEventStreamStore.getState().connect({
    subscribe(handlers) {
      handlers.onStatus('live')
      handlers.onEvent(event)
      return () => {}
    },
  })
}

const samplePayload = {
  cpu: 66,
  memory: 77,
  networkIo: 300,
  networkRx: 300,
  networkTx: 0,
  diskIo: 200,
  diskRead: 200,
  diskWrite: 0,
  load: { m1: 0.4, m5: 0.3, m15: 0.2 },
}

beforeEach(resetStores)

describe('mergeResourceSampleIntoWindow', () => {
  it('裁剪窗外点并追加最新采样', () => {
    const t0 = 1_700_000_000_000
    const merged = mergeResourceSampleIntoWindow(
      [
        { ts: t0 - 6 * 60_000, cpu: 1, memory: 1, networkIo: 1, networkRx: 1, networkTx: 0, diskIo: 1 , diskRead: 1 , diskWrite: 0 },
        { ts: t0 - 60_000, cpu: 2, memory: 2, networkIo: 2, networkRx: 2, networkTx: 0, diskIo: 2 , diskRead: 2 , diskWrite: 0 },
      ],
      '5m',
      { ts: t0, cpu: 99, memory: 88, networkIo: 77, networkRx: 77, networkTx: 0, diskIo: 66 , diskRead: 66 , diskWrite: 0 },
    )
    expect(merged.map((p) => p.cpu)).toEqual([2, 99])
  })

  it('过近时间戳替换末点而非重复', () => {
    const t0 = 1_700_000_000_000
    const merged = mergeResourceSampleIntoWindow(
      [{ ts: t0 - 1_000, cpu: 10, memory: 10, networkIo: 10, networkRx: 10, networkTx: 0, diskIo: 10 , diskRead: 10 , diskWrite: 0 }],
      '5m',
      { ts: t0, cpu: 20, memory: 20, networkIo: 20, networkRx: 20, networkTx: 0, diskIo: 20 , diskRead: 20 , diskWrite: 0 },
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.cpu).toBe(20)
  })
})

describe('仪表盘 store 资源窗与引用稳定', () => {
  it('默认 range 为 5m', () => {
    expect(useDashboardStore.getState().range).toBe('5m')
  })

  it('setRange 拉取失败时保留图表并设置错误信息', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)
    const before = useDashboardStore.getState().resources

    vi.spyOn(gateway.resources, 'list').mockRejectedValueOnce(new Error('演示用的范围切换失败'))
    useDashboardStore.getState().setRange('7d')

    await vi.waitFor(() =>
      expect(useDashboardStore.getState().errorMessage).toBe('演示用的范围切换失败'),
    )
    expect(useDashboardStore.getState().resources).toBe(before)
    expect(useDashboardStore.getState().range).toBe('7d')
  })

  it('setRange 会按新窗重新 list', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const listSpy = vi.spyOn(gateway.resources, 'list')
    await useDashboardStore.getState().load(gateway)
    const callsAfterLoad = listSpy.mock.calls.length

    useDashboardStore.getState().setRange('7d')
    await vi.waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(callsAfterLoad))
    expect(listSpy.mock.calls.at(-1)?.[0]).toBe('7d')
    expect(useDashboardStore.getState().range).toBe('7d')
  })
})

describe('仪表盘 store 的事件回灌', () => {
  it('resource/sample 追加当前窗资源点', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const loaded = useDashboardStore.getState().resources
    expect(loaded?.length).toBeGreaterThan(0)
    const lastTs = loaded![loaded!.length - 1]!.ts

    emit({
      id: 'evt-live-2',
      name: 'resource/sample',
      at: new Date(lastTs + 1_000).toISOString(),
      payload: samplePayload,
    })

    const resources = useDashboardStore.getState().resources
    expect(resources?.length).toBeGreaterThan(0)
    const last = resources?.[resources.length - 1]
    expect(last?.cpu).toBe(66)
    expect(last?.memory).toBe(77)
  })

  it('resource/sample 合并趋势序列，不用 listMockHistory 整窗覆盖', async () => {
    const listMockHistorySpy = vi.spyOn(resourceMetrics, 'listMockHistory')
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const seed = [
      { ts: 1_700_000_000_000, cpu: 11, memory: 22, networkIo: 33, networkRx: 33, networkTx: 0, diskIo: 44 , diskRead: 44 , diskWrite: 0 },
      { ts: 1_700_000_005_000, cpu: 12, memory: 23, networkIo: 34, networkRx: 34, networkTx: 0, diskIo: 45 , diskRead: 45 , diskWrite: 0 },
    ]
    vi.spyOn(gateway.resources, 'list').mockResolvedValue(seed)

    await useDashboardStore.getState().load(gateway)
    listMockHistorySpy.mockClear()

    emit({
      id: 'evt-live-merge',
      name: 'resource/sample',
      at: new Date(1_700_000_010_000).toISOString(),
      payload: { ...samplePayload, cpu: 55 },
    })

    expect(listMockHistorySpy).not.toHaveBeenCalled()
    const resources = useDashboardStore.getState().resources
    expect(resources?.map((p) => p.cpu)).toEqual([11, 12, 55])
    listMockHistorySpy.mockRestore()
  })

  it('onStreamEvent 的退订函数能解除监听', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    let called = 0
    const unsubscribe = onStreamEvent(() => {
      called += 1
    })
    unsubscribe()

    emit({
      id: 'evt-live-4',
      name: 'resource/sample',
      at: '2026-09-12T23:59:00.000Z',
      payload: samplePayload,
    })

    expect(called).toBe(0)
  })
})

// act 在此处被引入但仅用于 vi.useFakeTimers 测试；保留以备需要。
void act
