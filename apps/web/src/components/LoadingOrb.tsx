import { ThinkingOrb } from './easyui/ThinkingOrb'

/** 有独立朗读需求时传入 label，其他场景由原有按钮或状态文案播报。 */
export function LoadingOrb({ size = 16, className = '', label, paused = false, inverted = false }: {
  size?: number
  className?: string
  label?: string
  paused?: boolean
  inverted?: boolean
}) {
  // 给官网 Canvas 的外围光晕留空间，粒子主体仍占原来的图标槽。
  const canvasSize = Math.round(size * 1.6)
  return <span className={`relative inline-block shrink-0 align-middle ${className}`}
    style={{ width: size, height: size }} data-loading-orb="connecting" data-paused={paused || undefined}
    role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center">
      {typeof CanvasRenderingContext2D === 'undefined'
        ? <span className="block size-2.5 rounded-full border border-dotted border-current" />
        : <ThinkingOrb size={canvasSize} state="connecting" paused={paused} inverted={inverted} />}
    </span>
  </span>
}
