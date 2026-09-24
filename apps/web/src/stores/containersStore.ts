import type { Container, ContainerAction, ContainerCreateInput, ContainerImage, ContainerSample, ContainerStatus, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import { resolveViewTab, writeStoredViewTab } from '../app/theme/themePreferences'
import type { ElysianGateway } from '../contracts/adapters'
import { pushHistory, type TerminalLine } from '../components/terminal/terminalSession'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { containerActionSuccessMessage } from '../features/container/containerCopy'
import { getLastContainerSample, onStreamEvent } from './eventStreamStore'
import { useNotificationStore } from './notificationStore'

type TerminalSession = {
  containerId: string
  lines: readonly TerminalLine[]
  history: readonly string[]
}

const TERMINAL_BANNER = '演示终端 · 待接入真实执行'

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

async function refreshAfterResync(): Promise<void> {
  const gateway = activeGateway
  if (!gateway) return
  try {
    const [containers, images] = await Promise.all([
      gateway.containers.list(),
      gateway.containers.listImages(),
    ])
    useContainersStore.setState({ containers, images })
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
          terminal:
            state.terminal?.containerId === containerId ? undefined : state.terminal,
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
  samples: Readonly<Record<string, { cpuPercent: number; memMb: number }>>
  view: 'grid' | 'images'
  statusFilter: ContainerStatus | 'all'
  search: string
  detailContainerId?: string
  terminal?: TerminalSession
  busyActions: readonly string[]
  createOpen: boolean
  creating: boolean
  removingImageIds: readonly string[]
  pullingImage?: { name: string; tag: string; registry?: string }
  load: (gateway: ElysianGateway) => Promise<void>
  setLiveStatus: (status: 'live' | 'connecting') => void
  setView: (view: 'grid' | 'images') => void
  setStatusFilter: (filter: ContainerStatus | 'all') => void
  setSearch: (value: string) => void
  openCreate: () => void
  closeCreate: () => void
  createContainer: (gateway: ElysianGateway, input: ContainerCreateInput) => Promise<void>
  removeImage: (gateway: ElysianGateway, imageId: string) => Promise<void>
  pullImage: (gateway: ElysianGateway, input: { name: string; tag: string; registry?: string }) => Promise<void>
  openDetail: (containerId: string) => void
  closeDetail: () => void
  openTerminal: (containerId: string) => void
  closeTerminal: () => void
  submitCommand: (gateway: ElysianGateway, command: string) => Promise<void>
  appendTerminalOutput: (lines: readonly string[]) => void
  clearTerminalScreen: () => void
  runAction: (gateway: ElysianGateway, containerId: string, action: ContainerAction) => Promise<void>
}>((set, get) => ({
  status: 'idle',
  liveStatus: 'live',
  containers: [],
  images: [],
  samples: {},
  view: resolveViewTab(window.localStorage, 'containers', ['grid', 'images'] as const, 'grid'),
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
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [containers, images] = await Promise.all([
        gateway.containers.list(),
        gateway.containers.listImages(),
      ])
      set({ status: 'ready', containers, images })
      replayLatestSample()
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取容器数据失败',
      })
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
    const image = get().images.find((i) => i.id === imageId)
    set((state) => ({ removingImageIds: [...state.removingImageIds, imageId] }))
    try {
      await gateway.containers.removeImage(imageId)
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
        const images = await gateway.containers.listImages()
        set({ images })
      } catch {
        // 刷新失败时保留当前列表。
      }
    }
  },

  async pullImage(gateway, input) {
    if (get().pullingImage) return
    set({ pullingImage: { name: input.name, tag: input.tag, registry: input.registry } })
    try {
      if (!isDockerRuntime()) {
        // 模拟传输耗时后再落数据集；测试用假计时器推进这一段。
        await new Promise((resolve) => setTimeout(resolve, PULL_DELAY_MS))
      }
      const image = await gateway.containers.pullImage(input)
      useNotificationStore.getState().notify({
        tone: 'success',
        message: isDockerRuntime()
          ? `镜像 ${image.name}:${image.tag} 已拉取`
          : `镜像 ${image.name}:${image.tag} 已拉取（mock，待接入真实执行）`,
      })
      // 追加与清拉取中状态一次完成，避免界面闪现「新行 + 拉取中行并存」的中间帧。
      set((state) => ({ images: [...state.images, image], pullingImage: undefined }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useNotificationStore.getState().notify({ tone: 'danger', message: `拉取镜像失败：${detail}` })
      set({ pullingImage: undefined })
      try {
        const images = await gateway.containers.listImages()
        set({ images })
      } catch {
        // 刷新失败时保留当前列表。
      }
    }
  },

  openTerminal(containerId) {
    set({
      terminal: { containerId, lines: [{ kind: 'banner', text: TERMINAL_BANNER }], history: [] },
    })
  },
  closeTerminal() {
    set({ terminal: undefined })
  },

  async submitCommand(gateway, command) {
    const session = get().terminal
    const trimmed = command.trim()
    if (!session || !trimmed) return

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

    // input 行只存裸命令：提示符由终端壳渲染时拼在行首（提示符只有一个家）。
    set({ terminal: { ...session, lines: [...session.lines, { kind: 'input', text: trimmed }] } })
    try {
      const result = await gateway.containers.execMockCommand(session.containerId, trimmed)
      set((state) => ({
        terminal: state.terminal && {
          ...state.terminal,
          lines: [
            ...state.terminal.lines,
            ...result.lines.map((text): TerminalLine => ({ kind: 'output', text })),
          ],
          history: pushHistory(state.terminal.history, trimmed),
        },
      }))
    } catch (error) {
      const text = error instanceof Error ? error.message : '命令执行失败'
      set((state) => ({
        terminal: state.terminal && {
          ...state.terminal,
          lines: [...state.terminal.lines, { kind: 'output', text }],
        },
      }))
    }
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
