import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <div className="rounded border border-line bg-surface p-6 text-center">
      <h1 className="text-base font-semibold">未找到页面</h1>
      <p className="mt-1 text-sm text-fg-muted">地址与任何已知路由都不匹配。</p>
      <p className="mt-2 text-sm">
        <Link className="text-accent underline" to="/">
          回到仪表盘
        </Link>
      </p>
    </div>
  )
}
