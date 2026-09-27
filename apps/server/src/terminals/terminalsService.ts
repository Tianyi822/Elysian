import { randomUUID } from 'node:crypto'
import { TERMINAL_COLS, TERMINAL_ROWS } from '@elysian/contracts'
import type { TerminalClientFrame } from './terminalFrames.ts'
import { TerminalStreamAssembler, type TerminalStreamEvent } from './terminalStream.ts'

/*
 * 终端会话管理器：一连接一会话的服务端编排。职责边界——本模块只做会话生命周期
 * （创建/并发上限/空闲计时/清理）、PTY 启动行与哨兵等待、输出泵与合帧节流、补全
 * 上下文（compgen 命令表 + readdir 文件表）、截断与退出路径；真实进程与文件系统
 * 全部经 TerminalsHostDeps 注入，Vitest 用 fake PtyProcess 与 fake 时钟驱动，不
 * spawn 任何真进程。协议口径的唯一权威是方案的「端点契约」与「服务层设计」。
 */

/** 并发会话上限：第 6 条连接在升级后被以 1008 拒绝（不建 PTY）。 */
export const TERMINAL_MAX_SESSIONS = 5

/** 空闲超时：30 分钟无任何客户端帧即 4000 关闭并杀进程；任意客户端帧重置。 */
export const TERMINAL_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** 合帧节流：每 50ms 或累计 4096 字节发送一帧 output。 */
export const TERMINAL_FLUSH_INTERVAL_MS = 50
export const TERMINAL_FLUSH_MAX_BYTES = 4096

/**
 * 保序发送链的最大排队深度：超过即以 1008 断开会话。慢消费连接或事件洪水下链条
 * 会积累闭包与待发帧，深度上限是发送侧内存有界的兜底（输出违规在 WS 下的处置口径）。
 */
export const TERMINAL_ORDERED_QUEUE_MAX = 256

/** 补全上限：命令表条数截断；文件表超限回 null（客户端退回命令表）。 */
export const TERMINAL_COMPLETION_COMMANDS_MAX = 4096
export const TERMINAL_COMPLETION_FILES_MAX = 512

/**
 * 驯化启动行：关回显、定栅格、关历史扩展，随后 printf 输出 READY 哨兵（原始字节
 * \x01READY\x02）。参数里的 \x01 等是 printf 的字面转义文本，与哨兵的真实控制字节
 * 可区分（启动行回显因此不会冒充哨兵）。
 */
export const TERMINAL_STARTUP_LINE = `stty cols ${TERMINAL_COLS} rows ${TERMINAL_ROWS} -echo; set +H; printf '\\x01READY\\x02\\n'\n`

/** Shell 驯化规格：PTY 环境增量与启动行，本机与容器终端各自传入。 */
export type ShellSessionSpec = {
  env: Readonly<Record<string, string>>
  startupLine: string
}

/** 本机（容器内 host bash）终端沿用的 shell 规格，供装配层与测试默认对齐。 */
export const HOST_SHELL_SESSION_SPEC: ShellSessionSpec = {
  env: {
    PS1: '',
    PROMPT_COMMAND: 'printf "\\x01PWD:%s\\x02\\n" "$PWD"',
  },
  startupLine: TERMINAL_STARTUP_LINE,
}

const utf8Encoder = new TextEncoder()

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** PTY 进程的最小形状：Bun.spawn 管道形态（stdin FileSink、stdout 异步字节流）。 */
export type PtyProcess = {
  write(text: string): void
  flush(): void
  stdout: AsyncIterable<Uint8Array>
  /** SIGKILL 并等待退出码；幂等。 */
  kill(): Promise<number>
  exited: Promise<number>
}

/** 服务端身份：构造提示符与 HOME 归一（~）用。 */
export type TerminalIdentity = {
  user: string
  hostLabel: string
  homeDir: string
}

/** 服务注入形状（方案「deps 注入形状」逐字）：available 镜像容器边界，供装配层对齐。 */
export type TerminalsHostDeps = {
  available: boolean
  identity(): TerminalIdentity
  spawnPtyShell(opts: { env: Record<string, string>; cwd: string }): PtyProcess
  /** 容器终端使用固定提示符；缺省沿用本机终端的用户、主机和 cwd。 */
  formatPrompt?(identity: TerminalIdentity, cwd: string): string
  listDir(path: string): Promise<readonly string[]>
  listCommands(): Promise<readonly string[]>
  /**
   * 会话收尾钩子（可选）：dispose 杀掉 PTY 后调用，参数是 READY 哨兵捕获的 shell
   * pid（未见哨兵时为 null）；容器 exec 装配用它跑断开清理脚本。
   */
  disposeShell?: (shellPid: string | null) => void | Promise<void>
  now(): number
}

/** 服务端 → 客户端的六类帧。 */
export type TerminalServerFrame =
  | {
      readonly type: 'ready'
      readonly session: { readonly id: string; readonly user: string; readonly hostLabel: string; readonly prompt: string }
      readonly completion: { readonly commands: readonly string[] }
    }
  | { readonly type: 'output'; readonly lines: readonly string[] }
  | { readonly type: 'prompt'; readonly prompt: string; readonly cwd: string; readonly completion: { readonly files: readonly string[] | null } }
  | { readonly type: 'truncated'; readonly droppedBytes: number }
  | { readonly type: 'exit'; readonly exitCode: number }
  | { readonly type: 'pong' }

/** 会话向连接侧输出帧与关闭的出口（胶水层把它绑到 WSContext）。 */
export type TerminalSessionEvents = {
  sendFrame(frame: TerminalServerFrame): void
  close(code: number, reason: string): void
}

export type TerminalDisposeCause = 'client-close' | 'idle-timeout' | 'internal'

/** 对外的会话句柄：连接胶水按客户端帧驱动，关闭路径统一走 dispose。 */
export type TerminalSession = {
  readonly id: string
  handleClientFrame(frame: TerminalClientFrame): void
  dispose(cause: TerminalDisposeCause): Promise<void>
}

export type TerminalsService = {
  /** 占用一个会话槽并启动 PTY；并发已达上限返回 null（调用方以 1008 关闭、不建 PTY）。 */
  tryOpen(events: TerminalSessionEvents): TerminalSession | null
  activeCount(): number
}

/** 提示符构造：HOME 显示为 ~（含 HOME 下的子路径），其余路径原样。 */
export function buildTerminalPrompt(identity: TerminalIdentity, cwd: string): string {
  return `${identity.user}@${identity.hostLabel}:${tildePath(cwd, identity.homeDir)}$ `
}

function tildePath(path: string, homeDir: string): string {
  if (path === homeDir) return '~'
  if (homeDir !== '/' && path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`
  return path
}

/**
 * PTY 环境白名单：只透传驯化所需的最小集合，server 进程其余 env（含未来可能的
 * 凭据）绝不进终端。PATH 是固定串（含 ~/.bun/bin）。
 * 分页器一律指向 cat：会话是行模式、没有全屏能力，less 一类分页器在这里只会停在
 * 「terminal is not fully functional」与翻页提示上，git log、systemctl status、man 因此直接整页输出。
 * shell 规格里的 PS1/PROMPT 等在 spawn 时与 {@link buildPtyEnvBase} 合并，不写入本函数。
 */
export function buildPtyEnvBase(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    PATH: `${homeDir}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    TERM: 'dumb',
    LANG: 'C.UTF-8',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    SYSTEMD_PAGER: 'cat',
    MANPAGER: 'cat',
  }
}

/** 本机 host 会话的完整 spawn env（白名单 + {@link HOST_SHELL_SESSION_SPEC}），测试与断言锚点。 */
export function buildPtyEnv(homeDir: string): Record<string, string> {
  return { ...buildPtyEnvBase(homeDir), ...HOST_SHELL_SESSION_SPEC.env }
}

type Timer = ReturnType<typeof setTimeout>

class TerminalSessionImpl implements TerminalSession {
  private readonly assembler = new TerminalStreamAssembler()
  private readonly outputLines: string[] = []
  private outputBytes = 0
  private flushTimer: Timer | null = null
  private idleTimer: Timer | null = null
  private chain: Promise<void> = Promise.resolve()
  /** 发送链上排队未完成的任务数：深度上限的计数器。 */
  private queued = 0
  private proc: PtyProcess | null = null
  private identity: TerminalIdentity | null = null
  private disposed = false
  private cleaned = false
  private streamEnded = false
  private readySent = false
  /** READY 哨兵捕获的容器内 shell pid（本机启动行不带 pid，保持 null）。 */
  private shellPid: string | null = null
  private heldFrames: TerminalServerFrame[] = []
  private lastFlushAt = 0
  private readyResolve: (() => void) | null = null
  private readonly readyGate: Promise<void> = new Promise((resolve) => {
    this.readyResolve = resolve
  })

  constructor(
    readonly id: string,
    private readonly deps: TerminalsHostDeps,
    private readonly shell: ShellSessionSpec,
    private readonly events: TerminalSessionEvents,
    private readonly onEnded: (id: string) => void,
  ) {
    // 字段初始化先于构造体执行（useDefineForClassFields），此刻才能安全读 deps。
    this.lastFlushAt = deps.now()
  }

  /** 启动：spawn → 写启动行 → 后台输出泵 → 等 READY 哨兵与命令表 → 发 ready 帧。 */
  async start(): Promise<void> {
    try {
      this.identity = this.deps.identity()
      this.proc = this.deps.spawnPtyShell({
        env: { ...buildPtyEnvBase(this.identity.homeDir), ...this.shell.env },
        cwd: this.identity.homeDir,
      })
    } catch (error) {
      this.events.close(1011, `终端进程启动失败：${errorText(error)}`)
      this.resolveReady()
      this.cleanup()
      return
    }
    const proc = this.proc
    this.armIdle()
    try {
      if (this.shell.startupLine !== '') {
        proc.write(this.shell.startupLine)
        proc.flush()
      }
    } catch {
      // 启动行写入失败：按退出路径收尾（pump 观察到流结束）。
    }
    void this.pump(proc)
    await this.readyGate
    // 流已结束（bash 秒退）或已 dispose：退出路径由泵负责，这里不发 ready。
    if (this.disposed || this.streamEnded) return
    let commands: readonly string[] = []
    try {
      commands = await this.deps.listCommands()
    } catch {
      commands = [] // compgen 失败降级为空命令表
    }
    if (this.disposed || this.streamEnded) return
    const identity = this.identity
    this.runOrdered(() => {
      this.events.sendFrame({
        type: 'ready',
        session: {
          id: this.id,
          user: identity.user,
          hostLabel: identity.hostLabel,
          prompt: this.deps.formatPrompt?.(identity, identity.homeDir) ?? buildTerminalPrompt(identity, identity.homeDir),
        },
        completion: { commands: commands.slice(0, TERMINAL_COMPLETION_COMMANDS_MAX) },
      })
      // ready 是升级后的首帧：此前到达的 prompt/output 先扣住，ready 发出后按序补发。
      this.readySent = true
      for (const frame of this.heldFrames.splice(0)) {
        this.events.sendFrame(frame)
      }
    })
  }

  /** 客户端帧入口：任意帧重置空闲计时；input/interrupt 原样字节落 PTY 并武装下一个
   * 哨兵（只有跟过真实输入的 PWD 哨兵才算命令结束，伪造哨兵洪流不重置预算）；ping 回 pong。 */
  handleClientFrame(frame: TerminalClientFrame): void {
    this.armIdle()
    const proc = this.proc
    if (!proc || this.disposed) return
    if (frame.type === 'input') {
      this.assembler.noteInput()
      this.writePty(proc, `${frame.data}\n`)
      return
    }
    if (frame.type === 'interrupt') {
      this.assembler.noteInput()
      this.writePty(proc, '\x03')
      return
    }
    this.emit({ type: 'pong' })
  }

  /** 服务端帧出口：ready 未发出前扣住非 ready 帧，保证 ready 是升级后首帧。 */
  private emit(frame: TerminalServerFrame): void {
    if (!this.readySent) {
      this.heldFrames.push(frame)
      return
    }
    this.events.sendFrame(frame)
  }

  /** 放行扣住的帧：ready 发出后或会话收尾（退出/关闭）时调用。 */
  private releaseHeld(): void {
    this.readySent = true
    for (const frame of this.heldFrames.splice(0)) {
      this.events.sendFrame(frame)
    }
  }

  /** PTY 写入：死掉的 stdin 抛异常时吞掉，会话由退出/关闭路径收尾。 */
  private writePty(proc: PtyProcess, text: string): void {
    try {
      proc.write(text)
      proc.flush()
    } catch {
      // 进程已死：写入失败不外泄。
    }
  }

  /** 关闭路径（客户端断开/空闲超时/内部失败）：SIGKILL 并等待退出码，幂等。 */
  async dispose(cause: TerminalDisposeCause): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    this.resolveReady()
    // 先出账再杀：并发槽位在 onClose 同步路径里立即释放（kill 的等待不阻塞新会话）。
    this.cleanup()
    const proc = this.proc
    if (proc) {
      try {
        await proc.kill()
      } catch {
        // kill 幂等；对已退出进程的重复 kill 忽略，不外泄。
      }
    }
    this.runDisposeHook()
    if (cause === 'idle-timeout') {
      this.releaseHeld()
      this.events.close(4000, '终端会话空闲超时')
    }
  }

  /** 会话收尾钩子：容器 exec 的 shell 进程不随 hijack 断开退出，按捕获的 pid 追加清理。 */
  private runDisposeHook(): void {
    const hook = this.deps.disposeShell
    if (hook === undefined || this.shellPid === null) return
    void Promise.resolve(hook(this.shellPid)).catch(() => undefined)
  }

  private async pump(proc: PtyProcess): Promise<void> {
    try {
      for await (const chunk of proc.stdout) {
        if (this.disposed) return
        for (const event of this.assembler.push(chunk)) this.handleStreamEvent(event)
      }
    } catch {
      // 输出泵读异常：按流结束收尾，绝不向连接层外泄异常。
    }
    this.streamEnded = true
    this.resolveReady()
    if (this.disposed) return
    for (const event of this.assembler.finish()) this.handleStreamEvent(event)
    this.flushOutput()
    // 最后一轮无 prompt 帧收尾：仍有丢弃时补一帧 truncated，让截断标记可见。
    const droppedBytes = this.assembler.droppedBytes
    if (droppedBytes > 0) {
      this.runOrdered(() => {
        this.emit({ type: 'truncated', droppedBytes })
      })
    }
    const exitCode = await proc.exited
    if (this.disposed) return
    this.runOrdered(() => {
      // 退出路径放行一切扣住的帧（ready 可能因进程秒退从未发出）。
      this.releaseHeld()
      this.events.sendFrame({ type: 'exit', exitCode })
      this.events.close(1000, '')
    })
    this.cleanup()
  }

  private handleStreamEvent(event: TerminalStreamEvent): void {
    if (event.kind === 'ready') {
      this.shellPid = event.pid
      this.resolveReady()
      return
    }
    if (event.kind === 'lines') {
      for (const line of event.lines) this.bufferLine(line)
      return
    }
    // 命令结束：先 flush 余行，再补截断帧（如有），最后 readdir 后发 prompt 帧。
    this.flushOutput()
    const { cwd, droppedBytes } = event
    this.runOrdered(async () => {
      if (droppedBytes > 0) {
        this.emit({ type: 'truncated', droppedBytes })
      }
      const files = await this.listFiles(cwd)
      if (this.disposed) return
      const identity = this.identity
      if (!identity) return
      this.emit({
        type: 'prompt',
        prompt: this.deps.formatPrompt?.(identity, cwd) ?? buildTerminalPrompt(identity, cwd),
        cwd,
        completion: { files },
      })
    })
  }

  private async listFiles(cwd: string): Promise<readonly string[] | null> {
    try {
      const names = await this.deps.listDir(cwd)
      if (names.length > TERMINAL_COMPLETION_FILES_MAX) return null
      return names
    } catch {
      return null
    }
  }

  /** 行缓冲：累计 4096 字节立即 flush；静默期后到达的首行立即 flush，其余等 50ms 定时器。 */
  private bufferLine(line: string): void {
    this.outputLines.push(line)
    this.outputBytes += utf8ByteLength(line)
    if (this.outputBytes >= TERMINAL_FLUSH_MAX_BYTES) {
      this.flushOutput()
      return
    }
    if (this.flushTimer === null) {
      if (this.deps.now() - this.lastFlushAt >= TERMINAL_FLUSH_INTERVAL_MS) {
        this.flushOutput()
      } else {
        this.flushTimer = setTimeout(() => this.flushOutput(), TERMINAL_FLUSH_INTERVAL_MS)
      }
    }
  }

  private flushOutput(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.outputLines.length === 0) return
    const lines = this.outputLines.splice(0)
    this.outputBytes = 0
    this.lastFlushAt = this.deps.now()
    this.runOrdered(() => {
      this.emit({ type: 'output', lines })
    })
  }

  /** 保序发送链：output/truncated/prompt/exit 帧严格按流内次序到达客户端。 */
  private runOrdered(task: () => void | Promise<void>): void {
    if (this.disposed) return
    if (this.queued >= TERMINAL_ORDERED_QUEUE_MAX) {
      // 排队深度超限（慢消费连接或事件洪水）：断开是终端场景下背压的合理终态，
      // 防链条闭包与待发帧无界积累。
      void this.dispose('internal')
      this.events.close(1008, '终端输出队列超限')
      return
    }
    this.queued += 1
    this.chain = this.chain.then(task).then(
      () => {
        this.queued -= 1
      },
      () => {
        this.queued -= 1
      },
    )
  }

  private armIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.dispose('idle-timeout')
    }, TERMINAL_IDLE_TIMEOUT_MS)
  }

  private clearTimers(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private resolveReady(): void {
    this.readyResolve?.()
    this.readyResolve = null
  }

  private cleanup(): void {
    if (this.cleaned) return
    this.cleaned = true
    this.clearTimers()
    this.onEnded(this.id)
  }
}

/** 会话管理器工厂：并发上限与活跃会话账本在此，会话结束（退出或清理）即出账。 */
export function createTerminalsService(
  deps: TerminalsHostDeps,
  shell: ShellSessionSpec = HOST_SHELL_SESSION_SPEC,
): TerminalsService {
  const sessions = new Map<string, TerminalSessionImpl>()
  return {
    tryOpen(events) {
      if (sessions.size >= TERMINAL_MAX_SESSIONS) return null
      const id = randomUUID()
      const session = new TerminalSessionImpl(id, deps, shell, events, (endedId) => {
        sessions.delete(endedId)
      })
      sessions.set(id, session)
      void session.start()
      return session
    },
    activeCount() {
      return sessions.size
    },
  }
}
