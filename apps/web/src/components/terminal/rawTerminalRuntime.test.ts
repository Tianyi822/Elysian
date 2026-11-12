import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deactivateRawTerminal, disposeAllRawTerminals, disposeRawTerminal, rawTerminalRuntime } from './rawTerminalRuntime'

const library = vi.hoisted(() => {
  let constructionError: string | undefined
  const failed: string[] = []
  class FakeTerminal {
    options: Record<string, unknown>
    cols = 100
    rows = 30
    textarea = document.createElement('textarea')
    writes: Array<{ data: Uint8Array; consumed: () => void }> = []
    onDataCallback?: (data: string) => void
    onBinaryCallback?: (data: string) => void
    onResizeCallback?: (size: { cols: number; rows: number }) => void
    open = vi.fn((element: HTMLElement) => element.append(this.textarea))
    focus = vi.fn()
    dispose = vi.fn()
    getSelection = vi.fn(() => '')
    constructor(options: Record<string, unknown>) {
      this.options = options
      if (constructionError) {
        const message = constructionError
        constructionError = undefined
        failed.push(message)
        throw new Error(message)
      }
      terminals.push(this)
    }
    loadAddon(addon: FakeFit) { addon.terminal = this }
    onData(callback: (data: string) => void) { this.onDataCallback = callback }
    onBinary(callback: (data: string) => void) { this.onBinaryCallback = callback }
    onResize(callback: (size: { cols: number; rows: number }) => void) { this.onResizeCallback = callback }
    attachCustomKeyEventHandler() {}
    write(data: Uint8Array, consumed: () => void) { this.writes.push({ data, consumed }) }
  }
  class FakeFit {
    terminal?: FakeTerminal
    fit() {
      if (!this.terminal) return
      this.terminal.cols = 120
      this.terminal.rows = 40
      this.terminal.onResizeCallback?.({ cols: 120, rows: 40 })
    }
  }
  const terminals: FakeTerminal[] = []
  return { FakeTerminal, FakeFit, terminals, failed, failNextConstruction: (message: string) => { constructionError = message } }
})
vi.mock('@xterm/xterm', () => ({ Terminal: library.FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: library.FakeFit }))

function transport() {
  return { send: vi.fn(async (_data: Uint8Array) => {}), resize: vi.fn(async (_cols: number, _rows: number) => {}), acknowledge: vi.fn(), onError: vi.fn() }
}
function host() {
  const element = document.createElement('div')
  Object.defineProperties(element, { clientWidth: { value: 960 }, clientHeight: { value: 600 } })
  document.body.append(element)
  return element
}
async function terminal() { await waitFor(() => expect(library.terminals).toHaveLength(1)); return library.terminals[0]! }
beforeEach(() => { disposeAllRawTerminals(); library.terminals.length = 0; library.failed.length = 0 })
afterEach(() => { disposeAllRawTerminals(); document.documentElement.style.removeProperty('--t-fg') })

describe('xterm 原始终端运行实例', () => {
  it('输出按原字节排队，等 xterm 实际消费后才确认；销毁后不确认迟到消费', async () => {
    const runtime = rawTerminalRuntime('host:one')
    const channel = transport()
    const bytes = Uint8Array.of(0, 27, 91, 50, 74, 255)
    runtime.write(bytes)
    runtime.configure(channel)
    const instance = await terminal()
    expect(instance.writes[0]?.data).toBe(bytes)
    expect(channel.acknowledge).not.toHaveBeenCalled()
    instance.writes[0]!.consumed()
    expect(channel.acknowledge).toHaveBeenCalledExactlyOnceWith(bytes.length)
    runtime.write(Uint8Array.of(7))
    disposeRawTerminal('host:one')
    instance.writes[1]!.consumed()
    expect(channel.acknowledge).toHaveBeenCalledTimes(1)
    expect(instance.dispose).toHaveBeenCalledOnce()
  })

  it('离开页面只 detach，重新挂载保留同一缓冲区并同步尺寸、字号与输入标签', async () => {
    const runtime = rawTerminalRuntime('host:one')
    const channel = transport()
    runtime.configure(channel)
    const first = host()
    const detach = runtime.attach(first, 12, '主机命令输入')
    const instance = await terminal()
    await waitFor(() => expect(instance.open).toHaveBeenCalledOnce())
    runtime.write(Uint8Array.of(27, 91, 72))
    expect(channel.resize).toHaveBeenCalledExactlyOnceWith(120, 40)
    detach()
    expect(first).toBeEmptyDOMElement()
    expect(instance.dispose).not.toHaveBeenCalled()
    const second = host()
    document.documentElement.style.setProperty('--t-fg', '#112233')
    runtime.attach(second, 16, '容器命令输入')
    expect(rawTerminalRuntime('host:one')).toBe(runtime)
    expect(instance.open).toHaveBeenCalledOnce()
    expect(instance.writes).toHaveLength(1)
    expect(instance.options.fontSize).toBe(16)
    expect(instance.options.theme).toMatchObject({ foreground: '#112233' })
    expect(instance.textarea).toHaveAttribute('aria-label', '容器命令输入')
    expect(second).toContainElement(instance.textarea)
    expect(channel.resize).toHaveBeenCalledTimes(1)
  })

  it('输入由库生成 UTF-8 和二进制字节，断开后屏蔽输入', async () => {
    const runtime = rawTerminalRuntime('container:one')
    const channel = transport()
    runtime.configure(channel)
    const instance = await terminal()
    instance.onDataCallback!('中文\r\x03')
    instance.onBinaryCallback!('\x00\x80\xff')
    expect([...channel.send.mock.calls[0]![0]]).toEqual([...new TextEncoder().encode('中文\r\x03')])
    expect([...channel.send.mock.calls[1]![0]]).toEqual([0, 128, 255])
    deactivateRawTerminal('container:one')
    instance.onDataCallback!('ignored')
    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(instance.options.disableStdin).toBe(true)
  })

  it('关闭不存在的演示会话不创建终端，初始化输出队列有上限', async () => {
    deactivateRawTerminal('mock:one')
    expect(library.terminals).toHaveLength(0)
    const runtime = rawTerminalRuntime('host:one')
    const channel = transport()
    runtime.configure(channel)
    runtime.write(new Uint8Array(1024 * 1024 + 1))
    expect(channel.onError).toHaveBeenCalledWith('终端输出缓冲区已满，请重新连接')
    const instance = await terminal()
    expect(instance.writes).toHaveLength(0)
  })

  it('库初始化失败早于连接绑定时，仍向稍后绑定的 transport 报错', async () => {
    library.failNextConstruction('终端组件初始化失败')
    const runtime = rawTerminalRuntime('host:error')
    await waitFor(() => expect(library.failed).toEqual(['终端组件初始化失败']))
    const channel = transport()
    runtime.configure(channel)
    expect(channel.onError).toHaveBeenCalledExactlyOnceWith('终端组件初始化失败')
    expect(channel.send).not.toHaveBeenCalled()
    expect(channel.resize).not.toHaveBeenCalled()
  })
})
