import { useEffect, useRef } from 'react'
import { rawTerminalRuntime } from './rawTerminalRuntime'
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_WHEEL_STEP } from './terminalFontSize'

export function RawTerminalViewport({ sessionKey, interactive = true, fontSize = TERMINAL_FONT_SIZE_DEFAULT, onFontZoom, inputLabel = '命令输入', className = '' }: {
  sessionKey: string
  interactive?: boolean
  fontSize?: number
  onFontZoom?: (delta: number) => void
  inputLabel?: string
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    return rawTerminalRuntime(sessionKey).attach(host.current, fontSize, inputLabel)
  }, [sessionKey, fontSize, inputLabel])
  useEffect(() => { rawTerminalRuntime(sessionKey).setInteractive(interactive) }, [sessionKey, interactive])
  useEffect(() => {
    const element = host.current
    if (!element || !onFontZoom) return
    const zoom = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.deltaY === 0) return
      event.preventDefault()
      onFontZoom((event.deltaY < 0 ? 1 : -1) * TERMINAL_FONT_SIZE_WHEEL_STEP)
    }
    element.addEventListener('wheel', zoom, { passive: false })
    return () => element.removeEventListener('wheel', zoom)
  }, [onFontZoom])
  return <div ref={host} aria-label="终端显示区" className={`min-h-0 min-w-0 flex-1 overflow-hidden p-3 ${className}`} />
}
