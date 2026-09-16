import { useId } from 'react'
import type { ReactNode } from 'react'

/*
 * SSH 管理页的共用卡片部件：卡的形状、卡内区域的形状，以及卡内输入类控件与推进动作的类名。
 * 三张设置卡与密钥表共用它们，样式只在这里维护一份。
 */

/**
 * 卡内控件统一高度（34px）。
 * 输入框按内距加行高算出来正好是 34px，按钮若只写内距会矮 4px——横排时一高一低。
 * 因此这里把高度写成显式常量，输入框与挨着它的按钮都取它，不靠两边的内距各自凑。
 */
export const CONTROL_HEIGHT_CLASS = 'h-[34px]'

/** 卡内输入框：坐在卡面或区域内都取浮起底，靠边框与悬停反馈显形。 */
export const INPUT_CLASS = `min-w-0 flex-1 ${CONTROL_HEIGHT_CLASS} rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`

/** 卡里的推进动作：中性描边加中字重，不用强调蓝做填充底。 */
export const ACTION_CLASS = `inline-flex ${CONTROL_HEIGHT_CLASS} shrink-0 items-center rounded-lg border border-line bg-surface-raised px-3 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50`

/** 次要动作：与推进动作同高同形，只去掉底色并把文字降一档色阶。 */
export const SECONDARY_ACTION_CLASS = `inline-flex ${CONTROL_HEIGHT_CLASS} shrink-0 items-center rounded-lg border border-line px-3 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg disabled:opacity-50`

/**
 * 表格的分页条：左侧给出条数摘要与每页容量，右侧是上一页、页码、下一页。
 * 两张表共用；`label` 区分是哪张表的分页导航，读屏与查询都要靠它分辨。
 * 只有一页时页码仍渲染，按钮置灰——位置固定，翻页不会让底部行高跳动。
 */
export function TablePager({
  label,
  summary,
  page,
  pageCount,
  pageSize,
  onPageChange,
}: {
  label: string
  summary: string
  page: number
  pageCount: number
  pageSize: number
  onPageChange: (page: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
      <span className="tabular-nums">
        {summary} · 每页 {pageSize} 条
      </span>
      <nav aria-label={label} className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-lg border border-line px-2 py-1 transition-colors enabled:hover:bg-surface-raised enabled:hover:text-fg disabled:opacity-50"
        >
          上一页
        </button>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
          <button
            key={pageNumber}
            type="button"
            aria-current={pageNumber === page ? 'page' : undefined}
            onClick={() => onPageChange(pageNumber)}
            className={`min-w-7 rounded-lg border px-2 py-1 tabular-nums transition-colors ${
              pageNumber === page
                ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                : 'border-line hover:bg-surface-raised hover:text-fg'
            }`}
          >
            {pageNumber}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          className="rounded-lg border border-line px-2 py-1 transition-colors enabled:hover:bg-surface-raised enabled:hover:text-fg disabled:opacity-50"
        >
          下一页
        </button>
      </nav>
    </div>
  )
}

/** 卡：标题加内容，卡内区域由这里统一排布间距。 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      // min-w-0 是必需的：卡片是网格项，自动最小宽度会跟随内容，
      // 卡里的宽表格会因此把整张卡顶出视口，横向滚动也就落不到容器里。
      className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-3 sm:p-4"
    >
      <h2 id={titleId} className="text-sm font-medium text-fg">
        {title}
      </h2>
      {/* 区域容器吃掉卡片剩下的高度，再由各区域按内容高度平分（见 Region 的 grow）。 */}
      <div className="mt-4 flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </section>
  )
}

/**
 * 卡内的内容区域。标题可省：没有子标题的区域（如占位模块）不写标题。
 * `labelFor` 传输入框 id 时标题渲染成 label：「监听端口」这类标题本身就是那个输入框的可见标签，不另写一份。
 */
export function Region({
  title,
  labelFor,
  children,
}: {
  title?: string
  labelFor?: string
  children: ReactNode
}) {
  const titleClass = 'text-xs font-medium text-fg-muted'
  return (
    <div className="flex grow flex-col rounded-lg bg-surface-raised px-4 py-4">
      {labelFor ? (
        <label htmlFor={labelFor} className={titleClass}>
          {title}
        </label>
      ) : title ? (
        <p className={titleClass}>{title}</p>
      ) : null}
      <div className={title ? 'mt-3' : ''}>{children}</div>
    </div>
  )
}
