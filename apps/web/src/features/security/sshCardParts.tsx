import * as Switch from '@radix-ui/react-switch'
import { useId } from 'react'
import type { ReactNode } from 'react'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY, FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'

/*
 * SSH 管理页的共用卡片部件：卡的形状、卡内区域的形状，以及卡内输入类控件与推进动作的类名。
 * 三张设置卡与密钥表共用它们，样式只在这里维护一份。
 */

/** 卡内控件高度，与表单控件同一套，见 `components/formControl.ts`。 */
export const CONTROL_HEIGHT_CLASS = FORM_CONTROL_HEIGHT_CLASS

/** 卡内输入框：与按钮同高同圆角同描边，同一行里看得出是一对。 */
export const INPUT_CLASS = `${CTL_FIELD} min-w-0 flex-1`

/** 卡里的推进动作：中性描边加中字重，不用强调蓝做填充底。 */
export const ACTION_CLASS = `${CTL_PRIMARY} shrink-0`

/** 次要动作：与推进动作同高同形，只去掉底色并把文字降一档色阶。 */
export const SECONDARY_ACTION_CLASS = `${CTL_SECONDARY} shrink-0`

/** 卡内表格沿用全站的圆角描边、表头内距与数据行密度，不重复叠加玻璃面板。 */
export const TABLE_CONTAINER_CLASS = 'hover-scrollbar min-w-0 overflow-x-auto rounded-xl border border-line'
export const TABLE_HEADER_CLASS = 'border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted'
export const TABLE_CELL_CLASS = 'border-b border-line px-3 py-2.5'

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
                ? 'border-accent/50 bg-accent/10 font-medium text-accent-fg'
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

/** 开关本体：只画控件，标签与排布由调用方决定；界面上的布尔设置都从这里出。 */
export function SwitchToggle({
  label,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Switch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="ui-switch relative inline-flex h-5 w-9 shrink-0 items-center"
    >
      <Switch.Thumb className="ui-switch-thumb ml-0.5 block size-3.5 data-[state=checked]:translate-x-4" />
    </Switch.Root>
  )
}

/** 卡：标题加内容，卡内区域由这里统一排布间距。 */
export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      // min-w-0 是必需的：卡片是网格项，自动最小宽度会跟随内容，
      // 卡里的宽表格会因此把整张卡顶出视口，横向滚动也就落不到容器里。
      className="flex min-w-0 flex-col panel-surface p-3 sm:p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-sm font-medium text-fg">{title}</h2>
        {aside}
      </div>
      {/* 区域按内容取高度：瀑布列里矮卡不该被邻列撑开，区内也不平分剩余空白。 */}
      <div className="mt-4 flex min-w-0 flex-col gap-4">{children}</div>
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
  aside,
  children,
}: {
  title?: string
  labelFor?: string
  /** 标题行右侧附属信息（如「上次变更」），与标题同一行、不占内容区高度。 */
  aside?: ReactNode
  children: ReactNode
}) {
  const titleClass = 'text-xs font-medium text-fg-muted'
  const heading = labelFor ? (
    <label htmlFor={labelFor} className={titleClass}>
      {title}
    </label>
  ) : title ? (
    <p className={titleClass}>{title}</p>
  ) : null
  return (
    <div className="flex flex-col rounded-lg bg-surface-raised px-4 py-4">
      {aside ? (
        <div className="flex items-center justify-between gap-3">
          {heading}
          {aside}
        </div>
      ) : (
        heading
      )}
      <div className={heading || aside ? 'mt-3' : ''}>{children}</div>
    </div>
  )
}
