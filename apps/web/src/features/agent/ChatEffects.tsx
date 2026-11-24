import { useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { BorderBeam } from 'border-beam'
import { useReducedMotion } from 'framer-motion'
import { Liquid } from 'liquid-gooey'
import { MetalFx } from 'metal-fx'
import { IconButton } from '../../components/IconButton'
import { ArrowUp, Paperclip } from '../../components/icons'

const EDITOR_RADIUS = 20

function observeTheme(update: () => void) {
  const observer = new MutationObserver(update)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

function readTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function observeVisibility(update: () => void) {
  document.addEventListener('visibilitychange', update)
  return () => document.removeEventListener('visibilitychange', update)
}

function pageVisible() {
  return !document.hidden
}

export function ChatEditorFrame({ inline = false, children }: { inline?: boolean; children: ReactElement }) {
  const theme = useSyncExternalStore(observeTheme, readTheme)
  const visible = useSyncExternalStore(observeVisibility, pageVisible)
  const reducedMotion = useReducedMotion()
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const highlighted = focused || dragging
  const hasBeam = typeof window.matchMedia === 'function'
  const Frame = hasBeam ? BorderBeam : 'div'
  const beam = hasBeam ? {
    size: 'md' as const, colorVariant: 'colorful' as const, strength: 0.7, borderRadius: EDITOR_RADIUS, theme,
    active: highlighted && visible && !reducedMotion,
  } : {}

  return <Frame className={`chat-editor-frame${inline ? ' chat-editor-frame-inline' : ''}`} {...beam}
    style={{ borderRadius: EDITOR_RADIUS }}
    data-chat-highlighted={highlighted || undefined} data-chat-static={reducedMotion || !hasBeam || undefined}
    onFocusCapture={event => { if (event.currentTarget.contains(event.target)) setFocused(true) }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    onDragEnterCapture={event => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return
      dragDepth.current += 1
      setDragging(true)
    }}
    onDragLeaveCapture={() => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }}
    onDropCapture={() => { dragDepth.current = 0; setDragging(false) }}>
    {children}
  </Frame>
}

export function ChatSendButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress(): void }) {
  const theme = useSyncExternalStore(observeTheme, readTheme)
  const visible = useSyncExternalStore(observeVisibility, pageVisible)
  const reducedMotion = useReducedMotion()
  return <div className="chat-send-slot">
    {!disabled && !reducedMotion && typeof WebGL2RenderingContext !== 'undefined' && (
      <MetalFx className="chat-send-metal" aria-hidden="true" variant="circle" preset="chromatic"
        theme={theme} strength={1} glowGain={0.55} innerShadow normalizeHostStyles={false}
        style={{ background: 'transparent' }} paused={!visible}>
        <span className="chat-send-silhouette" />
      </MetalFx>
    )}
    <IconButton label={label} onPress={onPress} disabled={disabled} className="chat-send chat-send-action">
      <ArrowUp size={19} aria-hidden />
    </IconButton>
  </div>
}

export function ChatAttachButton({ disabled, onPress }: { disabled: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const engaged = !disabled && (hovered || focused)
  return <div className="chat-attach-slot" data-engaged={engaged || undefined}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    {!disabled && <Liquid className="chat-attach-liquid" style={{ position: 'absolute', inset: 0 }}
      aria-hidden="true" fill="var(--t-surface-raised)" blur={4}>
      <Liquid.Item radius={12}><span className="chat-attach-disc" /></Liquid.Item>
      <Liquid.Item x={engaged ? 10 : 0} y={engaged ? -8 : 0} transition="snappy" radius={5}>
        <span className="chat-attach-drop" />
      </Liquid.Item>
    </Liquid>}
    <IconButton label="添加文件" tooltipSide="top" variant="ghost" onPress={onPress} disabled={disabled} className="chat-add-file">
      <Paperclip size={18} aria-hidden />
    </IconButton>
  </div>
}
