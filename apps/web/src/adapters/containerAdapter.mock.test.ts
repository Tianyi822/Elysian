import { describe, expect, it, vi } from 'vitest'
import { isValidContainerBuildTag } from '@elysian/contracts'
import { createMockDataset } from './mock/dataset'
import { MockContainerAdapter } from './mock/mockAdapters'
import { runContainerAdapterContract } from './containerAdapterContract'

/** 构建演示的注入时钟与节奏：时间断言不依赖当前时间，任务推进零延迟立即终态。 */
const DEMO_BUILD_NOW = () => new Date('2026-10-04T07:30:00Z')

function makeAdapter() {
  // 单一数据集实例：create 之后的 list 必须读回写入，getter 每次新建数据集会丢。
  const dataset = createMockDataset()
  return new MockContainerAdapter(
    () => dataset,
    {
      onAction: vi.fn(),
      scheduleRestart: vi.fn(),
      onCreate: vi.fn(),
    },
    { now: DEMO_BUILD_NOW, buildDelays: { queuedMs: 0, buildingMs: 0 } },
  )
}

runContainerAdapterContract(makeAdapter)

describe('MockContainerAdapter', () => {
  it('requestAction 改写共享数据集并回调 onAction', async () => {
    const dataset = createMockDataset()
    const onAction = vi.fn()
    const scheduleRestart = vi.fn()
    const adapter = new MockContainerAdapter(() => dataset, { onAction, scheduleRestart, onCreate: vi.fn() })

    const stopped = await adapter.requestAction('ctr-backup-agent', 'start')
    expect(stopped.status).toBe('running')
    expect(dataset.containers.find((c) => c.id === 'ctr-backup-agent')?.status).toBe('running')
    expect(onAction).toHaveBeenCalledWith('ctr-backup-agent')

    const restarted = await adapter.requestAction('ctr-nginx-proxy', 'restart')
    expect(restarted.status).toBe('restarting')
    expect(scheduleRestart).toHaveBeenCalledWith('ctr-nginx-proxy')
  })

  it('sendTerminalInput 输出与数据集联动；容器不存在在连接时抛中文错误', async () => {
    const dataset = createMockDataset()
    const adapter = new MockContainerAdapter(() => dataset, {
      onAction: vi.fn(),
      scheduleRestart: vi.fn(),
      onCreate: vi.fn(),
    })

    const frames: { lines: readonly string[] }[] = []
    const info = await adapter.connectTerminal('ctr-nginx-proxy', {
      onFrame: (_sessionId, frame) => {
        if (frame.type === 'output') frames.push(frame)
      },
      onClose: () => {},
    })
    await adapter.sendTerminalInput(info.id, 'env')
    expect(frames[0]?.lines).toEqual(['TZ=Asia/Shanghai'])

    await expect(adapter.connectTerminal('ctr-nope', { onFrame: () => {}, onClose: () => {} })).rejects.toThrow(
      '容器不存在',
    )
  })

  it('removeImage 落实数据集：未引用镜像移除，被引用与不存在抛中文错误', async () => {
    const dataset = createMockDataset()
    const adapter = new MockContainerAdapter(() => dataset, {
      onAction: vi.fn(),
      scheduleRestart: vi.fn(),
      onCreate: vi.fn(),
    })

    await expect(adapter.removeImage('img-grafana')).resolves.toBeUndefined()
    expect(dataset.images.map((image) => image.id)).not.toContain('img-grafana')

    await expect(adapter.removeImage('img-nginx')).rejects.toThrow('镜像仍被容器引用，删除失败')
    await expect(adapter.removeImage('img-missing')).rejects.toThrow('镜像不存在，删除失败')
  })
})

describe('MockContainerAdapter 镜像构建演示', () => {
  function buildAdapter(options?: { buildDelays?: { queuedMs: number; buildingMs: number } }) {
    const dataset = createMockDataset()
    const adapter = new MockContainerAdapter(
      () => dataset,
      { onAction: vi.fn(), scheduleRestart: vi.fn(), onCreate: vi.fn() },
      // 默认零延迟：任务推进立即完成，时间断言只看注入时钟的派生结果。
      { now: DEMO_BUILD_NOW, buildDelays: { queuedMs: 0, buildingMs: 0 }, ...options },
    )
    return { adapter, dataset }
  }

  async function seedWorkspace(adapter: MockContainerAdapter) {
    await adapter.createApp({ slug: 'demo-build', displayName: '构建演示' })
    await adapter.uploadAppFile('demo-build', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
  }

  async function waitSettled(adapter: MockContainerAdapter, taskId: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = await adapter.getAppBuild('demo-build', taskId)
      if (task.state !== 'queued' && task.state !== 'building') return task
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('演示构建未在预期时间内到达终态')
  }

  it('tag 由注入时钟的 UTC 时刻与任务 id 前 4 字符派生，同秒不同任务 tag 不同', async () => {
    const { adapter } = buildAdapter()
    await seedWorkspace(adapter)
    const first = await adapter.submitAppBuild('demo-build', {
      mode: 'dockerfile',
      requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
      dockerfile: 'Dockerfile',
    })
    const firstDone = await waitSettled(adapter, first.id)
    const second = await adapter.submitAppBuild('demo-build', {
      mode: 'dockerfile',
      requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5c',
      dockerfile: 'Dockerfile',
    })
    const secondDone = await waitSettled(adapter, second.id)
    const firstTag = firstDone.results[0]!.tag
    const secondTag = secondDone.results[0]!.tag
    // 注入时钟恒为 2026-10-04T07:30:00Z：UTC 时间片恒为 20261004-073000。
    expect(firstTag.startsWith('20261004-073000-')).toBe(true)
    expect(secondTag.startsWith('20261004-073000-')).toBe(true)
    expect(isValidContainerBuildTag(firstTag)).toBe(true)
    expect(isValidContainerBuildTag(secondTag)).toBe(true)
    expect(firstTag).not.toBe(secondTag)
  })

  it('活跃构建任务期间删除工作区被拒，取消后可删', async () => {
    const { adapter } = buildAdapter({ buildDelays: { queuedMs: 60_000, buildingMs: 60_000 } })
    await seedWorkspace(adapter)
    const task = await adapter.submitAppBuild('demo-build', {
      mode: 'dockerfile',
      requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
      dockerfile: 'Dockerfile',
    })
    await expect(adapter.removeApp('demo-build')).rejects.toThrow('工作区有进行中的构建任务，请先取消或等待完成')
    await adapter.cancelAppBuild('demo-build', task.id)
    await expect(adapter.removeApp('demo-build')).resolves.toBeUndefined()
    await expect(adapter.getAppBuild('demo-build', task.id)).rejects.toThrow('构建任务不存在')
  })
})
