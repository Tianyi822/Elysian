import { Link } from 'react-router'
import type { AgentWikiRef } from '@elysian/contracts'

export function MemoryOriginLink({ kind, id, runId, workflowId }: { kind: string; id: string; runId?: string; workflowId?: string }) {
  if (kind === 'manual') return <span>{id}</span>
  const run = runId ?? (kind === 'run' ? id : undefined)
  const workflow = workflowId ?? (kind === 'workflow' ? id : undefined)
  if (run !== undefined) return <Link className="text-info underline underline-offset-2" to={`/agent/runs?runId=${encodeURIComponent(run)}`}>{id}</Link>
  if (workflow !== undefined) return <Link className="text-info underline underline-offset-2" to={`/agent/workflows?view=instances&instanceId=${encodeURIComponent(workflow)}`}>{id}</Link>
  return <span>{id}</span>
}

export function MemoryPageSourceLink({ source, spaceId }: { source: AgentWikiRef; spaceId: string }) {
  return (
    <Link className="text-info underline underline-offset-2" to={`/agent/memory?spaceId=${encodeURIComponent(spaceId)}&pageId=${encodeURIComponent(source.pageId)}&tab=pages`}>
      {source.pageId}
    </Link>
  )
}
