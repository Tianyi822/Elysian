import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DockerTransport } from './dockerTransport'
import { createDockerEventsHub } from './dockerEventsHub'

const BOOT_ID = '00000000-0000-4000-8000-000000000001'
const CONTAINER_ID = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456'
const SHORT_ID = CONTAINER_ID.slice(0, 13)
const EVENTS_FILTERS = JSON.stringify({ type: ['container', 'image'] })
const EVENTS_PATH = `/v1.41/events?filters=${encodeURIComponent(EVENTS_FILTERS)}`

function baseInspect(status: string, startedAt?: string) {
  return {
    Id: CONTAINER_ID,
    Name: '/demo',
    Created: '2024-06-01T10:00:00.000000000Z',
    Image: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    Path: '/bin/sh',
    Args: [] as string[],
    State: {
      Status: status,
      StartedAt: startedAt ?? '2024-06-01T10:01:00.000000000Z',
    },
    Config: { Image: 'demo:latest', Env: [] as string[] },
    HostConfig: { PortBindings: {}, RestartPolicy: { Name: 'no' } },
    Mounts: [] as unknown[],
  }
}

function statsJson(withPrecpu: boolean) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 200_000_000, percpu_usage: [1, 2] },
      system_cpu_usage: 400_000_000,
      online_cpus: 2,
    },
    precpu_stats: withPrecpu
      ? {
          cpu_usage: { total_usage: 100_000_000, percpu_usage: [1, 2] },
          system_cpu_usage: 200_000_000,
          online_cpus: 2,
        }
      : {},
    memory_stats: {
      usage: 100 * 1024 * 1024,
      stats: { inactive_file: 0 },
    },
  }
}

type ScheduledTask = { at: number; fn: () => void; cancel: () => void }

function createFakeClock() {
  let nowMs = 1_700_000_000_000
  const tasks: ScheduledTask[] = []

  const schedule = (fn: () => void, ms: number): (() => void) => {
    const task: ScheduledTask = {
      at: nowMs + ms,
      fn,
      cancel: () => {},
    }
    task.cancel = () => {
      const index = tasks.indexOf(task)
      if (index >= 0) tasks.splice(index, 1)
    }
    tasks.push(task)
    return task.cancel
  }

  function runDue(): void {
    tasks.sort((a, b) => a.at - b.at)
    while (tasks.length > 0 && tasks[0]!.at <= nowMs) {
      const task = tasks.shift()!
      task.fn()
    }
  }

  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms
      runDue()
    },
    schedule,
  }
}

function parseFrameData(data: string): { name: string; payload: unknown } {
  const envelope = JSON.parse(data) as { name: string; payload: unknown }
  return { name: envelope.name, payload: envelope.payload }
}

describe('createDockerEventsHub', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('首个订阅者启动 Engine 事件流，退订到 0 时取消', () => {
    const clock = createFakeClock()
    let streamClosed = false

    const transport: DockerTransport = {
      request: vi.fn(async () => ({ status: 200, json: [] })),
      openStream: vi.fn((input) => {
        expect(input.method).toBe('GET')
        expect(input.path).toBe(EVENTS_PATH)
        return () => {
          streamClosed = true
        }
      }),
    }

    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    const unsub = hub.subscribe({ onEvent: vi.fn(), onStatus: vi.fn() })
    expect(transport.openStream).toHaveBeenCalledTimes(1)

    unsub()
    expect(streamClosed).toBe(true)

    hub.subscribe({ onEvent: vi.fn(), onStatus: vi.fn() })
    expect(transport.openStream).toHaveBeenCalledTimes(2)
  })

  it('第 9 个 subscribe 抛错', () => {
    const clock = createFakeClock()
    const transport: DockerTransport = {
      request: vi.fn(async () => ({ status: 200, json: [] })),
      openStream: vi.fn(() => () => {}),
    }
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    const unsubs: Array<() => void> = []
    for (let i = 0; i < 8; i += 1) {
      unsubs.push(hub.subscribe({ onEvent: vi.fn(), onStatus: vi.fn() }))
    }
    expect(() => hub.subscribe({ onEvent: vi.fn(), onStatus: vi.fn() })).toThrowError(
      '实时连接数已达上限',
    )
    for (const u of unsubs) u()
  })

  it('Engine 断开后重连上报 live，且 HTTP 订阅无需重新建立', () => {
    const clock = createFakeClock()
    let closeEngine: (() => void) | undefined
    const transport: DockerTransport = {
      request: vi.fn(async () => ({ status: 200, json: [] })),
      openStream: vi.fn((input) => {
        closeEngine = input.onClose
        return () => {}
      }),
    }
    const hub = createDockerEventsHub({ transport, now: clock.now, schedule: clock.schedule, bootId: BOOT_ID })
    const statuses: Array<'live' | 'connecting'> = []
    const onEvent = vi.fn()
    const unsubscribe = hub.subscribe({ onEvent, onStatus: (status) => statuses.push(status) })
    try {
      expect(statuses).toEqual(['connecting', 'live'])
      closeEngine?.()
      expect(statuses).toEqual(['connecting', 'live', 'connecting'])
      clock.advance(1_000)
      expect(transport.openStream).toHaveBeenCalledTimes(2)
      expect(statuses).toEqual(['connecting', 'live', 'connecting', 'live'])
      expect(onEvent.mock.calls.filter(([frame]) => frame.event === 'container/resync')).toHaveLength(2)
    } finally {
      unsubscribe()
    }
  })

  it('die 防抖 inspect 后推出 container/updated 且 startedAt 为 null', async () => {
    const clock = createFakeClock()
    let pushLine: ((line: string) => void) | undefined

    const transport: DockerTransport = {
      request: vi.fn(async (input) => {
        if (input.path.includes('/json')) {
          return { status: 200, json: baseInspect('exited') }
        }
        return { status: 200, json: [] }
      }),
      openStream: vi.fn((input) => {
        pushLine = input.onLine
        return () => {}
      }),
    }

    const frames: string[] = []
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    hub.subscribe({
      onEvent: (frame) => {
        if (frame.event !== 'container/resync') {
          frames.push(frame.data)
        }
      },
      onStatus: vi.fn(),
    })

    pushLine?.(
      JSON.stringify({
        Type: 'container',
        Action: 'die',
        id: CONTAINER_ID,
      }),
    )
    clock.advance(199)
    expect(frames.some((data) => parseFrameData(data).name === 'container/updated')).toBe(false)
    clock.advance(1)

    await vi.waitFor(() => {
      expect(
        frames.some((data) => {
          const parsed = parseFrameData(data)
          return (
            parsed.name === 'container/updated' &&
            parsed.payload &&
            typeof parsed.payload === 'object' &&
            'startedAt' in parsed.payload &&
            (parsed.payload as { startedAt: unknown }).startedAt === null
          )
        }),
      ).toBe(true)
    })
  })

  it('destroy 推出 container/removed；rename 与镜像 pull 推出 container/resync', async () => {
    const clock = createFakeClock()
    let pushLine: ((line: string) => void) | undefined

    const transport: DockerTransport = {
      request: vi.fn(async () => ({ status: 200, json: [] })),
      openStream: vi.fn((input) => {
        pushLine = input.onLine
        return () => {}
      }),
    }

    const names: string[] = []
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    hub.subscribe({
      onEvent: (frame) => {
        names.push(parseFrameData(frame.data).name)
      },
      onStatus: vi.fn(),
    })

    pushLine?.(
      JSON.stringify({ Type: 'container', Action: 'destroy', id: CONTAINER_ID }),
    )
    clock.advance(200)
    await vi.waitFor(() => expect(names).toContain('container/removed'))

    pushLine?.(
      JSON.stringify({ Type: 'container', Action: 'rename', id: CONTAINER_ID }),
    )
    clock.advance(200)
    await vi.waitFor(() => expect(names.filter((n) => n === 'container/resync').length).toBeGreaterThan(0))

    pushLine?.(JSON.stringify({ Type: 'image', Action: 'pull', id: 'abc' }))
    clock.advance(200)
    await vi.waitFor(() => expect(names.filter((n) => n === 'container/resync').length).toBeGreaterThan(1))
  })

  it('采样 running 容器 stats；无 precpu 不入 samples；上一拍未完跳过下一拍', async () => {
    const clock = createFakeClock()
    let statsCalls = 0
    let resolveStats: ((value: { status: number; json: unknown }) => void) | undefined

    const transport: DockerTransport = {
      request: vi.fn(async (input): Promise<{ status: number; json: unknown }> => {
        if (input.path.includes('/containers/json')) {
          return {
            status: 200,
            json: [{ Id: CONTAINER_ID, State: 'running' }],
          }
        }
        if (input.path.includes('/stats?stream=0')) {
          statsCalls += 1
          if (statsCalls === 1) {
            return new Promise((resolve) => {
              resolveStats = resolve
            })
          }
          return { status: 200, json: statsJson(true) }
        }
        return { status: 200, json: [] }
      }),
      openStream: vi.fn(() => () => {}),
    }

    const samplePayloads: unknown[] = []
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    hub.subscribe({
      onEvent: (frame) => {
        if (frame.event === 'container/sample') {
          samplePayloads.push(parseFrameData(frame.data).payload)
        }
      },
      onStatus: vi.fn(),
    })

    await vi.waitFor(() => expect(statsCalls).toBe(1))
    clock.advance(3000)
    expect(statsCalls).toBe(1)

    resolveStats?.({ status: 200, json: statsJson(false) })
    await vi.waitFor(() => expect(samplePayloads.length).toBeGreaterThan(0))
    const first = samplePayloads[0] as { samples: { containerId: string }[] }
    expect(first.samples).toEqual([])

    resolveStats = undefined
    clock.advance(3000)
    await vi.waitFor(() => expect(statsCalls).toBe(2))
    await vi.waitFor(() => expect(samplePayloads.length).toBeGreaterThan(1))
    const second = samplePayloads.at(-1) as { samples: { containerId: string }[] }
    expect(second.samples.some((s) => s.containerId === CONTAINER_ID)).toBe(true)
  })

  it('缓冲 257 条后按最旧 id 重连先 resync；采样 id 仍新时不 resync；boot 前缀不符先 resync', async () => {
    const clock = createFakeClock()
    const transport: DockerTransport = {
      request: vi.fn(async () => ({ status: 200, json: [] })),
      openStream: vi.fn(() => () => {}),
    }
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    let sampleEventId = ''
    hub.subscribe({
      onEvent: (frame) => {
        if (frame.event === 'container/sample') {
          sampleEventId = frame.id
        }
      },
      onStatus: vi.fn(),
    })

    await vi.waitFor(() => expect(sampleEventId.length).toBeGreaterThan(0))

    for (let i = 0; i < 257; i += 1) {
      hub.notifyRestarting(CONTAINER_ID)
    }

    const seqBeforeAdvance = Number.parseInt(sampleEventId.split('.').at(-1) ?? '0', 10)
    clock.advance(3000)
    await vi.waitFor(() => {
      const seq = Number.parseInt(sampleEventId.split('.').at(-1) ?? '0', 10)
      expect(seq).toBeGreaterThan(seqBeforeAdvance)
    })

    const replayEvents: string[] = []
    hub.subscribe({
      lastEventId: `${BOOT_ID}.1`,
      onEvent: (frame) => {
        replayEvents.push(parseFrameData(frame.data).name)
      },
      onStatus: vi.fn(),
    })
    expect(replayEvents[0]).toBe('container/resync')

    const sampleOnly: string[] = []
    hub.subscribe({
      lastEventId: sampleEventId,
      onEvent: (frame) => {
        sampleOnly.push(parseFrameData(frame.data).name)
      },
      onStatus: vi.fn(),
    })
    expect(sampleOnly.some((name) => name === 'container/resync')).toBe(false)

    const wrongBoot: string[] = []
    hub.subscribe({
      lastEventId: `other-boot.999`,
      onEvent: (frame) => {
        wrongBoot.push(parseFrameData(frame.data).name)
      },
      onStatus: vi.fn(),
    })
    expect(wrongBoot[0]).toBe('container/resync')
  })

  it('notifyRestarting 在容器有 startedAt 时推送字符串而非 null', async () => {
    const clock = createFakeClock()
    const transport: DockerTransport = {
      request: vi.fn(async (input) => {
        if (input.path.includes('/json')) {
          return { status: 200, json: baseInspect('running') }
        }
        return { status: 200, json: [] }
      }),
      openStream: vi.fn(() => () => {}),
    }
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    let payload: unknown
    hub.subscribe({
      onEvent: (frame) => {
        if (frame.event === 'container/updated') {
          payload = parseFrameData(frame.data).payload
        }
      },
      onStatus: vi.fn(),
    })

    hub.notifyRestarting(SHORT_ID)
    await vi.waitFor(() => {
      expect(payload).toEqual({
        containerId: SHORT_ID,
        status: 'restarting',
        startedAt: '2024-06-01T10:01:00.000000000Z',
      })
    })
  })

  it('Last-Event-ID 等于最新采样帧时仍重放其后非采样事件', async () => {
    const clock = createFakeClock()
    const transport: DockerTransport = {
      request: vi.fn(async () => ({ status: 200, json: [] })),
      openStream: vi.fn(() => () => {}),
    }
    const hub = createDockerEventsHub({
      transport,
      now: clock.now,
      schedule: clock.schedule,
      bootId: BOOT_ID,
    })

    let sampleEventId = ''
    hub.subscribe({
      onEvent: (frame) => {
        if (frame.event === 'container/sample') {
          sampleEventId = frame.id
        }
      },
      onStatus: vi.fn(),
    })
    await vi.waitFor(() => expect(sampleEventId.length).toBeGreaterThan(0))

    hub.notifyRestarting(SHORT_ID)

    const replayNames: string[] = []
    hub.subscribe({
      lastEventId: sampleEventId,
      onEvent: (frame) => {
        replayNames.push(parseFrameData(frame.data).name)
      },
      onStatus: vi.fn(),
    })

    await vi.waitFor(() => {
      expect(replayNames).toContain('container/updated')
    })

    expect(replayNames).toContain('container/sample')
  })
})
