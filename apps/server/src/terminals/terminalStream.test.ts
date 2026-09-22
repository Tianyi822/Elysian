import { describe, expect, it } from 'vitest'
import {
  TERMINAL_PENDING_MAX_CHARS,
  TERMINAL_TURN_OUTPUT_BUDGET_BYTES,
  TerminalStreamAssembler,
} from './terminalStream.ts'

/*
 * 行模型汇编器的行为锚定：\r\n 与 lone \r、ANSI（CSI/OSC/单字符 ESC）剥离、UTF-8
 * 分块边界（多字节字符跨 chunk）、PWD 哨兵提取与流中移除、READY 前丢弃、单轮预算
 * 触顶与丢弃计数、控制字符剥离（\t 保留）、无换行积压硬上限（丢弃态与边界信号）、
 * 哨兵的输入门控（伪造哨兵剥离）。
 */

const READY = '\x01READY\x02'

function eventsOf(...chunks: readonly string[]): ReturnType<TerminalStreamAssembler['push']> {
  const assembler = new TerminalStreamAssembler()
  let events: ReturnType<TerminalStreamAssembler['push']> = []
  for (const chunk of chunks) {
    events = [...events, ...assembler.push(new TextEncoder().encode(chunk))]
  }
  return events
}

describe('TerminalStreamAssembler', () => {
  it('READY 之前的字节全部丢弃，READY 之后才产出事件', () => {
    const events = eventsOf(`bash-5.2# 噪音\r\n${READY}\r\n`, 'hello\r\n')
    expect(events[0]).toEqual({ kind: 'ready' })
    expect(events.slice(1)).toEqual([{ kind: 'lines', lines: ['hello'] }])
  })

  it('READY 哨兵跨 chunk 分裂时仍能识别（尾部前缀保留）', () => {
    const events = eventsOf('noise\x01RE', 'ADY\x02\r\nout\r\n')
    expect(events).toEqual([{ kind: 'ready' }, { kind: 'lines', lines: ['out'] }])
  })

  it('启动行回显里的字面 \\x01 文本不冒充 READY 哨兵', () => {
    const events = eventsOf("printf '\\x01READY\\x02\\n'\r\n", `${READY}\r\nreal\r\n`)
    expect(events[0]).toEqual({ kind: 'ready' })
    expect(events).toContainEqual({ kind: 'lines', lines: ['real'] })
  })

  it('\\r\\n 切行剥行尾 \\r；lone \\r 行内去除', () => {
    const events = eventsOf(`${READY}\r\na\r\n`, 'pro\x07gress\x08\r\n')
    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'lines', lines: ['a'] },
      { kind: 'lines', lines: ['progress'] },
    ])
  })

  it('不带 \\n 的进度重绘合并为去掉 \\r 的长行', () => {
    const events = eventsOf(`${READY}\r\n10%\r`, '99%\r\n')
    expect(events).toEqual([{ kind: 'ready' }, { kind: 'lines', lines: ['10%99%'] }])
  })

  it('CSI 与 OSC 转义序列剥离', () => {
    const events = eventsOf(`${READY}\r\n`, '\x1b[31mred\x1b[0m\r\n', '\x1b]0;title\x07after-osc\r\n', '\x1b[2Kcleared\r\n')
    expect(events.slice(1)).toEqual([
      { kind: 'lines', lines: ['red'] },
      { kind: 'lines', lines: ['after-osc'] },
      { kind: 'lines', lines: ['cleared'] },
    ])
  })

  it('单字符 ESC 序列剥离', () => {
    const events = eventsOf(`${READY}\r\n\x1bMline\r\n`)
    expect(events.slice(1)).toEqual([{ kind: 'lines', lines: ['line'] }])
  })

  it('控制字符剥离但 \\t 保留（对齐语义）', () => {
    const events = eventsOf(`${READY}\r\na\tb\x00c\x7f\r\n`)
    expect(events.slice(1)).toEqual([{ kind: 'lines', lines: ['a\tbc'] }])
  })

  it('多字节 UTF-8 字符跨 chunk 边界不撕裂', () => {
    const bytes = new TextEncoder().encode(`${READY}\r\n中文`)
    const assembler = new TerminalStreamAssembler()
    const first = assembler.push(bytes.slice(0, bytes.length - 2))
    expect(first).toEqual([{ kind: 'ready' }])
    const second = [...assembler.push(bytes.slice(bytes.length - 2)), ...assembler.finish()]
    expect(second).toEqual([{ kind: 'lines', lines: ['中文'] }])
  })

  it('PWD 哨兵提取为 prompt 事件并从流中移除；输出行先于 prompt 事件', () => {
    const events = eventsOf(`${READY}\r\nresult\r\n\x01PWD:/tmp\x02\r\n`)
    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'lines', lines: ['result'] },
      { kind: 'prompt', cwd: '/tmp', droppedBytes: 0 },
    ])
  })

  it('哨兵与输出同行时哨兵剥离、其余文本保留为输出行', () => {
    const events = eventsOf(`${READY}\r\nout\x01PWD:/var\x02tail\r\n`)
    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'lines', lines: ['outtail'] },
      { kind: 'prompt', cwd: '/var', droppedBytes: 0 },
    ])
  })

  it('纯哨兵行不产空输出行，真实空行保留', () => {
    const events = eventsOf(`${READY}\r\n\x01PWD:/root\x02\r\n\r\n`)
    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'prompt', cwd: '/root', droppedBytes: 0 },
      { kind: 'lines', lines: [''] },
    ])
  })

  it('单轮预算触顶：超出部分丢弃并计数，prompt 处重置', () => {
    const assembler = new TerminalStreamAssembler()
    assembler.push(new TextEncoder().encode(`${READY}\r\n`))
    const bigLine = 'x'.repeat(TERMINAL_TURN_OUTPUT_BUDGET_BYTES - 10)
    const over = 'y'.repeat(5000)
    let events = assembler.push(new TextEncoder().encode(`${bigLine}\r\n${over}\r\n`))
    events = [...events, ...assembler.push(new TextEncoder().encode('\x01PWD:/root\x02\r\nok\r\n'))]
    expect(events).toEqual([
      { kind: 'lines', lines: [bigLine] },
      { kind: 'prompt', cwd: '/root', droppedBytes: 5000 },
      { kind: 'lines', lines: ['ok'] },
    ])
    expect(assembler.droppedBytes).toBe(0)
  })

  it('finish 冲刷未换行的末行；READY 未出现时一切作废', () => {
    const assembler = new TerminalStreamAssembler()
    assembler.push(new TextEncoder().encode(`${READY}\r\npartial`))
    expect(assembler.finish()).toEqual([{ kind: 'lines', lines: ['partial'] }])

    const dead = new TerminalStreamAssembler()
    dead.push(new TextEncoder().encode('died before ready'))
    expect(dead.finish()).toEqual([])
    expect(dead.isReady).toBe(false)
  })

  it('无换行洪流：pending 超硬上限即结扎丢弃并实时记账，不依赖换行与 finish', () => {
    const assembler = new TerminalStreamAssembler()
    assembler.push(new TextEncoder().encode(`${READY}\r\n`))
    // 64 KiB 一块的无换行字节：前四块（恰等于预算）不触发，第五块起结扎丢弃。
    const chunk = 'x'.repeat(65536)
    for (let i = 0; i < 4; i += 1) {
      expect(assembler.push(new TextEncoder().encode(chunk))).toEqual([])
      expect(assembler.droppedBytes).toBe(0)
    }
    const events = assembler.push(new TextEncoder().encode(chunk))
    expect(events).toEqual([])
    expect(assembler.droppedBytes).toBe(5 * 65536)
    // 丢弃态继续吞增量并记账：内存不随洪流体积增长。
    expect(assembler.push(new TextEncoder().encode(chunk))).toEqual([])
    expect(assembler.droppedBytes).toBe(6 * 65536)
    expect(assembler.finish()).toEqual([])
  })

  it('丢弃态的行终止：换行前的残余丢弃记账，其后各行恢复正常产出', () => {
    const assembler = new TerminalStreamAssembler()
    assembler.push(new TextEncoder().encode(`${READY}\r\n`))
    assembler.push(new TextEncoder().encode('x'.repeat(TERMINAL_PENDING_MAX_CHARS + 1)))
    const events = assembler.push(new TextEncoder().encode('tail-before-nl\nafter\n'))
    expect(events).toEqual([{ kind: 'lines', lines: ['after'] }])
    expect(assembler.droppedBytes).toBe(TERMINAL_PENDING_MAX_CHARS + 1 + 'tail-before-nl'.length)
  })

  it('丢弃态保留哨兵：命令结束信号不被截断吞掉，丢弃量计入 prompt 的 droppedBytes', () => {
    const assembler = new TerminalStreamAssembler()
    assembler.push(new TextEncoder().encode(`${READY}\r\n`))
    assembler.push(new TextEncoder().encode('x'.repeat(300000)))
    const events = assembler.push(new TextEncoder().encode('\x01PWD:/tmp\x02\nok\n'))
    expect(events).toEqual([
      { kind: 'prompt', cwd: '/tmp', droppedBytes: 300000 },
      { kind: 'lines', lines: ['ok'] },
    ])
    expect(assembler.droppedBytes).toBe(0)
  })

  it('伪造哨兵：无输入跟进的连续哨兵只认首个，noteInput 后恢复有效', () => {
    const assembler = new TerminalStreamAssembler()
    // 初始哨兵（bash 首提示符，跟在启动行这次输入之后）有效；其后无输入的哨兵
    // 是命令输出伪造的字面字节：剥离、不产事件、不重置预算。
    const events = assembler.push(
      new TextEncoder().encode(`${READY}\r\n\x01PWD:/a\x02\nout\n\x01PWD:/b\x02\n\x01PWD:/c\x02\n`),
    )
    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'prompt', cwd: '/a', droppedBytes: 0 },
      { kind: 'lines', lines: ['out'] },
    ])
    assembler.noteInput()
    expect(assembler.push(new TextEncoder().encode('\x01PWD:/d\x02\n'))).toEqual([
      { kind: 'prompt', cwd: '/d', droppedBytes: 0 },
    ])
  })
})
