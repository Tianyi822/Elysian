import type { Container, ContainerSample, Unsubscribe } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import type { ContainerTerminalSession } from './containerTerminal'
import { getLastContainerSample, onStreamEvent } from './eventStreamStore'

type EventState = {
  containers: readonly Container[]
  samples: Readonly<Record<string, { cpuPercent: number; memMb: number }>>
  detailContainerId?: string
  terminal?: ContainerTerminalSession
}

type ContainerEventsOptions = {
  get: () => EventState
  set: (update: Partial<EventState> | ((state: EventState) => Partial<EventState>)) => void
  getGateway: () => ElysianGateway | undefined
  onResync: () => void
  releaseTerminal: (gateway: ElysianGateway | undefined, session: ContainerTerminalSession) => void
}

export function createContainerEvents({ get, set, getGateway, onResync, releaseTerminal }: ContainerEventsOptions) {
  let detach: Unsubscribe | undefined

  function applySamples(samples: readonly ContainerSample[]): void {
    set({
      samples: Object.fromEntries(
        samples.map((sample) => [sample.containerId, { cpuPercent: sample.cpuPercent, memMb: sample.memMb }]),
      ),
    })
  }

  function applyContainerRemoval(containerId: string, gateway: ElysianGateway | undefined): void {
    const terminal = get().terminal
    const closesTerminal = terminal?.containerId === containerId
    set((state) => {
      const { [containerId]: _sample, ...samples } = state.samples
      return {
        containers: state.containers.filter((container) => container.id !== containerId),
        samples,
        detailContainerId: state.detailContainerId === containerId ? undefined : state.detailContainerId,
        terminal: closesTerminal ? undefined : state.terminal,
      }
    })
    if (closesTerminal) releaseTerminal(gateway, terminal)
  }

  function attach(): void {
    if (detach) return
    detach = onStreamEvent((event) => {
      if (event.name === 'container/sample') {
        applySamples(event.payload.samples)
        return
      }
      if (event.name === 'container/created') {
        const container = event.payload.container
        set((state) => ({
          containers: state.containers.some((item) => item.id === container.id)
            ? state.containers
            : [...state.containers, container],
        }))
        return
      }
      if (event.name === 'container/updated') {
        const { containerId, status, startedAt } = event.payload
        set((state) => ({
          containers: state.containers.map((container) => {
            if (container.id !== containerId) return container
            if (startedAt === null) {
              const { startedAt: _removed, ...rest } = container
              return { ...rest, status }
            }
            if (typeof startedAt === 'string') return { ...container, status, startedAt }
            return { ...container, status }
          }),
        }))
        return
      }
      if (event.name === 'container/removed') {
        applyContainerRemoval(event.payload.containerId, getGateway())
        return
      }
      if (event.name === 'container/resync') onResync()
    })
  }

  return {
    attach,
    removeContainer: applyContainerRemoval,
    detach() {
      detach?.()
      detach = undefined
    },
    replayLatestSample() {
      const latest = getLastContainerSample()
      if (latest?.name === 'container/sample') applySamples(latest.payload.samples)
    },
  }
}
