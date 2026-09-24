import { randomUUID } from 'node:crypto'
import type { Container, ContainerSample, ContainerStatus, ElysianEvent } from '@elysian/contracts'
import type { DockerTransport } from './dockerTransport.ts'
import { mapContainer } from './dockerMappers.ts'
import { cpuPercent, memoryMb } from './dockerStats.ts'

const API_PREFIX = '/v1.41'
const JSON_MAX_BYTES = 32 * 1024 * 1024
const LIST_TIMEOUT_MS = 10_000
const STATS_TIMEOUT_MS = 2_000
const SAMPLE_INTERVAL_MS = 3_000
const DEBOUNCE_MS = 200
const STATS_CONCURRENCY = 8
const NON_SAMPLE_BUFFER_SIZE = 256
const MAX_SUBSCRIBERS = 8
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 30_000

const EVENTS_FILTERS = JSON.stringify({ type: ['container', 'image'] })
const EVENTS_PATH = `${API_PREFIX}/events?filters=${encodeURIComponent(EVENTS_FILTERS)}`

const IMAGE_RESYNC_ACTIONS = new Set(['pull', 'tag', 'untag', 'delete'])

export type DockerEventsHub = {
  subscribe(handlers: {
    onEvent: (frame: { event: string; id: string; data: string }) => void
    onStatus: (status: 'live' | 'connecting') => void
    lastEventId?: string
  }): () => void
  notifyRestarting(containerId: string): void
}

export type DockerEventsHubDeps = {
  transport: DockerTransport
  now: () => number
  schedule: (fn: () => void, ms: number) => () => void
  bootId?: string
}

type SseFrame = { event: string; id: string; data: string; seq: number; sample: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function encodeEngineId(id: string): string {
  return encodeURIComponent(id)
}

function stripSha256Prefix(id: string): string {
  return id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
}

function updatedPayload(container: Container): Extract<ElysianEvent, { name: 'container/updated' }>['payload'] {
  return {
    containerId: container.id,
    status: container.status,
    startedAt: container.status === 'stopped' ? null : (container.startedAt ?? null),
  }
}

function parseSeqFromId(eventId: string, bootId: string): { boot: string; seq: number } | null {
  const dot = eventId.lastIndexOf('.')
  if (dot <= 0) return null
  const boot = eventId.slice(0, dot)
  const seq = Number.parseInt(eventId.slice(dot + 1), 10)
  if (!Number.isFinite(seq) || seq < 0) return null
  if (boot !== bootId) return { boot, seq }
  return { boot, seq }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}

export function createDockerEventsHub(deps: DockerEventsHubDeps): DockerEventsHub {
  const bootId = deps.bootId ?? randomUUID()
  let seq = 0
  let subscriberCount = 0
  const subscribers = new Set<{
    onEvent: (frame: { event: string; id: string; data: string }) => void
    onStatus: (status: 'live' | 'connecting') => void
  }>()

  let dockerStreamCancel: (() => void) | undefined
  let sampleTimerCancel: (() => void) | undefined
  let reconnectTimerCancel: (() => void) | undefined
  let backoffMs = BACKOFF_INITIAL_MS
  let dockerLive = false
  let statsInFlight = false
  let lastSampleFrame: SseFrame | undefined

  const nonSampleBuffer: SseFrame[] = []

  const containerDebounce = new Map<string, () => void>()
  let imageResyncCancel: (() => void) | undefined
  const lastKnownStartedAt = new Map<string, string>()

  function isoNow(): string {
    return new Date(deps.now()).toISOString()
  }

  function pushBuffer(frame: SseFrame): void {
    if (frame.sample) return
    nonSampleBuffer.push(frame)
    while (nonSampleBuffer.length > NON_SAMPLE_BUFFER_SIZE) {
      nonSampleBuffer.shift()
    }
  }

  function broadcast(frame: SseFrame): void {
    const { event, id, data } = frame
    for (const sub of subscribers) {
      sub.onEvent({ event, id, data })
    }
  }

  function buildFrame(name: ElysianEvent['name'], payload: ElysianEvent['payload'], sample: boolean): SseFrame {
    seq += 1
    const id = `${bootId}.${seq}`
    const envelope = { id, name, at: isoNow(), payload }
    const data = JSON.stringify(envelope)
    return { event: name, id, data, seq, sample }
  }

  function publish(frame: SseFrame): void {
    pushBuffer(frame)
    if (frame.sample) {
      lastSampleFrame = frame
    }
    broadcast(frame)
  }

  function emit(name: ElysianEvent['name'], payload: ElysianEvent['payload'], sample: boolean): SseFrame {
    const frame = buildFrame(name, payload, sample)
    publish(frame)
    return frame
  }

  function oldestBufferedSeq(): number | undefined {
    return nonSampleBuffer[0]?.seq
  }

  function deliverReplay(
    lastEventId: string | undefined,
    onEvent: (frame: { event: string; id: string; data: string }) => void,
  ): void {
    if (lastEventId) {
      const parsed = parseSeqFromId(lastEventId, bootId)
      const oldest = oldestBufferedSeq()

      if (lastSampleFrame?.id === lastEventId && parsed !== null && parsed.boot === bootId) {
        const gapLost = oldest !== undefined && oldest > parsed.seq + 1
        if (!gapLost) {
          const { event, id, data } = lastSampleFrame
          onEvent({ event, id, data })
          for (const frame of nonSampleBuffer) {
            if (frame.seq > parsed.seq) {
              onEvent({ event: frame.event, id: frame.id, data: frame.data })
            }
          }
          return
        }
      }

      let needResync = false

      if (parsed === null) {
        needResync = true
      } else if (parsed.boot !== bootId) {
        needResync = true
      } else if (oldest !== undefined && parsed.seq < oldest) {
        needResync = true
      }

      if (needResync) {
        const resync = buildFrame('container/resync', {}, false)
        onEvent({ event: resync.event, id: resync.id, data: resync.data })
      } else if (parsed !== null && parsed.boot === bootId) {
        for (const frame of nonSampleBuffer) {
          if (frame.seq > parsed.seq) {
            onEvent({ event: frame.event, id: frame.id, data: frame.data })
          }
        }
      }
    }

    if (lastSampleFrame && lastSampleFrame.id !== lastEventId) {
      const { event, id, data } = lastSampleFrame
      onEvent({ event, id, data })
    }
  }

  function setConnecting(): void {
    for (const sub of subscribers) {
      sub.onStatus('connecting')
    }
  }

  function setLive(): void {
    for (const sub of subscribers) {
      sub.onStatus('live')
    }
  }

  async function inspectContainer(id: string): Promise<Container | undefined> {
    try {
      const response = await deps.transport.request({
        method: 'GET',
        path: `${API_PREFIX}/containers/${encodeEngineId(id)}/json`,
        timeoutMs: LIST_TIMEOUT_MS,
        maxBytes: JSON_MAX_BYTES,
      })
      if (response.status < 200 || response.status >= 300) {
        return undefined
      }
      return mapContainer(response.json)
    } catch {
      return undefined
    }
  }

  function scheduleContainerRefresh(containerId: string, handler: () => void): void {
    containerDebounce.get(containerId)?.()
    const cancel = deps.schedule(() => {
      containerDebounce.delete(containerId)
      void handler()
    }, DEBOUNCE_MS)
    containerDebounce.set(containerId, cancel)
  }

  function scheduleImageResync(): void {
    imageResyncCancel?.()
    const cancel = deps.schedule(() => {
      imageResyncCancel = undefined
      emit('container/resync', {}, false)
    }, DEBOUNCE_MS)
    imageResyncCancel = cancel
  }

  async function handleContainerEngineEvent(action: string, containerId: string): Promise<void> {
    if (action === 'destroy' || action === 'remove') {
      emit('container/removed', { containerId: stripSha256Prefix(containerId) }, false)
      return
    }
    if (action === 'rename') {
      emit('container/resync', {}, false)
      return
    }
    if (action === 'create') {
      const container = await inspectContainer(containerId)
      if (container) {
        if (container.startedAt !== undefined) {
          lastKnownStartedAt.set(container.id, container.startedAt)
        }
        emit('container/created', { container }, false)
      }
      return
    }
    if (
      action === 'start' ||
      action === 'die' ||
      action === 'kill' ||
      action === 'pause' ||
      action === 'unpause' ||
      action === 'restart'
    ) {
      const container = await inspectContainer(containerId)
      if (container) {
        if (container.startedAt !== undefined) {
          lastKnownStartedAt.set(container.id, container.startedAt)
        }
        emit('container/updated', updatedPayload(container), false)
      }
      return
    }
    emit('container/resync', {}, false)
  }

  function restartingStartedAt(containerId: string): string | null {
    const cached = lastKnownStartedAt.get(containerId)
    return cached ?? null
  }

  function onDockerLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(value)) return

    const type = value.Type
    const action = value.Action
    if (typeof action !== 'string') return

    if (type === 'image' && IMAGE_RESYNC_ACTIONS.has(action)) {
      scheduleImageResync()
      return
    }

    if (type !== 'container') return
    const containerId = typeof value.id === 'string' ? value.id : undefined
    if (!containerId) return

    scheduleContainerRefresh(containerId, () => {
      void handleContainerEngineEvent(action, containerId)
    })
  }

  function stopDockerStream(): void {
    dockerStreamCancel?.()
    dockerStreamCancel = undefined
    dockerLive = false
  }

  function scheduleReconnect(): void {
    reconnectTimerCancel?.()
    setConnecting()
    const cancel = deps.schedule(() => {
      reconnectTimerCancel = undefined
      startDockerStream()
    }, backoffMs)
    reconnectTimerCancel = cancel
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2)
  }

  function startDockerStream(): void {
    stopDockerStream()
    const openStream = deps.transport.openStream
    if (!openStream) {
      scheduleReconnect()
      return
    }

    dockerStreamCancel = openStream({
      method: 'GET',
      path: EVENTS_PATH,
      onLine: onDockerLine,
      onError: () => {
        stopDockerStream()
        scheduleReconnect()
      },
      onClose: () => {
        stopDockerStream()
        scheduleReconnect()
      },
    })
    dockerLive = true
    backoffMs = BACKOFF_INITIAL_MS
    emit('container/resync', {}, false)
    setLive()
  }

  function stopSampleTimer(): void {
    sampleTimerCancel?.()
    sampleTimerCancel = undefined
  }

  async function sampleOnce(): Promise<void> {
    if (statsInFlight) return
    statsInFlight = true
    try {
      const listResponse = await deps.transport.request({
        method: 'GET',
        path: `${API_PREFIX}/containers/json?all=1`,
        timeoutMs: LIST_TIMEOUT_MS,
        maxBytes: JSON_MAX_BYTES,
      })
      if (listResponse.status < 200 || listResponse.status >= 300 || !Array.isArray(listResponse.json)) {
        return
      }

      const runningIds: string[] = []
      for (const entry of listResponse.json) {
        if (!isRecord(entry)) continue
        const id = entry.Id
        const state = entry.State
        if (typeof id === 'string' && state === 'running') {
          runningIds.push(id)
        }
      }

      const statsResults = await mapWithConcurrency(runningIds, STATS_CONCURRENCY, async (id) => {
        try {
          const response = await deps.transport.request({
            method: 'GET',
            path: `${API_PREFIX}/containers/${encodeEngineId(id)}/stats?stream=0`,
            timeoutMs: STATS_TIMEOUT_MS,
            maxBytes: JSON_MAX_BYTES,
          })
          if (response.status < 200 || response.status >= 300) {
            return undefined
          }
          const cpu = cpuPercent(response.json, undefined)
          const mem = memoryMb(response.json)
          if (cpu === undefined || mem === undefined) {
            return undefined
          }
          const sample: ContainerSample = {
            containerId: stripSha256Prefix(id),
            cpuPercent: cpu,
            memMb: mem,
          }
          return sample
        } catch {
          return undefined
        }
      })

      const samples = statsResults.filter((item): item is ContainerSample => item !== undefined)
      emit('container/sample', { samples }, true)
    } finally {
      statsInFlight = false
    }
  }

  function startSampleTimer(): void {
    stopSampleTimer()
    void sampleOnce()
    const cancel = deps.schedule(function tick() {
      void sampleOnce()
      sampleTimerCancel = deps.schedule(tick, SAMPLE_INTERVAL_MS)
    }, SAMPLE_INTERVAL_MS)
    sampleTimerCancel = cancel
  }

  function startHub(): void {
    startDockerStream()
    startSampleTimer()
  }

  function stopHub(): void {
    stopDockerStream()
    stopSampleTimer()
    reconnectTimerCancel?.()
    reconnectTimerCancel = undefined
    for (const cancel of containerDebounce.values()) {
      cancel()
    }
    containerDebounce.clear()
    imageResyncCancel?.()
    imageResyncCancel = undefined
  }

  return {
    subscribe(handlers) {
      if (subscriberCount >= MAX_SUBSCRIBERS) {
        throw new Error('实时连接数已达上限')
      }
      subscriberCount += 1
      const wasZero = subscriberCount === 1
      const sub = {
        onEvent: handlers.onEvent,
        onStatus: handlers.onStatus,
      }
      subscribers.add(sub)

      deliverReplay(handlers.lastEventId, handlers.onEvent)

      if (dockerLive) {
        handlers.onStatus('live')
      } else {
        handlers.onStatus('connecting')
      }

      if (wasZero) {
        startHub()
      }

      return () => {
        subscribers.delete(sub)
        subscriberCount -= 1
        if (subscriberCount === 0) {
          stopHub()
        }
      }
    },

    notifyRestarting(containerId: string) {
      void (async () => {
        let startedAt = restartingStartedAt(containerId)
        if (startedAt === null) {
          const container = await inspectContainer(containerId)
          if (container?.startedAt !== undefined) {
            startedAt = container.startedAt
            lastKnownStartedAt.set(containerId, startedAt)
          }
        }
        emit(
          'container/updated',
          {
            containerId,
            status: 'restarting' satisfies ContainerStatus,
            startedAt,
          },
          false,
        )
      })()
    },
  }
}
