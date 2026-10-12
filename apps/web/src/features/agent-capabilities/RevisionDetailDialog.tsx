import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from '../../components/icons'
import { JsonView } from '../../components/agent/JsonView'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { useGateway } from '../../adapters/GatewayProvider'
import { LoadingState, ErrorState } from '../../components/states/StateViews'
import { useAgentCapabilitiesStore } from '../../stores/agentCapabilitiesStore'

/*
 * 修订详情弹窗（执行配置 / 授权 / 资源规则三个单读端点共用）。修订号输入
 * 1 到最新修订之间任取，读取服务端当次事实；最新修订的完整 JSON 用 JsonView
 * 原文呈现（结构化对象序列化一次用于展示，不经解析重构决定内容）。
 */

const KIND_LABELS = { execution: '执行配置', grant: '执行授权', rule: '资源规则' } as const

export function RevisionDetailDialog({ latestRevision }: { latestRevision: number }) {
  const gateway = useGateway()
  const detail = useAgentCapabilitiesStore((state) => state.detail)
  const loadDetail = useAgentCapabilitiesStore((state) => state.loadRevisionDetail)
  const closeDetail = useAgentCapabilitiesStore((state) => state.closeRevisionDetail)
  const [revisionText, setRevisionText] = useState<string>(String(latestRevision))

  useEffect(() => {
    if (detail !== undefined) setRevisionText(String(detail.revision ?? latestRevision))
  }, [detail, latestRevision])

  if (detail === undefined) return null
  const kindLabel = KIND_LABELS[detail.kind]

  const readRevision = () => {
    const parsed = Number.parseInt(revisionText, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > latestRevision) return
    void loadDetail(gateway, detail.kind, detail.id, parsed)
  }

  const item = detail.kind === 'execution' ? detail.execution : detail.kind === 'grant' ? detail.grant : detail.rule

  return (
    <Dialog.Root open onOpenChange={(next) => !next && closeDetail()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">
              {kindLabel}修订详情（{detail.id}）
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭修订详情"
                className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
              >
                <X aria-hidden size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="agent-capabilities-revision-input" className="block text-xs text-fg-muted">
                修订号（1 至 {latestRevision}）
              </label>
              <input
                id="agent-capabilities-revision-input"
                type="number"
                min={1}
                max={latestRevision}
                step={1}
                value={revisionText}
                onChange={(event) => setRevisionText(event.target.value)}
                className={`${CTL_FIELD} mt-1 h-9 w-28 tabular-nums`}
              />
            </div>
            <button type="button" onClick={readRevision} className={CTL_SECONDARY}>
              读取该修订
            </button>
            <button
              type="button"
              onClick={() => void loadDetail(gateway, detail.kind, detail.id)}
              className={CTL_PRIMARY}
            >
              读取最新修订
            </button>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {detail.status === 'loading' ? <LoadingState label="正在读取修订…" /> : null}
            {detail.status === 'error' ? (
              <ErrorState
                title="修订读取失败"
                description={detail.errorMessage}
                onRetry={() => void loadDetail(gateway, detail.kind, detail.id, detail.revision)}
              />
            ) : null}
            {detail.status === 'ready' && item !== undefined ? (
              <div className="flex flex-col gap-3">
                <JsonView label="修订完整 JSON" text={JSON.stringify(item, null, 2)} />
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
