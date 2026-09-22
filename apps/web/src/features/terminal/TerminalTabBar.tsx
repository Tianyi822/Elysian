import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useLayoutEffect, useRef, useState } from 'react'
import { useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { IconButton } from '../../components/IconButton'
import { Check, ChevronDown, Plus, X } from '../../components/icons'
import { HOST_TERMINAL_BANNER, tabLabel, type HostTerminalSession } from '../../stores/terminalsStore'

const STATUS_TEXT: Record<HostTerminalSession['status'], string | undefined> = {
  connecting: '连接中',
  error: '已断开',
  connected: undefined,
}

/**
 * 终端页的标签栏：兼页头。形态对齐顶栏 HeaderTabs——大字号、无盒、选中靠颜色与底边指示条。
 * 窄屏左侧留出浮动「打开主导航」的位置。
 *
 * 形态按标签栏留给平铺项的宽度决定：摆得下就摊开，摆不下就只显当前项、其余收进浮层菜单。
 * 不用视口断点——同一视口下会话数量、演示标识显隐都会改变可用宽度。摊开所需宽度由隐藏探针量出，
 * 探针与可见形态共用同一段渲染。
 *
 * 两种形态都常驻 DOM、只切显示，测量与查询因此都不受当前形态影响。
 * 菜单由本文件自绘，不用原生 select，因此不会呼出操作系统的下拉控件，键盘与取值都留在界面内。
 */
export function TerminalTabBar({
  sessions,
  activeId,
  opening,
  onSelect,
  onClose,
  onCreate,
}: {
  sessions: readonly HostTerminalSession[]
  activeId?: string
  opening: boolean
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
      className="relative flex h-14 shrink-0 items-stretch border-b border-line bg-surface pl-14 pr-2 md:pl-3"
    >
      {/* 固有宽度探针：脱离布局，量出全部标签摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <TabItems
            sessions={sessions}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
          />
        </div>
      </div>

      <div className={expanded ? 'flex min-w-0 flex-1 items-stretch' : 'hidden'}>
        <div
          role="tablist"
          aria-label="终端会话"
          className="flex min-w-0 flex-1 items-stretch"
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
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className={`${
                expanded ? 'hidden' : 'inline-flex'
              } min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg`}
            >
              <span className="sr-only">终端会话：</span>
              <span className="truncate font-medium text-fg">{activeLabel}</span>
              <ChevronDown aria-hidden size={13} className="shrink-0" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-32 rounded-lg border border-line bg-surface p-1 text-xs shadow-lg"
            >
              <DropdownMenu.RadioGroup value={activeId} onValueChange={onSelect}>
                {sessions.map((session) => {
                  const label = tabLabel(session, sessions)
                  return (
                    <DropdownMenu.RadioItem
                      key={session.id}
                      value={session.id}
                      className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none text-fg-muted data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                    >
                      {session.id === activeId ? (
                        <Check aria-hidden size={13} />
                      ) : (
                        <span aria-hidden className="w-[13px]" />
                      )}
                      {label}
                    </DropdownMenu.RadioItem>
                  )
                })}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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

      <div ref={trailingRef} className="flex shrink-0 items-center gap-2 pl-2">
        <span className="hidden rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning sm:inline">
          {HOST_TERMINAL_BANNER}
        </span>
        <IconButton label="新建终端" onPress={onCreate} variant="ghost">
          <Plus aria-hidden size={17} className={opening ? 'opacity-50' : undefined} />
        </IconButton>
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
          'relative flex shrink-0 items-center',
          selected ? 'text-fg' : 'text-fg-muted hover:text-fg',
        ].join(' ')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          id={labelled ? `terminal-tab-${session.id}` : undefined}
          aria-controls={labelled && selected ? `terminal-panel-${session.id}` : undefined}
          onClick={() => onSelect(session.id)}
          className="max-w-[16rem] truncate px-3 text-left text-base font-semibold"
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
        {selected ? (
          <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />
        ) : null}
      </div>
    )
  })
}
