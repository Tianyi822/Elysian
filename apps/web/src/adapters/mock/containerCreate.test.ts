import { describe, expect, it } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import type { EventsAdapter } from '../../contracts/adapters'
import { createMockDataset } from './dataset'
import { MockContainerAdapter } from './mockAdapters'
import { createContainerEventsLayer } from './containerEvents'
import { createMockGateway } from './gateway'

/** 直连数据集与事件层：不走 store，验证 adapter 与事件层的协作契约。 */
function setup() {
  const dataset = createMockDataset()
  const received: ElysianEvent[] = []
  const layer = createContainerEventsLayer(() => dataset, { intervalMs: 60_000 })
  const passthrough: EventsAdapter = { subscribe: () => () => {} }
  const unsubscribe = layer.wrap(passthrough).subscribe({
    onEvent: (event) => received.push(event),
    onStatus: () => {},
  })
  const adapter = new MockContainerAdapter(() => dataset, {
    onAction: () => {},
    scheduleRestart: () => {},
    onCreate: (containerId) => layer.emitCreated(containerId),
  })
  return { dataset, received, adapter, unsubscribe }
}

const INPUT = { imageId: 'img-redis', ports: [], env: [], volumes: [], restartPolicy: 'no' as const }

describe('mock 容器创建', () => {
  it('create 追加运行中的新容器并返回副本，id 由名称派生', async () => {
    const { dataset, adapter } = setup()
    const created = await adapter.create({ ...INPUT, name: 'redis-echo' })
    expect(created).toMatchObject({
      id: 'ctr-redis-echo', name: 'redis-echo', status: 'running', imageId: 'img-redis',
    })
    expect(dataset.containers.find((c) => c.id === 'ctr-redis-echo')).toBeDefined()
    expect(created).not.toBe(dataset.containers.find((c) => c.id === 'ctr-redis-echo'))
  })

  it('名称留空按镜像名自动生成且不冲突：连续两次得到 redis 与 redis-2', async () => {
    const { adapter } = setup()
    expect((await adapter.create(INPUT)).name).toBe('redis')
    const second = await adapter.create(INPUT)
    expect(second.name).toBe('redis-2')
    expect(second.id).toBe('ctr-redis-2')
  })

  it('镜像名含斜杠时自动名转连字符：grafana/grafana → grafana-grafana', async () => {
    const { adapter } = setup()
    expect((await adapter.create({ ...INPUT, imageId: 'img-grafana' })).name).toBe('grafana-grafana')
  })

  it('显式重名与未知镜像都抛中文错误', async () => {
    const { adapter } = setup()
    await expect(adapter.create({ ...INPUT, name: 'nginx-proxy' })).rejects.toThrow('容器名称已存在：nginx-proxy')
    await expect(adapter.create({ ...INPUT, imageId: 'img-missing' })).rejects.toThrow('镜像不存在，无法创建容器')
  })

  it('onCreate 经事件层推 container/created，载荷带完整容器', async () => {
    const { received, adapter } = setup()
    await adapter.create({
      ...INPUT,
      name: 'redis-echo',
      ports: [{ containerPort: 6379, hostPort: 16379, protocol: 'tcp' }],
    })
    const event = received.find((e) => e.name === 'container/created')
    expect(event).toBeDefined()
    if (event?.name === 'container/created') {
      expect(event.payload.container.name).toBe('redis-echo')
      expect(event.payload.container.ports).toHaveLength(1)
    }
  })

  it('网关布线后 create 生效：list 能读到新容器', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await gateway.containers.create({ ...INPUT, name: 'redis-echo' })
    const names = (await gateway.containers.list()).map((c) => c.name)
    expect(names).toContain('redis-echo')
  })
})
