import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_COMPLETION_COMMANDS_MAX,
  TERMINAL_COMPLETION_FILES_MAX,
  TERMINAL_FLUSH_MAX_BYTES,
  TERMINAL_IDLE_TIMEOUT_MS,
  TERMINAL_MAX_SESSIONS,
  TERMINAL_ORDERED_QUEUE_MAX,
  TERMINAL_STARTUP_LINE,
  buildPtyEnv,
  createTerminalsService,
  type PtyProcess,
  type TerminalsHostDeps,
  type TerminalServerFrame,
  type TerminalSession,
  type TerminalSessionEvents,
} from './terminalsService.ts'

/*
 * 会话管理器的 fake 驱动测试：可编排字节的 fake PtyProcess（异步队列 stdout +
 * 写入账本 + 幂等 kill）与可控时钟，锚定启动行、ready 帧形状、input/interrupt
 * 写入字节、空闲超时、断开清理、并发上限、节流合帧、truncated、exit 路径与补全
 * 上下文。不 spawn 真进程、不起定时服务。
 */

const READY = '\x01READY\x02'

/** 可编排的 fake PTY：pushText 喂输出字节，emulateExit 结束 stdout 并给退出码。 */
function createFakePty() {
  const writes: string[] = []
  let flushCount = 0
  let killCount = 0
  let exitCode = 0
  let ended = false
  const chunks: Uint8Array[] = []
  const wakers: ((result: IteratorResult<Uint8Array>) => void)[] = []
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })

  const iterator = {
    next: (): Promise<IteratorResult<Uint8Array>> => {
      const chunk = chunks.shift()
      if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false })
      if (ended) return Promise.resolve({ value: undefined, done: true })
      return new Promise<IteratorResult<Uint8Array>>((resolve) => {
        wakers.push(resolve)
      })
    },
  }

  function wake(): void {
    for (const resolve of wakers.splice(0)) void iterator.next().then(resolve)
  }

  function emulateExit(code: number): void {
    exitCode = code
    ended = true
    resolveExit(code)
    wake()
  }

  const pty: PtyProcess = {
    write: (text) => {
      writes.push(text)
    },
    flush: () => {
      flushCount += 1
    },
    stdout: {
      [Symbol.asyncIterator]: () => iterator,
    },
    kill: async () => {
      killCount += 1
      emulateExit(137)
      return exited
    },
    exited,
  }

  function pushText(text: string): void {
    chunks.push(new TextEncoder().encode(text))
    wake()
  }

  return { pty, writes, pushText, emulateExit, get flushCount() { return flushCount }, get killCount() { return killCount }, get exitCode() { return exitCode } }
}

function createRecorder(): { frames: TerminalServerFrame[]; closes: { code: number; reason: string }[]; events: TerminalSessionEvents } {
  const frames: TerminalServerFrame[] = []
  const closes: { code: number; reason: string }[] = []
  return {
    frames,
    closes,
    events: {
      sendFrame: (frame) => {
        frames.push(frame)
      },
      close: (code, reason) => {
        closes.push({ code, reason })
      },
    },
  }
}

type Fixture = {
  frames: TerminalServerFrame[]
  closes: { code: number; reason: string }[]
  session: TerminalSession
  pty: ReturnType<typeof createFakePty>
  listDirCalls: string[]
  listCommandsCalls: number
  spawnEnv: Record<string, string> | undefined
  spawnCwd: string | undefined
  clock: { value: number }
}

function createFixture(overrides: Partial<TerminalsHostDeps> = {}): Fixture {
  const pty = createFakePty()
  const recorder = createRecorder()
  const listDirCalls: string[] = []
  let listCommandsCalls = 0
  let spawnEnv: Record<string, string> | undefined
  let spawnCwd: string | undefined
  const clock = { value: 1_000_000 }
  const deps: TerminalsHostDeps = {
    available: true,
    identity: () => ({ user: 'root', hostLabel: 'elysian-web-1', homeDir: '/root' }),
    spawnPtyShell: (opts) => {
      spawnEnv = opts.env
      spawnCwd = opts.cwd
      return pty.pty
    },
    listDir: async (path) => {
      listDirCalls.push(path)
      return ['apps', 'docs']
    },
    listCommands: async () => {
      listCommandsCalls += 1
      return ['bash', 'ls', 'whoami']
    },
    now: () => clock.value,
    ...overrides,
  }
  const service = createTerminalsService(deps)
  const session = service.tryOpen(recorder.events)
  if (!session) throw new Error('fake 并发不应触顶')
  return {
    frames: recorder.frames,
    closes: recorder.closes,
    session,
    pty,
    listDirCalls,
    get listCommandsCalls() {
      return listCommandsCalls
    },
    get spawnEnv() {
      return spawnEnv
    },
    get spawnCwd() {
      return spawnCwd
    },
    clock,
  }
}

/** 微任务轮转直至条件成立（fake timers 下 setTimeout 之外的可等待路径）。 */
async function waitFor(condition: () => boolean, rounds = 1000): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  }
  expect(condition(), 'waitFor 条件在轮转内未成立').toBe(true)
}

function outputFrames(frames: readonly TerminalServerFrame[]): Array<Extract<TerminalServerFrame, { type: 'output' }>> {
  return frames.filter((frame): frame is Extract<TerminalServerFrame, { type: 'output' }> => frame.type === 'output')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('buildPtyEnv', () => {
  it('分页器一律指向 cat：行模式会话里 git log、systemctl status、man 直接整页输出', () => {
    const env = buildPtyEnv('/root')
    expect(env.PAGER).toBe('cat')
    expect(env.GIT_PAGER).toBe('cat')
    expect(env.SYSTEMD_PAGER).toBe('cat')
    expect(env.MANPAGER).toBe('cat')
  })
})

describe('createTerminalsService 会话生命周期', () => {
  it('启动：spawn 用 env 白名单与 HOME cwd，写启动行并 flush', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    expect(f.spawnEnv).toEqual(buildPtyEnv('/root'))
    expect(f.spawnEnv?.PROMPT_COMMAND).toBe('printf "\\x01PWD:%s\\x02\\n" "$PWD"')
    expect(f.spawnCwd).toBe('/root')
    expect(f.pty.writes[0]).toBe(TERMINAL_STARTUP_LINE)
    expect(f.pty.flushCount).toBeGreaterThanOrEqual(1)
    await f.session.dispose('client-close')
  })

  it('READY 哨兵后发 ready 帧：身份、HOME 显示 ~ 的提示符与命令表', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    const ready = f.frames.find((frame) => frame.type === 'ready')
    if (ready?.type !== 'ready') throw new Error('ready 帧缺失')
    expect(ready.session.user).toBe('root')
    expect(ready.session.hostLabel).toBe('elysian-web-1')
    expect(ready.session.prompt).toBe('root@elysian-web-1:~$ ')
    expect(ready.session.id).not.toBe('')
    expect(ready.completion.commands).toEqual(['bash', 'ls', 'whoami'])
    expect(f.listCommandsCalls).toBe(1)
    await f.session.dispose('client-close')
  })

  it('ready 是首帧：compgen 完成前到达的 output/prompt 帧被扣住，ready 后按序补发', async () => {
    let releaseCommands!: () => void
    const commandsGate = new Promise<void>((resolve) => {
      releaseCommands = resolve
    })
    const f = createFixture({
      listCommands: async () => {
        await commandsGate
        return ['ls']
      },
    })
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\nout\r\n\x01PWD:/root\x02\r\n`)
    // compgen 未完成：命令结束帧已产但被扣住，连接上没有任何帧。
    for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(f.frames).toEqual([])
    releaseCommands()
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    expect(f.frames.map((frame) => frame.type)).toEqual(['ready', 'output', 'prompt'])
    await f.session.dispose('client-close')
  })

  it('两次连接的会话 id 不同（randomUUID）', async () => {
    const a = createFixture()
    const b = createFixture()
    expect(a.session.id).not.toBe(b.session.id)
    await a.session.dispose('client-close')
    await b.session.dispose('client-close')
  })

  it('spawn 失败：1011 关闭并给中文 reason，不遗留会话槽', async () => {
    const f = createFixture({
      spawnPtyShell: () => {
        throw new Error('script 不存在')
      },
    })
    await waitFor(() => f.closes.length >= 1)
    expect(f.closes[0]).toEqual({ code: 1011, reason: '终端进程启动失败：script 不存在' })
  })

  it('客户端帧：input 补换行、interrupt 写 \\x03、ping 回 pong', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))

    f.session.handleClientFrame({ type: 'input', data: 'whoami' })
    expect(f.pty.writes.at(-1)).toBe('whoami\n')
    expect(f.pty.flushCount).toBeGreaterThanOrEqual(2)

    f.session.handleClientFrame({ type: 'interrupt' })
    expect(f.pty.writes.at(-1)).toBe('\x03')

    f.session.handleClientFrame({ type: 'ping' })
    await waitFor(() => f.frames.some((frame) => frame.type === 'pong'))
    await f.session.dispose('client-close')
  })

  it('输出节流：行先进缓冲，50ms 定时器到点合为一帧', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\none\r\ntwo\r\n`)
    await vi.advanceTimersByTimeAsync(0)
    expect(outputFrames(f.frames)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(50)
    const outputs = outputFrames(f.frames)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.lines).toEqual(['one', 'two'])
    await f.session.dispose('client-close')
  })

  it('输出节流：累计 4096 字节立即 flush，不等定时器', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n${'x'.repeat(TERMINAL_FLUSH_MAX_BYTES)}\r\n`)
    await vi.advanceTimersByTimeAsync(0)
    const outputs = outputFrames(f.frames)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.lines).toEqual(['x'.repeat(TERMINAL_FLUSH_MAX_BYTES)])
    await f.session.dispose('client-close')
  })

  it('PWD 哨兵：flush 余行、prompt 帧带新提示符与 cwd 文件表、readdir 以 cwd 调用', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\nresult\r\n\x01PWD:/tmp\x02\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'prompt'))
    const prompt = f.frames.find((frame) => frame.type === 'prompt')
    if (prompt?.type !== 'prompt') throw new Error('prompt 帧缺失')
    expect(prompt.prompt).toBe('root@elysian-web-1:/tmp$ ')
    expect(prompt.cwd).toBe('/tmp')
    expect(prompt.completion.files).toEqual(['apps', 'docs'])
    expect(f.listDirCalls).toEqual(['/tmp'])
    // 命令结束前余行已 flush（output 帧先于 prompt 帧到达）。
    expect(f.frames.findIndex((frame) => frame.type === 'output')).toBeLessThan(
      f.frames.findIndex((frame) => frame.type === 'prompt'),
    )
    await f.session.dispose('client-close')
  })

  it('文件表超 512 项回 null（补全退回命令表）', async () => {
    const f = createFixture({
      listDir: async () => Array.from({ length: TERMINAL_COMPLETION_FILES_MAX + 1 }, (_, i) => `f${i}`),
    })
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n\x01PWD:/root\x02\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'prompt'))
    const prompt = f.frames.find((frame) => frame.type === 'prompt')
    if (prompt?.type !== 'prompt') throw new Error('prompt 帧缺失')
    expect(prompt.completion.files).toBeNull()
    await f.session.dispose('client-close')
  })

  it('命令表超上限截断到 4096', async () => {
    const f = createFixture({
      listCommands: async () => Array.from({ length: TERMINAL_COMPLETION_COMMANDS_MAX + 5 }, (_, i) => `cmd${i}`),
    })
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    const ready = f.frames.find((frame) => frame.type === 'ready')
    if (ready?.type !== 'ready') throw new Error('ready 帧缺失')
    expect(ready.completion.commands).toHaveLength(TERMINAL_COMPLETION_COMMANDS_MAX)
    await f.session.dispose('client-close')
  })

  it('compgen 失败降级空命令表', async () => {
    const f = createFixture({
      listCommands: async () => {
        throw new Error('compgen 失败')
      },
    })
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    const ready = f.frames.find((frame) => frame.type === 'ready')
    if (ready?.type !== 'ready') throw new Error('ready 帧缺失')
    expect(ready.completion.commands).toEqual([])
    await f.session.dispose('client-close')
  })

  it('单轮预算超限：prompt 帧前补 truncated，预算在 prompt 处重置', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n${'y'.repeat(300000)}\r\n\x01PWD:/root\x02\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'prompt'))
    // 第二个哨兵必须跟过真实输入才有效（伪造哨兵不再重置预算）。
    f.session.handleClientFrame({ type: 'input', data: 'true' })
    f.pty.pushText(`ok\r\n\x01PWD:/root\x02\r\n`)
    await waitFor(() => f.frames.filter((frame) => frame.type === 'prompt').length >= 2)
    const truncated = f.frames.find((frame) => frame.type === 'truncated')
    if (truncated?.type !== 'truncated') throw new Error('truncated 帧缺失')
    expect(truncated.droppedBytes).toBe(300000)
    // 超预算行不出现在 output 帧；预算重置后的 ok 行随下一个命令结束正常输出。
    expect(outputFrames(f.frames)).toEqual([{ type: 'output', lines: ['ok'] }])
    await f.session.dispose('client-close')
  })

  it('伪造哨兵洪水：无输入跟进的哨兵只认首个，预算不被逐轮重置、readdir 不被刷屏', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    // READY 后的首提示符哨兵有效；其后 100 轮「4096 字节行 + 伪造哨兵」全部无输入跟进。
    let flood = `${READY}\r\n\x01PWD:/root\x02\r\n`
    for (let i = 0; i < 100; i += 1) flood += `${'z'.repeat(4096)}\r\n\x01PWD:/root\x02\r\n`
    f.pty.pushText(flood)
    await waitFor(() => f.frames.some((frame) => frame.type === 'prompt'))
    for (let i = 0; i < 500; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve))
    // 只有一次 prompt 帧、一次 readdir：伪造哨兵不再逐一触发 prompt + readdir。
    expect(f.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(1)
    expect(f.listDirCalls).toEqual(['/root'])
    // 预算未被逐轮重置：100 行 × 4096 字节中超出 256 KiB 的 36 行被丢弃记账。
    expect(outputFrames(f.frames).reduce((sum, frame) => sum + frame.lines.length, 0)).toBe(64)
    f.pty.emulateExit(0)
    await waitFor(() => f.frames.some((frame) => frame.type === 'exit'))
    const truncated = f.frames.find((frame) => frame.type === 'truncated')
    if (truncated?.type !== 'truncated') throw new Error('truncated 帧缺失')
    expect(truncated.droppedBytes).toBe(36 * 4096)
    await f.session.dispose('client-close')
  })

  it('发送链排队深度超限：以 1008 中文 reason 断开并清理会话', async () => {
    let releaseListDir!: () => void
    const listDirGate = new Promise<void>((resolve) => {
      releaseListDir = resolve
    })
    const f = createFixture({
      listDir: async () => {
        await listDirGate // readdir 挂起：发送链不消费，排队深度单调上涨。
        return []
      },
    })
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    // 每轮真实 input 解锁一个哨兵：合法 prompt 事件在慢链上排队。逐轮等待 pump
    // 消费完再继续，保证 input → 哨兵的次序与真实 PTY 一致。
    for (let i = 0; i < TERMINAL_ORDERED_QUEUE_MAX + 10; i += 1) {
      f.session.handleClientFrame({ type: 'input', data: ':' })
      f.pty.pushText(`\x01PWD:/root\x02\r\n`)
      for (let k = 0; k < 20; k += 1) await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
    await waitFor(() => f.closes.some((close) => close.code === 1008), 5000)
    expect(f.closes).toContainEqual({ code: 1008, reason: '终端输出队列超限' })
    expect(f.pty.killCount).toBeGreaterThanOrEqual(1)
    releaseListDir()
    await f.session.dispose('client-close')
  })

  it('空闲超时：30 分钟无客户端帧触发 kill 与 4000 关闭', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_TIMEOUT_MS - 1)
    expect(f.closes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await waitFor(() => f.pty.killCount >= 1)
    expect(f.closes).toEqual([{ code: 4000, reason: '终端会话空闲超时' }])
    expect(f.pty.killCount).toBe(1)
  })

  it('任意客户端帧重置空闲计时', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_TIMEOUT_MS - 1)
    f.session.handleClientFrame({ type: 'ping' })
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_TIMEOUT_MS - 1)
    expect(f.closes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await waitFor(() => f.closes.length >= 1)
    expect(f.closes[0]).toEqual({ code: 4000, reason: '终端会话空闲超时' })
  })

  it('断开清理：dispose 幂等，kill 恰好一次', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\n`)
    await waitFor(() => f.frames.some((frame) => frame.type === 'ready'))
    await f.session.dispose('client-close')
    await f.session.dispose('client-close')
    expect(f.pty.killCount).toBe(1)
    expect(f.closes).toHaveLength(0) // 客户端关闭路径不再向连接发关闭帧
  })

  it('PTY 自然退出：flush 余行、exit 帧带退出码、1000 关闭', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.pushText(`${READY}\r\nlast words\r\n`)
    f.pty.emulateExit(3)
    await waitFor(() => f.frames.some((frame) => frame.type === 'exit'))
    const exit = f.frames.find((frame) => frame.type === 'exit')
    if (exit?.type !== 'exit') throw new Error('exit 帧缺失')
    expect(exit.exitCode).toBe(3)
    await waitFor(() => f.closes.length >= 1)
    expect(f.closes[0]).toEqual({ code: 1000, reason: '' })
    expect(f.pty.killCount).toBe(0)
    await waitFor(() => outputFrames(f.frames).some((frame) => frame.lines.includes('last words')))
  })

  it('READY 之前进程死亡：不发 ready，走 exit 路径', async () => {
    const f = createFixture()
    await waitFor(() => f.pty.writes.length >= 1)
    f.pty.emulateExit(0)
    await waitFor(() => f.frames.some((frame) => frame.type === 'exit'))
    expect(f.frames.some((frame) => frame.type === 'ready')).toBe(false)
    await f.session.dispose('client-close')
  })

  it('并发上限：第 6 个会话被拒，释放后可再开', async () => {
    const deps: TerminalsHostDeps = {
      available: true,
      identity: () => ({ user: 'root', hostLabel: 'h', homeDir: '/root' }),
      spawnPtyShell: () => createFakePty().pty,
      listDir: async () => [],
      listCommands: async () => [],
      now: () => 0,
    }
    const service = createTerminalsService(deps)
    const sessions: TerminalSession[] = []
    for (let i = 0; i < TERMINAL_MAX_SESSIONS; i += 1) {
      const session = service.tryOpen(createRecorder().events)
      if (!session) throw new Error('前 5 个会话不应被拒')
      sessions.push(session)
    }
    expect(service.activeCount()).toBe(TERMINAL_MAX_SESSIONS)
    expect(service.tryOpen(createRecorder().events)).toBeNull()
    await sessions[0]?.dispose('client-close')
    expect(service.activeCount()).toBe(TERMINAL_MAX_SESSIONS - 1)
    expect(service.tryOpen(createRecorder().events)).not.toBeNull()
    for (const session of sessions.slice(1)) await session.dispose('client-close')
  })
})
