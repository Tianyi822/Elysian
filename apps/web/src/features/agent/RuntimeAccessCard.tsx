import type { ReactNode } from 'react'
import type { AgentAccessDecisionInput, AgentExecutionProfile, AgentOperation, AgentRuntimeAccess } from '@elysian/contracts'
import { Check, Square, X } from '../../components/icons'

const BUTTON = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-control-line px-3 text-xs hover:bg-surface-hover disabled:opacity-50'

export function RuntimeAccessDetails({ access, operation, profile = operation?.execution?.profile }: { access: AgentRuntimeAccess; operation?: AgentOperation; profile?: AgentExecutionProfile }) {
  return <div className="space-y-2 text-xs">
    {operation?.capability.source === 'builtin' && operation.capability.description && <p aria-label="操作说明" className="whitespace-pre-wrap break-words leading-5">{operation.capability.description}</p>}
    {access.reason && <p className="leading-5 text-fg-muted">{access.reason}</p>}
    {access.runtime && <p>运行环境：{access.runtime.name} · {access.runtime.requiresDownload ? '确认后下载镜像' : '使用本机镜像'}</p>}
    {access.directories.map(directory => <p key={directory.path} className="break-all"><code>{directory.path}</code> · {directory.access === 'rw' ? '读写' : '只读'}</p>)}
    {access.resources?.map(resource => <p key={`${resource.domain}:${resource.id}`} className="break-all">{resource.domain} / {resource.id} · {resource.access === 'write' ? '修改' : '读取'}</p>)}
    {access.network.map(endpoint => <p key={`${endpoint.scheme}:${endpoint.host}:${endpoint.port}`} className="break-all">网络：{endpoint.scheme}://{endpoint.host}:{endpoint.port}</p>)}
    {!!access.privateCidrs.length && <p className="break-all">私有网络：{access.privateCidrs.join('、')}</p>}
    {access.kind === 'mcp' && <p className="leading-5 text-fg-muted">授权绑定当前服务修订、目录与工具。无法识别目标范围时，仅匹配完全相同的参数。</p>}
    <details className="border-t border-line pt-2"><summary className="cursor-pointer text-fg-muted">命令、镜像、挂载与限额</summary>
      <div className="mt-2 space-y-2">
        {operation?.capability.source === 'mcp' && <p className="break-all text-fg-muted">工具别名：{operation.capability.name}</p>}
        {!!profile?.command.length && <div><p className="mb-1 text-fg-muted">运行环境启动命令（按参数顺序）</p><pre aria-label="运行环境启动命令" className="hover-scrollbar max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised p-2 font-mono">{JSON.stringify(profile.command)}</pre></div>}
        {operation && <pre aria-label="完整操作参数" className="hover-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised p-2 font-mono">{operation.argumentsJson}</pre>}
        {access.runtime && <><code className="block break-all">{access.runtime.image}</code><p>{access.runtime.platform}</p></>}
        {access.directories.map((directory, index) => <code key={directory.path} className="block break-all">{directory.path}{(access.kind === 'script' || access.kind === 'mcp') ? ` → /grants/${index}` : '（宿主业务目录）'} · {directory.access}</code>)}
        {profile && <p>{profile.cpuMillis / 1000} CPU · {Math.round(profile.memoryBytes / 1048576)} MiB · {profile.pids} PID · 最长 {profile.timeoutSeconds} 秒</p>}
        {operation && <p className="text-fg-muted">任务工作区 v{operation.workspaceRevision}</p>}
      </div>
    </details>
  </div>
}

export function RuntimeAccessCard({ title, access, operation, profile, busy = false, confirmed = false, pending, onDecision, onCancel, children }: {
  title: string; access: AgentRuntimeAccess; operation?: AgentOperation; busy?: boolean; confirmed?: boolean
  profile?: AgentExecutionProfile
  pending?: AgentAccessDecisionInput; onDecision(decision: AgentAccessDecisionInput['decision']): void; onCancel(): void; children?: ReactNode
}) {
  return <section aria-label={`权限申请 ${title}`} className="space-y-3 rounded-lg border border-line bg-surface p-3">
    <h3 className="break-all text-sm font-medium">{title}</h3>
    <RuntimeAccessDetails access={access} operation={operation} profile={profile} />
    {operation?.preparation?.error && <p role="status" className="text-xs text-danger">{operation.preparation.error}</p>}
    {operation?.fileChanges?.map(change => <details key={change.path} className="border-t border-line pt-2 text-xs"><summary className="cursor-pointer break-all">文件变更：{change.path}</summary><div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">{(['before', 'after'] as const).map(side => {
      const content = change[side]
      return <div key={side} className="min-w-0"><p className="mb-1 text-fg-muted">{side === 'before' ? '修改前' : '修改后'}</p>{!content ? <p className="text-fg-muted">不存在</p> : <><code className="block break-all text-fg-muted">{content.digest}</code>{content.text === undefined ? <p className="text-fg-muted">按版本摘要核对。</p> : <pre className="hover-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-surface-raised p-2">{content.text || '空文件'}</pre>}</>}</div>
    })}</div></details>)}
    {children}
    {confirmed ? <><p role="status" className="text-xs text-fg-muted">{operation?.preparation?.state === 'unknown' ? '镜像准备结果尚未确认，请先核实，当前操作不会重复派发。' : operation?.preparation?.state === 'failed' ? '镜像准备失败，请按提示重试。' : '已确认，正在准备并继续执行…'}</p>
      {operation?.preparation?.state === 'pulling' && <progress className="w-full accent-[var(--color-accent)]" aria-label="镜像下载进度" max={operation.preparation.total || undefined} value={operation.preparation.total ? operation.preparation.current ?? 0 : undefined} />}
      <button type="button" className={BUTTON} disabled={busy} onClick={onCancel}><Square size={12} aria-hidden />停止任务</button>
    </> : <>
      {pending && <p role="status" className="text-xs text-warning">结果尚未确认。重新读取后，可按原选择重试。</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={busy} onClick={() => onDecision(pending?.decision ?? 'once')}><Check size={14} aria-hidden />{pending ? '按原选择重试' : operation?.preparation?.state === 'unknown' ? '重新核实并继续' : operation?.preparation?.state === 'failed' ? '确认并重试准备' : '确认并继续'}</button>
        <button type="button" className={`${BUTTON} text-danger`} disabled={busy || !!pending} onClick={() => onDecision('denied')}><X size={14} aria-hidden />拒绝</button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onCancel}><Square size={12} aria-hidden />停止任务</button>
      </div>
    </>}
  </section>
}
