import { captureAuthGeneration } from '../utils/authGeneration'
import type { Container, ContainerAction, ContainerCreateInput, ContainerSample, ContainerStatus, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import type {
  ElysianGateway,
  HostTerminalCloseInfo,
  HostTerminalFrame,
} from '../contracts/adapters'
import { hostTerminalCloseMessage } from '../terminal/terminalCloseMessage'
import { deactivateRawTerminal, disposeRawTerminal, rawTerminalRuntime } from '../terminal/rawTerminalRuntime'
import { isDockerRuntime } from '../utils/isDockerRuntime'
import { demoNoticeSuffix, MOCK_ACTION_NOTE } from '../utils/demoNotice'
import {
  containerActionSuccessMessage,
  containerRemoveBlockedReason,
  CONTAINER_TERMINAL_CLOSE_FALLBACK,
} from '../utils/containerCopy'
import { getLastContainerSample, onStreamEvent } from './eventStreamStore'
import { useMessageStore } from './messageStore'
import { messageOf } from '../utils/errorMessage'
import { createContainerImages, type ContainerImagesState } from './containerImages'
import { createContainerInventory } from './containerInventory'
import { createTabMemorySlice, type TabMemoryState } from './tabMemoryStore'

type ContainerTerminalStatus = 'connecting' | 'connected' | 'error'

type TerminalSession = {
  containerId: string
  sessionId: string
  openId?: string
  prompt?: string
  status: ContainerTerminalStatus
  errorMessage?: string
}

let pendingTerminalSeq = 1

function nextPendingTerminalId(): string {
  const id = `pending-ctr-term-${pendingTerminalSeq}`
  pendingTerminalSeq += 1
  return id
}

/**
 * 终端会话的统一释放入口：connected 断开真实会话，connecting 经 cancelTerminalConnect
 * 取消未决连接（先 settle 再关 socket，被取消的 openTerminal 不会悬挂）。
 * closeTerminal 与 container/removed 共用，防止 connecting 态的 pending WS 无人关闭、
 * 占用服务端会话槽位直到空闲超时。
 */
function releaseTerminalSession(gateway: ElysianGateway | undefined, session: TerminalSession): void {
  disposeRawTerminal(`container:${session.sessionId}`)
  if (!gateway) return
  if (session.status === 'connected') {
    void gateway.containers.disconnectTerminal(session.sessionId).catch(() => {
      // 适配层已无此会话时界面仍要关掉窗口。
    })
    return
  }
  if (session.status === 'connecting') {
    gateway.containers.cancelTerminalConnect?.()
  }
}

/** 采样表以最近一拍为准：载荷未覆盖的容器显示 —。 */
function applySamples(samples: readonly ContainerSample[]): void {
  useContainersStore.setState({
    samples: Object.fromEntries(
      samples.map((sample) => [sample.containerId, { cpuPercent: sample.cpuPercent, memMb: sample.memMb }]),
    ),
  })
}

/*
 * 事件回灌：container/sample 更新采样表（以最近一拍为准，载荷未覆盖的容器显示 —），
 * container/updated 更新状态列；HTTP 动作的忙碌标记只在请求结清时释放。
 */
let detachLive: Unsubscribe | undefined
let activeGateway: ElysianGateway | undefined
let containerActionScope: { gateway: ElysianGateway; auth: number } | undefined
let pendingLoad: { read: Promise<void>; promise: Promise<void> } | undefined

const imageActions = createContainerImages(
  () => useContainersStore.getState(),
  (update) => useContainersStore.setState(update),
)
const inventory = createContainerInventory(
  () => useContainersStore.getState(),
  (update) => useContainersStore.setState(update),
  imageActions.captureImageCommit,
)

/** 容器页和数据库页共用 Docker 清单，数据库登记及其读取状态由数据库域维护。 */
export function readContainerInventory(gateway: ElysianGateway, options?: { fresh?: boolean }): Promise<void> {
  activeGateway = gateway
  attachLiveEvents()
  return inventory.read(gateway, options)
}

async function refreshAfterResync(): Promise<void> {
  if (!activeGateway) return
  try {
    await readContainerInventory(activeGateway, { fresh: true })
  } catch {
    // 重同步失败时保留当前列表，等待下一拍 resync 或用户手动刷新。
  }
}

function applyContainerRemoval(containerId: string, gateway?: ElysianGateway): void {
  const { terminal } = useContainersStore.getState()
  const closesTerminal = terminal?.containerId === containerId
  useContainersStore.setState((state) => {
    const { [containerId]: _sample, ...samples } = state.samples
    return {
      containers: state.containers.filter((container) => container.id !== containerId),
      samples,
      detailContainerId: state.detailContainerId === containerId ? undefined : state.detailContainerId,
      terminal: closesTerminal ? undefined : state.terminal,
    }
  })
  if (closesTerminal) releaseTerminalSession(gateway, terminal)
}

function containerMutationCurrent(gateway: ElysianGateway): () => boolean {
  const auth = captureAuthGeneration()
  if (containerActionScope?.gateway !== gateway || containerActionScope.auth !== auth) {
    containerActionScope = { gateway, auth }
    useContainersStore.setState({ busyActions: [] })
  }
  const scope = containerActionScope
  return () => containerActionScope === scope && captureAuthGeneration() === auth
}

function containerBusy(keys: readonly string[], id: string): boolean {
  return keys.some((key) => key.startsWith(`${id}:`))
}

function attachLiveEvents(): void {
  if (detachLive) return
  detachLive = onStreamEvent((event) => {
    if (event.name === 'container/sample') {
      applySamples(event.payload.samples)
      return
    }
    if (event.name === 'container/created') {
      const container = event.payload.container
      useContainersStore.setState((state) => ({
        containers: state.containers.some((c) => c.id === container.id)
          ? state.containers
          : [...state.containers, container],
      }))
      return
    }
    if (event.name === 'container/updated') {
      const { containerId, status, startedAt } = event.payload
      useContainersStore.setState((state) => ({
        containers: state.containers.map((container) => {
          if (container.id !== containerId) return container
          if (startedAt === null) {
            const { startedAt: _removed, ...rest } = container
            return { ...rest, status }
          }
          if (typeof startedAt === 'string') {
            return { ...container, status, startedAt }
          }
          return { ...container, status }
        }),
      }))
      return
    }
    if (event.name === 'container/removed') {
      applyContainerRemoval(event.payload.containerId, activeGateway)
      return
    }
    if (event.name === 'container/resync') {
      void refreshAfterResync()
    }
  })
}

/*
 * 首屏不空等：页面挂载晚于事件流连接，事件源订阅即补发的那拍采样
 * 发生在监听器注册之前，从事件流 store 的采样缓存回放最新一拍 container/sample
 * （缓存不随重连清空，回放宁可旧一拍也不空屏）。
 */
function replayLatestSample(): void {
  const latest = getLastContainerSample()
  if (latest?.name === 'container/sample') applySamples(latest.payload.samples)
}

type ContainerView = 'grid' | 'images' | 'apps'

export const useContainersStore = create<TabMemoryState<ContainerView> & ContainerImagesState & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  liveStatus: 'live' | 'connecting'
  errorMessage?: string
  containers: readonly Container[]
  samples: Readonly<Record<string, { cpuPercent: number; memMb: number }>>
  statusFilter: ContainerStatus | 'all'
  search: string
  detailContainerId?: string
  terminal?: TerminalSession
  busyActions: readonly string[]
  createOpen: boolean
  creating: boolean
  createError?: string
  clearDisplay: () => void
  load: (gateway: ElysianGateway) => Promise<void>
  setLiveStatus: (status: 'live' | 'connecting') => void
  setStatusFilter: (filter: ContainerStatus | 'all') => void
  setSearch: (value: string) => void
  openCreate: () => void
  closeCreate: () => void
  createContainer: (gateway: ElysianGateway, input: ContainerCreateInput) => Promise<void>
  removeContainer: (gateway: ElysianGateway, containerId: string) => Promise<void>
  openDetail: (containerId: string) => void
  closeDetail: () => void
  openTerminal: (gateway: ElysianGateway, containerId: string) => Promise<void>
  closeTerminal: (gateway: ElysianGateway) => Promise<void>
  applyTerminalFrame: (sessionId: string, frame: HostTerminalFrame) => void
  handleTerminalClose: (sessionId: string, info: HostTerminalCloseInfo) => void
  runAction: (gateway: ElysianGateway, containerId: string, action: ContainerAction) => Promise<void>
}>((set, get, store) => ({
  status: 'idle',
  liveStatus: 'live',
  containers: [],
  ...imageActions.state,
  samples: {},
  ...createTabMemorySlice<ContainerView>('grid', set),
  statusFilter: 'all',
  search: '',
  busyActions: [],
  createOpen: false, creating: false,

  clearDisplay() {
    const { terminal, tab } = get()
    const gateway = activeGateway
    activeGateway = undefined
    detachLive?.()
    detachLive = undefined
    containerActionScope = undefined
    pendingLoad = undefined
    inventory.reset()
    const cancelPull = imageActions.invalidate()
    set({ ...store.getInitialState(), tab }, true)
    cancelPull()
    if (terminal) releaseTerminalSession(gateway, terminal)
  },

  setLiveStatus(liveStatus) {
    set({
      liveStatus,
      ...(liveStatus === 'connecting' ? { samples: {} } : {}),
    })
  },

  load(gateway) {
    containerMutationCurrent(gateway)
    const auth = captureAuthGeneration()
    imageActions.syncActionGeneration(auth)
    const read = readContainerInventory(gateway)
    if (pendingLoad?.read === read) return pendingLoad.promise
    const operation = { read, promise: Promise.resolve() }
    const hadData = get().status === 'ready'
    pendingLoad = operation
    const current = () => pendingLoad === operation && activeGateway === gateway && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', errorMessage: undefined })
    operation.promise = (async () => {
      try {
        await read
        if (!current()) return
        set({ status: 'ready' })
        replayLatestSample()
      } catch (error) {
        if (current()) set({ status: hadData ? 'ready' : 'error', errorMessage: messageOf(error, '读取容器数据失败') })
      } finally { if (pendingLoad === operation) pendingLoad = undefined }
    })()
    return operation.promise
  },

  setStatusFilter(statusFilter) {
    set({ statusFilter })
  },
  setSearch(search) {
    set({ search })
  },
  openCreate() {
    set({ createOpen: true, createError: undefined })
  },
  closeCreate() {
    set({ createOpen: false })
  },

  async createContainer(gateway, input) {
    const current = containerMutationCurrent(gateway)
    set({ creating: true, createError: undefined })
    try {
      const created = await gateway.containers.create(input)
      if (!current()) return
      useMessageStore
        .getState()
        .notify({
          tone: 'success',
          message: `容器 ${created.name} 已创建${demoNoticeSuffix(isDockerRuntime(), MOCK_ACTION_NOTE)}`,
        })
      set((state) => ({
        // 事件回灌通常已追加过；按 id 去重，返回值只做兜底。
        containers: state.containers.some((c) => c.id === created.id)
          ? state.containers
          : [...state.containers, created],
        createOpen: false,
      }))
    } catch (error) {
      if (!current()) return
      const detail = messageOf(error)
      set({ createError: `创建容器失败：${detail}` })
      useMessageStore.getState().notify({ tone: 'danger', message: `创建容器失败：${detail}` })
    } finally {
      if (current()) set({ creating: false })
    }
  },

  openDetail(containerId) {
    set({ detailContainerId: containerId })
  },
  closeDetail() {
    set({ detailContainerId: undefined })
  },

  async openTerminal(gateway, containerId) {
    const current = get().terminal
    if (current?.status === 'connecting') return
    if (current) releaseTerminalSession(gateway, current)
    const pendingId = nextPendingTerminalId()
    const generation = captureAuthGeneration()
    set({ terminal: { containerId, sessionId: pendingId, openId: pendingId, prompt: '$ ', status: 'connecting' } })
    const earlyFrames: Array<{ id: string; frame: HostTerminalFrame }> = []
    let accepted = false
    let earlyClose: { id: string; info: HostTerminalCloseInfo } | undefined
    try {
      const info = await gateway.containers.connectTerminal(containerId, {
        onFrame(id, frame) {
          if (get().terminal?.openId !== pendingId) return
          if (accepted) get().applyTerminalFrame(id, frame)
          else earlyFrames.push({ id, frame })
        },
        onClose(id, closeInfo) {
          if (get().terminal?.openId !== pendingId) return
          if (accepted) get().handleTerminalClose(id, closeInfo)
          else earlyClose = { id, info: closeInfo }
        },
      })
      if (generation !== captureAuthGeneration() || get().terminal?.sessionId !== pendingId) {
        await gateway.containers.disconnectTerminal(info.id).catch(() => {}); return
      }
      if (gateway.containers.terminalMode === 'pty') rawTerminalRuntime(`container:${info.id}`).configure({
        send: data => gateway.containers.sendTerminalInput(info.id, data),
        resize: (cols, rows) => gateway.containers.resizeTerminal(info.id, cols, rows),
        acknowledge: bytes => gateway.containers.acknowledgeTerminal(info.id, bytes),
        onError: message => {
          get().handleTerminalClose(info.id, { code: 1006, reason: message })
          void gateway.containers.disconnectTerminal(info.id).catch(() => {})
        },
      })
      set(state => ({ terminal: state.terminal?.sessionId === pendingId ? { ...state.terminal, sessionId: info.id, prompt: info.prompt, status: 'connected' } : state.terminal }))
      accepted = true
      for (const { id, frame } of earlyFrames) get().applyTerminalFrame(id, frame)
      if (earlyClose) get().handleTerminalClose(earlyClose.id, earlyClose.info)
    } catch (error) {
      if (generation !== captureAuthGeneration() || get().terminal?.sessionId !== pendingId) return
      const errorMessage = messageOf(error, '连接容器终端失败')
      set(state => ({ terminal: state.terminal && { ...state.terminal, status: 'error', errorMessage } }))
      useMessageStore.getState().notify({ tone: 'danger', message: errorMessage })
    }
  },
  async closeTerminal(gateway) {
    const session = get().terminal
    if (session) releaseTerminalSession(gateway, session)
    set({ terminal: undefined })
  },
  applyTerminalFrame(sessionId, frame) {
    if (get().terminal?.sessionId !== sessionId) return
    if (frame.type === 'output') { rawTerminalRuntime(`container:${sessionId}`).write(frame.data); return }
    get().handleTerminalClose(sessionId, { code: 1008, reason: `会话已退出（退出码 ${frame.exitCode}）` })
  },
  handleTerminalClose(sessionId, info) {
    const session = get().terminal
    if (!session || session.sessionId !== sessionId || session.status === 'error') return
    deactivateRawTerminal(`container:${sessionId}`)
    const errorMessage = info.reason || hostTerminalCloseMessage(info.code, info.reason, CONTAINER_TERMINAL_CLOSE_FALLBACK)
    set({ terminal: { ...session, status: 'error', errorMessage } })
    useMessageStore.getState().notify({ tone: 'danger', message: errorMessage })
  },

  async runAction(gateway, containerId, action) {
    const current = containerMutationCurrent(gateway)
    if (containerBusy(get().busyActions, containerId)) return
    const key = `${containerId}:${action}`
    const name = get().containers.find((c) => c.id === containerId)?.name ?? containerId
    set((state) => ({ busyActions: [...state.busyActions, key] }))
    try {
      await gateway.containers.requestAction(containerId, action)
      if (!current()) return
      useMessageStore.getState().notify({
        tone: 'success',
        message: containerActionSuccessMessage(action, name, isDockerRuntime()),
      })
    } catch (error) {
      if (!current()) return
      const detail = messageOf(error)
      useMessageStore
        .getState()
        .notify({ tone: 'danger', message: `容器 ${name} 操作失败：${detail}` })
    } finally {
      if (current()) set((state) => ({ busyActions: state.busyActions.filter((k) => k !== key) }))
    }
  },

  async removeContainer(gateway, containerId) {
    const current = containerMutationCurrent(gateway)
    const container = get().containers.find((candidate) => candidate.id === containerId)
    if (!container || containerRemoveBlockedReason(container, containerBusy(get().busyActions, containerId))) return
    const key = `${containerId}:remove`
    set((state) => ({ busyActions: [...state.busyActions, key] }))
    try {
      await gateway.containers.removeContainer(containerId)
      if (!current()) return
      applyContainerRemoval(containerId, gateway)
      useMessageStore.getState().notify({ tone: 'success', message: `容器 ${container.name} 已删除${isDockerRuntime() ? '' : '（演示）'}` })
    } catch (error) {
      if (!current()) return
      const detail = messageOf(error)
      useMessageStore.getState().notify({ tone: 'danger', message: `未能确认删除容器 ${container.name}：${detail}` })
      const snapshot = get().containers
      try {
        const containers = await gateway.containers.list()
        if (!current() || snapshot !== get().containers) return
        const actual = containers.find((candidate) => candidate.id === containerId)
        if (actual) {
          set({ containers: snapshot.map((candidate) => candidate.id === containerId ? actual : candidate) })
        } else {
          applyContainerRemoval(containerId, gateway)
        }
      } catch {
        // 回读失败保留上次事实，不自动重投删除。
      }
    } finally {
      if (current()) set((state) => ({ busyActions: state.busyActions.filter((candidate) => candidate !== key) }))
    }
  },
}))
