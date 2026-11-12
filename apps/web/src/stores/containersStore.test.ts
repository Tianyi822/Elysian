import { vi as terminalVi } from 'vitest'
terminalVi.mock('../components/terminal/rawTerminalRuntime', () => ({ rawTerminalRuntime: () => ({ configure() {}, write() {}, setInteractive() {} }), disposeRawTerminal() {}, deactivateRawTerminal() {} }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import type { Container, ContainerImage } from '@elysian/contracts'
import type { ElysianGateway, EventsAdapter } from '../contracts/adapters'
import { useMessageStore } from './messageStore'
import { useEventStreamStore } from './eventStreamStore'
import {
  containerActionSuccessMessage,
  containerRestartConfirmDescription,
  containerStopConfirmDescription,
} from '../features/container/containerCopy'
import { useContainersStore } from './containersStore'
import { CONTAINERS, CONTAINER_IMAGES } from '../adapters/mock/containersData'

function gatewayWith(overrides: Partial<ElysianGateway['containers']> = {}): ElysianGateway {
  return {
    containers: {
      list: async () => [...CONTAINERS],
      listImages: async () => [...CONTAINER_IMAGES],
      createPolicy: async () => ({ mountRoot: '/srv/elysian', reservedPorts: [48100] }),
      terminalMode: 'repl',
      connectTerminal: async () => ({ id: 'sess-test', user: 'demo', hostLabel: 'ctr', prompt: '$ ' }),
      sendTerminalInput: async () => {},
      resizeTerminal: async () => {},
      acknowledgeTerminal: () => {},
      executeTerminalCommand: async () => ({ lines: ['ok'] }),
      terminalCompletions: () => [],
      disconnectTerminal: async () => {},
      requestAction: async (id: string) => CONTAINERS.find((c) => c.id === id)!,
      create: async () => CONTAINERS[0]!,
      removeImage: async () => {},
      pullImage: async ({ name, tag }: { name: string; tag: string }) => ({
        id: 'img-pulled', name, tag, digest: 'sha256:abcd1234abcd', sizeMb: 42, pulledAt: '2026-09-12T08:00:00.000Z',
      }),
      watchLive: (handlers: {
        onEvent: (event: ElysianEvent) => void
        onStatus: (status: 'live' | 'connecting') => void
      }) => {
        handlers.onStatus('live')
        return () => {}
      },
      ...overrides,
    },
  } as unknown as ElysianGateway
}

/** 事件投递入口：经真实 eventStreamStore 连接注入，测试不直接触内部监听集合。 */
let emitToStore: ((event: ElysianEvent) => void) | undefined

beforeEach(async () => {
  useContainersStore.setState({
    status: 'idle', liveStatus: 'live', errorMessage: undefined, containers: [], images: [], imageRefreshStatus: 'idle', samples: {},
    view: 'grid', statusFilter: 'all', search: '', detailContainerId: undefined,
    terminal: undefined, busyActions: [], createOpen: false, creating: false, removingImageIds: [],
    pullingImage: undefined, imagePullError: undefined,
  })
  useMessageStore.setState({ messages: [] })
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

afterEach(async () => {
  useEventStreamStore.getState().disconnect()
})

function event(name: 'container/sample', payload: Extract<ElysianEvent, { name: 'container/sample' }>['payload']): ElysianEvent
function event(name: 'container/updated', payload: Extract<ElysianEvent, { name: 'container/updated' }>['payload']): ElysianEvent
function event(name: 'container/created', payload: Extract<ElysianEvent, { name: 'container/created' }>['payload']): ElysianEvent
function event(name: 'container/removed', payload: Extract<ElysianEvent, { name: 'container/removed' }>['payload']): ElysianEvent
function event(name: 'container/resync', payload: Extract<ElysianEvent, { name: 'container/resync' }>['payload']): ElysianEvent
function event(
  name: 'container/sample' | 'container/updated' | 'container/created' | 'container/removed' | 'container/resync',
  payload: unknown,
): ElysianEvent {
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

  it('container/updated 的 startedAt 字符串写回、null 清掉字段', async () => {
    await useContainersStore.getState().load(gatewayWith())
    const target = CONTAINERS.find((c) => c.id === 'ctr-nginx-proxy')!
    emitToStore?.(
      event('container/updated', {
        containerId: target.id,
        status: 'running',
        startedAt: '2026-09-13T01:00:00.000Z',
      }),
    )
    expect(useContainersStore.getState().containers.find((c) => c.id === target.id)?.startedAt).toBe(
      '2026-09-13T01:00:00.000Z',
    )

    emitToStore?.(event('container/updated', { containerId: target.id, status: 'stopped', startedAt: null }))
    const stopped = useContainersStore.getState().containers.find((c) => c.id === target.id)
    expect(stopped?.status).toBe('stopped')
    expect(stopped?.startedAt).toBeUndefined()
  })

  it('container/removed 删掉容器并在详情或终端指向它时关掉', async () => {
    await useContainersStore.getState().load(gatewayWith())
    useContainersStore.setState({
      samples: { 'ctr-nginx-proxy': { cpuPercent: 1, memMb: 2 } },
      detailContainerId: 'ctr-nginx-proxy',
      terminal: {
        containerId: 'ctr-nginx-proxy',
        sessionId: 'sess-test',
        prompt: '$ ',

        status: 'connected',

      },
    })
    emitToStore?.(event('container/removed', { containerId: 'ctr-nginx-proxy' }))
    const state = useContainersStore.getState()
    expect(state.containers.some((c) => c.id === 'ctr-nginx-proxy')).toBe(false)
    expect(state.samples['ctr-nginx-proxy']).toBeUndefined()
    expect(state.detailContainerId).toBeUndefined()
    expect(state.terminal).toBeUndefined()
  })

  it('container/resync 再拉 list 与 listImages', async () => {
    const list = vi.fn(async () => [...CONTAINERS].slice(0, 2))
    const listImages = vi.fn(async () => [...CONTAINER_IMAGES].slice(0, 1))
    await useContainersStore.getState().load(gatewayWith({ list, listImages }))
    emitToStore?.(event('container/resync', {}))
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(listImages).toHaveBeenCalledTimes(2)
    expect(useContainersStore.getState().containers).toHaveLength(2)
    expect(useContainersStore.getState().images).toHaveLength(1)
  })

  it('setLiveStatus(connecting) 清空 samples', () => {
    useContainersStore.setState({
      samples: { 'ctr-nginx-proxy': { cpuPercent: 9, memMb: 10 } },
    })
    useContainersStore.getState().setLiveStatus('connecting')
    expect(useContainersStore.getState().samples).toEqual({})
  })

  it('Docker 运行时启停成功通知不含 mock 标注', () => {
    expect(containerActionSuccessMessage('stop', 'web', true)).toBe('容器 web 已停止')
    expect(containerActionSuccessMessage('restart', 'web', true)).toBe('已请求重启 web')
    expect(containerActionSuccessMessage('restart', 'web', false)).toContain('mock')
  })

  it('停止确认含 SIGTERM 与 10 秒；重启确认含服务中断与回到运行中；mock 保持演示说明', () => {
    expect(containerStopConfirmDescription(true)).toContain('SIGTERM')
    expect(containerStopConfirmDescription(true)).toContain('10 秒')
    expect(containerRestartConfirmDescription(true)).toContain('服务会中断')
    expect(containerRestartConfirmDescription(true)).toContain('运行中')
    expect(containerStopConfirmDescription(false)).toContain('演示数据')
    expect(containerRestartConfirmDescription(false)).toContain('演示数据')
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

  it('runAction 成功发通知并清忙碌；失败发危险通知', async () => {
    const gateway = gatewayWith({
      requestAction: async (id, action) => {
        if (action === 'restart') throw new Error('演示环境不支持')
        return CONTAINERS.find((c) => c.id === id)!
      },
    })
    await useContainersStore.getState().load(gateway)

    await useContainersStore.getState().runAction(gateway, 'ctr-backup-agent', 'start')
    expect(useMessageStore.getState().messages[0]?.message).toContain('已启动')

    await useContainersStore.getState().runAction(gateway, 'ctr-nginx-proxy', 'restart')
    const notifications = useMessageStore.getState().messages
    expect(notifications[notifications.length - 1]?.tone).toBe('danger')
    expect(notifications[notifications.length - 1]?.message).toContain('演示环境不支持')
  })

  it('打开另一容器终端时先断开已连接的上一会话', async () => {
    let sessionSeq = 0
    const disconnected: string[] = []
    const gateway = gatewayWith({
      connectTerminal: async () => {
        sessionSeq += 1
        return { id: `sess-${sessionSeq}`, user: 'demo', hostLabel: 'ctr', prompt: '$ ' }
      },
      disconnectTerminal: async (sessionId: string) => {
        disconnected.push(sessionId)
      },
    })
    await useContainersStore.getState().load(gateway)
    await useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    expect(useContainersStore.getState().terminal?.sessionId).toBe('sess-1')

    await useContainersStore.getState().openTerminal(gateway, 'ctr-backup-agent')
    expect(disconnected).toEqual(['sess-1'])
    expect(useContainersStore.getState().terminal?.containerId).toBe('ctr-backup-agent')
    expect(useContainersStore.getState().terminal?.sessionId).toBe('sess-2')
  })

  it('closeTerminal 清空会话；closeDetail 清空详情', async () => {
    const gateway = gatewayWith()
    await useContainersStore.getState().load(gateway)
    await useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    useContainersStore.getState().openDetail('ctr-nginx-proxy')
    await useContainersStore.getState().closeTerminal(gateway)
    useContainersStore.getState().closeDetail()
    const state = useContainersStore.getState()
    expect(state.terminal).toBeUndefined()
    expect(state.detailContainerId).toBeUndefined()
  })
})

/** 可手动落定的 promise，模拟真实 WS 适配器「ready 帧后才 resolve」的 pending 连接。 */
function deferredSession() {
  let resolve!: (info: { id: string; user: string; hostLabel: string; prompt: string }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ id: string; user: string; hostLabel: string; prompt: string }>(
    (res, rej) => {
      resolve = res
      reject = rej
    },
  )
  return { promise, resolve, reject }
}

const SESSION_INFO = { id: 'sess-test', user: 'root', hostLabel: 'ctr', prompt: '$ ' } as const

describe('终端会话 connecting 态', () => {
  it('connecting 态连点两次只产生一次 connectTerminal（打开串行化）', async () => {
    const gate = deferredSession()
    const connect = vi.fn(() => gate.promise)
    const gateway = gatewayWith({ connectTerminal: connect })
    await useContainersStore.getState().load(gateway)

    const first = useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    const second = useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    expect(connect).toHaveBeenCalledTimes(1)

    gate.resolve(SESSION_INFO)
    await Promise.all([first, second])
    expect(useContainersStore.getState().terminal?.sessionId).toBe('sess-test')
  })

  it('connecting 中 closeTerminal 取消未决连接，立即重开同一容器不被迟到结算污染', async () => {
    const first = deferredSession()
    const cancel = vi.fn(() => {
      // 与真实 cancelTerminalConnect 同语义：先 settle（reject）未决连接。
      first.reject(new Error('连接容器终端失败'))
    })
    const gateway = gatewayWith({
      connectTerminal: vi.fn(() => first.promise),
      cancelTerminalConnect: cancel,
    })
    await useContainersStore.getState().load(gateway)

    const opening = useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    expect(useContainersStore.getState().terminal?.status).toBe('connecting')

    await useContainersStore.getState().closeTerminal(gateway)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useContainersStore.getState().terminal).toBeUndefined()
    // openTerminal 把连接失败吞进会话状态（不向调用方抛）；这里等它落定，
    // 冲掉迟到 rejection 的微任务链，确认取消路径没有把 terminal 状态写回。
    await opening

    // 立即重开同一容器：connecting 中关窗不得卡住重开，新会话干净落位。
    const second = deferredSession()
    vi.mocked(gateway.containers.connectTerminal).mockImplementation(() => second.promise)
    const reopening = useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    second.resolve({ ...SESSION_INFO, id: 'sess-2' })
    await reopening
    await vi.waitFor(() => {
      const terminal = useContainersStore.getState().terminal
      expect(terminal?.status).toBe('connected')
      expect(terminal?.sessionId).toBe('sess-2')
      expect(terminal?.errorMessage).toBeUndefined()
    })
  })

  it('connecting 中取消后重开，旧连接的迟到 resolve 不改写新会话', async () => {
    const first = deferredSession()
    const disconnect = vi.fn(async () => {})
    const gateway = gatewayWith({
      connectTerminal: vi.fn(() => first.promise),
      cancelTerminalConnect: () => {},
      disconnectTerminal: disconnect,
    })
    await useContainersStore.getState().load(gateway)

    const opening = useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    await useContainersStore.getState().closeTerminal(gateway)

    const second = deferredSession()
    vi.mocked(gateway.containers.connectTerminal).mockImplementation(() => second.promise)
    const reopening = useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    second.resolve({ ...SESSION_INFO, id: 'sess-2' })
    await reopening

    first.resolve({ ...SESSION_INFO, id: 'sess-old' }) // 迟到的 resolve
    await opening
    await vi.waitFor(() => {
      const terminal = useContainersStore.getState().terminal
      expect(terminal?.sessionId).toBe('sess-2')
      expect(terminal?.status).toBe('connected')
      expect(disconnect).toHaveBeenCalledWith('sess-old')
    })
  })

  it('container/removed 在 connecting 态也取消未决连接', async () => {
    const gate = deferredSession()
    const cancel = vi.fn()
    const gateway = gatewayWith({
      connectTerminal: vi.fn(() => gate.promise),
      cancelTerminalConnect: cancel,
    })
    await useContainersStore.getState().load(gateway)

    void useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    expect(useContainersStore.getState().terminal?.status).toBe('connecting')

    emitToStore?.(event('container/removed', { containerId: 'ctr-nginx-proxy' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useContainersStore.getState().terminal).toBeUndefined()
  })
})

describe('终端会话状态', () => {
  it('退出保留元数据并显示退出原因；不在 store 保存终端屏幕', async () => {
    const gateway = gatewayWith()
    await useContainersStore.getState().openTerminal(gateway, 'ctr-nginx-proxy')
    useContainersStore.getState().applyTerminalFrame('sess-test', { type: 'exit', exitCode: 7 })
    expect(useContainersStore.getState().terminal).toMatchObject({ status: 'error', errorMessage: '会话已退出（退出码 7）' })
    expect(useContainersStore.getState().terminal).not.toHaveProperty('lines')
  })
  it('空闲超时使用容器终端中文原因', async () => {
    await useContainersStore.getState().openTerminal(gatewayWith(), 'ctr-nginx-proxy')
    useContainersStore.getState().handleTerminalClose('sess-test', { code: 4000, reason: '' })
    expect(useContainersStore.getState().terminal?.errorMessage).toBe('终端会话空闲超时，已断开')
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
    expect(state.createError).toBe('创建容器失败：镜像不存在，无法创建容器')
    expect(useMessageStore.getState().messages[0]).toMatchObject({
      tone: 'danger',
      message: '创建容器失败：镜像不存在，无法创建容器',
    })
    useContainersStore.getState().openCreate()
    expect(useContainersStore.getState().createError).toBeUndefined()
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
    expect(useMessageStore.getState().messages[0]).toMatchObject({
      tone: 'danger',
      message: '删除镜像失败：镜像仍被容器引用，删除失败',
    })
  })

  it('removeImage 失败后刷新 listImages', async () => {
    const listImages = vi.fn(async () => [...CONTAINER_IMAGES].slice(0, 3))
    await useContainersStore.getState().load(gatewayWith({ listImages }))
    await useContainersStore.getState().removeImage(
      gatewayWith({
        listImages,
        removeImage: async () => {
          throw new Error('冲突')
        },
      }),
      'img-nginx',
    )
    expect(listImages).toHaveBeenCalledTimes(2)
    expect(useContainersStore.getState().images).toHaveLength(3)
  })
})

describe('镜像列表刷新', () => {
  it('失败保留旧列表并走通知，成功更新列表并走通知', async () => {
    await useMessageStore.getState().clear()
    await useContainersStore.getState().load(gatewayWith())
    const oldImages = useContainersStore.getState().images
    await useContainersStore.getState().refreshImages(gatewayWith({ listImages: async () => { throw new Error('断线') } }))
    expect(useContainersStore.getState()).toMatchObject({ images: oldImages, imageRefreshStatus: 'idle' })
    expect(useMessageStore.getState().messages.at(-1)).toMatchObject({ tone: 'danger', message: '刷新镜像失败：断线' })
    await useContainersStore.getState().refreshImages(gatewayWith({ listImages: async () => [...CONTAINER_IMAGES].slice(0, 2) }))
    expect(useContainersStore.getState()).toMatchObject({ imageRefreshStatus: 'idle' })
    expect(useMessageStore.getState().messages.at(-1)).toMatchObject({ tone: 'success', message: '镜像列表已刷新' })
    expect(useContainersStore.getState().images).toHaveLength(2)
  })

  it('页签自动刷新（notify:false）成功静默、失败仍发危险通知', async () => {
    await useMessageStore.getState().clear()
    await useContainersStore.getState().load(gatewayWith())
    await useContainersStore.getState().refreshImages(
      gatewayWith({ listImages: async () => [...CONTAINER_IMAGES] }),
      { notify: false },
    )
    expect(useMessageStore.getState().messages).toHaveLength(0)
    await useContainersStore.getState().refreshImages(
      gatewayWith({ listImages: async () => { throw new Error('断线') } }),
      { notify: false },
    )
    expect(useMessageStore.getState().messages.at(-1)).toMatchObject({ tone: 'danger', message: '刷新镜像失败：断线' })
  })

  it('晚到的刷新不得覆盖删除和下一次刷新', async () => {
    await useContainersStore.getState().load(gatewayWith())
    let settle!: (images: readonly ContainerImage[]) => void
    const stale = new Promise<readonly ContainerImage[]>((resolve) => { settle = resolve })
    const first = useContainersStore.getState().refreshImages(gatewayWith({ listImages: () => stale }))
    await useContainersStore.getState().removeImage(gatewayWith(), CONTAINER_IMAGES[0]!.id)
    settle([...CONTAINER_IMAGES])
    await first
    expect(useContainersStore.getState().images.some((image) => image.id === CONTAINER_IMAGES[0]!.id)).toBe(false)

    let settleSecond!: (images: readonly ContainerImage[]) => void
    const second = new Promise<readonly ContainerImage[]>((resolve) => { settleSecond = resolve })
    const pending = useContainersStore.getState().refreshImages(gatewayWith({ listImages: () => second }))
    await useContainersStore.getState().refreshImages(gatewayWith({ listImages: async () => [] }))
    settleSecond([...CONTAINER_IMAGES])
    await pending
    expect(useContainersStore.getState().images).toEqual([])
  })

  it('晚到的刷新不得移除刚拉取的镜像', async () => {
    vi.useFakeTimers()
    try {
      await useContainersStore.getState().load(gatewayWith())
      let settle!: (images: readonly ContainerImage[]) => void
      const stale = new Promise<readonly ContainerImage[]>((resolve) => { settle = resolve })
      const refreshing = useContainersStore.getState().refreshImages(gatewayWith({ listImages: () => stale }))
      const pulling = useContainersStore.getState().pullImage(gatewayWith(), { name: 'newrepo', tag: 'latest' })
      await vi.advanceTimersByTimeAsync(1500)
      await pulling
      settle([...CONTAINER_IMAGES])
      await refreshing
      expect(useContainersStore.getState().images.some((image) => image.name === 'newrepo')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('晚到的手动刷新不得覆盖事件重同步后的镜像列表', async () => {
    let settle!: (images: readonly ContainerImage[]) => void
    const stale = new Promise<readonly ContainerImage[]>((resolve) => { settle = resolve })
    let calls = 0
    const listImages = vi.fn(() => {
      calls += 1
      if (calls === 2) return stale
      return Promise.resolve(calls === 3 ? [...CONTAINER_IMAGES].slice(0, 1) : [...CONTAINER_IMAGES])
    })
    const gateway = gatewayWith({ listImages })
    await useContainersStore.getState().load(gateway)
    const pending = useContainersStore.getState().refreshImages(gateway)
    emitToStore?.(event('container/resync', {}))
    await vi.waitFor(() => expect(useContainersStore.getState().images).toHaveLength(1))
    settle([...CONTAINER_IMAGES])
    await pending
    expect(useContainersStore.getState().images).toHaveLength(1)
  })
})

describe('拉取镜像', () => {
  afterEach(async () => {
    vi.useRealTimers()
  })

  it('准备阶段也能停止，不派发拉取且通知为取消', async () => {
    vi.useFakeTimers()
    const pullImage = vi.fn()
    const listImages = vi.fn(async () => [...CONTAINER_IMAGES])
    const pending = useContainersStore.getState().pullImage(gatewayWith({ pullImage, listImages }), { name: 'cancel-preparing', tag: 'latest' })
    useContainersStore.getState().cancelImagePull()
    useContainersStore.getState().cancelImagePull()
    await pending
    await vi.advanceTimersByTimeAsync(2000)
    expect(pullImage).not.toHaveBeenCalled()
    expect(listImages).toHaveBeenCalledTimes(1)
    expect(useContainersStore.getState().pullingImage).toBeUndefined()
    expect(useContainersStore.getState().imagePullError).toBeUndefined()
    expect(useMessageStore.getState().messages).toEqual([expect.objectContaining({ tone: 'info', message: '已取消镜像 cancel-preparing:latest 的拉取请求' })])
  })

  it('停止在途拉取传递信号，迟到的进度与成功不污染下一次拉取', async () => {
    vi.useFakeTimers()
    let oldProgress!: (progress: { phase: 'preparing' }) => void
    let finish!: (image: ContainerImage) => void
    const pullImage = vi.fn<ElysianGateway['containers']['pullImage']>((_input, onProgress) => {
      oldProgress = onProgress!
      return new Promise<ContainerImage>((resolve) => { finish = resolve })
    })
    const gateway = gatewayWith({ pullImage })
    const first = useContainersStore.getState().pullImage(gateway, { name: 'cancel-old', tag: 'latest' })
    await vi.advanceTimersByTimeAsync(1500)
    const signal = pullImage.mock.calls[0]![2]
    useContainersStore.getState().cancelImagePull()
    expect(signal?.aborted).toBe(true)
    await first

    const second = useContainersStore.getState().pullImage(gatewayWith(), { name: 'new-pull', tag: 'latest' })
    oldProgress({ phase: 'preparing' })
    finish({ ...CONTAINER_IMAGES[0]!, id: 'cancel-late', name: 'cancel-old', tag: 'latest' })
    await Promise.resolve()
    expect(useContainersStore.getState().pullingImage?.name).toBe('new-pull')
    expect(useContainersStore.getState().pullingImage?.progress).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    await second
    expect(useContainersStore.getState().images.some((row) => row.name === 'cancel-old')).toBe(false)
    expect(useContainersStore.getState().images.some((row) => row.name === 'new-pull')).toBe(true)
    expect(useMessageStore.getState().messages.some((row) => row.tone === 'success' && row.message.includes('cancel-old'))).toBe(false)
  })

  it('接收适配器实时层进度并写入拉取中行，完成后清除进度', async () => {
    vi.useFakeTimers()
    await useContainersStore.getState().load(gatewayWith())
    let finish!: (image: ContainerImage) => void
    const pullImage = vi.fn((_input: unknown, onProgress?: (progress: { phase: 'downloading'; layerId: string; currentBytes: number; totalBytes: number }) => void) => {
      onProgress?.({ phase: 'downloading', layerId: 'abc', currentBytes: 25, totalBytes: 100 })
      return new Promise<ContainerImage>((resolve) => { finish = resolve })
    })
    const pending = useContainersStore.getState().pullImage(gatewayWith({ pullImage }), { name: 'newrepo', tag: 'latest' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(useContainersStore.getState().pullingImage?.progress).toEqual({
      phase: 'downloading', layerId: 'abc', currentBytes: 25, totalBytes: 100,
    })
    finish({ ...CONTAINER_IMAGES[0]!, id: 'img-newrepo', name: 'newrepo', tag: 'latest' })
    await pending
    expect(useContainersStore.getState().pullingImage).toBeUndefined()
  })

  // 成功路径由 ContainerPage.test 的拉取全流程端到端覆盖，这里只测失败分支。
  it('pullImage 失败回读列表，并保留源地址与错误直到关闭或新拉取', async () => {
    vi.useFakeTimers()
    await useContainersStore.getState().load(gatewayWith())
    const promise = useContainersStore.getState().pullImage(
      gatewayWith({ pullImage: async () => { throw new Error('镜像已存在：redis:8-alpine') } }),
      { name: 'redis', tag: '8-alpine', registry: 'https://docker.1ms.run' },
    )
    await vi.advanceTimersByTimeAsync(1500)
    await promise

    const state = useContainersStore.getState()
    expect(state.images).toHaveLength(8)
    expect(state.pullingImage).toBeUndefined()
    expect(state.imagePullError).toEqual({ name: 'redis', tag: '8-alpine', registry: 'https://docker.1ms.run', message: '镜像已存在：redis:8-alpine' })
    expect(useMessageStore.getState().messages[0]).toMatchObject({
      tone: 'danger',
      message: '拉取镜像失败：镜像已存在：redis:8-alpine',
    })
    await useMessageStore.getState().clear()
    expect(useContainersStore.getState().imagePullError?.message).toBe('镜像已存在：redis:8-alpine')
    const next = useContainersStore.getState().pullImage(gatewayWith(), { name: 'next', tag: 'latest' })
    expect(useContainersStore.getState().imagePullError).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    await next
  })
})
