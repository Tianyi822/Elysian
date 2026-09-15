import type { Container, ContainerAction, ContainerImage, ContainerSample, ContainerStatus, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { getLastContainerSample, onStreamEvent } from './eventStreamStore'
import { useNotificationStore } from './notificationStore'

export type TerminalLine = { kind: 'banner' | 'input' | 'output'; text: string }

type TerminalSession = {
  containerId: string
  lines: readonly TerminalLine[]
  history: readonly string[]
}

const TERMINAL_BANNER = '演示终端 · 待接入真实执行'

/** 历史命令连续去重：连按同一条只记一次。 */
function pushHistory(history: readonly string[], command: string): readonly string[] {
  return history[history.length - 1] === command ? history : [...history, command]
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

function attachLiveEvents(): void {
  if (detachLive) return
  detachLive = onStreamEvent((event) => {
    if (event.name === 'container/sample') {
      applySamples(event.payload.samples)
      return
    }
    if (event.name === 'container/updated') {
      const { containerId, status } = event.payload
      useContainersStore.setState((state) => ({
        containers: state.containers.map((container) =>
          container.id === containerId ? { ...container, status } : container,
        ),
        busyActions: state.busyActions.filter((key) => !key.startsWith(`${containerId}:`)),
      }))
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

const ACTION_MESSAGES: Record<ContainerAction, (name: string) => string> = {
  start: (name) => `容器 ${name} 已启动`,
  stop: (name) => `容器 ${name} 已停止`,
  restart: (name) => `已请求重启 ${name}（mock，待接入真实执行）`,
}

export const useContainersStore = create<{
  status: 'idle' | 'loading' | 'ready' | 'error'
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
  load: (gateway: ElysianGateway) => Promise<void>
  setView: (view: 'grid' | 'images') => void
  setStatusFilter: (filter: ContainerStatus | 'all') => void
  setSearch: (value: string) => void
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
  containers: [],
  images: [],
  samples: {},
  view: 'grid',
  statusFilter: 'all',
  search: '',
  busyActions: [],

  async load(gateway) {
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
    set({ view })
  },
  setStatusFilter(statusFilter) {
    set({ statusFilter })
  },
  setSearch(search) {
    set({ search })
  },
  openDetail(containerId) {
    set({ detailContainerId: containerId })
  },
  closeDetail() {
    set({ detailContainerId: undefined })
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

    set({ terminal: { ...session, lines: [...session.lines, { kind: 'input', text: `$ ${trimmed}` }] } })
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
      useNotificationStore.getState().notify({ tone: 'success', message: ACTION_MESSAGES[action](name) })
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
