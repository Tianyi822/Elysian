import { TERMINAL_TAB_WIDTH, terminalCharWidth } from '@elysian/contracts'

/*
 * 终端字节流 → 行模型的纯汇编器（无 IO、无定时器）：流式 UTF-8 解码、按 \n 切行
 * 保留不完整行、每行按终端语义落成文本（见 renderTerminalLine：\r 回行首覆盖写、
 * \b 左移、\t 展开到制表位、CSI K/C/D/G 行内擦除与横移，其余 ANSI 转义与控制字符
 * 剥离）、\x01…\x02 哨兵提取（READY / PWD）。READY 哨兵（原始字节 \x01READY\x02，
 * 容器 exec 启动行产出的是带 pid 的 \x01READY:<pid>\x02，两种形态都接受）之前的
 * 一切输出（bash 初始提示符、启动行回显里的字面 \x01 文本）全部丢弃。单命令轮输出
 * 预算在发出 prompt 事件时重置，被丢字节数随 prompt 事件
 * 上报。无换行的积压设硬上限（等于单轮预算）：超限立即结扎丢弃并记账，预算的执行
 * 不依赖换行到达（防 cat /dev/zero 类无换行洪流打爆内存）；丢弃态只保留行终止与
 * PWD 哨兵两类边界信号。PWD 哨兵只在跟过真实输入（noteInput）后才被当作命令结束
 * 信号，命令输出伪造的字面哨兵字节被剥离丢弃。协议口径的唯一权威是方案的
 * 「端点契约」与「服务层设计」。
 */

/** 单命令轮输出预算：超出部分丢弃，字节累计进 prompt 事件的 droppedBytes。 */
export const TERMINAL_TURN_OUTPUT_BUDGET_BYTES = 256 * 1024

/**
 * 未成行积压（pending）的硬上限（字符数）：无换行洪流在此结扎丢弃。字符数 ≤ 对应
 * UTF-8 字节数，用预算字节数作上限不会误杀任何预算内的行。
 */
export const TERMINAL_PENDING_MAX_CHARS = TERMINAL_TURN_OUTPUT_BUDGET_BYTES

/** 汇编器事件：ready（READY 哨兵已见，pid 取自容器 exec 的 \x01READY:<pid>\x02）、
 * lines（完整输出行）、prompt（命令结束 + cwd）。 */
export type TerminalStreamEvent =
  | { readonly kind: 'ready'; readonly pid: string | null }
  | { readonly kind: 'lines'; readonly lines: readonly string[] }
  | { readonly kind: 'prompt'; readonly cwd: string; readonly droppedBytes: number }

/**
 * READY 哨兵的匹配形态：本机启动行的 \x01READY\x02 与容器 exec 启动行 printf 产出
 * 的 \x01READY:<pid>\x02（pid 是容器内 shell 进程号，断开清理的目标），二者都接受。
 */
const READY_SENTINEL_PATTERN = /\x01READY(?::([0-9]{1,10}))?\x02/

/**
 * READY 之前 pending 保留的尾部上界：哨兵最长形态是 \x01READY: + 10 位数字 + \x02
 * 共 18 字符，跨块分裂时任一真前缀都不超过 17 字符，保留 17 字符的尾部不漏识别。
 */
const READY_CARRY_CHARS = 17

/** PWD 哨兵：PROMPT_COMMAND 在每个提示符处流出的 \x01PWD:<cwd>\x02。 */
const PWD_SENTINEL = /\x01PWD:([^\x02]*)\x02/g

/** PWD 哨兵的起始前缀：超长行丢弃态下唯一保留识别的边界信号（命令结束信号）。 */
const PWD_SENTINEL_PREFIX = '\x01PWD:'

/**
 * 行内 token：OSC 转义（窗口标题等，以 BEL 或 ST 结束）、CSI 转义（参数列 + 中间列 +
 * 终结字节，捕获参数与终结字节）、其余单字符 ESC 序列（ESC M、ESC 7 一类），以及单个码点。
 */
const LINE_TOKEN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-?]*)[ -/]*([@-~])|\x1b[@-Z\\-_]|[\s\S]/gu

/** 无操作语义的控制字符（C0 与 DEL）：直接丢弃。\r、\b、\t 在落行时单独处理。 */
const DROPPED_CONTROL = /[\x00-\x07\x0a-\x1f\x7f]/

/** 行缓冲里宽字符次格的占位：首格放字符本身，拼接时次格不产出文本。 */
const WIDE_TAIL = ''

const utf8Encoder = new TextEncoder()

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length
}

/** 文本尾部与 \x01PWD: 前缀的最长重叠：跨块分裂的哨兵在丢弃态仍可被识别。 */
function pwdPrefixCarry(text: string): string {
  const max = Math.min(text.length, PWD_SENTINEL_PREFIX.length - 1)
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(PWD_SENTINEL_PREFIX.slice(0, len))) return text.slice(text.length - len)
  }
  return ''
}

/** 覆盖宽字符的任一半格时另一半一并清成空格：与终端一致，不留半个字。 */
function clearCell(cells: string[], index: number): void {
  if (index >= cells.length) return
  if (cells[index] === WIDE_TAIL && index > 0) cells[index - 1] = ' '
  if (cells[index + 1] === WIDE_TAIL) cells[index + 1] = ' '
  cells[index] = ' '
}

function csiCount(params: string): number {
  const count = Number.parseInt(params, 10)
  return Number.isNaN(count) || count < 1 ? 1 : count
}

/**
 * 按终端语义把一行（已解码、已提取哨兵）落成文本：光标在行缓冲里移动，\r 回行首后
 * 覆盖写（进度条只留最终一帧），\b 左移一格（man 页的叠印加粗与下划线还原成单字），
 * \t 跳到下一个制表位并以空格补位，CSI K 擦除行内、CSI C/D/G 横移光标；宽字符占两格。
 * 其余转义（颜色、光标上下移、清屏）与控制字符丢弃。
 */
export function renderTerminalLine(raw: string): string {
  const cells: string[] = []
  let col = 0
  for (const match of raw.matchAll(LINE_TOKEN)) {
    const token = match[0]
    const final = match[2]
    if (final !== undefined) {
      const params = match[1] ?? ''
      if (final === 'K') {
        const mode = params === '' ? 0 : Number(params)
        if (mode === 0) {
          if (cells[col] === WIDE_TAIL && col > 0) cells[col - 1] = ' '
          if (col < cells.length) cells.length = col
        } else if (mode === 1) {
          for (let index = 0; index <= col; index += 1) clearCell(cells, index)
        } else if (mode === 2) {
          cells.length = 0
        }
      } else if (final === 'C') {
        col += csiCount(params)
      } else if (final === 'D') {
        col = Math.max(0, col - csiCount(params))
      } else if (final === 'G') {
        col = csiCount(params) - 1
      }
      continue
    }
    if (token.startsWith('\x1b') && token.length > 1) continue
    if (token === '\r') {
      col = 0
      continue
    }
    if (token === '\b') {
      col = Math.max(0, col - 1)
      continue
    }
    if (token === '\t') {
      col = (Math.floor(col / TERMINAL_TAB_WIDTH) + 1) * TERMINAL_TAB_WIDTH
      continue
    }
    if (DROPPED_CONTROL.test(token)) continue

    const width = terminalCharWidth(token)
    if (width === 0) {
      let target = col - 1
      if (cells[target] === WIDE_TAIL) target -= 1
      if (target >= 0 && target < cells.length) cells[target] += token
      continue
    }
    while (cells.length < col) cells.push(' ')
    for (let index = col; index < col + width; index += 1) clearCell(cells, index)
    cells[col] = token
    if (width === 2) cells[col + 1] = WIDE_TAIL
    col += width
  }
  return cells.join('')
}

export class TerminalStreamAssembler {
  private readonly decoder = new TextDecoder()
  private pending = ''
  private seenReady = false
  private skipToNewline = false
  private turnBytes = 0
  private turnDroppedBytes = 0
  private events: readonly TerminalStreamEvent[] = []
  /** 超长行丢弃态：pending 已清空，增量在 consumeDropped 里丢弃记账。 */
  private dropping = false
  /** 丢弃态下跨块哨兵前缀的碎片缓存。 */
  private dropCarry = ''
  /** 下一个 PWD 哨兵是否被接受：READY（启动行）与 noteInput（真实输入）武装。 */
  private promptArmed = false

  /** READY 哨兵是否已出现（服务端据此判定驯化 bash 已就绪）。 */
  get isReady(): boolean {
    return this.seenReady
  }

  /** 当前命令轮累计被丢字节数（prompt 事件发出时清零；流结束时供退出路径读取）。 */
  get droppedBytes(): number {
    return this.turnDroppedBytes
  }

  /**
   * 客户端向 PTY 写入了新输入（input/interrupt 帧）：解锁下一个 PWD 哨兵。命令
   * 输出可伪造字面哨兵字节（printf '\001PWD:…\002'），只有跟在真实输入之后的
   * 哨兵才被当作命令结束信号——伪造哨兵洪流不再逐个重置输出预算与触发 prompt。
   */
  noteInput(): void {
    this.promptArmed = true
  }

  /** 喂入一段 PTY 输出字节，返回这段字节产出的全部事件（次序即流内次序）。 */
  push(chunk: Uint8Array): readonly TerminalStreamEvent[] {
    this.events = []
    let text = this.decoder.decode(chunk, { stream: true })
    if (this.dropping) {
      text = this.consumeDropped(this.dropCarry + text)
      this.dropCarry = ''
      if (text === '') return this.events
    }
    this.pending += text
    this.drain()
    return this.events
  }

  /** 流结束：冲刷解码器残尾，未换行的末行按完整行处理。 */
  finish(): readonly TerminalStreamEvent[] {
    this.events = []
    this.pending += this.decoder.decode()
    if (!this.seenReady) {
      // 流结束仍未见到 READY 哨兵：启动失败或进程秒退，一切输出作废。
      this.pending = ''
      return this.events
    }
    if (this.dropping) {
      // 丢弃态未恢复的残尾（含哨兵前缀碎片）一并作废：丢弃已在发生时记账。
      this.pending = ''
      this.dropCarry = ''
      return this.events
    }
    if (this.pending !== '') {
      const rest = this.pending
      this.pending = ''
      this.handleLine(rest)
    }
    return this.events
  }

  private drain(): void {
    if (!this.seenReady) {
      const match = this.pending.match(READY_SENTINEL_PATTERN)
      if (match === null || match.index === undefined) {
        // READY 之前的一切字节丢弃；只保留可能是跨块哨兵前缀的尾部。
        const carry = Math.min(this.pending.length, READY_CARRY_CHARS)
        this.pending = carry > 0 ? this.pending.slice(-carry) : ''
        return
      }
      this.pending = this.pending.slice(match.index + match[0].length)
      this.seenReady = true
      this.promptArmed = true // 启动行是服务端写入的第一次输入：其后的首提示符哨兵有效。
      this.skipToNewline = true
      this.events = [...this.events, { kind: 'ready', pid: match[1] ?? null }]
    }
    if (this.skipToNewline) {
      // READY 哨兵自带行终止符（printf '\n'）：连同其后的行尾一并消费，不产空行。
      const nl = this.pending.indexOf('\n')
      if (nl === -1) {
        this.pending = ''
        return
      }
      this.pending = this.pending.slice(nl + 1)
      this.skipToNewline = false
    }
    for (;;) {
      const nl = this.pending.indexOf('\n')
      if (nl === -1) {
        // 无换行的积压设硬上限：超限立即结扎这行、丢弃记账并进入丢弃态——预算的
        // 执行不依赖换行到达，无换行洪流（cat /dev/zero 类）的内存有界。
        if (this.pending.length > TERMINAL_PENDING_MAX_CHARS) {
          this.turnDroppedBytes += utf8ByteLength(this.pending)
          this.pending = ''
          this.dropping = true
        }
        return
      }
      const rawLine = this.pending.slice(0, nl)
      this.pending = this.pending.slice(nl + 1)
      this.handleLine(rawLine)
    }
  }

  /**
   * 超长行丢弃态：丢弃一切内容字节并记账，只保留两类边界信号——行终止 \n 与 PWD
   * 哨兵（命令结束信号不能因截断而丢失，否则客户端永远等不到 prompt 帧）。返回
   * 恢复正常处理的剩余文本；空串表示整段丢弃（哨兵前缀碎片存入 dropCarry）。
   */
  private consumeDropped(text: string): string {
    const nl = text.indexOf('\n')
    const sentinel = text.indexOf(PWD_SENTINEL_PREFIX)
    if (sentinel !== -1 && (nl === -1 || sentinel < nl)) {
      this.turnDroppedBytes += utf8ByteLength(text.slice(0, sentinel))
      this.dropping = false
      return text.slice(sentinel)
    }
    if (nl !== -1) {
      this.turnDroppedBytes += utf8ByteLength(text.slice(0, nl))
      this.dropping = false
      return text.slice(nl + 1)
    }
    const carry = pwdPrefixCarry(text)
    this.turnDroppedBytes += utf8ByteLength(text.slice(0, text.length - carry.length))
    this.dropCarry = carry
    return ''
  }

  private handleLine(rawLine: string): void {
    // 先提取 PWD 哨兵（\x01/\x02 属控制字符，必须在控制字符过滤之前）。
    const cwds: string[] = []
    let rest = ''
    let last = 0
    for (const match of rawLine.matchAll(PWD_SENTINEL)) {
      rest += rawLine.slice(last, match.index)
      last = match.index + match[0].length
      cwds.push(match[1] ?? '')
    }
    rest += rawLine.slice(last)

    const cleaned = renderTerminalLine(rest)
    // 哨兵行清空后是控制元数据，不再产出空输出行；无哨兵的空行是真实空行，保留。
    if (!(cleaned === '' && cwds.length > 0)) {
      const bytes = utf8ByteLength(cleaned)
      if (this.turnBytes + bytes > TERMINAL_TURN_OUTPUT_BUDGET_BYTES) {
        this.turnDroppedBytes += bytes
      } else {
        this.turnBytes += bytes
        this.events = [...this.events, { kind: 'lines', lines: [cleaned] }]
      }
    }
    for (const cwd of cwds) {
      // 无输入即得的哨兵是伪造或重复（命令输出可产字面哨兵字节）：剥离丢弃，
      // 不产 prompt 事件、不重置预算。
      if (!this.promptArmed) continue
      this.promptArmed = false
      const droppedBytes = this.turnDroppedBytes
      this.turnBytes = 0
      this.turnDroppedBytes = 0
      this.events = [...this.events, { kind: 'prompt', cwd, droppedBytes }]
    }
  }
}
