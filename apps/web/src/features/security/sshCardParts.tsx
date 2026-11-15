export { ToggleSwitch as SwitchToggle } from '../../components/ToggleSwitch'
import { useId } from 'react'
import type { ReactNode } from 'react'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY, FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'

/*
 * SSH 管理页的共用卡片部件：卡的形状、卡内区域的形状，以及卡内输入类控件与推进动作的类名。
 * SSH 服务与 Root 设置共用它们，样式只在这里维护一份。
 */

/** 卡内控件高度，与表单控件同一套，见 `components/formControl.ts`。 */
export const CONTROL_HEIGHT_CLASS = FORM_CONTROL_HEIGHT_CLASS

/** 卡内输入框：与按钮同高同圆角同描边，同一行里看得出是一对。 */
export const INPUT_CLASS = `${CTL_FIELD} min-w-0 flex-1`

/** 卡里的推进动作：中性描边加中字重，不用强调蓝做填充底。 */
export const ACTION_CLASS = `${CTL_PRIMARY} shrink-0`

/** 次要动作：与推进动作同高同形，只去掉底色并把文字降一档色阶。 */
export const SECONDARY_ACTION_CLASS = `${CTL_SECONDARY} shrink-0`

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
