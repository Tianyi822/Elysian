import { PageHeader } from '../../components/PageHeader'

export function IncidentDetailPage() {
  return (
    <>
      <PageHeader title="事故详情" description="时间线、证据与判断、建议动作与审批状态。" />
      <p className="text-sm text-fg-muted">
        本页由 04 号票交付：时间线、指标摘要、证据与判断分离、高风险动作的审批状态。
      </p>
    </>
  )
}
