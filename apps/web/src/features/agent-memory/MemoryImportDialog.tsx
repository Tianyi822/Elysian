import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Plus, Trash2 } from '../../components/icons'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MemoryDialog } from './MemoryDialog'

/*
 * 导入弹窗：files 键值编辑（1..64 个 .md 文件）。提交 POST …/imports（无 requestId，
 * 单飞锁），返回 pending 候选列表，由「提炼候选」页签决定采纳与否。
 */
type ImportRow = { name: string; content: string }

const INITIAL_ROWS: readonly ImportRow[] = [
  { name: 'notes/imported.md', content: '# 导入笔记\n\n' },
]

export function MemoryImportDialog({ spaceId, onClose }: { spaceId: string; onClose(): void }) {
  const gateway = useGateway()
  const importPages = async (files: Readonly<Record<string, string>>) =>
    gateway.agentMemory.importPages(spaceId, files)
  const loadProposals = useAgentMemoryStore((state) => state.loadProposals)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [rows, setRows] = useState<readonly ImportRow[]>(INITIAL_ROWS)
  const [errorMessage, setErrorMessage] = useState<string>()

  const updateRow = (index: number, patch: Partial<ImportRow>) => {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  const submit = async () => {
    const files: Record<string, string> = {}
    for (const row of rows) {
      const name = row.name.trim()
      if (name === '') {
        setErrorMessage('每个文件都需要文件名')
        return
      }
      if (files[name] !== undefined) {
        setErrorMessage(`文件名重复：${name}`)
        return
      }
      files[name] = row.content
    }
    if (Object.keys(files).length === 0) {
      setErrorMessage('至少导入一个文件')
      return
    }
    await inFlightOnly(async () => {
      try {
        const proposals = await importPages(files)
        useNotificationStore.getState().notify({
          tone: 'info',
          message: `已提交 ${proposals.length} 个导入候选，请在「提炼候选」页签确认${gateway.agentMemory.available ? '' : '（演示数据）'}`,
        })
        await loadProposals(gateway, undefined, { silent: true })
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '导入失败')
      }
    })
  }

  return (
    <MemoryDialog title="导入 Markdown 文件" onClose={onClose} width="w-[min(44rem,calc(100vw-2rem))]"
    >
      <p className="text-xs leading-5 text-fg-muted">
        仅 .md 文件会产出候选；首行 <code className="font-mono"># 标题</code> 会作为候选标题。单次 1 至 64 个文件，导入结果先进入候选队列。
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {rows.map((row, index) => (
          <div key={index} className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <label htmlFor={`memory-import-name-${index}`} className="sr-only">文件名 {index + 1}</label>
              <input
                id={`memory-import-name-${index}`}
                value={row.name}
                onChange={(event) => updateRow(index, { name: event.target.value })}
                placeholder="pages/example.md"
                className="h-9 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-xs text-fg"
              />
              <button
                type="button"
                aria-label={`移除文件 ${row.name || index + 1}`}
                title={`移除文件 ${row.name || index + 1}`}
                onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
                disabled={rows.length === 1}
                className="rounded-lg border border-line p-2 text-fg-muted transition-colors hover:text-danger"
              >
                <Trash2 aria-hidden size={13} />
              </button>
            </div>
            <label htmlFor={`memory-import-content-${index}`} className="sr-only">文件内容 {index + 1}</label>
            <textarea
              id={`memory-import-content-${index}`}
              value={row.content}
              onChange={(event) => updateRow(index, { content: event.target.value })}
              rows={5}
              className="mt-2 w-full rounded-lg border border-line bg-surface p-2 font-mono text-xs leading-5 text-fg"
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`${CTL_SECONDARY} mt-3`}
        disabled={rows.length >= 64}
        onClick={() => setRows((current) => [...current, { name: '', content: '' }])}
      >
        <span className="inline-flex items-center gap-1">
          <Plus aria-hidden size={13} />
          添加文件
        </span>
      </button>
      {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
        <button type="submit" disabled={submitting} className={CTL_PRIMARY} onClick={() => void submit()}>
          提交导入
        </button>
      </div>
    </MemoryDialog>
  )
}
