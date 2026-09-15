import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import type { Container } from '@elysian/contracts'
import type { ElysianGateway, EventsAdapter } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'
import { useEventStreamStore } from './eventStreamStore'
import { useContainersStore } from './containersStore'
import { CONTAINERS, CONTAINER_IMAGES } from '../adapters/mock/containersData'

function gatewayWith(overrides: Partial<ElysianGateway['containers']> = {}): ElysianGateway {
  return {
    containers: {
      list: async () => [...CONTAINERS],
      listImages: async () => [...CONTAINER_IMAGES],
      execMockCommand: async () => ({ lines: ['ok'] }),
      requestAction: async (id: string) => CONTAINERS.find((c) => c.id === id)!,
      create: async () => CONTAINERS[0]!,
      removeImage: async () => {},
      ...overrides,
    },
  } as unknown as ElysianGateway
}

/** 事件投递入口：经真实 eventStreamStore 连接注入，测试不直接触内部监听集合。 */
let emitToStore: ((event: ElysianEvent) => void) | undefined

beforeEach(() => {
  useContainersStore.setState({
    status: 'idle', errorMessage: undefined, containers: [], images: [], samples: {},
    view: 'grid', statusFilter: 'all', search: '', detailContainerId: undefined,
    terminal: undefined, busyActions: [], createOpen: false, creating: false, removingImageIds: [],
  })
  useNotificationStore.setState({ notifications: [] })
  const adapter: EventsAdapter = {
    subscribe(handlers) {
      emitToStore = handlers.onEvent
      handlers.onStatus('live')
      return () => {
        emitToStore = undefined
      }
    },
  }
  useEventStreamStore.getState().connect(adapter)
})

afterEach(() => {
  useEventStreamStore.getState().disconnect()
})

function event(name: 'container/sample', payload: Extract<ElysianEvent, { name: 'container/sample' }>['payload']): ElysianEvent
function event(name: 'container/updated', payload: Extract<ElysianEvent, { name: 'container/updated' }>['payload']): ElysianEvent
function event(name: 'container/created', payload: Extract<ElysianEvent, { name: 'container/created' }>['payload']): ElysianEvent
function event(name: 'container/sample' | 'container/updated' | 'container/created', payload: unknown): ElysianEvent {
  return { id: `t-${Math.random()}`, name, at: '2026-09-12T08:00:00.000Z', payload } as ElysianEvent
}

describe('containersStore', () => {
  it('load 拉取容器与镜像并进入 ready', async () => {
    const gateway = gatewayWith()
    await useContainersStore.getState().load(gateway)
    const state = useContainersStore.getState()
    expect(state.status).toBe('ready')
    expect(state.containers).toHaveLength(8)
    expect(state.images).toHaveLength(6)
  })

  it('load 失败进入 error 且带中文信息', async () => {
    await useContainersStore.getState().load(gatewayWith({ list: async () => { throw new Error('连接失败') } }))
    const state = useContainersStore.getState()
    expect(state.status).toBe('error')
    expect(state.errorMessage).toBe('连接失败')
  })

  it('container/sample 更新采样表；container/updated 更新状态并清忙碌标记', async () => {
    await useContainersStore.getState().load(gatewayWith())
    useContainersStore.setState({ busyActions: ['ctr-nginx-proxy:stop'] })

    emitToStore?.(event('container/sample', { samples: [{ containerId: 'ctr-nginx-proxy', cpuPercent: 42, memMb: 300 }] }))
    expect(useContainersStore.getState().samples['ctr-nginx-proxy']).toEqual({ cpuPercent: 42, memMb: 300 })

    emitToStore?.(event('container/updated', { containerId: 'ctr-nginx-proxy', status: 'stopped' }))
    const state = useContainersStore.getState()
    expect(state.containers.find((c) => c.id === 'ctr-nginx-proxy')?.status).toBe('stopped')
    expect(state.busyActions).toHaveLength(0)
  })

  it('submitCommand 回显、追加输出、记录历史并支持清屏', async () => {
    const gateway = gatewayWith({ execMockCommand: async (_id, command) => command === 'clear' ? { lines: [], clear: true } : { lines: ['line-1'] } })
    await useContainersStore.getState().load(gateway)
    useContainersStore.getState().openTerminal('ctr-nginx-proxy')

    await useContainersStore.getState().submitCommand(gateway, 'env')
    let terminal = useContainersStore.getState().terminal!
    expect(terminal.lines.map((l) => l.text)).toEqual(['演示终端 · 待接入真实执行', '$ env', 'line-1'])
    expect(terminal.history).toEqual(['env'])

    await useContainersStore.getState().submitCommand(gateway, 'clear')
    terminal = useContainersStore.getState().terminal!
    expect(terminal.lines).toEqual([])
    expect(terminal.history).toEqual(['env', 'clear'])
  })

  it('submitCommand 对空命令不动作，历史连续去重', async () => {
    const gateway = gatewayWith()
    await useContainersStore.getState().load(gateway)
    useContainersStore.getState().openTerminal('ctr-nginx-proxy')
    await useContainersStore.getState().submitCommand(gateway, '   ')
    expect(useContainersStore.getState().terminal?.lines).toHaveLength(1) // 仅横幅

    await useContainersStore.getState().submitCommand(gateway, 'env')
    await useContainersStore.getState().submitCommand(gateway, 'env')
    expect(useContainersStore.getState().terminal?.history).toEqual(['env'])
  })

  it('runAction 成功发通知并清忙碌；失败发危险通知', async () => {
    const gateway = gatewayWith({
      requestAction: async (id, action) => {
        if (action === 'restart') throw new Error('演示环境不支持')
        return CONTAINERS.find((c) => c.id === id)!
      },
    })
    await useContainersStore.getState().load(gateway)

    await useContainersStore.getState().runAction(gateway, 'ctr-backup-agent', 'start')
    expect(useNotificationStore.getState().notifications[0]?.message).toContain('已启动')

    await useContainersStore.getState().runAction(gateway, 'ctr-nginx-proxy', 'restart')
    const notifications = useNotificationStore.getState().notifications
    expect(notifications[notifications.length - 1]?.tone).toBe('danger')
    expect(notifications[notifications.length - 1]?.message).toContain('演示环境不支持')
  })

  it('closeTerminal 清空会话；closeDetail 清空详情', async () => {
    await useContainersStore.getState().load(gatewayWith())
    useContainersStore.getState().openTerminal('ctr-nginx-proxy')
    useContainersStore.getState().openDetail('ctr-nginx-proxy')
    useContainersStore.getState().closeTerminal()
    useContainersStore.getState().closeDetail()
    const state = useContainersStore.getState()
    expect(state.terminal).toBeUndefined()
    expect(state.detailContainerId).toBeUndefined()
  })
})

describe('创建容器', () => {
  const NEW_CONTAINER: Container = {
    id: 'ctr-redis-echo', name: 'redis-echo', status: 'running', imageId: 'img-redis',
    ports: [], createdAt: '2026-09-12T08:00:00.000Z', startedAt: '2026-09-12T08:00:00.000Z',
    command: '', env: [], volumes: [], restartPolicy: 'no',
  }

  it('openCreate 与 closeCreate 控制弹窗开关', () => {
    useContainersStore.getState().openCreate()
    expect(useContainersStore.getState().createOpen).toBe(true)
    useContainersStore.getState().closeCreate()
    expect(useContainersStore.getState().createOpen).toBe(false)
  })

  it('createContainer 成功：列表追加、弹窗关闭、成功通知带 mock 标注', async () => {
    await useContainersStore.getState().load(gatewayWith())
    useContainersStore.getState().openCreate()
    await useContainersStore.getState().createContainer(
      gatewayWith({ create: async () => NEW_CONTAINER }),
      { imageId: 'img-redis', ports: [], env: [], volumes: [], restartPolicy: 'no' },
    )
    const state = useContainersStore.getState()
    expect(state.containers).toHaveLength(9)
    expect(state.containers.find((c) => c.id === 'ctr-redis-echo')).toBeDefined()
    expect(state.createOpen).toBe(false)
    expect(state.creating).toBe(false)
    expect(useNotificationStore.getState().notifications[0]?.message).toBe(
      '容器 redis-echo 已创建（mock，待接入真实执行）',
    )
  })

  it('createContainer 失败：弹窗保留、危险通知、creating 复位', async () => {
    await useContainersStore.getState().load(gatewayWith())
    useContainersStore.getState().openCreate()
    await useContainersStore.getState().createContainer(
      gatewayWith({ create: async () => { throw new Error('镜像不存在，无法创建容器') } }),
      { imageId: 'img-missing', ports: [], env: [], volumes: [], restartPolicy: 'no' },
    )
    const state = useContainersStore.getState()
    expect(state.createOpen).toBe(true)
    expect(state.creating).toBe(false)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '创建容器失败：镜像不存在，无法创建容器',
    })
  })

  it('container/created 事件把新容器追加进列表且按 id 去重', async () => {
    await useContainersStore.getState().load(gatewayWith())
    emitToStore?.(event('container/created', { container: NEW_CONTAINER }))
    expect(useContainersStore.getState().containers).toHaveLength(9)
    emitToStore?.(event('container/created', { container: NEW_CONTAINER }))
    expect(useContainersStore.getState().containers).toHaveLength(9)
  })
})

describe('删除镜像', () => {
  it('removeImage 成功：镜像列表移除、忙碌复位、成功通知带 mock 标注', async () => {
    await useContainersStore.getState().load(gatewayWith())
    await useContainersStore.getState().removeImage(gatewayWith(), 'img-grafana')
    const state = useContainersStore.getState()
    expect(state.images.map((image) => image.id)).not.toContain('img-grafana')
    expect(state.removingImageIds).toHaveLength(0)
    expect(useNotificationStore.getState().notifications[0]?.message).toBe(
      '镜像 grafana/grafana:11.3.0 已删除（mock，待接入真实执行）',
    )
  })

  it('removeImage 失败：镜像保留、危险通知、忙碌复位', async () => {
    await useContainersStore.getState().load(gatewayWith())
    await useContainersStore.getState().removeImage(
      gatewayWith({ removeImage: async () => { throw new Error('镜像仍被容器引用，删除失败') } }),
      'img-nginx',
    )
    const state = useContainersStore.getState()
    expect(state.images.map((image) => image.id)).toContain('img-nginx')
    expect(state.removingImageIds).toHaveLength(0)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '删除镜像失败：镜像仍被容器引用，删除失败',
    })
  })
})
