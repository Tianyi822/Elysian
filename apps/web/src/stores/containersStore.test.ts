import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      createPolicy: async () => ({ mountRoot: '/srv/elysian', reservedPorts: [48100] }),
      execMockCommand: async () => ({ lines: ['ok'] }),
      requestAction: async (id: string) => CONTAINERS.find((c) => c.id === id)!,
      create: async () => CONTAINERS[0]!,
      removeImage: async () => {},
      pullImage: async ({ name, tag }: { name: string; tag: string }) => ({
        id: 'img-pulled', name, tag, digest: 'sha256:abcd1234abcd', sizeMb: 42, pulledAt: '2026-09-12T08:00:00.000Z',
      }),
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
    pullingImage: undefined,
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
    expect(state.containers).toHaveLength(10)
    expect(state.images).toHaveLength(8)
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

    emitToStore?.(event('container/updated', { containerId: 'ctr-nginx-proxy', status: 'stopped', startedAt: null }))
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
    // input 行只存裸命令：提示符由终端壳渲染时拼在行首。
    expect(terminal.lines.map((l) => l.text)).toEqual(['演示终端 · 待接入真实执行', 'env', 'line-1'])
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

  // 成功路径（列表追加、通知、弹窗关闭）由 ContainerPage.test 的表单流程端到端覆盖，
  // store 层只留页面测不到的失败分支与事件回灌。
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
    expect(useContainersStore.getState().containers).toHaveLength(11)
    emitToStore?.(event('container/created', { container: NEW_CONTAINER }))
    expect(useContainersStore.getState().containers).toHaveLength(11)
  })
})

describe('删除镜像', () => {
  // 成功路径由 ContainerPage.test 的删除流程端到端覆盖，这里只测失败分支。
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

describe('拉取镜像', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // 成功路径由 ContainerPage.test 的拉取全流程端到端覆盖，这里只测失败分支。
  it('pullImage 失败发危险通知并复位拉取中状态', async () => {
    vi.useFakeTimers()
    await useContainersStore.getState().load(gatewayWith())
    const promise = useContainersStore.getState().pullImage(
      gatewayWith({ pullImage: async () => { throw new Error('镜像已存在：redis:8-alpine') } }),
      { name: 'redis', tag: '8-alpine' },
    )
    await vi.advanceTimersByTimeAsync(1500)
    await promise

    const state = useContainersStore.getState()
    expect(state.images).toHaveLength(8)
    expect(state.pullingImage).toBeUndefined()
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '拉取镜像失败：镜像已存在：redis:8-alpine',
    })
  })
})
