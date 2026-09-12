import { Link } from 'react-router'
import { PageHeader } from '../components/PageHeader'

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="未找到页面" description="地址与任何已知路由都不匹配。" />
      <p className="text-sm text-fg-muted">
        检查地址是否写错，或
        <Link className="mx-1 text-accent underline" to="/">
          回到总览
        </Link>
        重新进入。
      </p>
    </>
  )
}
