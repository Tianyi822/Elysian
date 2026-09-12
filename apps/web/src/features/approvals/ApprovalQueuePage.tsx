import { PageHeader } from '../../components/PageHeader'

export function ApprovalQueuePage() {
  return (
    <>
      <PageHeader title="审批队列" description="待审批动作、影响范围与风险说明。" />
      <p className="text-sm text-fg-muted">
        本页由 08 号票交付：风险排序、批准与拒绝、两层状态呈现。
      </p>
    </>
  )
}
