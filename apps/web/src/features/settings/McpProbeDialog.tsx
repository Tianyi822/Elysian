import { useEffect, useRef, useState } from 'react'
import type { AgentMCPProbeDecision, AgentMCPProbeRequest, AgentMCPServer } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { RuntimeAccessCard } from '../agent/RuntimeAccessCard'
import { ExtensionDialog } from './extensionUi'
import { CTL_SECONDARY } from '../../components/formControl'
import { McpCatalog } from './McpSection'

type Pointer = { requestId: string; id?: string; decision?: AgentMCPProbeDecision; cancelRequestId?: string }
const storageKey = (server: AgentMCPServer) => `elysian:mcp-probe:v1:${server.id}:${server.revision}`
const readPointer = (server: AgentMCPServer): Pointer => {
  try { const value = JSON.parse(sessionStorage.getItem(storageKey(server)) ?? 'null') as Pointer | null; if (value && typeof value.requestId === 'string') return value } catch { /* 浏览器禁用存储时保持当前页面内幂等。 */ }
  return { requestId: crypto.randomUUID() }
}

export function McpProbeDialog({ server, visible, onClose }: { server: AgentMCPServer; visible: boolean; onClose(): void }) {
  const api = useGateway().agentExtensions
  const [request, setRequest] = useState<AgentMCPProbeRequest>()
  const [pointer, setPointer] = useState(() => readPointer(server))
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const lifetime = useRef(0)
  const createPromise = useRef<Promise<AgentMCPProbeRequest> | undefined>(undefined)
  useEffect(() => { lifetime.current += 1; return () => { lifetime.current += 1 } }, [api, server.id, server.revision])
  const savePointer = (value: Pointer) => { setPointer(value); try { sessionStorage.setItem(storageKey(server), JSON.stringify(value)) } catch { /* 同页仍保留原请求。 */ } }
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController(), owner = lifetime.current, auth = captureAuthGeneration()
    const current = () => !controller.signal.aborted && owner === lifetime.current && auth === captureAuthGeneration()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      setReading(true)
      try {
        if (!pointer.id && !createPromise.current) {
          try { sessionStorage.setItem(storageKey(server), JSON.stringify(pointer)) } catch { /* 同页保留。 */ }
          createPromise.current = api.createMcpProbeRequest(server.id, { revision: server.revision, requestId: pointer.requestId })
        }
        const value = pointer.id ? await api.getMcpProbeRequest(pointer.id, controller.signal) : await createPromise.current!
        if (!current()) return
        setRequest(value); setError(undefined)
        if (!pointer.id) savePointer({ ...pointer, id: value.id })
        if (['preparing', 'running'].includes(value.state)) timer = setTimeout(() => void read(), 1000)
      } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '探测状态读取失败') }
      finally { if (current()) setReading(false) }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, server.id, server.revision, visible, pointer.id, pointer.requestId, attempt])
  const decide = async (decision: 'once' | 'session' | 'denied') => {
    if (!request || busy || reading) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    const input = pointer.decision ?? { requestId: crypto.randomUUID(), expectedVersion: request.version, expectedDigest: request.digest, decision: decision === 'denied' ? 'deny' : 'allow-once' }
    savePointer({ ...pointer, decision: input }); setBusy(true); setError(undefined)
    try { const value = await api.decideMcpProbeRequest(request.id, input); if (owner === lifetime.current && auth === captureAuthGeneration()) { setRequest(value); savePointer({ ...pointer, decision: undefined }) } }
    catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '探测确认结果未知') }
    finally { if (owner === lifetime.current && auth === captureAuthGeneration()) { setBusy(false); setAttempt(value => value + 1) } }
  }
  const cancel = async () => {
    if (!request || busy) return
    const owner = lifetime.current, auth = captureAuthGeneration(), requestId = pointer.cancelRequestId ?? crypto.randomUUID()
    savePointer({ ...pointer, cancelRequestId: requestId }); setBusy(true)
    try { const value = await api.cancelMcpProbeRequest(request.id, { requestId }); if (owner === lifetime.current && auth === captureAuthGeneration()) setRequest(value) }
    catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '停止结果未确认') }
    finally { if (owner === lifetime.current && auth === captureAuthGeneration()) { setBusy(false); setAttempt(value => value + 1) } }
  }
  const restart = () => { createPromise.current = undefined; setRequest(undefined); savePointer({ requestId: crypto.randomUUID() }); setAttempt(value => value + 1) }
  return <ExtensionDialog title="MCP 探测权限" open={visible} onClose={onClose} wide>
    {!request && reading && <p role="status" className="text-xs text-fg-muted">正在准备权限申请…</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-xs text-danger">{error}</p><button type="button" className={CTL_SECONDARY} disabled={busy || reading} onClick={() => { if (!pointer.id) createPromise.current = undefined; setAttempt(value => value + 1) }}>{pointer.id ? '重新读取探测状态' : '按原请求重试读取申请'}</button></div>}
    {request?.state === 'waiting' && <RuntimeAccessCard title={`探测 ${request.serverName}`} access={request.access} profile={request.environment?.profile} busy={busy || reading || !!error}
      pending={pointer.decision ? { requestId: pointer.decision.requestId, expectedRevision: pointer.decision.expectedVersion, expectedDigest: pointer.decision.expectedDigest, decision: pointer.decision.decision === 'deny' ? 'denied' : 'once' } : undefined}
      onDecision={decision => void decide(decision)} onCancel={() => void cancel()}><pre aria-label="探测启动命令" className="hover-scrollbar max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-raised p-2 font-mono text-xs">{request.command.join('\n')}</pre><p className="text-xs text-fg-muted">只允许本次探测，不授予聊天会话权限。</p></RuntimeAccessCard>}
    {request && ['preparing', 'running'].includes(request.state) && <div className="space-y-3"><p role="status" className="text-xs">{request.state === 'preparing' ? '正在准备探测环境…' : '正在连接服务并读取目录…'}</p>{request.progress?.state === 'pulling' && <progress aria-label="探测镜像下载进度" className="w-full" max={request.progress.total || undefined} value={request.progress.total ? request.progress.current ?? 0 : undefined} />}<button className={CTL_SECONDARY} disabled={busy} onClick={() => void cancel()}>停止探测</button></div>}
    {request?.state === 'completed' && <><p role="status" className="text-xs text-success">本次探测成功</p>{request.catalog && <McpCatalog catalog={request.catalog} />}</>}
    {request && ['denied', 'failed', 'unknown', 'cancelled'].includes(request.state) && <p role="status" className={`text-xs ${request.state === 'failed' || request.state === 'unknown' ? 'text-danger' : 'text-fg-muted'}`}>{request.error ?? ({ denied: '已拒绝本次探测。', cancelled: '探测已停止。', unknown: '探测结果尚未确认，需要核实执行状态后才能继续。', failed: '探测失败。' } as Record<string, string>)[request.state]}</p>}
    {request && ['completed', 'denied', 'failed', 'cancelled'].includes(request.state) && <button className={CTL_SECONDARY} disabled={busy || reading || !!error} onClick={restart}>重新申请探测</button>}
  </ExtensionDialog>
}
