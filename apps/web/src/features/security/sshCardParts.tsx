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

/** 卡：标题加内容，卡内区域由这里统一排布间距。 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col rounded-xl border border-line bg-surface p-3 sm:p-4"
    >
      <h2 id={titleId} className="text-sm font-medium text-fg">
        {title}
      </h2>
      {/* 区域容器吃掉卡片剩下的高度，再由各区域按内容高度平分（见 Region 的 grow）。 */}
      <div className="mt-4 flex flex-1 flex-col gap-4">{children}</div>
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
