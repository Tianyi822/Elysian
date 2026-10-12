import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useMemo, useState } from 'react'
import type { AgentSession, RuntimeTask } from '@elysian/contracts'
import { FolderTree, Trash2 } from '../../components/icons'
import { CTL_SECONDARY } from '../../components/formControl'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentWorkbenchStore } from '../../stores/agentWorkbenchStore'
import type { ElysianGateway } from '../../contracts/adapters'
import { formatWorkbenchBytes } from './workbenchDisplay'

/*
 * Task 工作区页签：文件清单（digest/大小）、单文件 base64 预览（>4 MiB 前端先挡）、
 * 写入编辑器（提交＝原始文件字节：编辑内容按 UTF-8 经 store.writeWorkspace →
 * sendRawBytes 原样发送，path 与 expectedRevision 走查询参数，绝不 JSON 包装）、
 * 删除（同参数）与 409 冲突提示。会话 busy 期间写删禁用并显示原因；
 * quarantined 版本显示「来源已撤回，内容已隔离」。
 */

const PREVIEW_LIMIT_BYTES = 4 * 1024 * 1024
const WRITE_LIMIT_BYTES = 128 * 1024 * 1024

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function WorkbenchWorkspace({
  gateway,
  task,
  session,
}: {
  gateway: ElysianGateway
  task: RuntimeTask
  session: AgentSession | undefined
}) {
  const workspaceView = useAgentWorkbenchStore((state) => state.workspaceView)
  const workspaceStatus = useAgentWorkbenchStore((state) => state.workspaceStatus)
  const workspaceError = useAgentWorkbenchStore((state) => state.workspaceError)
  const loadWorkspace = useAgentWorkbenchStore((state) => state.loadWorkspace)
  const workspaceFile = useAgentWorkbenchStore((state) => state.workspaceFile)
  const workspaceFileStatus = useAgentWorkbenchStore((state) => state.workspaceFileStatus)
  const workspaceFileError = useAgentWorkbenchStore((state) => state.workspaceFileError)
  const openWorkspaceFile = useAgentWorkbenchStore((state) => state.openWorkspaceFile)
  const closeWorkspaceFile = useAgentWorkbenchStore((state) => state.closeWorkspaceFile)

  useEffect(() => {
    void loadWorkspace(gateway)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  const busy = session !== undefined && (session.activeRunId !== undefined || session.activeWorkflowId !== undefined)
  const revision = workspaceView?.version.revision ?? 0

  return (
    <div className="relative flex min-h-0 flex-col gap-3 busy-host">
      <BusyVeil busy={workspaceStatus === 'loading' && workspaceView !== undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted">
          <FolderTree aria-hidden size={12} />工作区（版本 {revision}）
        </span>
        {workspaceView ? (
          <span className="text-[10px] tabular-nums text-fg-subtle">
            {workspaceView.version.fileCount} 个文件 · {formatWorkbenchBytes(workspaceView.version.bytes)}
          </span>
        ) : null}
        <span className="ml-auto">
          <RefreshButton label="刷新工作区" onPress={() => void loadWorkspace(gateway)} busy={workspaceStatus === 'loading'} />
        </span>
      </div>
      {workspaceView?.quarantined === true ? (
        <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">
          来源已撤回，内容已隔离：该版本引用的 Wiki 来源已失效，文件内容不再参与整理。
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-warning">
          会话有进行中的运行：工作区写入与删除在运行结束前被服务端拒绝（409 session-busy）。
        </p>
      ) : null}
      {workspaceView?.wikiSources !== undefined && workspaceView.wikiSources.length > 0 ? (
        <p className="text-[10px] text-fg-subtle">关联来源：{workspaceView.wikiSources.map((source) => `${source.pageId}（修订 ${source.revision}）`).join('、')}</p>
      ) : null}

      {workspaceStatus === 'loading' && workspaceView === undefined ? <LoadingState label="正在读取工作区…" /> : null}
      {workspaceStatus === 'error' && workspaceView === undefined ? <ErrorState description={workspaceError} onRetry={() => void loadWorkspace(gateway)} /> : null}
      {workspaceStatus === 'ready' && (workspaceView?.files ?? []).length === 0 ? (
        <EmptyState title="工作区为空" description="运行产物与人工写入的文件按不可变版本保存；下面可直接新建文件。" />
      ) : null}

      {(workspaceView?.files ?? []).length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[20rem] table-fixed border-separate border-spacing-0 text-left text-xs">
            <colgroup>
              <col className="w-[46%]" />
              <col className="w-[18%]" />
              <col className="w-[36%]" />
            </colgroup>
            <thead>
              <tr>
                {['路径', '大小', '操作'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-2 py-1.5 text-[10px] font-medium text-fg-muted">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(workspaceView?.files ?? []).map((file) => (
                <tr key={file.path} className="hover:bg-surface-raised/50">
                  <td className="border-b border-line/60 px-2 py-1.5 break-all font-mono text-[11px] text-fg">{file.path}</td>
                  <td className="border-b border-line/60 px-2 py-1.5 tabular-nums text-fg-muted">{formatWorkbenchBytes(file.size)}</td>
                  <td className="border-b border-line/60 px-2 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={file.size > PREVIEW_LIMIT_BYTES}
                        title={file.size > PREVIEW_LIMIT_BYTES ? '文件超过 4 MiB，无法预览' : undefined}
                        onClick={() => void openWorkspaceFile(gateway, file.path)}
                        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        预览
                      </button>
                      <DeleteFileButton gateway={gateway} path={file.path} revision={revision} disabled={busy} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {workspaceFileStatus === 'loading' ? <LoadingState label="正在读取文件…" /> : null}
      {workspaceFileStatus === 'error' ? <ErrorState description={workspaceFileError} onRetry={closeWorkspaceFile} /> : null}
      {workspaceFile !== undefined ? (
        <WorkspaceFileEditor gateway={gateway} busy={busy} onClose={closeWorkspaceFile} />
      ) : (
        <NewFileEditor gateway={gateway} busy={busy} revision={revision} />
      )}
    </div>
  )
}

function WorkspaceFileEditor({
  gateway,
  busy,
  onClose,
}: {
  gateway: ElysianGateway
  busy: boolean
  onClose(): void
}) {
  const workspaceFile = useAgentWorkbenchStore((state) => state.workspaceFile)
  const writeWorkspace = useAgentWorkbenchStore((state) => state.writeWorkspace)
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const decoded = useMemo(() => {
    if (workspaceFile?.content === undefined) return undefined
    try {
      return decodeBase64(workspaceFile.content)
    } catch {
      return undefined
    }
  }, [workspaceFile?.content])
  const decodedText = useMemo(() => {
    if (decoded === undefined) return ''
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(decoded)
    } catch {
      return new TextDecoder('utf-8').decode(decoded)
    }
  }, [decoded])
  const binaryNote = useMemo(() => {
    if (decoded === undefined) return true
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(decoded)
      return false
    } catch {
      return true
    }
  }, [decoded])
  const [text, setText] = useState(decodedText)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  useEffect(() => { setText(decodedText) }, [decodedText])

  if (workspaceFile === undefined) return null
  const path = workspaceFile.path ?? ''
  const revision = workspaceFile.version.revision

  const submit = async () => {
    const bytes = new TextEncoder().encode(text)
    if (bytes.byteLength > WRITE_LIMIT_BYTES) {
      notify({ tone: 'danger', message: '文件内容超过 128 MiB 写入上限' })
      return
    }
    await inFlightOnly(async () => {
      try {
        await writeWorkspace(gateway, workspaceFile.version.taskId, path, revision, bytes)
        notify({ tone: 'success', message: `文件已保存：${path}（版本 ${revision + 1}）` })
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存文件失败')
      }
    })
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg">{path}</p>
        <button type="button" onClick={onClose} className={`${CTL_SECONDARY} px-2 py-0.5 text-[10px]`}>关闭文件</button>
      </div>
      {workspaceFile.quarantined === true ? (
        <p role="note" className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">来源已撤回，内容已隔离。</p>
      ) : null}
      {binaryNote ? (
        <p className="rounded border border-line bg-surface px-2 py-1 text-[10px] text-fg-muted">该文件含非 UTF-8 字节：编辑器按替换字符显示，保存以当前编辑内容为准。</p>
      ) : null}
      <label htmlFor="workbench-workspace-file" className="text-[11px] text-fg-muted">文件内容（按 UTF-8 提交原始字节）</label>
      <textarea
        id="workbench-workspace-file"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy || submitting}
        rows={8}
        className="ctl-field mt-0 w-full resize-y font-mono text-[11px]"
      />
      {errorMessage ? <p role="alert" className="text-[10px] text-danger">{errorMessage}。编辑内容已保留；请核对最新版本后再试。</p> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-fg-subtle">expectedRevision={revision}（CAS；冲突回读最新版本）</span>
        <button
          type="submit"
          disabled={busy || submitting}
          className="rounded-lg border border-line bg-surface px-3 py-1 text-[11px] font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '正在保存…' : '保存文件'}
        </button>
      </div>
    </form>
  )
}

function NewFileEditor({ gateway, busy, revision }: { gateway: ElysianGateway; busy: boolean; revision: number }) {
  const selectedTaskId = useAgentWorkbenchStore((state) => state.selectedTaskId)
  const writeWorkspace = useAgentWorkbenchStore((state) => state.writeWorkspace)
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  const submit = async () => {
    const trimmed = path.trim()
    if (trimmed === '') {
      setErrorMessage('请填写文件路径')
      return
    }
    const bytes = new TextEncoder().encode(text)
    if (bytes.byteLength > WRITE_LIMIT_BYTES) {
      setErrorMessage('文件内容超过 128 MiB 写入上限')
      return
    }
    if (selectedTaskId === undefined) return
    setErrorMessage(undefined)
    await inFlightOnly(async () => {
      try {
        await writeWorkspace(gateway, selectedTaskId, trimmed, revision, bytes)
        notify({ tone: 'success', message: `文件已写入：${trimmed}（版本 ${revision + 1}）` })
        setPath('')
        setText('')
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '写入文件失败')
      }
    })
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="text-[11px] font-medium text-fg-muted">写入新文件（或覆盖同名文件）</p>
      <label htmlFor="workbench-workspace-new-path" className="text-[11px] text-fg-muted">路径</label>
      <input
        id="workbench-workspace-new-path"
        value={path}
        onChange={(event) => setPath(event.target.value)}
        disabled={busy || submitting}
        placeholder="例如 notes/summary.md"
        className="ctl-field w-full font-mono text-[11px]"
      />
      <label htmlFor="workbench-workspace-new-content" className="text-[11px] text-fg-muted">内容（按 UTF-8 提交原始字节）</label>
      <textarea
        id="workbench-workspace-new-content"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy || submitting}
        rows={5}
        className="ctl-field w-full resize-y font-mono text-[11px]"
      />
      {errorMessage ? <p role="alert" className="text-[10px] text-danger">{errorMessage}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-fg-subtle">expectedRevision={revision}（CAS；冲突回读最新版本）</span>
        <button
          type="submit"
          disabled={busy || submitting}
          className="rounded-lg border border-line bg-surface px-3 py-1 text-[11px] font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '正在写入…' : '写入文件'}
        </button>
      </div>
    </form>
  )
}

function DeleteFileButton({
  gateway,
  path,
  revision,
  disabled,
}: {
  gateway: ElysianGateway
  path: string
  revision: number
  disabled: boolean
}) {
  const selectedTaskId = useAgentWorkbenchStore((state) => state.selectedTaskId)
  const removeWorkspaceFile = useAgentWorkbenchStore((state) => state.removeWorkspaceFile)
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <button
        type="button"
        disabled={disabled || submitting}
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 aria-hidden size={11} />删除
      </button>
      {confirming ? (
        <Dialog.Root open onOpenChange={(next) => !next && setConfirming(false)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl">
              <Dialog.Title className="text-sm font-semibold">删除工作区文件</Dialog.Title>
              <p className="mt-2 break-all font-mono text-xs text-fg-muted">{path}</p>
              <p className="mt-2 text-xs text-fg-muted">删除产生新工作区版本（expectedRevision={revision}）；操作不可在面板内撤销。</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirming(false)} className={`${CTL_SECONDARY} px-3 py-1.5 text-xs`}>取消</button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    if (selectedTaskId === undefined) return
                    void inFlightOnly(async () => {
                      try {
                        await removeWorkspaceFile(gateway, selectedTaskId, path, revision)
                        notify({ tone: 'success', message: `文件已删除：${path}` })
                        setConfirming(false)
                      } catch (error) {
                        notify({ tone: 'danger', message: error instanceof Error ? error.message : '删除文件失败' })
                      }
                    })
                  }}
                  className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? '正在删除…' : '确认删除'}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  )
}
