import { useCallback, useEffect, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ConfirmCloseDialog } from '../../components/terminal/TerminalShell'
import {
  clampTerminalFontSize,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '../../components/terminal/terminalFontSize'
import { TerminalViewport } from '../../components/terminal/TerminalViewport'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import {
  hostTerminalEmptyDescription,
  useTerminalsStore,
} from '../../stores/terminalsStore'
import { TerminalTabBar } from './TerminalTabBar'

/**
 * 本机多标签终端：进页自动开一条会话，命令经终端适配层送出——mock 运行时在
 * 浏览器内确定性求值，Docker 运行时经 WebSocket 接容器内真实 Shell。
 * 关闭走确认框；全部关掉后是空状态。字号是页面级视图偏好，按钮与 Ctrl/Cmd+滚轮共用一份。
 */
export function TerminalPage() {
  const gateway = useGateway()
  const sessions = useTerminalsStore((state) => state.sessions)
  const activeId = useTerminalsStore((state) => state.activeId)
  const opening = useTerminalsStore((state) => state.opening)
  const hasUserDismissed = useTerminalsStore((state) => state.hasUserDismissed)
  const seedGeneration = useTerminalsStore((state) => state.seedGeneration)
  const openSession = useTerminalsStore((state) => state.openSession)
  const selectSession = useTerminalsStore((state) => state.selectSession)
  const closeSession = useTerminalsStore((state) => state.closeSession)
  const reconnect = useTerminalsStore((state) => state.reconnect)
  const submitCommand = useTerminalsStore((state) => state.submitCommand)
  const interruptCommand = useTerminalsStore((state) => state.interruptCommand)
  const appendOutput = useTerminalsStore((state) => state.appendOutput)
  const clearScreen = useTerminalsStore((state) => state.clearScreen)
  const [closingId, setClosingId] = useState<string | undefined>(undefined)
  const [fontSize, setFontSize] = useState(TERMINAL_FONT_SIZE_DEFAULT)
  const zoomFont = useCallback(
    (deltaPx: number) =>
      setFontSize((prev) => clampTerminalFontSize(prev + deltaPx)),
    [],
  )

  useEffect(() => {
    if (hasUserDismissed || sessions.length > 0 || opening) return
    void openSession(gateway)
  }, [gateway, hasUserDismissed, sessions.length, opening, seedGeneration, openSession])

  const active = sessions.find((session) => session.id === activeId)
  const closing = sessions.find((session) => session.id === closingId)

  if (sessions.length === 0) {
    if (hasUserDismissed) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <EmptyState
            title="还没有终端会话"
            description={hostTerminalEmptyDescription()}
            action={
              <button
                type="button"
                onClick={() => void openSession(gateway)}
                className="mt-1 rounded-lg border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg"
              >
                新建终端
              </button>
            }
          />
        </div>
      )
    }
    return <LoadingState label="正在连接本机终端…" />
  }

  return (
    <section aria-label="终端" className="flex h-full min-h-0 flex-col gap-3 p-3 pt-2 md:p-4">
      <TerminalTabBar
        sessions={sessions}
        activeId={activeId}
        opening={opening}
        fontSize={fontSize}
        onFontZoom={zoomFont}
        onSelect={selectSession}
        onClose={setClosingId}
        onCreate={() => void openSession(gateway)}
      />

      {active?.status === 'connecting' ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <LoadingState label="正在连接本机终端…" />
        </div>
      ) : null}

      {active?.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <ErrorState
            title="本机终端连接失败"
            description={active.errorMessage}
            notify={false}
            onRetry={() => void reconnect(gateway, active.id)}
          />
        </div>
      ) : null}

      {active?.status === 'connected' ? (
        <div
          id={`terminal-panel-${active.id}`}
          role="tabpanel"
          aria-labelledby={`terminal-tab-${active.id}`}
          className="flex min-h-0 flex-1 flex-col overflow-hidden panel-surface"
        >
          <TerminalViewport
            prompt={active.prompt}
            awaitingPrompt={active.awaitingPrompt}
            sessionKey={active.id}
            lines={active.lines}
            history={active.history}
            onSubmit={(command) => void submitCommand(gateway, command)}
            complete={(draft, cursor) => gateway.terminals.complete(active.id, draft, cursor)}
            onAppendOutput={appendOutput}
            onClear={clearScreen}
            onInterrupt={() => void interruptCommand(gateway)}
            inputLabel="命令输入"
            fontSize={fontSize}
            onFontZoom={zoomFont}
          />
        </div>
      ) : null}

      <ConfirmCloseDialog
        open={Boolean(closing)}
        title="确认关闭终端？"
        description="会话历史将不再保留。"
        cancelLabel="继续使用"
        acceptLabel="确认关闭"
        onCancel={() => setClosingId(undefined)}
        onConfirm={() => {
          if (!closing) return
          const id = closing.id
          setClosingId(undefined)
          void closeSession(gateway, id)
        }}
      />
    </section>
  )
}
