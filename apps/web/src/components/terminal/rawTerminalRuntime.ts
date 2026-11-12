import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { observeElementSize } from '../../utils/observeElementSize'
import { writeClipboardText } from '../../utils/clipboardText'
import { useMessageStore } from '../../stores/messageStore'
import { TERMINAL_FONT_SIZE_DEFAULT } from './terminalFontSize'
import './rawTerminal.css'

type Transport = {
  send(data: Uint8Array): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  acknowledge(bytes: number): void
  onError(message: string): void
}

let library: Promise<[typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')]> | undefined
function loadLibrary() {
  library ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]).then(([terminal, fit]) => [terminal, fit])
  return library
}

/** 一条会话只持有一份 xterm 缓冲区；离开页面仅移走 DOM，不回放无限日志。 */
class RawTerminalRuntime {
  private terminal?: Terminal
  private fit?: FitAddon
  private element = document.createElement('div')
  private mounted?: HTMLElement
  private transport?: Transport
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private disposed = false
  private interactive = true
  private opened = false
  private detachObservers?: () => void
  private fontSize = TERMINAL_FONT_SIZE_DEFAULT
  private label = '命令输入'
  private lastSize?: string
  private initializationError?: string
  private ready: Promise<void>

  constructor() {
    this.element.className = 'elysian-raw-terminal h-full min-h-0 w-full'
    this.ready = loadLibrary().then(([{ Terminal: Xterm }, { FitAddon: Fit }]) => {
      if (this.disposed) return
      const terminal = this.terminal = new Xterm({
        cols: 100, rows: 30, scrollback: 5000, cursorBlink: true, convertEol: false,
        allowTransparency: true, fontSize: this.fontSize,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        disableStdin: !this.interactive,
      })
      this.fit = new Fit()
      terminal.loadAddon(this.fit)
      terminal.onData(data => this.send(new TextEncoder().encode(data)))
      terminal.onBinary(data => this.send(Uint8Array.from(data, character => character.charCodeAt(0) & 255)))
      terminal.onResize(({ cols, rows }) => this.sendSize(cols, rows))
      terminal.attachCustomKeyEventHandler(event => {
        if (event.type === 'keydown' && event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'c') {
          event.preventDefault()
          this.copySelection()
          return false
        }
        return true
      })
      this.applyTheme()
      this.openIfMounted()
      this.flush()
    }).catch(error => {
      this.initializationError = error instanceof Error ? error.message : '终端组件加载失败'
      this.fail(error)
    })
  }

  configure(transport: Transport) {
    if (this.disposed) return
    this.transport = transport
    if (this.initializationError) { this.fail(new Error(this.initializationError)); return }
    this.lastSize = undefined
    this.resize()
    this.flush()
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : '终端组件加载失败'
    this.transport?.onError(message)
  }
  private send(data: Uint8Array) {
    if (!this.interactive || this.disposed) return
    void this.transport?.send(data).catch(error => this.fail(error))
  }
  write(data: Uint8Array) {
    if (this.disposed) return
    if (this.pendingBytes + data.byteLength > 1024 * 1024) {
      this.fail(new Error('终端输出缓冲区已满，请重新连接'))
      return
    }
    this.pending.push(data)
    this.pendingBytes += data.byteLength
    this.flush()
  }
  private flush() {
    if (!this.terminal || !this.transport || this.disposed) return
    for (const data of this.pending.splice(0)) {
      this.pendingBytes -= data.byteLength
      this.terminal.write(data, () => {
        if (this.disposed) return
        try { this.transport?.acknowledge(data.byteLength) } catch (error) { this.fail(error) }
      })
    }
  }
  setInteractive(interactive: boolean) {
    this.interactive = interactive
    if (this.terminal) this.terminal.options.disableStdin = !interactive
  }
  private applyTheme() {
    if (!this.terminal) return
    const styles = getComputedStyle(document.documentElement)
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
    const foreground = color('--t-fg', '#eaecf5')
    const selection = color('--t-line', '#39485f')
    this.terminal.options.theme = {
      background: '#00000000', foreground,
      cursor: foreground, cursorAccent: color('--t-bg', '#111827'),
      selectionBackground: selection, selectionForeground: foreground, selectionInactiveBackground: selection,
    }
  }
  private resize() {
    if (!this.mounted || this.mounted.clientWidth <= 0 || this.mounted.clientHeight <= 0 || !this.opened) return
    this.fit?.fit()
    // 初次尺寸碰巧等于默认值时仍同步给服务端。
    if (this.terminal) this.sendSize(this.terminal.cols, this.terminal.rows)
  }
  private sendSize(cols: number, rows: number) {
    const size = `${cols}:${rows}`
    if (!this.transport || this.disposed || this.lastSize === size) return
    this.lastSize = size
    void this.transport.resize(cols, rows).catch(error => this.fail(error))
  }
  private openIfMounted() {
    if (!this.mounted || !this.terminal) return
    if (!this.opened) { this.terminal.open(this.element); this.opened = true }
    this.terminal.textarea?.setAttribute('aria-label', this.label)
    this.resize()
    if (this.interactive) this.terminal.focus()
  }
  attach(host: HTMLElement, fontSize: number, label: string): () => void {
    if (this.disposed) return () => {}
    this.detachObservers?.()
    this.mounted = host
    this.fontSize = fontSize
    this.label = label
    host.append(this.element)
    if (this.terminal) this.terminal.options.fontSize = fontSize
    this.applyTheme()
    this.openIfMounted()
    const disconnectSize = observeElementSize([host], () => this.resize())
    const themeObserver = new MutationObserver(() => this.applyTheme())
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const copy = () => this.copySelection()
    host.addEventListener('mouseup', copy)
    const detach = () => { disconnectSize(); themeObserver.disconnect(); host.removeEventListener('mouseup', copy) }
    this.detachObservers = detach
    void this.ready.then(() => { if (this.mounted === host) this.openIfMounted() }).catch(error => this.fail(error))
    return () => {
      if (this.mounted !== host) return
      detach()
      this.detachObservers = undefined
      this.mounted = undefined
      this.element.remove()
    }
  }
  copySelection() {
    const text = this.terminal?.getSelection()
    if (!text) return
    void writeClipboardText(text).then(
      () => useMessageStore.getState().notify({ tone: 'success', message: '已复制终端选中文本' }),
      () => useMessageStore.getState().notify({ tone: 'danger', message: '复制终端选中文本失败，请手动复制或检查浏览器剪贴板权限。' }),
    )
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.detachObservers?.()
    this.terminal?.dispose()
    this.element.remove()
    this.pending = []
    this.pendingBytes = 0
    this.mounted = undefined
    this.transport = undefined
  }
}

const runtimes = new Map<string, RawTerminalRuntime>()
export function rawTerminalRuntime(key: string): RawTerminalRuntime {
  let runtime = runtimes.get(key)
  if (!runtime) { runtime = new RawTerminalRuntime(); runtimes.set(key, runtime) }
  return runtime
}
export function disposeRawTerminal(key: string) { runtimes.get(key)?.dispose(); runtimes.delete(key) }
export function deactivateRawTerminal(key: string) { runtimes.get(key)?.setInteractive(false) }
export function disposeAllRawTerminals() { for (const runtime of runtimes.values()) runtime.dispose(); runtimes.clear() }
