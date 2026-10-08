import { useLayoutEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { filesPathSegments, normalizeFilesPath, pickPathDropCount } from './filesPath'
import { useHeaderAccessoryWidth } from '../../app/layout/headerAccessoryWidth'

/**
 * 当前路径胶囊：固定标签说明含义，绝对路径紧随其后。
 *
 * 路径放不下时从前面逐段省略——运维要看的是「现在在哪个目录」，末段永远保留；
 * 完整路径放在 aria-label 与悬停提示里，读屏与鼠标都不读省略形态。
 * 段宽由隐藏探针量出，外壳宽度预算扣除标签、间距与描边后用于路径；测试环境尺寸全 0、
 * 预算为无限，按完整路径呈现。
 */
const PATH_TEXT_CLASS = 'font-mono text-sm font-medium leading-none'

export function FilesPathTitle() {
  const rawPath = useParams()['*'] ?? ''
  const path = normalizeFilesPath(rawPath)
  const segments = filesPathSegments(path)
  const availableWidth = useHeaderAccessoryWidth()

  const capsuleRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<{ segmentWidths: number[]; ellipsisWidth: number; chromeWidth: number } | null>(
    null,
  )

  // 段宽只随路径（文本内容）变化；字体加载也会改变宽度，探针尺寸随之变、观察器再量一次。
  useLayoutEffect(() => {
    const probe = probeRef.current
    const capsule = capsuleRef.current
    const label = labelRef.current
    if (!probe || !capsule || !label) return

    const measure = () => {
      const segmentSpans = Array.from(probe.querySelectorAll<HTMLElement>('[data-segment]'))
      const ellipsisSpan = probe.querySelector<HTMLElement>('[data-ellipsis]')
      if (!ellipsisSpan) return
      const style = getComputedStyle(capsule)
      const spacing = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth, style.columnGap]
        .reduce((total, value) => total + (Number.parseFloat(value) || 0), 0)
      setMetrics({
        segmentWidths: segmentSpans.map((span) => span.getBoundingClientRect().width),
        ellipsisWidth: ellipsisSpan.getBoundingClientRect().width,
        chromeWidth: label.getBoundingClientRect().width + spacing,
      })
    }

    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(probe)
    observer.observe(label)
    return () => observer.disconnect()
  }, [path])

  const dropCount = metrics
    ? pickPathDropCount(metrics.segmentWidths, metrics.ellipsisWidth, availableWidth - metrics.chromeWidth)
    : 0
  const text =
    path === '/'
      ? '/'
      : (dropCount > 0 ? '…' : '') + segments.slice(dropCount).map((s) => `/${s}`).join('')

  return (
    <div
      ref={capsuleRef}
      role="group"
      aria-label="当前路径"
      className="flex h-9 min-w-0 max-w-full items-center gap-3 rounded-full border border-panel-line bg-surface px-3"
      style={Number.isFinite(availableWidth) ? { maxWidth: Math.max(0, availableWidth) } : undefined}
    >
      {/* 固有宽度探针：脱离布局，逐段量出「/名字」的渲染宽度，与可见标题共用字体与字重。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className={`flex w-max ${PATH_TEXT_CLASS}`}>
          <span data-ellipsis>…</span>
          {segments.map((segment, index) => (
            <span key={index} data-segment>{`/${segment}`}</span>
          ))}
        </div>
      </div>

      <span ref={labelRef} className="shrink-0 border-r border-line pr-3 text-xs leading-4 text-fg-muted">
        当前路径
      </span>
      <h1 title={path} aria-label={path} className={`truncate text-fg ${PATH_TEXT_CLASS}`}>
        {text}
      </h1>
    </div>
  )
}
