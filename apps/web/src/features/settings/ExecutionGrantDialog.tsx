import { useEffect, useId, useRef, useState } from 'react'
import type { AgentExecutionGrant, AgentExecutionGrantInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { executionResourceChoices, type ExecutionResourceChoice } from '../../adapters/agentExecutionResources'
import { EXECUTION_RESOURCE_DOMAINS, validateExecutionGrant, type ExecutionFieldErrors } from '../../adapters/agentExecutionValidation'
import { useAgentExecutionStore, type ExecutionSaveResult } from '../../stores/agentExecutionStore'
import { CTL_FIELD, CTL_SECONDARY } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { Plus, Trash2 } from '../../components/icons'
import { ExtensionDialog, ExtensionToggle, IconAction } from './extensionUi'
import { ExecutionField, ExecutionFooter, ExecutionSaveNotice, useExecutionFields } from './executionUi'

type Directory = { path: string; access: 'ro' | 'rw' }
type Endpoint = { scheme: 'http' | 'https'; host: string; port: string }
type Resource = { domain: string; id: string; access: 'read' | 'write' }
type Inventory = { loading: boolean; items: ExecutionResourceChoice[]; error?: string }
const knownDirectories = new Set(['docker-container', 'docker-image', 'website', 'container-app', 'database'])

export function ExecutionGrantDialog({ grant, visible, onClose }: { grant?: AgentExecutionGrant; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const [name, setName] = useState(grant?.name ?? '')
  const [enabled, setEnabled] = useState(grant?.enabled ?? true)
  const [disableConfirmed, setDisableConfirmed] = useState(false)
  const [directories, setDirectories] = useState<Directory[]>(grant ? grant.directories.map(item => ({ ...item })) : [])
  const [network, setNetwork] = useState<Endpoint[]>(grant ? grant.network.map(item => ({ ...item, port: String(item.port) })) : [])
  const [resources, setResources] = useState<Resource[]>(grant?.resources?.map(item => ({ ...item })) ?? [])
  const [cidrs, setCIDRs] = useState(grant?.privateCidrs.join('\n') ?? '')
  const [revision, setRevision] = useState(grant?.revision ?? 0)
  const [mountRoot, setMountRoot] = useState<string>()
  const [rootError, setRootError] = useState<string>()
  const [inventories, setInventories] = useState<Record<string, Inventory>>({})
  const requested = useRef(new Set<string>())
  const [errors, setErrors] = useState<ExecutionFieldErrors>({})
  const [result, setResult] = useState<ExecutionSaveResult>()
  const [saving, setSaving] = useState(false)
  const lifetime = useRef(0)
  const form = useId(), field = useExecutionFields(errors)
  useEffect(() => {
    // StrictMode 会重放挂载效果；前一代目录请求失效后必须允许新一代重新读取。
    requested.current.clear()
    const owner = ++lifetime.current, auth = captureAuthGeneration()
    void gateway.containers.createPolicy().then(policy => { if (owner === lifetime.current && auth === captureAuthGeneration()) setMountRoot(policy.mountRoot) }).catch(cause => { if (owner === lifetime.current && auth === captureAuthGeneration()) setRootError(cause instanceof Error ? cause.message : '挂载根读取失败') })
    return () => { lifetime.current += 1 }
  }, [gateway])
  const loadDomain = async (domain: string) => {
    if (!knownDirectories.has(domain)) return
    requested.current.add(domain)
    const owner = lifetime.current, auth = captureAuthGeneration()
    setInventories(previous => ({ ...previous, [domain]: { loading: true, items: previous[domain]?.items ?? [] } }))
    try { const items = await executionResourceChoices(gateway, domain); if (owner === lifetime.current && auth === captureAuthGeneration()) setInventories(previous => ({ ...previous, [domain]: { loading: false, items } })) }
    catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setInventories(previous => ({ ...previous, [domain]: { loading: false, items: previous[domain]?.items ?? [], error: cause instanceof Error ? cause.message : '资源目录读取失败' } })) }
  }
  const domains = [...new Set(resources.map(resource => resource.domain))].sort().join('|')
  useEffect(() => { for (const domain of domains.split('|')) if (!requested.current.has(domain)) void loadDomain(domain) }, [domains, gateway])
  const submit = async () => {
    if (saving || result?.status === 'unknown') return
    const input: AgentExecutionGrantInput = { name: name.trim(), enabled, expectedRevision: revision, directories, network: network.map(item => ({ ...item, host: item.host.toLowerCase(), port: Number(item.port) })), privateCidrs: cidrs.split('\n').map(value => value.trim()).filter(Boolean), resources }
    const nextErrors = validateExecutionGrant(input, mountRoot)
    if (grant?.enabled && !enabled && !disableConfirmed) nextErrors.enabled = '请确认停用对后续操作的影响。'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    setSaving(true)
    const next = await useAgentExecutionStore.getState().saveGrant(gateway, input, grant?.id)
    if (owner !== lifetime.current || auth !== captureAuthGeneration() || next.status === 'stale') return
    setSaving(false)
    if (next.status === 'saved') onClose(); else setResult(next)
  }
  return <ExtensionDialog title={grant ? '编辑资源授权' : '新建资源授权'} open={visible} onClose={() => { if (!saving) onClose() }} wide
    footer={<ExecutionFooter form={form} saving={saving} unknown={result?.status === 'unknown'} onClose={onClose} />}>
    <form id={form} noValidate onSubmit={event => { event.preventDefault(); void submit() }} className="space-y-5">
      <fieldset disabled={saving} className="min-w-0 space-y-6">
        <ExecutionField label="授权名称" id={field('name').id} error={errors.name}><input {...field('name')} className={`${CTL_FIELD} w-full`} value={name} onChange={event => setName(event.target.value)} /></ExecutionField>
        <section aria-label="目录授权" className="space-y-3">
          <h3 className="text-sm font-medium">目录</h3>
          <p className="break-all text-xs text-fg-muted">业务挂载根：<code>{mountRoot ?? '尚未读取'}</code></p>
          {rootError && <p className="text-xs text-danger" role="alert">{rootError}；路径最终由服务端验证。</p>}
          {directories.map((directory, index) => <div key={index} className="space-y-2 border-b border-line pb-3">
            <div className="flex min-w-0 flex-wrap items-end gap-2"><div className="min-w-0 flex-[1_1_16rem]"><ExecutionField label={`目录 ${index + 1}`} id={field(`directories.${index}`).id} error={errors[`directories.${index}`]}><input {...field(`directories.${index}`)} className={`${CTL_FIELD} w-full font-mono text-xs`} placeholder={mountRoot ? `${mountRoot}/项目目录` : '真实绝对路径'} value={directory.path} onChange={event => setDirectories(directories.map((item, i) => i === index ? { ...item, path: event.target.value } : item))} /></ExecutionField></div>
              <SelectDropdown ariaLabel={`目录 ${index + 1} 权限`} items={[{ value: 'ro', label: '只读' }, { value: 'rw', label: '读写' }]} value={directory.access} onSelect={access => setDirectories(directories.map((item, i) => i === index ? { ...item, access } : item))} />
              <IconAction label={`删除目录 ${index + 1}`} onClick={() => setDirectories(directories.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden /></IconAction></div>
            <p className="break-all font-mono text-xs text-fg-muted">{directory.path || '宿主目录'} → /grants/{index}</p>
            {directory.access === 'rw' && <p className="text-xs text-danger">此目录允许真实修改和删除，不能自动回滚。</p>}
          </div>)}
          <button type="button" className={CTL_SECONDARY} disabled={directories.length >= 32} onClick={() => setDirectories([...directories, { path: '', access: 'ro' }])}><Plus size={14} aria-hidden />添加目录</button>
        </section>
        <section aria-label="网络授权" className="space-y-3">
          <h3 className="text-sm font-medium">网络</h3>
          <p className="text-xs leading-5 text-fg-muted">仅授权精确协议、域名与端口；回环、元数据地址、IP 地址和通配域名不支持。</p>
          {network.map((endpoint, index) => <div key={index} className="space-y-2 border-b border-line pb-3"><div className="flex min-w-0 flex-wrap items-end gap-2">
            <SelectDropdown ariaLabel={`网络 ${index + 1} 协议`} items={[{ value: 'https', label: 'HTTPS' }, { value: 'http', label: 'HTTP' }]} value={endpoint.scheme} onSelect={scheme => setNetwork(network.map((item, i) => i === index ? { ...item, scheme, port: item.port === '443' || item.port === '80' ? scheme === 'https' ? '443' : '80' : item.port } : item))} />
            <div className="min-w-0 flex-[1_1_12rem]"><ExecutionField label={`网络 ${index + 1} 域名`} id={field(`network.${index}`).id} error={errors[`network.${index}`]}><input {...field(`network.${index}`)} className={`${CTL_FIELD} w-full font-mono text-xs`} placeholder="api.example.com" value={endpoint.host} onChange={event => setNetwork(network.map((item, i) => i === index ? { ...item, host: event.target.value } : item))} /></ExecutionField></div>
            <div className="w-24"><ExecutionField label={`网络 ${index + 1} 端口`} id={`${form}-port-${index}`}><input id={`${form}-port-${index}`} className={`${CTL_FIELD} w-full tabular-nums`} type="number" min={1} max={65535} value={endpoint.port} onChange={event => setNetwork(network.map((item, i) => i === index ? { ...item, port: event.target.value } : item))} /></ExecutionField></div>
            <IconAction label={`删除网络 ${index + 1}`} onClick={() => setNetwork(network.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden /></IconAction>
          </div></div>)}
          <button type="button" className={CTL_SECONDARY} disabled={network.length >= 64} onClick={() => setNetwork([...network, { scheme: 'https', host: '', port: '443' }])}><Plus size={14} aria-hidden />添加网络</button>
          <details open={Object.keys(errors).some(key => key.startsWith('privateCidrs.'))}><summary className="cursor-pointer text-xs font-medium">高级设置：私网网段</summary><div className="mt-3"><ExecutionField label="私网网段（每行一个 CIDR）" id={`${form}-cidrs`} error={Object.entries(errors).filter(([key]) => key.startsWith('privateCidrs.')).map(([, error]) => error).join('；') || undefined}><textarea id={`${form}-cidrs`} className={`${CTL_FIELD} min-h-24 w-full font-mono text-xs`} value={cidrs} onChange={event => setCIDRs(event.target.value)} /></ExecutionField><p className="mt-2 text-xs text-fg-muted">只补充域名解析到私网时允许的地址范围，不独立授予出网权限。</p></div></details>
        </section>
        <section aria-label="平台对象授权" className="space-y-3">
          <h3 className="text-sm font-medium">平台对象</h3>
          <p className="text-xs leading-5 text-fg-muted">写授权覆盖该对象已开放的写工具，是否逐项确认由聊天权限模式决定。只读授权不会限制其他默认开放的状态查询。</p>
          {resources.map((resource, index) => {
            const inventory = inventories[resource.domain]
            return <div key={index} className="space-y-3 border-b border-line pb-3">
              <div className="flex flex-wrap items-center gap-2"><SelectDropdown ariaLabel={`平台对象 ${index + 1} 类型`} items={EXECUTION_RESOURCE_DOMAINS} value={resource.domain} onSelect={domain => setResources(resources.map((item, i) => i === index ? { ...item, domain, id: '' } : item))} />
                <SelectDropdown ariaLabel={`平台对象 ${index + 1} 权限`} items={[{ value: 'read', label: '只读' }, { value: 'write', label: '写入' }]} value={resource.access} onSelect={access => setResources(resources.map((item, i) => i === index ? { ...item, access } : item))} />
                <IconAction label={`删除平台对象 ${index + 1}`} onClick={() => setResources(resources.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden /></IconAction></div>
              {knownDirectories.has(resource.domain) && <SelectDropdown ariaLabel={`选择平台对象 ${index + 1}`} items={inventory?.items ?? []} value={inventory?.items.some(item => item.value === resource.id) ? resource.id : undefined} fallbackLabel={inventory?.loading ? '正在读取对象…' : '从现有对象中选择'} emptyLabel="没有可列出的对象，可填写下方精确标识。" fullWidth search={{ ariaLabel: `搜索平台对象 ${index + 1}`, placeholder: '搜索名称或标识' }} onSelect={id => setResources(resources.map((item, i) => i === index ? { ...item, id } : item))} />}
              {inventory?.error && <p className="text-xs text-danger" role="alert">{inventory.error} <button type="button" className="underline" onClick={() => void loadDomain(resource.domain)}>重新读取对象</button>；也可手填精确标识。</p>}
              <ExecutionField label={`平台对象 ${index + 1} 精确标识`} id={field(`resources.${index}`).id} error={errors[`resources.${index}`]}><input {...field(`resources.${index}`)} className={`${CTL_FIELD} w-full font-mono text-xs`} value={resource.id} onChange={event => setResources(resources.map((item, i) => i === index ? { ...item, id: event.target.value } : item))} /></ExecutionField>
              <p className="text-xs text-fg-muted">{resource.domain === 'docker-image' ? '删除本机镜像使用镜像 ID；拉取新镜像需另填工具要求的镜像引用。' : resource.domain === 'docker-container' ? '已有容器使用完整 ID；创建容器需另填精确名称。' : '提交精确标识，不以显示名称或通配符代替。'}</p>
            </div>
          })}
          <button type="button" className={CTL_SECONDARY} disabled={resources.length >= 128} onClick={() => setResources([...resources, { domain: 'docker-container', id: '', access: 'read' }])}><Plus size={14} aria-hidden />添加平台对象</button>
        </section>
        <ExtensionToggle label="启用此资源授权" checked={enabled} onChange={setEnabled} />
        {grant?.enabled && !enabled && <div className="space-y-2 text-xs"><label className="flex items-start gap-2"><input type="checkbox" checked={disableConfirmed} onChange={event => setDisableConfirmed(event.target.checked)} /><span>确认停用：阻止后续使用并保留历史，不保证停止已派发的操作。</span></label>{errors.enabled && <p role="alert" className="text-danger">{errors.enabled}</p>}</div>}
      </fieldset>
      <section aria-label="完整授权摘要" className="space-y-2 border-t border-line pt-4 text-xs">
        <h3 className="font-medium">保存的授权范围</h3>
        {!directories.length && !network.length && !resources.length && !cidrs.trim() && <p className="text-fg-muted">尚未添加范围。</p>}
        {directories.map((item, index) => <p key={`d${index}`} className={`break-all font-mono ${item.access === 'rw' ? 'text-danger' : 'text-fg-muted'}`}>{item.path || '未填写目录'} → /grants/{index} · {item.access === 'rw' ? '读写 · 真实修改' : '只读'}</p>)}
        {network.map((item, index) => <p key={`n${index}`} className="break-all font-mono text-fg-muted">{item.scheme}://{item.host || '未填写域名'}:{item.port}</p>)}
        {resources.map((item, index) => <p key={`r${index}`} className="break-all font-mono text-fg-muted">{item.domain} / {item.id || '未填写标识'} · {item.access}</p>)}
        {cidrs.split('\n').filter(item => item.trim()).map((item, index) => <p key={`c${index}`} className="break-all font-mono text-fg-muted">私网：{item}</p>)}
        {errors.scope && <p role="alert" className="text-danger">{errors.scope}</p>}
      </section>
      <ExecutionSaveNotice result={result} revision={revision} onRevision={setRevision} onAcknowledge={() => setResult(current => current ? { ...current, status: 'error', message: undefined } : undefined)} />
    </form>
  </ExtensionDialog>
}
