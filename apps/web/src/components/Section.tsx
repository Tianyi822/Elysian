import type { ReactNode } from 'react'

/**
 * 页面区块。用自然布局组织内容，不做互相嵌套的卡片，
 * 区块之间靠标题与分隔线区分。
 */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex flex-wrap items-end justify-between gap-2 border-b border-line pb-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {description ? <p className="mb-1.5 text-xs text-fg-muted">{description}</p> : null}
      {children}
    </section>
  )
}
