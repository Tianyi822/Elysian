import { describe, expect, it, vi } from 'vitest'
import { createMockDataset } from './mock/dataset'
import { MockContainerAdapter } from './mock/mockAdapters'
import { runContainerAdapterContract } from './containerAdapterContract'

function makeAdapter() {
  // 单一数据集实例：create 之后的 list 必须读回写入，getter 每次新建数据集会丢写。
  const dataset = createMockDataset()
  return new MockContainerAdapter(() => dataset, {
    onAction: vi.fn(),
    scheduleRestart: vi.fn(),
    onCreate: vi.fn(),
  })
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
