import { useLayoutEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { filesPathSegments, normalizeFilesPath, pickPathDropCount } from './filesPath'
import { useHeaderAccessoryWidth } from '../../app/layout/headerAccessoryWidth'

/**
 * 顶栏路径标题：当前目录的绝对路径占据原本的页面标题位（该页经路由 handle 藏掉可视标题）。
 *
 * 路径放不下时从前面逐段省略——运维要看的是「现在在哪个目录」，末段永远保留；
 * 完整路径放在 aria-label 与悬停提示里，读屏与鼠标都不读省略形态。
 * 段宽由隐藏探针量出（与可见形态共用同一段渲染），宽度预算来自外壳；测试环境尺寸全 0、
 * 预算为无限，按完整路径呈现。
 */
export function FilesPathTitle() {
  const rawPath = useParams()['*'] ?? ''
  const path = normalizeFilesPath(rawPath)
  const segments = filesPathSegments(path)
  const availableWidth = useHeaderAccessoryWidth()

  const probeRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<{ segmentWidths: number[]; ellipsisWidth: number } | null>(
    null,
  )

  // 段宽只随路径（文本内容）变化；字体加载也会改变宽度，探针尺寸随之变、观察器再量一次。
  useLayoutEffect(() => {
    const probe = probeRef.current
    if (!probe) return

    const measure = () => {
      const segmentSpans = Array.from(probe.querySelectorAll<HTMLElement>('[data-segment]'))
      const ellipsisSpan = probe.querySelector<HTMLElement>('[data-ellipsis]')
      if (!ellipsisSpan) return
      setMetrics({
        segmentWidths: segmentSpans.map((span) => span.getBoundingClientRect().width),
        ellipsisWidth: ellipsisSpan.getBoundingClientRect().width,
      })
    }

    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [path])

  const dropCount = metrics
    ? pickPathDropCount(metrics.segmentWidths, metrics.ellipsisWidth, availableWidth)
    : 0
  const text =
    path === '/'
      ? '/'
      : (dropCount > 0 ? '…' : '') + segments.slice(dropCount).map((s) => `/${s}`).join('')

  return (
    <div className="flex min-w-0 items-center">
      {/* 固有宽度探针：脱离布局，逐段量出「/名字」的渲染宽度，与可见标题共用字体与字重。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max text-base font-semibold leading-tight">
          <span data-ellipsis>…</span>
          {segments.map((segment) => (
            <span key={segment} data-segment>{`/${segment}`}</span>
          ))}
        </div>
      </div>

      <h1 title={path} aria-label={path} className="truncate text-base font-semibold leading-tight">
        {text}
      </h1>
    </div>
  )
}
