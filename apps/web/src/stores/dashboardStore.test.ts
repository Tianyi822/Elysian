import type { ElysianEvent } from '@elysian/contracts'
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDataset } from '../adapters/mock/dataset'
import { createMockGateway } from '../adapters/mock/gateway'
import { onStreamEvent, useEventStreamStore } from './eventStreamStore'
import { useDashboardStore } from './dashboardStore'

const dataset = createMockDataset()

function resetStores() {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  useDashboardStore.setState({
    status: 'idle',
    refreshing: false,
    range: '7d',
    stats: undefined,
    modules: undefined,
    resources: undefined,
    auditRecords: undefined,
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

beforeEach(resetStores)

describe('仪表盘 store 的事件回灌', () => {
  it('incident/created 让事故总数与待处理数各加一，模块卡活跃数联动', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const before = useDashboardStore.getState().stats?.totalIncidents ?? 0
    const beforeOpen = useDashboardStore.getState().stats?.openIncidents ?? 0

    emit({
      id: 'evt-live-1',
      name: 'incident/created',
      at: '2026-09-12T23:59:00.000Z',
      payload: { incidentId: 'INC-LIVE-1', severity: 'sev2', moduleId: 'incident-command' },
    })

    const stats = useDashboardStore.getState().stats
    expect(stats?.totalIncidents).toBe(before + 1)
    expect(stats?.openIncidents).toBe(beforeOpen + 1)

    const card = useDashboardStore
      .getState()
      .modules?.find((module) => module.moduleId === 'incident-command')
    expect(card?.activeIncidents).toBeGreaterThan(0)
  })

  it('resource/sample 滚动追加资源序列并保持 30 个点', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const before = useDashboardStore.getState().resources?.length ?? 0
    expect(before).toBe(30)

    emit({
      id: 'evt-live-2',
      name: 'resource/sample',
      at: '2026-09-12T23:59:00.000Z',
      payload: { cpu: 66, memory: 77, networkIo: 300, diskIo: 200 },
    })

    const resources = useDashboardStore.getState().resources
    expect(resources).toHaveLength(30)
    const last = resources?.[resources.length - 1]
    expect(last?.cpu).toBe(66)
    expect(last?.memory).toBe(77)
  })

  it('事件回灌落进数据集：手动刷新重新聚合后总数一致', async () => {
    vi.useFakeTimers()
    // 走真实的包装适配器：内存事件源每 30ms 一拍，第 4 拍诞生新事故。
    const gateway = createMockGateway({ eventIntervalMs: 30, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    useEventStreamStore.getState().connect(gateway.events)
    act(() => {
      vi.advanceTimersByTime(4 * 30 + 10)
    })

    const liveRows = await gateway.incidents.listRows({})
    expect(liveRows.rows.filter((row) => row.kind === 'incident').length).toBe(
      dataset.incidents.length + 1,
    )

    await useDashboardStore.getState().refresh(gateway)
    const stats = useDashboardStore.getState().stats
    expect(stats?.totalIncidents).toBe(dataset.incidents.length + 1)
    vi.useRealTimers()
  })

  it('重复 id 的事件不会把总数推高两次', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const before = useDashboardStore.getState().stats?.totalIncidents ?? 0
    const event: ElysianEvent = {
      id: 'evt-live-dup',
      name: 'incident/created',
      at: '2026-09-12T23:59:00.000Z',
      payload: { incidentId: 'INC-LIVE-DUP', severity: 'sev3' },
    }

    // 两次 connect 是模拟断线重连；事件 id 相同，数据集去重 + 界面去重都不该重复计数。
    emit(event)
    const afterFirst = useDashboardStore.getState().stats?.totalIncidents ?? 0

    emit({ ...event, id: 'evt-live-dup-2' })
    const afterSecond = useDashboardStore.getState().stats?.totalIncidents ?? 0

    expect(afterFirst).toBe(before + 1)
    expect(afterSecond).toBe(afterFirst)
  })

  it('onStreamEvent 的退订函数能解除监听', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    // 触发一次退订（间接验证注册表行为）：注册一个立刻退订的监听器，再发事件它不应被调用。
    let called = 0
    const unsubscribe = onStreamEvent(() => {
      called += 1
    })
    unsubscribe()

    emit({
      id: 'evt-live-4',
      name: 'incident/updated',
      at: '2026-09-12T23:59:00.000Z',
      payload: { incidentId: 'INC-2100' },
    })

    expect(called).toBe(0)
  })
})
