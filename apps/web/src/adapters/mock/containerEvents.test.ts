import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import type { EventsAdapter } from '../../contracts/adapters'
import { createMockDataset } from './dataset'
import { createContainerEventsLayer } from './containerEvents'

let dataset = createMockDataset()
const received: ElysianEvent[] = []

const stubUnderlying: EventsAdapter = {
  subscribe() {
    return () => {}
  },
}

function subscribe() {
  received.length = 0
  const layer = createContainerEventsLayer(() => dataset, { intervalMs: 2000 })
  const unsubscribe = layer.wrap(stubUnderlying).subscribe({
    onEvent: (event) => received.push(event),
    onStatus: () => {},
  })
  return { layer, unsubscribe }
}

beforeEach(() => {
  vi.useFakeTimers()
  dataset = createMockDataset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('容器事件包装层', () => {
  it('订阅即补发一拍采样，只含运行中容器', () => {
    subscribe()
    const samples = received.filter((e) => e.name === 'container/sample')
    expect(samples).toHaveLength(1)
    const ids = (samples[0]!.payload as { samples: readonly { containerId: string }[] }).samples.map((s) => s.containerId)
    expect(ids).not.toContain('ctr-backup-agent')
    expect(ids).not.toContain('ctr-metrics-agent')
  })

  it('每拍推进采样；emitUpdated 推送 container/updated', () => {
    const { layer } = subscribe()
    vi.advanceTimersByTime(2000)
    expect(received.filter((e) => e.name === 'container/sample')).toHaveLength(2)

    dataset.containers.find((c) => c.id === 'ctr-nginx-proxy')!.status = 'stopped'
    layer.markControlled('ctr-nginx-proxy')
    layer.emitUpdated('ctr-nginx-proxy')
    const updated = received.find((e) => e.name === 'container/updated')
    expect(updated?.payload).toEqual({ containerId: 'ctr-nginx-proxy', status: 'stopped', startedAt: null })
  })

  it('scheduleRestart 一拍后回到运行中', () => {
    const { layer } = subscribe()
    // 模拟 requestAction('restart') 已置 restarting，再排重启完成。
    dataset.containers.find((c) => c.id === 'ctr-nginx-proxy')!.status = 'restarting'
    layer.markControlled('ctr-nginx-proxy')
    layer.scheduleRestart('ctr-nginx-proxy')
    vi.advanceTimersByTime(2000)
    expect(dataset.containers.find((c) => c.id === 'ctr-nginx-proxy')?.status).toBe('running')
    expect(received.some((e) => e.name === 'container/updated')).toBe(true)
  })

  it('演示循环容器每 4 拍切换状态；markControlled 后退出循环', () => {
    const { layer } = subscribe()
    vi.advanceTimersByTime(8000)
    expect(dataset.containers.find((c) => c.id === 'ctr-metrics-agent')?.status).toBe('running')

    layer.markControlled('ctr-metrics-agent')
    dataset.containers.find((c) => c.id === 'ctr-metrics-agent')!.status = 'stopped'
    vi.advanceTimersByTime(8000)
    expect(dataset.containers.find((c) => c.id === 'ctr-metrics-agent')?.status).toBe('stopped')
  })

  it('退订后停止发事件；reset 清空循环与重启状态', () => {
    const { layer, unsubscribe } = subscribe()
    unsubscribe()
    vi.advanceTimersByTime(6000)
    expect(received.filter((e) => e.name === 'container/sample')).toHaveLength(1)

    layer.reset()
    expect(() => layer.reset()).not.toThrow()
  })
})
