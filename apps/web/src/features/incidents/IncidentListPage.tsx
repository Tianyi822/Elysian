import { PageHeader } from '../../components/PageHeader'

export function IncidentListPage() {
  return (
    <>
      <PageHeader title="事件中心" description="事故、告警与待处理任务的合并列表。" />
      <p className="text-sm text-fg-muted">
        本页由 03 号票交付：密集表格、按严重等级/状态/来源筛选、排序与地址同步。
      </p>
    </>
  )
}
