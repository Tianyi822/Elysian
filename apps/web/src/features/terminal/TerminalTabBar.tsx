import { useLayoutEffect, useRef, useState } from 'react'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { IconButton } from '../../components/IconButton'
import { CTL_GROUP, CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { X, ZoomIn, ZoomOut } from '../../components/icons'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_STEP,
} from '../../components/terminal/terminalFontSize'
import { hostTerminalBanner, tabLabel, type HostTerminalSession } from '../../stores/terminalsStore'

const STATUS_TEXT: Record<HostTerminalSession['status'], string | undefined> = {
  connecting: '连接中',
  error: '已断开',
  connected: undefined,
}

/**
 * 终端页的标签栏：一枚浮在画布上的胶囊工具条，标签靠填充色表达选中，不再贴边压一条底边框。
 * 窄屏左侧空出 48px 给浮动「打开主导航」触发器——让位由工具条整体外移完成，
 * 内衬只留给标签，胶囊外壳才不会从按钮底下垫过去。
 *
 * 形态按标签栏留给平铺项的宽度决定：摆得下就摊开，摆不下就只显当前项、其余收进浮层菜单。
 * 不用视口断点——同一视口下会话数量、演示标识显隐都会改变可用宽度。摊开所需宽度由隐藏探针量出，
 * 探针与可见形态共用同一段渲染。
 *
 * 两种形态都常驻 DOM、只切显示，测量与查询因此都不受当前形态影响。
 * 收起后的菜单用 SelectDropdown，不用原生 select。
 */
export function TerminalTabBar({
  sessions,
  activeId,
  opening,
  fontSize,
  onFontZoom,
  onSelect,
  onClose,
  onCreate,
}: {
  sessions: readonly HostTerminalSession[]
  activeId?: string
  opening: boolean
  /** 终端字号（px）：触到边界即禁用对应方向的按钮，缩放幅度由本栏决定。 */
  fontSize: number
  onFontZoom: (deltaPx: number) => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCreate: () => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const trailingRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(Number.POSITIVE_INFINITY)
  const flatWidth = useIntrinsicWidth(probeRef)

  useLayoutEffect(() => {
    const row = rowRef.current
    const trailing = trailingRef.current
    if (!row || !trailing) return

    const measure = () => {
      const style = getComputedStyle(row)
      const content =
        row.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
      setAvailableWidth(content - trailing.getBoundingClientRect().width)
    }

    measure()
    if (typeof ResizeObserver !== 'function') return

    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(trailing)
    return () => observer.disconnect()
  }, [])

  // 摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = flatWidth <= availableWidth
  const active = sessions.find((session) => session.id === activeId)
  const activeLabel = active ? tabLabel(active, sessions) : ''

  return (
    <div
      ref={rowRef}
      className="relative ml-12 flex h-12 shrink-0 items-center rounded-full panel-surface px-2 md:ml-0"
    >
      {/* 固有宽度探针：脱离布局，量出全部标签摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max items-center">
          <TabItems
            sessions={sessions}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
          />
        </div>
      </div>

      <div className={expanded ? 'flex min-w-0 flex-1 items-center' : 'hidden'}>
        <div
          role="tablist"
          aria-label="终端会话"
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          <TabItems
            sessions={sessions}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
            labelled
          />
        </div>
      </div>

      <div
        className={`${
          expanded ? 'hidden' : 'flex'
        } min-w-0 flex-1 items-center gap-1 overflow-hidden`}
      >
        <SelectDropdown
          ariaLabel="终端会话"
          items={sessions.map((session) => ({
            value: session.id,
            label: tabLabel(session, sessions),
          }))}
          value={active ? activeId : undefined}
          onSelect={onSelect}
          valueClassName="truncate font-medium text-fg"
          triggerClassName={`${
            expanded ? 'hidden' : 'inline-flex'
          } min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg`}
        />
        {active ? (
          <span hidden={expanded}>
            <IconButton
              label={`关闭 ${activeLabel}`}
              variant="ghost"
              tone="danger-hover"
              onPress={() => onClose(active.id)}
            >
              <X aria-hidden size={15} />
            </IconButton>
          </span>
        ) : null}
      </div>

      <div ref={trailingRef} className={`${CTL_TOOLBAR} flex shrink-0 items-center gap-2 pl-2`}>
        {isDockerRuntime() ? null : (
          <span className="hidden rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning sm:inline">
            {hostTerminalBanner()}
          </span>
        )}
        {/* 缩放是一对反向动作，包进同一枚胶囊里才读得出它们管同一件事。 */}
        <div className={CTL_GROUP}>
          <IconButton
            label="缩小终端字体"
            variant="ghost"
            className="size-7"
            disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
            onPress={() => onFontZoom(-TERMINAL_FONT_SIZE_STEP)}
          >
            <ZoomOut aria-hidden size={15} />
          </IconButton>
          <IconButton
            label="放大终端字体"
            variant="ghost"
            className="size-7"
            disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
            onPress={() => onFontZoom(TERMINAL_FONT_SIZE_STEP)}
          >
            <ZoomIn aria-hidden size={15} />
          </IconButton>
        </div>
        <button type="button" onClick={onCreate} disabled={opening} className={CTL_PRIMARY}>
          新建终端
        </button>
      </div>
    </div>
  )
}

function TabItems({
  sessions,
  activeId,
  onSelect,
  onClose,
  labelled = false,
}: {
  sessions: readonly HostTerminalSession[]
  activeId?: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  labelled?: boolean
}) {
  return sessions.map((session) => {
    const label = tabLabel(session, sessions)
    const selected = session.id === activeId
    const status = STATUS_TEXT[session.status]
    return (
      <div
        key={session.id}
        className={[
          'flex shrink-0 items-center rounded-full py-0.5 pr-1 transition-colors',
          selected ? 'bg-nav-selected' : 'hover:bg-nav-hover',
        ].join(' ')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          id={labelled ? `terminal-tab-${session.id}` : undefined}
          aria-controls={labelled && selected ? `terminal-panel-${session.id}` : undefined}
          onClick={() => onSelect(session.id)}
          className={`max-w-[14rem] truncate rounded-full pl-3 text-sm font-medium transition-colors ${
            selected ? 'text-fg' : 'text-fg-muted hover:text-fg'
          }`}
        >
          <span>{label}</span>
          {status ? (
            <span
              className={[
                'ml-2 text-xs font-medium',
                session.status === 'error' ? 'text-danger' : 'text-fg-muted',
              ].join(' ')}
            >
              {` ${status}`}
            </span>
          ) : null}
        </button>
        <IconButton
          label={`关闭 ${label}`}
          variant="ghost"
          tone="danger-hover"
          onPress={() => onClose(session.id)}
        >
          <X aria-hidden size={15} />
        </IconButton>
      </div>
    )
  })
}
