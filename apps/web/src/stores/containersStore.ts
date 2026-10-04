import type { Container, ContainerAction, ContainerCreateInput, ContainerImage, ContainerSample, ContainerStatus, ImagePullProgress, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import { resolveViewTab, writeStoredViewTab } from '../app/theme/themePreferences'
import type {
  ElysianGateway,
  HostTerminalCloseInfo,
  HostTerminalFrame,
  HostTerminalHandlers,
} from '../contracts/adapters'
import {
  hostTerminalCloseMessage,
  pushHistory,
  type TerminalLine,
} from '../components/terminal/terminalSession'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import {
  containerActionSuccessMessage,
  CONTAINER_TERMINAL_CLOSE_FALLBACK,
} from '../features/container/containerCopy'
import { getLastContainerSample, onStreamEvent } from './eventStreamStore'
import { useNotificationStore } from './notificationStore'

type ContainerTerminalStatus = 'connecting' | 'connected' | 'error'

type TerminalSession = {
  containerId: string
  sessionId: string
  /** 每次打开唯一；即使测试适配器重用 sessionId，旧回调也不能污染新窗口。 */
  openId?: string
  prompt: string
  status: ContainerTerminalStatus
  lines: readonly TerminalLine[]
  history: readonly string[]
}

let pendingTerminalSeq = 1

function nextPendingTerminalId(): string {
  const id = `pending-ctr-term-${pendingTerminalSeq}`
  pendingTerminalSeq += 1
  return id
}

function asOutputLines(lines: readonly string[]): readonly TerminalLine[] {
  return lines.map((text): TerminalLine => ({ kind: 'output', text }))
}

const TERMINAL_BANNER = '演示终端 · 待接入真实执行'

/**
 * 终端会话的统一释放入口：connected 断开真实会话，connecting 经 cancelTerminalConnect
 * 取消未决连接（先 settle 再关 socket，被取消的 openTerminal 不会悬挂）。
 * closeTerminal 与 container/removed 共用，防止 connecting 态的 pending WS 无人关闭、
 * 占用服务端会话槽位直到空闲超时。
 */
function releaseTerminalSession(gateway: ElysianGateway | undefined, session: TerminalSession): void {
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
 * container/updated 更新状态列并清掉该容器的忙碌标记。
 */
let detachLive: Unsubscribe | undefined
let activeGateway: ElysianGateway | undefined
let imageRevision = 0
let imageRefreshSequence = 0
let imagePullSequence = 0

async function refreshAfterResync(): Promise<void> {
  const gateway = activeGateway
  if (!gateway) return
  const revision = imageRevision
  try {
    const [containers, images] = await Promise.all([
      gateway.containers.list(),
      gateway.containers.listImages(),
    ])
    const canCommitImages = revision === imageRevision
    if (canCommitImages) imageRevision += 1
    useContainersStore.setState({ containers, ...(canCommitImages ? { images } : {}) })
  } catch {
    // 重同步失败时保留当前列表，等待下一拍 resync 或用户手动刷新。
  }
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
        busyActions: state.busyActions.filter((key) => !key.startsWith(`${containerId}:`)),
      }))
      return
    }
    if (event.name === 'container/removed') {
      const { containerId } = event.payload
      useContainersStore.setState((state) => {
        const { [containerId]: _sample, ...samples } = state.samples
        return {
          containers: state.containers.filter((container) => container.id !== containerId),
          samples,
          detailContainerId:
            state.detailContainerId === containerId ? undefined : state.detailContainerId,
          terminal: (() => {
            if (state.terminal?.containerId !== containerId) return state.terminal
            // connecting 态同样取消：pending WS 也要关掉，不能留给服务端空闲超时收敛。
            releaseTerminalSession(activeGateway, state.terminal)
            return undefined
          })(),
          busyActions: state.busyActions.filter((key) => !key.startsWith(`${containerId}:`)),
        }
      })
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

/** 拉取的模拟传输耗时；测试用假计时器推进。 */
const PULL_DELAY_MS = 1500

export const useContainersStore = create<{
  status: 'idle' | 'loading' | 'ready' | 'error'
  liveStatus: 'live' | 'connecting'
  errorMessage?: string
  containers: readonly Container[]
  images: readonly ContainerImage[]
  /** 镜像手动刷新的忙碌标记（loading 期间锁按钮）；结果经全局通知组件反馈，页面不另写反馈条。 */
  imageRefreshStatus: 'idle' | 'loading'
  samples: Readonly<Record<string, { cpuPercent: number; memMb: number }>>
  view: 'grid' | 'images' | 'apps'
  statusFilter: ContainerStatus | 'all'
  search: string
  detailContainerId?: string
  terminal?: TerminalSession
  busyActions: readonly string[]
  createOpen: boolean
  creating: boolean
  removingImageIds: readonly string[]
  pullingImage?: { name: string; tag: string; registry?: string; progress?: ImagePullProgress }
  load: (gateway: ElysianGateway) => Promise<void>
  refreshImages: (gateway: ElysianGateway, options?: { notify?: boolean }) => Promise<void>
  setLiveStatus: (status: 'live' | 'connecting') => void
  setView: (view: 'grid' | 'images' | 'apps') => void
  setStatusFilter: (filter: ContainerStatus | 'all') => void
  setSearch: (value: string) => void
  openCreate: () => void
  closeCreate: () => void
  createContainer: (gateway: ElysianGateway, input: ContainerCreateInput) => Promise<void>
  removeImage: (gateway: ElysianGateway, imageId: string) => Promise<void>
  pullImage: (gateway: ElysianGateway, input: { name: string; tag: string; registry?: string }) => Promise<void>
  openDetail: (containerId: string) => void
  closeDetail: () => void
  openTerminal: (gateway: ElysianGateway, containerId: string) => Promise<void>
  closeTerminal: (gateway: ElysianGateway) => Promise<void>
  submitCommand: (gateway: ElysianGateway, command: string) => Promise<void>
  interruptTerminal: (gateway: ElysianGateway) => Promise<void>
  applyTerminalFrame: (sessionId: string, frame: HostTerminalFrame) => void
  handleTerminalClose: (sessionId: string, info: HostTerminalCloseInfo) => void
  appendTerminalOutput: (lines: readonly string[]) => void
  clearTerminalScreen: () => void
  runAction: (gateway: ElysianGateway, containerId: string, action: ContainerAction) => Promise<void>
}>((set, get) => ({
  status: 'idle',
  liveStatus: 'live',
  containers: [],
  images: [],
  imageRefreshStatus: 'idle',
  samples: {},
  view: resolveViewTab(window.localStorage, 'containers', ['grid', 'images', 'apps'] as const, 'grid'),
  statusFilter: 'all',
  search: '',
  busyActions: [],
  createOpen: false, creating: false, removingImageIds: [], pullingImage: undefined,

  setLiveStatus(liveStatus) {
    set({
      liveStatus,
      ...(liveStatus === 'connecting' ? { samples: {} } : {}),
    })
  },

  async load(gateway) {
    activeGateway = gateway
    attachLiveEvents()
    imageRevision += 1
    imageRefreshSequence += 1
    const revision = imageRevision
    set({ status: 'loading', errorMessage: undefined, imageRefreshStatus: 'idle' })
    try {
      const [containers, images] = await Promise.all([
        gateway.containers.list(),
        gateway.containers.listImages(),
      ])
      const canCommitImages = revision === imageRevision
      if (canCommitImages) imageRevision += 1
      set({ status: 'ready', containers, ...(canCommitImages ? { images } : {}) })
      replayLatestSample()
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取容器数据失败',
      })
    }
  },

  async refreshImages(gateway, options) {
    // 缺省通知结果；页签自动刷新传 notify:false 静默成功（失败仍可见），避免每次切页签都弹提示。
    const notifyOutcome = options?.notify !== false
    const sequence = ++imageRefreshSequence
    const revision = imageRevision
    set({ imageRefreshStatus: 'loading' })
    try {
      const images = await gateway.containers.listImages()
      if (sequence !== imageRefreshSequence) return
      if (revision !== imageRevision) {
        set({ imageRefreshStatus: 'idle' })
        if (notifyOutcome) useNotificationStore.getState().notify({ tone: 'success', message: '镜像列表已由其他操作更新' })
        return
      }
      imageRevision += 1
      set({ images, imageRefreshStatus: 'idle' })
      if (notifyOutcome) useNotificationStore.getState().notify({ tone: 'success', message: '镜像列表已刷新' })
    } catch (error) {
      if (sequence !== imageRefreshSequence) return
      const detail = error instanceof Error ? error.message : '未知错误'
      set({ imageRefreshStatus: 'idle' })
      useNotificationStore.getState().notify({ tone: 'danger', message: `刷新镜像失败：${detail}` })
    }
  },

  setView(view) {
    writeStoredViewTab(window.localStorage, 'containers', view)
    set({ view })
  },
  setStatusFilter(statusFilter) {
    set({ statusFilter })
  },
  setSearch(search) {
    set({ search })
  },
  openCreate() {
    set({ createOpen: true })
  },
  closeCreate() {
    set({ createOpen: false })
  },

  async createContainer(gateway, input) {
    set({ creating: true })
    try {
      const created = await gateway.containers.create(input)
      useNotificationStore
        .getState()
        .notify({
          tone: 'success',
          message: isDockerRuntime()
            ? `容器 ${created.name} 已创建`
            : `容器 ${created.name} 已创建（mock，待接入真实执行）`,
        })
      set((state) => ({
        // 事件回灌通常已追加过；按 id 去重，返回值只做兜底。
        containers: state.containers.some((c) => c.id === created.id)
          ? state.containers
          : [...state.containers, created],
        createOpen: false,
      }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useNotificationStore.getState().notify({ tone: 'danger', message: `创建容器失败：${detail}` })
    } finally {
      set({ creating: false })
    }
  },

  openDetail(containerId) {
    set({ detailContainerId: containerId })
  },
  closeDetail() {
    set({ detailContainerId: undefined })
  },

  async removeImage(gateway, imageId) {
    if (get().removingImageIds.includes(imageId)) return
    imageRevision += 1
    const image = get().images.find((i) => i.id === imageId)
    set((state) => ({ removingImageIds: [...state.removingImageIds, imageId] }))
    try {
      await gateway.containers.removeImage(imageId)
      imageRevision += 1
      set((state) => ({
        images: state.images.filter((candidate) => candidate.id !== imageId),
        removingImageIds: state.removingImageIds.filter((id) => id !== imageId),
      }))
      const label = image ? `${image.name}:${image.tag}` : imageId
      useNotificationStore.getState().notify({
        tone: 'success',
        message: isDockerRuntime()
          ? `镜像 ${label} 已删除`
          : `镜像 ${label} 已删除（mock，待接入真实执行）`,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      set((state) => ({ removingImageIds: state.removingImageIds.filter((id) => id !== imageId) }))
      useNotificationStore.getState().notify({ tone: 'danger', message: `删除镜像失败：${detail}` })
      try {
        const revision = imageRevision
        const images = await gateway.containers.listImages()
        if (revision === imageRevision) { imageRevision += 1; set({ images }) }
      } catch {
        // 刷新失败时保留当前列表。
      }
    }
  },

  async pullImage(gateway, input) {
    if (get().pullingImage) return
    const pullSequence = ++imagePullSequence
    imageRevision += 1
    set({ pullingImage: { name: input.name, tag: input.tag, registry: input.registry } })
    try {
      if (!isDockerRuntime()) {
        // 模拟传输耗时后再落数据集；测试用假计时器推进这一段。
        await new Promise((resolve) => setTimeout(resolve, PULL_DELAY_MS))
      }
      const image = await gateway.containers.pullImage(input, (progress) => {
        set((state) => state.pullingImage && imagePullSequence === pullSequence
          ? { pullingImage: { ...state.pullingImage, progress } }
          : state)
      })
      imageRevision += 1
      useNotificationStore.getState().notify({
        tone: 'success',
        message: isDockerRuntime()
          ? `镜像 ${image.name}:${image.tag} 已拉取`
          : `镜像 ${image.name}:${image.tag} 已拉取（mock，待接入真实执行）`,
      })
      // 追加与清拉取中状态一次完成，避免界面闪现「新行 + 拉取中行并存」的中间帧。
      set((state) => ({
        images: state.images.some((candidate) => candidate.id === image.id ||
          (candidate.name === image.name && candidate.tag === image.tag))
          ? state.images.map((candidate) => candidate.id === image.id ||
            (candidate.name === image.name && candidate.tag === image.tag) ? image : candidate)
          : [...state.images, image],
        pullingImage: undefined,
      }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useNotificationStore.getState().notify({ tone: 'danger', message: `拉取镜像失败：${detail}` })
      set({ pullingImage: undefined })
      try {
        const revision = imageRevision
        const images = await gateway.containers.listImages()
        if (revision === imageRevision) { imageRevision += 1; set({ images }) }
      } catch {
        // 刷新失败时保留当前列表。
      }
    }
  },

  async openTerminal(gateway, containerId) {
    const current = get().terminal
    // 打开串行化：connecting 态连点不叠加第二条 pending WS（对齐 terminalsStore 的 opening 模式）。
    // 复位随 terminal 状态走：关窗/容器被删清掉 connecting 态后即可重开，不卡在标志位上。
    if (current?.status === 'connecting') return
    if (current?.status === 'connected') {
      try {
        await gateway.containers.disconnectTerminal(current.sessionId)
      } catch {
        // 旧会话断开失败仍继续打开新容器终端，不吞掉用户点击。
      }
    }

    const pendingId = nextPendingTerminalId()
    set({
      terminal: {
        containerId,
        sessionId: pendingId,
        openId: pendingId,
        prompt: '$ ',
        status: 'connecting',
        lines: [
          ...(isDockerRuntime() ? [] : [{ kind: 'banner' as const, text: TERMINAL_BANNER }]),
          { kind: 'output', text: '正在连接容器终端…' },
        ],
        history: [],
      },
    })
    try {
      const info = await gateway.containers.connectTerminal(containerId, containerTerminalHandlers(pendingId))
      let accepted = false
      set((state) => {
        // 迟到结算锚点：只认本次打开的 pendingId——connecting 中取消后重开同一容器时，
        // 旧连接的迟到 resolve 不得改写新会话的 sessionId。
        if (!state.terminal || state.terminal.sessionId !== pendingId) return {}
        accepted = true
        return {
          terminal: {
            ...state.terminal,
            sessionId: info.id,
            prompt: info.prompt,
            status: 'connected',
            lines: state.terminal.lines.filter((line) => line.text !== '正在连接容器终端…'),
          },
        }
      })
      if (!accepted) {
        void gateway.containers.disconnectTerminal(info.id).catch(() => {})
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : '连接容器终端失败'
      set((state) => ({
        // 同一锚点：迟到 reject 不得给重开的新会话追加错误行或置 error 态。
        terminal:
          state.terminal && state.terminal.sessionId === pendingId
            ? {
                ...state.terminal,
                status: 'error',
                lines: [
                  ...state.terminal.lines.filter((line) => line.text !== '正在连接容器终端…'),
                  { kind: 'output', text },
                ],
              }
            : state.terminal,
      }))
    }
  },

  async closeTerminal(gateway) {
    const session = get().terminal
    if (session) releaseTerminalSession(gateway, session)
    set({ terminal: undefined })
  },

  async submitCommand(gateway, command) {
    const session = get().terminal
    const trimmed = command.trim()
    if (!session || session.status !== 'connected' || !trimmed) return

    if (trimmed === 'clear') {
      set({
        terminal: {
          ...session,
          lines: [],
          history: pushHistory(session.history, trimmed),
        },
      })
      return
    }

    const submittedPrompt = session.prompt
    set({
      terminal: {
        ...session,
        lines: [...session.lines, { kind: 'input', text: trimmed, prompt: submittedPrompt }],
        history: pushHistory(session.history, trimmed),
      },
    })
    try {
      await gateway.containers.sendTerminalInput(session.sessionId, trimmed)
    } catch (error) {
      const text = error instanceof Error ? error.message : '命令执行失败'
      set((state) => ({
        terminal: state.terminal?.openId === session.openId && state.terminal?.sessionId === session.sessionId ? {
          ...state.terminal,
          lines: [...state.terminal.lines, { kind: 'output', text }],
        } : state.terminal,
      }))
    }
  },

  async interruptTerminal(gateway) {
    const session = get().terminal
    if (!session || session.status !== 'connected') return
    try {
      await gateway.containers.interruptTerminal(session.sessionId)
    } catch {
      // 会话已断开时错误态由关闭路径接管。
    }
  },

  applyTerminalFrame(sessionId, frame) {
    set((state) => {
      const session = state.terminal
      if (!session || session.sessionId !== sessionId) return {}
      switch (frame.type) {
        case 'output':
          return {
            terminal: {
              ...session,
              lines: [...session.lines, ...asOutputLines(frame.lines)],
            },
          }
        case 'prompt':
          return { terminal: { ...session, prompt: frame.prompt } }
        case 'truncated':
          return {
            terminal: {
              ...session,
              lines: [
                ...session.lines,
                {
                  kind: 'output',
                  text: `输出超出单轮上限，已丢弃 ${frame.droppedBytes} 字节`,
                },
              ],
            },
          }
        case 'exit':
          return {
            terminal: {
              ...session,
              status: 'error',
              lines: [
                ...session.lines,
                { kind: 'output', text: `会话已退出（退出码 ${frame.exitCode}）` },
              ],
            },
          }
        default:
          return {}
      }
    })
  },

  handleTerminalClose(sessionId, info) {
    set((state) => {
      const session = state.terminal
      if (!session || session.sessionId !== sessionId || session.status === 'error') return {}
      return {
        terminal: {
          ...session,
          status: 'error',
          lines: [
            ...session.lines,
            {
              kind: 'output',
              text: hostTerminalCloseMessage(info.code, info.reason, CONTAINER_TERMINAL_CLOSE_FALLBACK),
            },
          ],
        },
      }
    })
  },

  appendTerminalOutput(lines) {
    set((state) => ({
      terminal: state.terminal && {
        ...state.terminal,
        lines: [
          ...state.terminal.lines,
          ...lines.map((text): TerminalLine => ({ kind: 'output', text })),
        ],
      },
    }))
  },

  clearTerminalScreen() {
    set((state) => ({
      terminal: state.terminal && { ...state.terminal, lines: [] },
    }))
  },

  async runAction(gateway, containerId, action) {
    const key = `${containerId}:${action}`
    const name = get().containers.find((c) => c.id === containerId)?.name ?? containerId
    set((state) => ({ busyActions: [...state.busyActions, key] }))
    try {
      await gateway.containers.requestAction(containerId, action)
      useNotificationStore.getState().notify({
        tone: 'success',
        message: containerActionSuccessMessage(action, name, isDockerRuntime()),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useNotificationStore
        .getState()
        .notify({ tone: 'danger', message: `容器 ${name} 操作失败：${detail}` })
    } finally {
      set((state) => ({ busyActions: state.busyActions.filter((k) => k !== key) }))
    }
  },
}))

function containerTerminalHandlers(openId: string): HostTerminalHandlers {
  return {
    onFrame: (sessionId, frame) => {
      if (useContainersStore.getState().terminal?.openId !== openId) return
      useContainersStore.getState().applyTerminalFrame(sessionId, frame)
    },
    onClose: (sessionId, info) => {
      if (useContainersStore.getState().terminal?.openId !== openId) return
      useContainersStore.getState().handleTerminalClose(sessionId, info)
    },
  }
}
