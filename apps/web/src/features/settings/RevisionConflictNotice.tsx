import { JsonView } from './JsonView'
import { CTL_SECONDARY } from '../../components/formControl'

export function RevisionConflictNotice({ latest, baseRevision, onAccept }: {
  latest: { revision: number } | undefined
  baseRevision: number
  onAccept(revision: number): void
}) {
  if (latest === undefined || latest.revision <= baseRevision) return null
  return (
    <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
      <p>服务端已有修订 {latest.revision}。当前草稿仍保留，请查看最新内容后再决定是否基于该修订提交。</p>
      <details className="mt-2">
        <summary className="cursor-pointer">查看服务端最新修订</summary>
        <div className="mt-2"><JsonView label="服务端最新修订 JSON" text={JSON.stringify(latest, null, 2)} /></div>
      </details>
      <button type="button" className={`${CTL_SECONDARY} mt-2`} onClick={() => onAccept(latest.revision)}>
        使用修订 {latest.revision} 继续编辑
      </button>
    </div>
  )
}
