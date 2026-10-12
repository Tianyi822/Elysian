import { useState } from 'react'
import type { AgentMemorySpace } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Globe, Pencil, Plus } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MemoryDialog } from './MemoryDialog'

/*
 * 左侧空间列表：business/global 两类，global 唯一且带说明。建/改名均无 requestId
 * （单飞锁）；global 重复创建由服务端 409 wiki-global-exists 透传为中文行内错误。
 */

export function MemorySpacesPanel({
  selectedSpaceId,
  onSelect,
}: {
  selectedSpaceId?: string
  onSelect(spaceId: string): void
}) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.spacesStatus)
  const reloading = useAgentMemoryStore((state) => state.spacesReloading)
  const spaces = useAgentMemoryStore((state) => state.spaces)
  const errorMessage = useAgentMemoryStore((state) => state.spacesErrorMessage)
  const load = useAgentMemoryStore((state) => state.loadSpaces)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<AgentMemorySpace | undefined>(undefined)

  return (
    <section aria-label="记忆空间列表" className="busy-host relative flex w-full shrink-0 flex-col gap-3 panel-surface p-4 lg:w-64">
      <BusyVeil busy={reloading} />
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">记忆空间</h2>
        <RefreshButton label="刷新空间列表" onPress={() => void load(gateway)} busy={reloading} />
        <span className="ml-auto">
          <button type="button" className={`${CTL_PRIMARY} px-2 text-xs`} onClick={() => setCreating(true)}>
            <span className="inline-flex items-center gap-1">
              <Plus aria-hidden size={13} />
              新建空间
            </span>
          </button>
        </span>
      </header>
      <p className="text-xs leading-5 text-fg-muted">
        长期记忆（Wiki）是跨会话沉淀的知识库；工作台里的「任务工作记忆」属于单个 Task、由整理函数维护，两者分域。
      </p>
      {status === 'loading' || status === 'idle' ? <LoadingState label="正在读取记忆空间…" /> : null}
      {status === 'error' ? <ErrorState description={errorMessage} onRetry={() => void load(gateway)} /> : null}
      {status === 'ready' && spaces.length === 0 ? (
        <EmptyState title="暂无记忆空间" description="先创建业务空间，再往里沉淀 Wiki 页面。" />
      ) : null}
      {status === 'ready' ? (
        <ul className="flex flex-col gap-1.5">
          {spaces.map((space) => {
            const selected = space.id === selectedSpaceId
            return (
              <li key={space.id}>
                <div
                  className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                    selected ? 'border-control-line bg-surface-raised' : 'border-line hover:bg-surface-raised'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(space.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {space.kind === 'global' ? <Globe aria-hidden size={13} className="shrink-0 text-fg-subtle" /> : null}
                      <span className="truncate text-sm font-medium text-fg" title={space.name}>{space.name}</span>
                    </span>
                    <span className="mt-1 flex items-center gap-1.5">
                      {space.kind === 'global'
                        ? <StatusTag label="全局 · 唯一" tone="info" />
                        : <StatusTag label="业务" tone="neutral" />}
                      <span className="text-xs tabular-nums text-fg-subtle">修订 {space.revision}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`重命名空间「${space.name}」`}
                    title={`重命名空间「${space.name}」`}
                    onClick={() => setRenaming(space)}
                    className="rounded-lg border border-line p-1.5 text-fg-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil aria-hidden size={13} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      <p className="mt-auto text-xs leading-5 text-fg-subtle">
        全局空间整个面板只能存在一个，供所有会话共享引用；重复创建会被服务端拒绝。
      </p>
      {creating ? (
        <CreateSpaceDialog
          onClose={() => setCreating(false)}
          hasGlobal={spaces.some((space) => space.kind === 'global')}
        />
      ) : null}
      {renaming !== undefined ? <RenameSpaceDialog space={renaming} onClose={() => setRenaming(undefined)} /> : null}
    </section>
  )
}

function CreateSpaceDialog({ onClose, hasGlobal }: { onClose(): void; hasGlobal: boolean }) {
  const gateway = useGateway()
  const createSpace = useAgentMemoryStore((state) => state.createSpace)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'business' | 'global'>('business')
  const [errorMessage, setErrorMessage] = useState<string>()

  const submit = async () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setErrorMessage('空间名称不能为空')
      return
    }
    await inFlightOnly(async () => {
      try {
        await createSpace(gateway, { name: trimmed, kind })
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '创建记忆空间失败')
      }
    })
  }

  return (
    <MemoryDialog title="新建记忆空间" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="memory-space-name" className="block text-xs text-fg-muted">名称</label>
        <input
          id="memory-space-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={120}
          className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
        />
        <fieldset className="mt-3">
          <legend className="text-xs text-fg-muted">类型</legend>
          <div className="mt-1 flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="memory-space-kind" checked={kind === 'business'} onChange={() => setKind('business')} />
              业务空间（随项目积累）
            </label>
            <label className={`flex items-center gap-2 text-sm ${hasGlobal ? 'text-fg-subtle' : ''}`}>
              <input type="radio" name="memory-space-kind" checked={kind === 'global'} onChange={() => setKind('global')} disabled={hasGlobal} />
              全局空间（整个面板唯一{hasGlobal ? '，已存在' : ''}）
            </label>
          </div>
        </fieldset>
        {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
          <button type="submit" disabled={submitting} className={CTL_PRIMARY}>创建空间</button>
        </div>
      </form>
    </MemoryDialog>
  )
}

function RenameSpaceDialog({ space, onClose }: { space: AgentMemorySpace; onClose(): void }) {
  const gateway = useGateway()
  const renameSpace = useAgentMemoryStore((state) => state.renameSpace)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [name, setName] = useState(space.name)
  const [errorMessage, setErrorMessage] = useState<string>()

  const submit = async () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setErrorMessage('空间名称不能为空')
      return
    }
    await inFlightOnly(async () => {
      try {
        await renameSpace(gateway, space.id, space.revision, trimmed)
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '重命名记忆空间失败')
      }
    })
  }

  return (
    <MemoryDialog title={`重命名「${space.name}」`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="memory-space-rename" className="block text-xs text-fg-muted">新名称</label>
        <input
          id="memory-space-rename"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={120}
          className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
        />
        <p className="mt-2 text-xs text-fg-subtle">改名携带当前修订（{space.revision}）做 CAS 校验；并发改动会被拒绝。</p>
        {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
          <button type="submit" disabled={submitting} className={CTL_PRIMARY}>确认重命名</button>
        </div>
      </form>
    </MemoryDialog>
  )
}
