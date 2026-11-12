import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type { Container, ContainerAction, ContainerCreateInput, ContainerImage, ContainerSample, ContainerStatus, ImagePullProgress, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import type {
  ElysianGateway,
  HostTerminalCloseInfo,
  HostTerminalFrame,
} from '../contracts/adapters'
import { hostTerminalCloseMessage } from '../components/terminal/terminalCloseMessage'
import { deactivateRawTerminal, disposeRawTerminal, rawTerminalRuntime } from '../components/terminal/rawTerminalRuntime'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import {
  containerActionSuccessMessage,
  CONTAINER_TERMINAL_CLOSE_FALLBACK,
} from '../features/container/containerCopy'
import { getLastContainerSample, onStreamEvent } from './eventStreamStore'
import { useMessageStore } from './messageStore'
import { abortableDelay, awaitAbortable, throwIfAborted } from '../utils/abortable'

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
 * container/updated 更新状态列并清掉该容器的忙碌标记。
 */
let detachLive: Unsubscribe | undefined
let activeGateway: ElysianGateway | undefined
let pendingLoad: { gateway: ElysianGateway; auth: number; snapshot: readonly Container[]; promise: Promise<void> } | undefined
let imageRevision = 0
let imageRefreshSequence = 0
let pendingImages: { gateway: ElysianGateway; auth: number; revision: number; notify: boolean; promise: Promise<void> } | undefined
let imagePullSequence = 0
let imagePullController: AbortController | undefined

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
  createError?: string
  removingImageIds: readonly string[]
  pullingImage?: { name: string; tag: string; registry?: string; progress?: ImagePullProgress; cancelling?: boolean }
  imagePullError?: { name: string; tag: string; registry?: string; message: string }
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
  cancelImagePull: () => void
  dismissImagePullError: () => void
  openDetail: (containerId: string) => void
  closeDetail: () => void
  openTerminal: (gateway: ElysianGateway, containerId: string) => Promise<void>
  closeTerminal: (gateway: ElysianGateway) => Promise<void>
  clearTerminalDisplay: () => void
  applyTerminalFrame: (sessionId: string, frame: HostTerminalFrame) => void
  handleTerminalClose: (sessionId: string, info: HostTerminalCloseInfo) => void
  runAction: (gateway: ElysianGateway, containerId: string, action: ContainerAction) => Promise<void>
}>((set, get) => ({
  status: 'idle',
  liveStatus: 'live',
  containers: [],
  images: [],
  imageRefreshStatus: 'idle',
  samples: {},
  view: 'grid',
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

  load(gateway) {
    activeGateway = gateway
    attachLiveEvents()
    const auth = captureAuthGeneration()
    if (pendingLoad?.gateway === gateway && pendingLoad.auth === auth && pendingLoad.snapshot === get().containers) return pendingLoad.promise
    const revision = imageRevision
    const operation = { gateway, auth, snapshot: get().containers, promise: Promise.resolve() }
    const hadData = get().status === 'ready'
    pendingLoad = operation
    const current = () => pendingLoad === operation && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', errorMessage: undefined })
    operation.promise = (async () => {
      try {
        const [containers, images] = await Promise.all([gateway.containers.list(), gateway.containers.listImages()])
        if (!current()) return
        const canCommitImages = revision === imageRevision
        if (canCommitImages) imageRevision += 1
        set({ status: 'ready', ...(operation.snapshot === get().containers ? { containers } : {}), ...(canCommitImages ? { images } : {}) })
        replayLatestSample()
      } catch (error) {
        if (current()) set({ status: hadData ? 'ready' : 'error', errorMessage: error instanceof Error ? error.message : '读取容器数据失败' })
      } finally { if (pendingLoad === operation) pendingLoad = undefined }
    })()
    return operation.promise
  },

  refreshImages(gateway, options) {
    const manual = options?.notify !== false
    const auth = captureAuthGeneration(), revision = imageRevision
    if (pendingImages?.gateway === gateway && pendingImages.auth === auth && pendingImages.revision === revision) {
      if (manual) { pendingImages.notify = true; set({ imageRefreshStatus: 'loading' }) }
      return pendingImages.promise
    }
    const sequence = ++imageRefreshSequence
    const operation = { gateway, auth, revision, notify: manual, promise: Promise.resolve() }
    pendingImages = operation
    const current = () => sequence === imageRefreshSequence && auth === captureAuthGeneration()
    set({ imageRefreshStatus: manual ? 'loading' : 'idle' })
    operation.promise = (async () => {
      try {
        const images = await gateway.containers.listImages()
        if (!current()) return
        if (revision !== imageRevision) {
          if (operation.notify) useMessageStore.getState().notify({ tone: 'success', message: '镜像列表已由其他操作更新' })
          return
        }
        imageRevision += 1
        set({ images })
        if (operation.notify) useMessageStore.getState().notify({ tone: 'success', message: '镜像列表已刷新' })
      } catch (error) {
        if (current()) useMessageStore.getState().notify({ tone: 'danger', message: `刷新镜像失败：${error instanceof Error ? error.message : '未知错误'}` })
      } finally {
        if (pendingImages === operation) {
          pendingImages = undefined
          if (current()) set({ imageRefreshStatus: 'idle' })
        }
      }
    })()
    return operation.promise
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
  openCreate() {
    set({ createOpen: true, createError: undefined })
  },
  closeCreate() {
    set({ createOpen: false })
  },

  async createContainer(gateway, input) {
    set({ creating: true, createError: undefined })
    try {
      const created = await gateway.containers.create(input)
      useMessageStore
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
      set({ createError: `创建容器失败：${detail}` })
      useMessageStore.getState().notify({ tone: 'danger', message: `创建容器失败：${detail}` })
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
      useMessageStore.getState().notify({
        tone: 'success',
        message: isDockerRuntime()
          ? `镜像 ${label} 已删除`
          : `镜像 ${label} 已删除（mock，待接入真实执行）`,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      set((state) => ({ removingImageIds: state.removingImageIds.filter((id) => id !== imageId) }))
      useMessageStore.getState().notify({ tone: 'danger', message: `删除镜像失败：${detail}` })
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
    const controller = new AbortController()
    imagePullController = controller
    imageRevision += 1
    set({ pullingImage: { name: input.name, tag: input.tag, registry: input.registry }, imagePullError: undefined })
    try {
      if (!isDockerRuntime()) {
        // 模拟传输耗时后再落数据集；测试用假计时器推进这一段。
        await abortableDelay(PULL_DELAY_MS, controller.signal)
      }
      throwIfAborted(controller.signal)
      const image = await awaitAbortable(gateway.containers.pullImage(input, (progress) => {
        set((state) => state.pullingImage && imagePullSequence === pullSequence && !controller.signal.aborted
          ? { pullingImage: { ...state.pullingImage, progress } }
          : state)
      }, controller.signal), controller.signal)
      if (imagePullSequence !== pullSequence) return
      throwIfAborted(controller.signal)
      imageRevision += 1
      useMessageStore.getState().notify({
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
      if (imagePullSequence !== pullSequence) return
      const detail = error instanceof Error ? error.message : '未知错误'
      useMessageStore.getState().notify(controller.signal.aborted
        ? { tone: 'info', message: `已取消镜像 ${input.name}:${input.tag} 的拉取请求` }
        : { tone: 'danger', message: `拉取镜像失败：${detail}` })
      imageRevision += 1
      // 失败留在镜像列表中，避免短暂通知消失后只剩「进度突然没了」。
      set({ pullingImage: undefined, imagePullError: controller.signal.aborted ? undefined : { ...input, message: detail } })
      try {
        const revision = imageRevision
        const images = await gateway.containers.listImages()
        if (revision === imageRevision) { imageRevision += 1; set({ images }) }
      } catch {
        // 刷新失败时保留当前列表。
      }
    } finally {
      if (imagePullController === controller) imagePullController = undefined
    }
  },

  cancelImagePull() {
    const pulling = get().pullingImage
    if (!pulling || pulling.cancelling || !imagePullController) return
    set({ pullingImage: { ...pulling, cancelling: true } })
    imagePullController.abort()
  },

  dismissImagePullError() { set({ imagePullError: undefined }) },

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
      const errorMessage = error instanceof Error ? error.message : '连接容器终端失败'
      set(state => ({ terminal: state.terminal && { ...state.terminal, status: 'error', errorMessage } }))
      useMessageStore.getState().notify({ tone: 'danger', message: errorMessage })
    }
  },
  async closeTerminal(gateway) {
    const session = get().terminal
    if (session) releaseTerminalSession(gateway, session)
    set({ terminal: undefined })
  },
  clearTerminalDisplay() {
    const session = get().terminal
    if (session) releaseTerminalSession(activeGateway, session)
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
    const key = `${containerId}:${action}`
    const name = get().containers.find((c) => c.id === containerId)?.name ?? containerId
    set((state) => ({ busyActions: [...state.busyActions, key] }))
    try {
      await gateway.containers.requestAction(containerId, action)
      useMessageStore.getState().notify({
        tone: 'success',
        message: containerActionSuccessMessage(action, name, isDockerRuntime()),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useMessageStore
        .getState()
        .notify({ tone: 'danger', message: `容器 ${name} 操作失败：${detail}` })
    } finally {
      set((state) => ({ busyActions: state.busyActions.filter((k) => k !== key) }))
    }
  },
}))
