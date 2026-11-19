import type { ContainerImage, ImagePullProgress } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { abortableDelay, awaitAbortable, throwIfAborted } from '../utils/abortable'
import { captureAuthGeneration } from '../utils/authGeneration'
import { demoNoticeSuffix, MOCK_ACTION_NOTE } from '../utils/demoNotice'
import { messageOf } from '../utils/errorMessage'
import { isDockerRuntime } from '../utils/isDockerRuntime'
import { tableBatchFailure, type TableBatchOutcome } from '../utils/tableBatch'
import { useMessageStore } from './messageStore'

/** 拉取的模拟传输耗时；测试用假计时器推进。 */
const PULL_DELAY_MS = 1500

type ImagePullInput = { name: string; tag: string; registry?: string }
type ImagePullResult = { status: 'succeeded' | 'interrupted' } | { status: 'failed'; error: string }
/** 调用方核验最新清单并负责呈现回执。省略时使用镜像表的回执和通知。 */
type ImagePullOptions = { confirmInventory: () => Promise<void> }
type ImageDisplay = {
  images: readonly ContainerImage[]
  /** 镜像手动刷新的忙碌标记（loading 期间锁按钮）；结果经全局通知组件反馈，页面不另写反馈条。 */
  imageRefreshStatus: 'idle' | 'loading'
  removingImageIds: readonly string[]
  pullingImage?: ImagePullInput & { progress?: ImagePullProgress; cancelling?: boolean }
  imagePullError?: ImagePullInput & { message: string }
}

export type ContainerImagesState = ImageDisplay & {
  refreshImages: (gateway: ElysianGateway, options?: { notify?: boolean }) => Promise<void>
  removeImage: (gateway: ElysianGateway, imageId: string) => Promise<TableBatchOutcome>
  pullImage: (gateway: ElysianGateway, input: ImagePullInput, options?: ImagePullOptions) => Promise<ImagePullResult>
  cancelImagePull: () => void
  dismissImagePullError: () => void
}

export function createContainerImages(
  get: () => ImageDisplay,
  set: (update: Partial<ImageDisplay> | ((state: ImageDisplay) => Partial<ImageDisplay>)) => void,
) {
  let imageRevision = 0
  let imageActionGeneration = captureAuthGeneration()
  let imageRefreshSequence = 0
  let pendingImages: { gateway: ElysianGateway; auth: number; revision: number; notify: boolean; promise: Promise<void> } | undefined
  let imagePullSequence = 0
  let imagePullController: AbortController | undefined

  function syncActionGeneration(auth: number): void {
    if (imageActionGeneration !== auth) { imageActionGeneration = auth; set({ removingImageIds: [] }) }
  }

  const state: ContainerImagesState = {
    images: [],
    imageRefreshStatus: 'idle',
    removingImageIds: [],
    pullingImage: undefined,

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
          if (current()) useMessageStore.getState().notify({ tone: 'danger', message: `刷新镜像失败：${messageOf(error)}` })
        } finally {
          if (pendingImages === operation) {
            pendingImages = undefined
            if (current()) set({ imageRefreshStatus: 'idle' })
          }
        }
      })()
      return operation.promise
    },

    async removeImage(gateway, imageId) {
      const auth = captureAuthGeneration()
      syncActionGeneration(auth)
      if (get().removingImageIds.includes(imageId)) return { status: 'failed', error: '镜像正在删除' }
      imageRevision += 1
      const image = get().images.find((i) => i.id === imageId)
      set((state) => ({ removingImageIds: [...state.removingImageIds, imageId] }))
      try {
        await gateway.containers.removeImage(imageId)
        if (auth !== captureAuthGeneration()) return { status: 'unknown', error: '登录状态已变化，结果未确认' }
        imageRevision += 1
        set((state) => ({
          images: state.images.filter((candidate) => candidate.id !== imageId),
          removingImageIds: state.removingImageIds.filter((id) => id !== imageId),
        }))
        const label = image ? `${image.name}:${image.tag}` : imageId
        useMessageStore.getState().notify({
          tone: 'success',
          message: `镜像 ${label} 已删除${demoNoticeSuffix(isDockerRuntime(), MOCK_ACTION_NOTE)}`,
        })
        return { status: 'succeeded' }
      } catch (error) {
        if (auth !== captureAuthGeneration()) return { status: 'unknown', error: '登录状态已变化，结果未确认' }
        const detail = messageOf(error)
        set((state) => ({ removingImageIds: state.removingImageIds.filter((id) => id !== imageId) }))
        useMessageStore.getState().notify({ tone: 'danger', message: `删除镜像失败：${detail}` })
        try {
          const revision = imageRevision
          const images = await gateway.containers.listImages()
          if (auth === captureAuthGeneration() && revision === imageRevision) { imageRevision += 1; set({ images }) }
        } catch {
          // 刷新失败时保留当前列表。
        }
        return tableBatchFailure(error)
      }
    },

    async pullImage(gateway, input, options) {
      if (get().pullingImage) return { status: 'interrupted' }
      const pullSequence = ++imagePullSequence
      const auth = captureAuthGeneration()
      const current = () => imagePullSequence === pullSequence && auth === captureAuthGeneration()
      const controller = new AbortController()
      imagePullController = controller
      imageRevision += 1
      set({ pullingImage: input, ...(options ? {} : { imagePullError: undefined }) })
      try {
        if (!options && !isDockerRuntime()) {
          // 镜像表在本地演示中模拟传输耗时后再落数据集；测试用假计时器推进这一段。
          await abortableDelay(PULL_DELAY_MS, controller.signal)
        }
        throwIfAborted(controller.signal)
        const image = await awaitAbortable(gateway.containers.pullImage(input, (progress) => {
          set((state) => state.pullingImage && current() && !controller.signal.aborted
            ? { pullingImage: { ...state.pullingImage, progress } }
            : state)
        }, controller.signal), controller.signal)
        if (!current()) return { status: 'interrupted' }
        throwIfAborted(controller.signal)
        imageRevision += 1
        if (options) {
          await awaitAbortable(options.confirmInventory(), controller.signal)
          if (!current()) return { status: 'interrupted' }
          set({ pullingImage: undefined })
          return { status: 'succeeded' }
        }
        useMessageStore.getState().notify({
          tone: 'success',
          message: `镜像 ${image.name}:${image.tag} 已拉取${demoNoticeSuffix(isDockerRuntime(), MOCK_ACTION_NOTE)}`,
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
        return { status: 'succeeded' }
      } catch (error) {
        if (!current()) return { status: 'interrupted' }
        const aborted = controller.signal.aborted
        const detail = options ? messageOf(error, '镜像拉取失败') : messageOf(error)
        if (options) {
          set({ pullingImage: undefined })
          return aborted ? { status: 'interrupted' } : { status: 'failed', error: detail }
        }
        useMessageStore.getState().notify(aborted
          ? { tone: 'info', message: `已取消镜像 ${input.name}:${input.tag} 的拉取请求` }
          : { tone: 'danger', message: `拉取镜像失败：${detail}` })
        imageRevision += 1
        // 失败留在镜像列表中，避免短暂通知消失后只剩「进度突然没了」。
        set({ pullingImage: undefined, imagePullError: aborted ? undefined : { ...input, message: detail } })
        try {
          const revision = imageRevision
          const images = await gateway.containers.listImages()
          if (current() && revision === imageRevision) { imageRevision += 1; set({ images }) }
        } catch {
          // 刷新失败时保留当前列表。
        }
        return aborted ? { status: 'interrupted' } : { status: 'failed', error: detail }
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
  }

  return {
    state,
    syncActionGeneration,
    captureImageCommit() {
      const revision = imageRevision
      return () => {
        if (revision !== imageRevision) return false
        imageRevision += 1
        return true
      }
    },
    invalidate() {
      pendingImages = undefined
      imageRefreshSequence += 1
      imagePullSequence += 1
      const pull = imagePullController
      imagePullController = undefined
      // 先使回执失效，调用方清屏后再取消传输。
      return () => pull?.abort()
    },
  }
}
