import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_SECONDARY } from '../../components/formControl'
import { CopyButton } from '../../components/CopyButton'
import { LoadingState, ErrorState, EmptyState } from '../../components/states/StateViews'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MemoryDialog } from './MemoryDialog'

/*
 * 导出预览：GET …/export 的 files 原样呈现（不 JSON.parse 往返、不改写字节），
 * 每个文件可单独复制原文。
 */
export function MemoryExportDialog({ spaceId, onClose }: { spaceId: string; onClose(): void }) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.exportStatus)
  const data = useAgentMemoryStore((state) => state.exportData)
  const errorMessage = useAgentMemoryStore((state) => state.exportErrorMessage)
  const loadExport = useAgentMemoryStore((state) => state.loadExport)

  useEffect(() => {
    void loadExport(gateway, spaceId)
  }, [gateway, spaceId, loadExport])

  const files = data === undefined ? [] : Object.entries(data.files)

  return (
    <MemoryDialog title="导出空间内容（预览）" onClose={onClose} width="w-[min(44rem,calc(100vw-2rem))]"
    >
      <p className="text-xs leading-5 text-fg-muted">
        导出包含逐页 Markdown、索引、修订记录与来源清单；以下为服务端原文，复制不经过重新序列化。
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {status === 'loading' ? <LoadingState label="正在生成导出内容…" /> : null}
        {status === 'error' ? (
          <ErrorState description={errorMessage} onRetry={() => void loadExport(gateway, spaceId)} />
        ) : null}
        {status === 'ready' && files.length === 0 ? (
          <EmptyState title="空间内没有可导出的页面" />
        ) : null}
        {status === 'ready'
          ? files.map(([name, content]) => (
              <div key={name} className="rounded-lg border border-line">
                <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                  <span className="truncate font-mono text-xs text-fg" title={name}>{name}</span>
                  <CopyButton label={`文件 ${name}`} value={content} tooltip="复制文件原文" />
                </div>
                <pre className="max-h-40 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-all text-fg-muted">
                  {content}
                </pre>
              </div>
            ))
          : null}
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>关闭</button>
      </div>
    </MemoryDialog>
  )
}
