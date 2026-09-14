import type {
  ContainerStatus,
  ElysianEvent,
  EventStreamHandlers,
  Unsubscribe,
} from '@elysian/contracts'
import type { EventsAdapter } from '../../contracts/adapters'
import {
  DEMO_CYCLE_CONTAINER_IDS,
  initialContainerUsage,
  walkContainerUsage,
} from './containersData'
import type { ContainerUsage } from './containersData'
import type { MockDataset } from './dataset'

/**
 * 容器事件包装层：在两种 transport（dev SSE 与内存降级）之上统一生成
 * container/sample 与 container/updated。事件内容取自网关共享数据集，
 * 容器操作改写的也是这份状态，采样与状态因此永远一致；
 * SSE 插件不重复发送容器事件。事件 id 使用独立前缀，避免与 transport 的 id 撞车。
 */

export function createContainerEventsLayer(
  dataset: () => MockDataset,
  options: { intervalMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 2000
  let seq = 0
  let usage: readonly ContainerUsage[] = initialContainerUsage()
  let cycleTick = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let handlers: EventStreamHandlers | undefined
  const restartIn = new Map<string, number>()
  const controlled = new Set<string>()

  const emit = (event: ElysianEvent): void => {
    handlers?.onEvent(event)
  }

  const containerOf = (id: string) => dataset().containers.find((c) => c.id === id)

  const emitUpdated = (containerId: string): void => {
    const status: ContainerStatus | undefined = containerOf(containerId)?.status
    if (!status) return
    seq += 1
    emit({
      id: `ctr-evt-${seq}`,
      name: 'container/updated',
      at: new Date().toISOString(),
      payload: { containerId, status },
    })
  }

  const emitSample = (): void => {
    seq += 1
    emit({
      id: `ctr-evt-${seq}`,
      name: 'container/sample',
      at: new Date().toISOString(),
      payload: { samples: usage.map((u) => ({ ...u })) },
    })
  }

  const tick = (): void => {
    cycleTick += 1
    // 演示循环：未被人工接管时，每 4 拍在 restarting/running 间切换。
    if (cycleTick % 4 === 0) {
      for (const id of DEMO_CYCLE_CONTAINER_IDS) {
        if (controlled.has(id)) continue
        const container = containerOf(id)
        if (!container || container.status === 'stopped') continue
        container.status = container.status === 'restarting' ? 'running' : 'restarting'
        emitUpdated(id)
      }
    }
    // 重启调度：倒计时归零后回到运行中。
    for (const [id, remain] of [...restartIn]) {
      if (remain > 1) {
        restartIn.set(id, remain - 1)
        continue
      }
      restartIn.delete(id)
      const container = containerOf(id)
      if (container && container.status === 'restarting') {
        container.status = 'running'
        emitUpdated(id)
      }
    }
    usage = walkContainerUsage(usage, dataset().containers)
    emitSample()
  }

  return {
    /** 容器操作生效后立即推状态事件。 */
    emitUpdated,
    /** 人工接管后退出演示循环。 */
    markControlled: (id: string) => controlled.add(id),
    /** 重启在下一拍完成。 */
    scheduleRestart: (id: string) => restartIn.set(id, 1),
    /** 网关重置演示数据时同步清理瞬态。 */
    reset() {
      usage = initialContainerUsage()
      restartIn.clear()
      controlled.clear()
      cycleTick = 0
    },
    wrap(adapter: EventsAdapter): EventsAdapter {
      return {
        subscribe(h: EventStreamHandlers): Unsubscribe {
          const unsubscribe = adapter.subscribe(h)
          handlers = h
          emitSample() // 订阅即补发一拍，卡片不用空等
          timer = setInterval(tick, intervalMs)
          return () => {
            if (timer) clearInterval(timer)
            timer = undefined
            handlers = undefined
            unsubscribe()
          }
        },
      }
    },
  }
}
