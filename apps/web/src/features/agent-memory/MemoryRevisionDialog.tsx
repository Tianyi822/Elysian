import { useEffect, useState } from 'react'
import type { AgentMemoryPage } from '@elysian/contracts'
import { AGENT_MEMORY_PAGE_KIND_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_SECONDARY } from '../../components/formControl'
import { StatusTag } from '../../components/StatusTag'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MEMORY_PAGE_STATUS_LABELS, MEMORY_PAGE_STATUS_TONES } from './memoryLabels'
import { MemoryDialog } from './MemoryDialog'

/*
 * 历史修订只读查看器：revisions/{revision} 按精确修订号读取，不提供修订目录——
 * 用数字输入选择修订（1..当前修订），内容只读。
 */
export function MemoryRevisionDialog({
  spaceId,
  page,
  onClose,
}: {
  spaceId: string
  page: AgentMemoryPage
  onClose(): void
}) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.revisionStatus)
  const revisionPage = useAgentMemoryStore((state) => state.revisionPage)
  const errorMessage = useAgentMemoryStore((state) => state.revisionErrorMessage)
  const loadPageRevision = useAgentMemoryStore((state) => state.loadPageRevision)
  const [revisionInput, setRevisionInput] = useState(String(page.revision))

  useEffect(() => {
    setRevisionInput(String(page.revision))
    void loadPageRevision(gateway, spaceId, page.id, page.revision)
  }, [gateway, spaceId, page.id, page.revision, loadPageRevision])

  return (
    <MemoryDialog
      title={`历史修订 · ${page.title}`}
      onClose={onClose}
      width="w-[min(44rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="memory-revision-number" className="block text-xs text-fg-muted">修订号（1 至 {page.revision}）</label>
          <input
            id="memory-revision-number"
            type="number"
            min={1}
            max={page.revision}
            value={revisionInput}
            onChange={(event) => setRevisionInput(event.target.value)}
            className="mt-1 h-9 w-28 rounded-lg border border-line bg-surface px-3 text-sm tabular-nums text-fg"
          />
        </div>
        <button
          type="button"
          className={CTL_SECONDARY}
          onClick={() => {
            const value = Number(revisionInput)
            if (Number.isSafeInteger(value) && value >= 1) void loadPageRevision(gateway, spaceId, page.id, value)
          }}
        >
          读取该修订
        </button>
        {status === 'loading' ? <span role="status" className="text-xs text-fg-muted">读取中…</span> : null}
      </div>
      {status === 'error' ? <p role="alert" className="mt-3 text-xs text-danger">{errorMessage}</p> : null}
      {status === 'ready' && revisionPage !== undefined ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <StatusTag label={`修订 ${revisionPage.revision}`} tone="info" />
            <StatusTag label={MEMORY_PAGE_STATUS_LABELS[revisionPage.status]} tone={MEMORY_PAGE_STATUS_TONES[revisionPage.status]} />
            <span>{AGENT_MEMORY_PAGE_KIND_LABELS[revisionPage.kind]}</span>
            <time dateTime={revisionPage.updatedAt}>{revisionPage.updatedAt}</time>
          </div>
          <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs whitespace-pre-wrap break-all text-fg">
            {revisionPage.markdown}
          </pre>
          <p className="text-xs text-fg-subtle">
            历史修订只读：服务端按精确修订号返回不可变快照，不提供回滚到旧修订的操作。
          </p>
        </div>
      ) : null}
      <div className="mt-4 flex justify-end">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>关闭</button>
      </div>
    </MemoryDialog>
  )
}
