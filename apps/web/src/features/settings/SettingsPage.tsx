import { PageHeader } from '../../components/PageHeader'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="系统设置" description="主题、事件源状态与演示数据说明。" />
      <p className="text-sm text-fg-muted">
        本页由 11 号票交付：主题切换、事件源连接状态、演示数据重置与边界声明。
      </p>
    </>
  )
}
