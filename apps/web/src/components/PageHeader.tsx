import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-line pb-2">
      <div className="min-w-0">
        <h1 className="text-base font-semibold">{title}</h1>
        {description ? <p className="mt-0.5 text-xs text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
