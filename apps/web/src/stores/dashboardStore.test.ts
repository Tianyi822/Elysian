import type { ElysianEvent } from '@elysian/contracts'
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDataset } from '../adapters/mock/dataset'
import { createMockGateway } from '../adapters/mock/gateway'
import * as resourceMetrics from '../adapters/mock/resourceMetrics'
import { resetMockHistory } from '../adapters/mock/resourceMetrics'
import { onStreamEvent, useEventStreamStore } from './eventStreamStore'
import { INITIAL_DISKS } from '../adapters/mock/resourceMetrics'
import { mergeResourceSampleIntoWindow, useDashboardStore } from './dashboardStore'

const dataset = createMockDataset()

function resetStores() {
  resetMockHistory()
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  useDashboardStore.setState({
    status: 'idle',
    refreshing: false,
    range: '5m',
    stats: undefined,
    modules: undefined,
    resources: undefined,
    system: undefined,
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
  disks: [
    { mount: '/', usagePct: 63, usedKb: 630_000, sizeKb: 1_000_000 },
    { mount: '/data', usagePct: 79, usedKb: 1_580_000, sizeKb: 2_000_000 },
    { mount: '/backup', usagePct: 42, usedKb: 2_100_000, sizeKb: 5_000_000 },
  ],
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

  it('load 后不把 mock 初始挂载写入 system', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const system = useDashboardStore.getState().system
    expect(system).toBeUndefined()
    expect(INITIAL_DISKS.map((disk) => disk.mount)).toEqual(['/', '/data', '/backup'])
  })

  it('resource/sample 后 refresh 仍保留采样中的负载与磁盘', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    emit({
      id: 'evt-refresh-preserve',
      name: 'resource/sample',
      at: new Date().toISOString(),
      payload: {
        ...samplePayload,
        load: { m1: 1.1, m5: 0.9, m15: 0.7 },
        disks: [
          { mount: '/var', usagePct: 11, usedKb: 11_000, sizeKb: 100_000 },
          { mount: '/srv', usagePct: 22, usedKb: 22_000, sizeKb: 100_000 },
        ],
      },
    })

    await useDashboardStore.getState().refresh(gateway)

    const system = useDashboardStore.getState().system
    expect(system?.load).toEqual({ m1: 1.1, m5: 0.9, m15: 0.7 })
    expect(system?.disks.map((disk) => disk.mount)).toEqual(['/var', '/srv'])
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

  it('相同 load/disks 不更换 system 引用', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const t0 = Date.now()
    emit({
      id: 'evt-live-sys-1',
      name: 'resource/sample',
      at: new Date(t0).toISOString(),
      payload: samplePayload,
    })
    const first = useDashboardStore.getState().system

    emit({
      id: 'evt-live-sys-2',
      name: 'resource/sample',
      at: new Date(t0 + 3_000).toISOString(),
      payload: {
        ...samplePayload,
        cpu: 70,
        memory: 80,
      },
    })
    const second = useDashboardStore.getState().system

    expect(second).toBe(first)
    expect(useDashboardStore.getState().resources?.at(-1)?.cpu).toBe(70)
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
  it('incident/created 让事故总数与待处理数各加一，模块卡活跃数联动', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    await useDashboardStore.getState().load(gateway)

    const before = useDashboardStore.getState().stats?.totalIncidents ?? 0
    const beforeOpen = useDashboardStore.getState().stats?.openIncidents ?? 0

    emit({
      id: 'evt-live-1',
      name: 'incident/created',
      at: '2026-09-12T23:59:00.000Z',
      payload: { incidentId: 'INC-LIVE-1', severity: 'sev2', moduleId: 'command-coordination' },
    })

    const stats = useDashboardStore.getState().stats
    expect(stats?.totalIncidents).toBe(before + 1)
    expect(stats?.openIncidents).toBe(beforeOpen + 1)

    const card = useDashboardStore
      .getState()
      .modules?.find((module) => module.moduleId === 'command-coordination')
    expect(card?.activeIncidents).toBeGreaterThan(0)
  })

  it('resource/sample 追加当前窗资源点并更新 system', async () => {
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

    const system = useDashboardStore.getState().system
    expect(system?.load).toEqual({ m1: 0.4, m5: 0.3, m15: 0.2 })
    expect(system?.disks.map((disk) => disk.usagePct)).toEqual([63, 79, 42])
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

  it('事件回灌落进数据集：手动刷新重新聚合后总数一致', async () => {
    vi.useFakeTimers()
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
