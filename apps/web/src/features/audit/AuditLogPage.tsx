import { PageHeader } from '../../components/PageHeader'

export function AuditLogPage() {
  return (
    <>
      <PageHeader title="审计日志" description="事件、决策、工具调用、审批与执行结果的时间顺序记录。" />
      <p className="text-sm text-fg-muted">
        本页由 06 号票交付：按类型筛选、搜索、详情查看与随事件流增长。
      </p>
    </>
  )
}
