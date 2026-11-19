import type { ElysianEvent, EventStreamHandlers, Unsubscribe } from '@elysian/contracts'
import type { EventsAdapter } from '../../contracts/adapters'
import type { MockDataset } from './dataset'
import { INITIAL_LOAD, nextLoadWalk } from './resourceMetrics'

/**
 * 内存事件源：事件流端点不可用时的降级实现，契约与 SSE 实现完全一致。
 * 它按固定节奏产出确定性的事件内容，使界面在没有服务端进程时也能演示增量刷新。
 */
export function createInMemoryEventsAdapter(
  dataset: () => MockDataset,
  options: { intervalMs?: number } = {},
): EventsAdapter {
  const intervalMs = options.intervalMs ?? 2000

  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      handlers.onStatus('connecting')

      let counter = 0
      let cursor = 0
      let walk = {
        cpu: 55,
        memory: 68,
        networkRx: 220,
        networkTx: 160,
        networkIo: 380,
        diskRead: 130,
        diskWrite: 80,
        diskIo: 210,
        load: { ...INITIAL_LOAD },
      }
      const stepWalk = (): typeof walk => {
        const networkRx = Math.min(550, Math.max(30, walk.networkRx + Math.round((Math.random() - 0.5) * 50)))
        const networkTx = Math.min(450, Math.max(20, walk.networkTx + Math.round((Math.random() - 0.5) * 40)))
        const diskRead = Math.min(320, Math.max(20, walk.diskRead + Math.round((Math.random() - 0.5) * 36)))
        const diskWrite = Math.min(280, Math.max(15, walk.diskWrite + Math.round((Math.random() - 0.5) * 30)))
        walk = {
          cpu: Math.min(90, Math.max(20, walk.cpu + Math.round((Math.random() - 0.5) * 4))),
          memory: Math.min(92, Math.max(45, walk.memory + Math.round((Math.random() - 0.5) * 2))),
          networkRx,
          networkTx,
          networkIo: networkRx + networkTx,
          diskRead,
          diskWrite,
          diskIo: diskRead + diskWrite,
          load: nextLoadWalk(walk.load),
        }
        return walk
      }

      const emitLater = () => {
        counter += 1
        const data = dataset()
        const events: ElysianEvent[] = []

        // 每拍一条资源采样；每 4 拍诞生一次新事故，让图表持续可见地动。
        events.push({
          id: `mem-${counter}-resource`,
          name: 'resource/sample',
          at: new Date().toISOString(),
          payload: stepWalk(),
        })
        if (counter % 4 === 0) {
          const roll = Math.random()
          const severity = roll < 0.1 ? 'sev1' : roll < 0.3 ? 'sev2' : roll < 0.7 ? 'sev3' : 'sev4'
          events.push({
            id: `mem-${counter}-new-incident`,
            name: 'incident/created',
            at: new Date().toISOString(),
            payload: { incidentId: `INC-LIVE-${counter}`, severity },
          })
        }

        const run = data.runs[cursor % Math.max(1, data.runs.length)]
        if (run) {
          events.push({
            id: `mem-${counter}-agent`,
            name: 'agent/status',
            at: new Date().toISOString(),
            payload: {
              moduleId: run.moduleId,
              // 与 mock 事件流端点保持同一套判定，避免同一个事件名在两处语义不同。
              status:
                run.status === 'running' || run.status === 'waiting-approval' ? 'running' : 'idle',
            },
          })
        }

        const approval = data.approvals[cursor % Math.max(1, data.approvals.length)]
        if (approval && approval.status === 'pending') {
          events.push({
            id: `mem-${counter}-approval`,
            name: 'approval/asked',
            at: new Date().toISOString(),
            payload: { approvalId: approval.id },
          })
        }

        const incident = data.incidents[cursor % Math.max(1, data.incidents.length)]
        if (incident) {
          events.push({
            id: `mem-${counter}-incident`,
            name: 'incident/updated',
            at: new Date().toISOString(),
            payload: { incidentId: incident.id, status: incident.status },
          })
        }

        cursor += 1
        for (const event of events) handlers.onEvent(event)
      }

      handlers.onStatus('live')
      const timer = setInterval(emitLater, intervalMs)

      return () => {
        clearInterval(timer)
      }
    },
  }
}
