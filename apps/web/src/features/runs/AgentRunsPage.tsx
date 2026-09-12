import { PageHeader } from '../../components/PageHeader'

export function AgentRunsPage() {
  return (
    <>
      <PageHeader title="Agent 运行" description="按职责模块查看运行状态与事件时间线。" />
      <p className="text-sm text-fg-muted">
        本页由 07 号票交付：职责模块列表、单次运行的时间线、等待原因与错误。
      </p>
    </>
  )
}
