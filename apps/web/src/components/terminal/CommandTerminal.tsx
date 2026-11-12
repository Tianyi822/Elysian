import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { loadCommandTerminalLibrary, type CommandTerminalInstance } from './commandTerminalLibrary'
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_WHEEL_STEP } from './terminalFontSize'
import { writeClipboardText } from '../../utils/clipboardText'
import { useMessageStore } from '../../stores/messageStore'
import './commandTerminal.css'

export type CommandTerminalResult = { lines: readonly string[]; clear?: boolean; prompt?: string }
export type CommandTerminalProps = {
  sessionKey: string
  prompt: string
  execute: (command: string) => Promise<readonly string[] | CommandTerminalResult>
  completions?: readonly string[] | ((input: string) => readonly string[])
  onInterrupt?: () => void | Promise<void>
  interactive?: boolean
  fontSize?: number
  onFontZoom?: (deltaPx: number) => void
  inputLabel?: string
  className?: string
}

/** Database values are text, never VT sequences or jQuery Terminal extended commands. */
export function commandTerminalText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

const echoOptions = { raw: false, formatters: false, exec: false, invokeMethods: false, ansi: false } as const

export function CommandTerminal(props: CommandTerminalProps) {
  const { sessionKey, fontSize = TERMINAL_FONT_SIZE_DEFAULT, inputLabel = '命令输入', className = '' } = props
  const current = useRef(props)
  current.current = props
  const root = useRef<HTMLDivElement>(null)
  const terminal = useRef<CommandTerminalInstance | undefined>(undefined)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const node = root.current
    if (!node) return
    let alive = true
    let composing = false
    let candidateConfirmed = false
    let compositionTimer: ReturnType<typeof setTimeout> | undefined
    let operation: AbortController | undefined
    let busy = false
    let instance: CommandTerminalInstance | undefined
    let observer: ResizeObserver | undefined
    setError(undefined)

    const onCompositionStart = () => { composing = true }
    const onCompositionEnd = () => {
      composing = false
      candidateConfirmed = true
      compositionTimer = setTimeout(() => { candidateConfirmed = false }, 0)
    }
    const onKeyCapture = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (composing || candidateConfirmed || event.isComposing || event.keyCode === 229)) {
        // Keep the native IME default action; only prevent the REPL from submitting it.
        event.stopImmediatePropagation()
      }
    }
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !current.current.onFontZoom) return
      event.preventDefault()
      current.current.onFontZoom((event.deltaY < 0 ? 1 : -1) * TERMINAL_FONT_SIZE_WHEEL_STEP)
    }
    const copySelection = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return
      const value = selection.toString()
      if (!value) return
      void writeClipboardText(value).catch(() => useMessageStore.getState().notify({ tone: 'danger', message: '复制终端选中文本失败，请手动复制或检查浏览器剪贴板权限。' }))
    }
    node.addEventListener('compositionstart', onCompositionStart, true)
    node.addEventListener('compositionend', onCompositionEnd, true)
    node.addEventListener('keydown', onKeyCapture, true)
    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('mouseup', copySelection)

    void loadCommandTerminalLibrary().then(($) => {
      if (!alive) return
      const safe = (text: string) => $.terminal.escape_brackets(commandTerminalText(text))
      const echo = (text: string) => { instance?.echo(safe(text), echoOptions) }
      instance = $(node).terminal(async (command: string) => {
        if (busy || current.current.interactive === false || !alive) return
        busy = true
        const controller = new AbortController()
        operation = controller
        try {
          const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('执行已中断', 'AbortError')), { once: true }))
          const result = await Promise.race([current.current.execute(command), aborted])
          if (!alive || controller.signal.aborted) return
          if (Array.isArray(result)) {
            for (const line of result) echo(line)
          } else {
            const response = result as CommandTerminalResult
            if (response.clear) instance?.clear()
            for (const line of response.lines) echo(line)
            if (response.prompt !== undefined) instance?.set_prompt(safe(response.prompt))
          }
        } catch (failure) {
          if (alive && !controller.signal.aborted && !(failure instanceof Error && failure.name === 'AbortError')) {
            echo(`错误：${failure instanceof Error ? failure.message : '执行失败'}`)
          }
        } finally {
          if (operation === controller) { operation = undefined; busy = false }
        }
      }, {
        memory: true,
        name: sessionKey,
        historySize: 100,
        greetings: null,
        prompt: safe(current.current.prompt),
        enabled: current.current.interactive !== false,
        completion: (input, callback) => {
          const source = current.current.completions
          callback([...(typeof source === 'function' ? source(input) : source ?? [])])
        },
        wordAutocomplete: false,
        completionEscape: false,
        outputLimit: 10000,
        invokeMethods: false,
        execHash: false,
        historyState: false,
        exit: false,
        clear: false,
        convertLinks: false,
        raw: false,
        pauseEvents: false,
        keydown: (event) => {
          const native = event.originalEvent as KeyboardEvent | undefined
          if (event.key === 'Enter' && (composing || candidateConfirmed || native?.isComposing || event.which === 229)) return false
          if (event.key?.toLowerCase() === 'c' && event.metaKey) { copySelection(); return false }
          if (event.key?.toLowerCase() === 'c' && event.ctrlKey && event.shiftKey) { copySelection(); return false }
          return undefined
        },
        keymap: {
          'CTRL+C': () => {
            if (composing) return false
            operation?.abort()
            instance?.set_command('')
            echo('^C')
            if (current.current.onInterrupt) {
              void Promise.resolve(current.current.onInterrupt()).catch((failure: unknown) => {
                if (alive) echo(`错误：${failure instanceof Error ? failure.message : '中断失败'}`)
              })
            }
            return false
          },
        },
      })
      terminal.current = instance
      const field = node.querySelector('textarea')
      field?.setAttribute('aria-label', current.current.inputLabel ?? '命令输入')
      field?.setAttribute('spellcheck', 'false')
      if (current.current.interactive !== false) instance.focus()
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => { if (node.clientWidth > 0 && node.clientHeight > 0) instance?.resize() })
        observer.observe(node)
      }
    }).catch((failure: unknown) => { if (alive) setError(failure instanceof Error ? failure.message : '终端组件加载失败') })

    return () => {
      alive = false
      operation?.abort()
      if (compositionTimer) clearTimeout(compositionTimer)
      observer?.disconnect()
      if (terminal.current === instance) terminal.current = undefined
      instance?.destroy()
      node.replaceChildren()
      node.removeEventListener('compositionstart', onCompositionStart, true)
      node.removeEventListener('compositionend', onCompositionEnd, true)
      node.removeEventListener('keydown', onKeyCapture, true)
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('mouseup', copySelection)
    }
  }, [sessionKey])

  useEffect(() => {
    if (props.interactive === false) terminal.current?.disable()
    else terminal.current?.enable().focus()
  }, [props.interactive])
  useEffect(() => { terminal.current?.resize() }, [fontSize])

  return <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
    {error && <p role="alert" className="p-3 text-xs text-danger">终端组件加载失败：{error}</p>}
    <div ref={root} aria-label={`${inputLabel}终端`} role="region" className="elysian-command-terminal min-h-0 flex-1" style={{ '--size': fontSize / 12 } as CSSProperties} />
  </div>
}
