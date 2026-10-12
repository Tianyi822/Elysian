import { useState } from 'react'
import type { AgentMemoryPage } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_DANGER, CTL_SECONDARY } from '../../components/formControl'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MemoryDialog } from './MemoryDialog'

/*
 * 撤回确认：DELETE 的 expectedRevision 在 JSON body（服务端 memory_routes.go
 * 108-122），确认文案说明同事务会把依赖它的派生物标记 invalidated。
 */
export function MemoryWithdrawDialog({
  spaceId,
  page,
  onClose,
}: {
  spaceId: string
  page: AgentMemoryPage
  onClose(): void
}) {
  const gateway = useGateway()
  const withdrawPage = useAgentMemoryStore((state) => state.withdrawPage)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [errorMessage, setErrorMessage] = useState<string>()

  const submit = async () => {
    await inFlightOnly(async () => {
      try {
        await withdrawPage(gateway, spaceId, page.id, page.revision)
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '撤回 Wiki 页面失败')
      }
    })
  }

  return (
    <MemoryDialog title={`撤回「${page.title}」`} onClose={onClose}>
      <p className="text-sm leading-6 text-fg">
        将以当前修订 {page.revision} 为基准撤回该页面。撤回在服务端同一事务里完成：
        引用该页的待确认候选会被标记为「来源失效」，依赖它的运行上下文与派生物一并失效。
      </p>
      <p className="mt-2 text-xs leading-5 text-fg-muted">
        撤回会产生新的页面修订（status=withdrawn），历史修订仍可只读查看；此动作不可一键恢复，需重新发布新修订。
      </p>
      {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
        <button
          type="button"
          className={CTL_DANGER}
          disabled={submitting}
          onClick={() => void submit()}
        >
          确认撤回
        </button>
      </div>
    </MemoryDialog>
  )
}
