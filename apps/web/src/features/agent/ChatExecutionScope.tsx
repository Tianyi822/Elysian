import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentCapability, AgentEnvironment, AgentExecutionGrant, AgentExecutionProfile, AgentRevisionRef } from '@elysian/contracts'
import type { AgentChatGovernance } from '../../contracts/agentChat'
import { IconButton } from '../../components/IconButton'
import { Save, X } from '../../components/icons'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useNotificationStore } from '../../stores/notificationStore'

const BUTTON = 'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-control-line px-3 text-sm hover:bg-surface-hover disabled:opacity-50'
const identity = (r: AgentRevisionRef) => `${r.id}@${r.revision}`

export function ChatExecutionScope({ open, sessionId, api, locked, onClose }: {
  open: boolean; sessionId?: string; api?: AgentChatGovernance; locked: boolean; onClose(): void
}) {
  const [environment, setEnvironment] = useState<AgentEnvironment | null>(null)
  const [profiles, setProfiles] = useState<readonly AgentExecutionProfile[]>([])
  const [grants, setGrants] = useState<readonly AgentExecutionGrant[]>([])
  const [tools, setTools] = useState<readonly AgentCapability[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const lifetime = useRef(0)
  useEffect(() => { lifetime.current += 1; return () => { lifetime.current += 1 } }, [open, sessionId, api])
  useFeedbackNotification(open ? error : null)
  useFeedbackNotification(open && !api ? '当前环境未提供执行范围。' : null, 'info')
  useEffect(() => {
    setEnvironment(null); setError(null)
    if (!open || !api || !sessionId) return
    const controller = new AbortController()
    setLoading(true)
    void Promise.all([api.environment(sessionId, controller.signal), api.profiles(controller.signal), api.grants(controller.signal), api.tools(sessionId, controller.signal)])
      .then(([env, p, g, t]) => { if (!controller.signal.aborted) { setEnvironment(env); setProfiles(p); setGrants(g); setTools(t) } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取执行范围失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, sessionId, api, attempt])
  const toggleRef = (kind: 'grants' | 'executionProfiles', ref: AgentRevisionRef, checked: boolean) => {
    if (environment) setEnvironment({ ...environment, [kind]: checked ? [...environment[kind].filter(item => item.id !== ref.id), ref] : environment[kind].filter(item => identity(item) !== identity(ref)) })
  }
  const save = async () => {
    if (!environment || !api || !sessionId || saving || locked) return
    const owner = lifetime.current
    setSaving(true); setError(null)
    try {
      await api.updateEnvironment(sessionId, environment.revision, environment)
      if (owner !== lifetime.current) return
      useNotificationStore.getState().notify({ tone: 'success', message: '执行范围已保存。' })
      onClose()
    }
    catch (cause) { if (owner === lifetime.current) setError(cause instanceof Error ? cause.message : '保存执行范围失败') }
    finally { if (owner === lifetime.current) setSaving(false) }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !saving) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
      <div className="flex items-center justify-between px-5 pt-4"><Dialog.Title className="text-sm font-semibold">执行范围</Dialog.Title><IconButton label="关闭执行范围" variant="ghost" disabled={saving} onPress={onClose}><X size={16} aria-hidden /></IconButton></div>
      <Dialog.Description className="px-5 pt-1 text-xs text-fg-muted">{sessionId ? '后续轮次使用此范围。宿主 rw 挂载产生真实修改，不能自动回滚。' : '先发送一条消息以创建服务端会话。'}</Dialog.Description>
      <div className="hover-scrollbar min-h-0 overflow-y-auto px-5 py-4 text-sm">
        {!api && <p role="status" className="text-fg-muted">当前环境未提供执行范围。</p>}
        {loading && <p role="status">正在读取执行范围…</p>}
        {error && <button className="mb-3 underline" onClick={() => setAttempt(value => value + 1)}>重新读取执行范围</button>}
        {environment && <fieldset disabled={saving || locked} className="space-y-5">
          <section><h3 className="mb-2 font-medium">执行配置</h3>{!profiles.length && <p className="text-xs text-fg-muted">尚无管理员执行配置。</p>}
            {profiles.map(profile => <label key={identity(profile)} className="flex gap-3 border-b border-line py-2"><input type="checkbox" className="mt-1 accent-[var(--color-accent)]" disabled={!profile.enabled} checked={environment.executionProfiles.some(ref => identity(ref) === identity(profile))} onChange={event => toggleRef('executionProfiles', { id: profile.id, revision: profile.revision }, event.target.checked)} />
              <span className="min-w-0 flex-1"><span className="font-medium">{profile.name} <span className="text-xs text-fg-muted">v{profile.revision}{!profile.enabled && ' · 已禁用'}</span></span><code className="mt-1 block break-all text-xs text-fg-muted">{profile.image}</code><span className="mt-1 block text-xs text-fg-muted">{profile.runtime} · {profile.timeoutSeconds}s · {profile.cpuMillis / 1000} CPU · {Math.round(profile.memoryBytes / 1048576)} MiB · {profile.pids} PID</span></span>
            </label>)}
            {environment.executionProfiles.filter(ref => !profiles.some(p => identity(p) === identity(ref))).map(ref => <label key={identity(ref)} className="flex gap-3 py-2 text-xs"><input type="checkbox" checked onChange={() => toggleRef('executionProfiles', ref, false)} />{identity(ref)} · 旧修订</label>)}
          </section>
          <section><h3 className="mb-2 font-medium">目录、网络与平台授权</h3>{!grants.length && <p className="text-xs text-fg-muted">尚无管理员授权。任务工作区独立隔离。</p>}
            {grants.map(grant => <label key={identity(grant)} className="flex gap-3 border-b border-line py-2"><input type="checkbox" className="mt-1" disabled={!grant.enabled} checked={environment.grants.some(ref => identity(ref) === identity(grant))} onChange={event => toggleRef('grants', { id: grant.id, revision: grant.revision }, event.target.checked)} />
              <span className="min-w-0 flex-1"><span className="font-medium">{grant.name} <span className="text-xs text-fg-muted">v{grant.revision}{!grant.enabled && ' · 已禁用'}</span></span>
                {grant.directories.map((dir, index) => <code key={dir.path} className="mt-1 block break-all text-xs">{dir.path} → /grants/{index} · {dir.access}</code>)}
                {grant.network.map(item => <code key={`${item.host}:${item.port}`} className="mt-1 block break-all text-xs">{item.scheme}://{item.host}:{item.port}</code>)}
                {grant.resources?.map(item => <code key={`${item.domain}:${item.id}`} className="mt-1 block break-all text-xs">{item.domain} / {item.id} · {item.access}</code>)}
              </span>
            </label>)}
            {environment.grants.filter(ref => !grants.some(g => identity(g) === identity(ref))).map(ref => <label key={identity(ref)} className="flex gap-3 py-2 text-xs"><input type="checkbox" checked onChange={() => toggleRef('grants', ref, false)} />{identity(ref)} · 旧修订</label>)}
          </section>
          <section><h3 className="mb-2 font-medium">工具</h3>{!tools.length && <p className="text-xs text-fg-muted">没有可用工具。</p>}
            {tools.map(tool => <label key={tool.name} className="flex items-start gap-3 py-1.5"><input className="mt-1" type="checkbox" checked={environment.tools.includes(tool.name)} onChange={event => setEnvironment({ ...environment, tools: event.target.checked ? [...environment.tools, tool.name] : environment.tools.filter(name => name !== tool.name) })} /><span className="min-w-0 break-all"><code className="text-xs">{tool.name}</code><span className="mt-0.5 block text-xs text-fg-muted">{tool.description}</span></span></label>)}
          </section>
        </fieldset>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-4"><button className={BUTTON} disabled={saving} onClick={onClose}>取消</button><button className={BUTTON} disabled={!environment || loading || saving || locked} onClick={() => void save()}><Save size={15} aria-hidden />{saving ? '正在保存…' : '保存'}</button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
