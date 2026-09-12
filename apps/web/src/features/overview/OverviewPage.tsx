import { PageHeader } from '../../components/PageHeader'

export function OverviewPage() {
  return (
    <>
      <PageHeader title="总览" description="当前事故、Agent 运行、待审批动作与服务健康摘要。" />
      <p className="text-sm text-fg-muted">本页由 10 号票交付：态势聚合与下钻。</p>
    </>
  )
}
