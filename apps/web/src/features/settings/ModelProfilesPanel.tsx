import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { AGENT_MODEL_API_FORMATS, getAgentModelPreset, type AgentDiscoveredModel, type AgentModelAPIFormat, type AgentModelProvider, type AgentModelService, type AgentModelServiceInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from './useInFlightSubmit'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { Download, Eye, EyeOff, Loader2, Pencil, Plus, Search, Trash2, X } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { useModelSettingsStore, validateModelInput, isRevisionConflict } from '../../stores/modelSettingsStore'
import { EmptyState } from '../../components/states/StateViews'
import { RevisionConflictNotice } from './RevisionConflictNotice'
import { SelectDropdown } from '../../components/SelectDropdown'
import { SuggestionInput } from '../../components/SuggestionInput'
import { ScrollArea } from '../../components/ScrollArea'
import { RefreshButton } from '../../components/RefreshState'
import { ModelAdvancedFields } from './ModelAdvancedFields'
import { blankModel, discoveredModelDraft, modelPresetDraft, savedModelDraft, type DraftModel } from './modelDraft'

const formatTokens = (value: number) => value >= 1024 * 1024 ? `${Number((value / (1024 * 1024)).toFixed(2))}M` : value >= 1024 ? `${Math.round(value / 1024)}k` : String(value)
const iconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40'

/** 服务共享地址、协议与凭据，模型保留各自修订；整个服务的修改以一次 CAS 提交。 */
export function ModelProfilesPanel({ active = true, refreshing = false, onRefresh }: { active?: boolean; refreshing?: boolean; onRefresh?: () => void }) {
  const services = useModelSettingsStore(state => state.services)
  const search = useModelSettingsStore(state => state.search)
  const setSearch = useModelSettingsStore(state => state.setSearch)
  const [editing, setEditing] = useState<AgentModelService | 'new'>()
  const rows = useMemo(() => services.flatMap(service => service.models.map(model => ({ service, model }))).filter(({ service, model }) => [service.name, model.model, service.baseUrl].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))), [services, search])
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => setEditing('new')} className={CTL_PRIMARY}><span className="inline-flex items-center gap-1.5"><Plus aria-hidden size={14} />新建模型配置</span></button>
      <div className="relative min-w-0 flex-1 sm:max-w-72">
        <label htmlFor="agent-models-search" className="sr-only">搜索模型 ID、服务或地址</label>
        <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input id="agent-models-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索模型 ID、服务或地址" className="ctl-field h-9 w-full pl-8" />
      </div>
      {onRefresh ? <RefreshButton label="刷新模型配置" busy={refreshing} onPress={onRefresh} /> : null}
    </div>
    {rows.length === 0 ? <EmptyState title={search.trim() ? '没有匹配的模型配置' : '还没有模型配置'} description={search.trim() ? '换个关键词，或清空过滤查看全部模型配置。' : '添加 DeepSeek、智谱或自定义模型服务，同一服务可配置多个模型。'} /> : <div role="region" aria-label="模型配置列表" tabIndex={0} className="table-scrollbar min-w-0 overflow-x-auto panel-surface">
      <table className="w-full min-w-[54rem] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>{['30%', '28%', '8%', '8%', '10%', '9%', '7%'].map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
        <thead><tr>{['模型 ID', '服务地址', '上下文', '输出', '能力', '状态', '操作'].map((label, index) => <th key={label} scope="col" className={`border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted ${index === 0 ? 'sticky left-0 z-20 border-r' : ''}`}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(({ service, model }) => {
          const details = `${service.name} · ${AGENT_MODEL_API_FORMATS.find(format => format.value === service.apiFormat)?.label.split(' (')[0]} · 修订 ${model.revision}`
          return <tr key={model.id} className="group transition-colors hover:bg-surface-raised">
          <td className="sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-3 transition-colors group-hover:bg-surface-raised"><span className="block truncate font-mono text-xs font-medium" title={model.model}>{model.model}</span><span className="block truncate text-xs text-fg-subtle" title={details}>{details}</span></td>
          <td className="border-b border-line px-3 py-3"><span className="block truncate font-mono text-xs" title={service.baseUrl}>{service.baseUrl}</span><span className="text-xs text-fg-subtle">{service.hasCredential ? '已配置 API Key' : '未配置 API Key'}</span></td>
          <td className="border-b border-line px-3 py-3 tabular-nums text-fg-muted">{formatTokens(model.contextTokens)}</td>
          <td className="border-b border-line px-3 py-3 tabular-nums text-fg-muted">{formatTokens(model.outputTokens)}</td>
          <td className="border-b border-line px-3 py-3"><StatusTag label={model.capabilities.image || model.capabilities.video ? '多模态' : '文本'} tone="info" /></td>
          <td className="border-b border-line px-3 py-3"><StatusTag label={model.active ? '已启用' : '已停用'} tone={model.active ? 'success' : 'neutral'} /></td>
          <td className="border-b border-line px-3 py-3"><button type="button" onClick={() => setEditing(service)} aria-label={`编辑 ${model.model}`} className={iconButton}><Pencil aria-hidden size={14} /></button></td>
        </tr>})}</tbody>
      </table>
    </div>}
    {editing !== undefined && <ModelServiceDialog visible={active} service={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
  </div>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <Switch.Root aria-label={label} checked={checked} onCheckedChange={onChange} className="ui-switch relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"><Switch.Thumb className="ui-switch-thumb ml-0.5 block size-3.5 data-[state=checked]:translate-x-4" /></Switch.Root>
}

function ModelServiceDialog({ service, visible, onClose }: { service?: AgentModelService; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const saveService = useModelSettingsStore(state => state.saveService)
  const latest = useModelSettingsStore(state => state.services.find(item => item.id === service?.id))
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [revision, setRevision] = useState(service?.revision ?? 0)
  const [provider, setProvider] = useState<AgentModelProvider>(service?.provider ?? 'openai-compatible')
  const [apiFormat, setAPIFormat] = useState<AgentModelAPIFormat>(service?.apiFormat ?? 'anthropic-messages')
  const [name, setName] = useState(service?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? '')
  const [credential, setCredential] = useState('')
  const [showCredential, setShowCredential] = useState(false)
  const [models, setModels] = useState<DraftModel[]>(() => service?.models.map(savedModelDraft) ?? [])
  const [expanded, setExpanded] = useState<string>()
  const [error, setError] = useState<string>()
  const [catalog, setCatalog] = useState<readonly AgentDiscoveredModel[]>()
  const [catalogError, setCatalogError] = useState<string>()
  const [fetchingModels, setFetchingModels] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const discoveryRequest = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    setCatalog(undefined); setCatalogError(undefined); setCatalogSearch(''); setSelectedModels([]); setFetchingModels(false)
    return () => { discoveryRequest.current?.abort(); discoveryRequest.current = undefined }
  }, [provider, apiFormat, baseUrl, credential, revision])
  const discoverModels = async () => {
    if (discoveryRequest.current) return
    if (!baseUrl.trim()) { setCatalogError('请先填写 Base URL'); return }
    if (!(credential.trim() || service?.hasCredential)) { setCatalogError('获取模型前请先配置 API Key'); return }
    const controller = new AbortController()
    discoveryRequest.current = controller
    setFetchingModels(true); setCatalogError(undefined)
    try {
      const rows = await gateway.modelSettings.discoverModels({ provider, apiFormat, baseUrl, ...(credential ? { credential } : {}), ...(service ? { serviceId: service.id, expectedRevision: revision } : {}) }, controller.signal)
      if (discoveryRequest.current === controller) { setCatalog(rows); setSelectedModels([]) }
    } catch (error) {
      if (discoveryRequest.current === controller && !controller.signal.aborted) {
        setCatalogError(error instanceof Error ? error.message : '获取模型失败，请重试或手动添加')
        if (isRevisionConflict(error)) await useModelSettingsStore.getState().refresh(gateway)
      }
    } finally {
      if (discoveryRequest.current === controller) { discoveryRequest.current = undefined; setFetchingModels(false) }
    }
  }
  const selected = catalog?.filter(row => selectedModels.includes(row.model) && !models.some(model => model.model.trim() === row.model)) ?? []
  const addSelectedModels = () => {
    if (selected.length === 0 || models.length + selected.length > 64) return
    const rows = selected.map(model => discoveredModelDraft(provider, model))
    setModels(current => [...current, ...rows]); setSelectedModels([]); setExpanded(undefined); setError(undefined)
  }
  const patch = (key: string, values: Partial<DraftModel>) => setModels(rows => rows.map(row => row.key === key ? { ...row, ...values } : row))
  const selectFormat = (next: AgentModelAPIFormat) => {
    setAPIFormat(next)
    if (provider === 'deepseek' && ['https://api.deepseek.com', 'https://api.deepseek.com/anthropic'].includes(baseUrl.replace(/\/+$/, ''))) setBaseUrl(next === 'anthropic-messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com')
  }
  const submit = async () => {
    if (models.length === 0) { setError('请先添加至少一个模型'); return }
    const input: AgentModelServiceInput = {
      name,
      provider,
      apiFormat,
      baseUrl,
      active: service?.active ?? true,
      ...(credential ? { credential } : {}),
      models: models.map(row => ({
        ...(row.id ? { id: row.id } : {}),
        model: row.model,
        contextTokens: Number(row.contextTokens),
        outputTokens: Number(row.outputTokens),
        capabilities: {
          text: row.text,
          tools: row.tools,
          image: row.image,
          video: row.video,
          pdf: row.pdf,
          structuredOutput: row.structuredOutput,
          webSearch: row.webSearch,
          systemMessages: row.systemMessages,
          reasoningLevels: row.reasoningLevels,
          ...(row.defaultReasoningLevel ? { defaultReasoningLevel: row.defaultReasoningLevel } : {}),
          source: row.source,
        },
        enabled: row.enabled,
      })),
    }
    if (!(credential.trim() || service?.hasCredential)) { setError('请配置 API Key'); return }
    for (const row of input.models) { const invalid = validateModelInput({ ...input, ...row, active: input.active && row.enabled }, service?.hasCredential); if (invalid) { setError(invalid); return } }
    if (new Set(input.models.map(row => row.model.trim())).size !== models.length) { setError('同一服务不能重复配置相同模型 ID'); return }
    setError(undefined)
    const ok = await inFlightOnly(() => saveService(gateway, input, service ? { id: service.id, revision } : undefined))
    if (ok) onClose()
  }
  return <Dialog.Root open={visible} onOpenChange={next => !next && onClose()}>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
      <Dialog.Content aria-describedby="model-service-description" className="fixed left-1/2 top-1/2 z-[61] flex max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3"><Dialog.Title className="text-sm font-semibold">{service ? '编辑模型配置' : '新建模型配置'}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="关闭模型配置表单" className={iconButton}><X aria-hidden size={16} /></button></Dialog.Close></div>
        <form onSubmit={event => { event.preventDefault(); void submit() }} className="flex min-h-0 flex-col">
          <ScrollArea label="模型配置表单"><fieldset disabled={submitting} className="flex min-w-0 flex-col gap-4 px-5 py-4">
            <Dialog.Description id="model-service-description" className="text-xs leading-relaxed text-fg-subtle">同一服务下的模型共用地址、API 格式与凭据，保存后统一生效。</Dialog.Description>
            {!service && <Field label="提供商" id="model-provider"><SelectDropdown id="model-provider" ariaLabel="提供商" value={provider} onSelect={next => { setProvider(next); setName(next === 'deepseek' ? 'DeepSeek' : next === 'zhipu' ? '智谱 BigModel' : ''); setError(undefined); if (next === 'deepseek') setBaseUrl(apiFormat === 'anthropic-messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com'); if (next === 'zhipu') { setAPIFormat('chat-completions'); setBaseUrl('https://open.bigmodel.cn/api/coding/paas/v4'); if (models.length === 0) setModels([discoveredModelDraft('zhipu', { model: 'glm-5.3', name: 'GLM-5.3' }), discoveredModelDraft('zhipu', { model: 'glm-5.3-flash', name: 'GLM-5.3-Flash' })]) } }} fullWidth disabled={submitting} items={[{ value: 'openai-compatible', label: '自定义（兼容 API）' }, { value: 'deepseek', label: 'DeepSeek' }, { value: 'zhipu', label: '智谱 BigModel Coding Plan（国内）' }]} /></Field>}
            {provider === 'openai-compatible' && <div><label htmlFor="agent-service-name" className="sr-only">名称</label><input id="agent-service-name" required maxLength={120} placeholder="服务名称" value={name} onChange={event => setName(event.target.value)} className={`${CTL_FIELD} h-9 w-full font-semibold`} /></div>}
            <Field label="Base URL" id="agent-model-baseurl"><input id="agent-model-baseurl" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className={`${CTL_FIELD} h-9 w-full font-mono text-xs`} /></Field>
            <Field label="API 格式" id="agent-api-format"><SelectDropdown id="agent-api-format" ariaLabel="API 格式" value={apiFormat} onSelect={selectFormat} fullWidth disabled={submitting} items={AGENT_MODEL_API_FORMATS} /></Field>
            <Field label="API Key" id="agent-model-credential"><div className="relative"><input id="agent-model-credential" type={showCredential ? 'text' : 'password'} value={credential} onChange={event => setCredential(event.target.value)} autoComplete="new-password" placeholder={service?.hasCredential ? '留空沿用现有 API Key' : '输入 API Key'} className={`${CTL_FIELD} h-9 w-full pr-10 font-mono text-xs`} /><button type="button" aria-label={showCredential ? '隐藏 API Key' : '显示输入的 API Key'} onClick={() => setShowCredential(value => !value)} className={`${iconButton} absolute right-1 top-0.5`}>{showCredential ? <EyeOff aria-hidden size={14} /> : <Eye aria-hidden size={14} />}</button></div>
              <div className="mt-1.5 text-xs text-fg-subtle">{service?.hasCredential ? '必填；留空沿用现有 API Key，输入新值则替换，已有凭据不回显。' : '必填；保存后只写入不回显。'}</div>
            </Field>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-fg-muted">模型列表 <span className="text-fg-subtle">({models.length})</span></span><div className="flex flex-wrap items-center gap-2"><button type="button" disabled={fetchingModels} onClick={() => void discoverModels()} className={CTL_SECONDARY}><span className="inline-flex items-center gap-1">{fetchingModels ? <Loader2 aria-hidden size={13} className="animate-spin motion-reduce:animate-none" /> : <Download aria-hidden size={13} />}{fetchingModels ? '获取中…' : '获取模型'}</span></button><button type="button" disabled={models.length >= 64} onClick={() => { const row = blankModel(); setModels(rows => [...rows, row]); setExpanded(row.key); setError(undefined) }} className={CTL_SECONDARY}><span className="inline-flex items-center gap-1"><Plus aria-hidden size={13} />添加模型</span></button></div></div>
              {catalogError && <p role="alert" className="text-xs text-danger">{catalogError}</p>}
              {fetchingModels && <p role="status" className="text-xs text-fg-subtle">正在读取服务提供的模型列表…</p>}
              {catalog !== undefined && <div role="region" aria-label="可选模型" className="flex flex-col gap-2 border-y border-line py-3">
                <div className="flex items-center justify-between gap-2"><span className="text-xs text-fg-muted">可选模型（{catalog.length}）</span><button type="button" aria-label="收起可选模型" onClick={() => setCatalog(undefined)} className={iconButton}><X aria-hidden size={14} /></button></div>
                {catalog.length === 0 ? <p role="status" className="text-xs text-fg-subtle">服务没有返回可用模型，可以手动添加。</p> : <>
                  <label htmlFor="model-catalog-search" className="sr-only">搜索可选模型</label><input id="model-catalog-search" type="search" value={catalogSearch} onChange={event => setCatalogSearch(event.target.value)} placeholder="搜索模型名称或 ID" className={`${CTL_FIELD} h-9 w-full`} />
                  <div className="max-h-48 overflow-y-auto">{catalog.filter(row => [row.name, row.model].some(value => value.toLowerCase().includes(catalogSearch.trim().toLowerCase()))).map(row => {
                    const added = models.some(model => model.model.trim() === row.model)
                    return <label key={row.model} className="flex min-h-11 items-center gap-2 rounded px-2 py-2 text-xs hover:bg-surface-raised"><input type="checkbox" disabled={added} checked={added || selectedModels.includes(row.model)} onChange={event => setSelectedModels(current => event.target.checked ? [...current, row.model] : current.filter(model => model !== row.model))} aria-label={`选择 ${row.model}`} /><span className="min-w-0 flex-1"><span className="block truncate text-fg" title={row.name}>{row.name}</span><span className="block truncate font-mono text-fg-subtle" title={row.model}>{row.model}</span></span>{row.contextTokens && <span className="shrink-0 tabular-nums text-fg-muted">{formatTokens(row.contextTokens)}</span>}{added && <span className="shrink-0 text-fg-subtle">已添加</span>}</label>
                  })}{catalogSearch.trim() && !catalog.some(row => [row.name, row.model].some(value => value.toLowerCase().includes(catalogSearch.trim().toLowerCase()))) && <p className="py-2 text-xs text-fg-subtle">没有匹配的模型。</p>}</div>
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-fg-subtle">{models.length + selected.length > 64 ? '每个服务最多配置 64 个模型。' : '选择后添加，参数仍可编辑。'}</span><button type="button" disabled={selected.length === 0 || models.length + selected.length > 64} onClick={addSelectedModels} className={CTL_SECONDARY}>添加选中模型{selected.length > 0 ? `（${selected.length}）` : ''}</button></div>
                </>}
              </div>}
              {models.length === 0 && <p className="py-3 text-xs text-fg-subtle">尚未添加模型，可获取模型或手动添加。</p>}
              {models.map((row, index) => <div key={row.key} className="rounded-lg border border-line">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"><span className="min-w-0 basis-full truncate font-mono text-sm sm:flex-1 sm:basis-auto" title={row.model}>{row.model || `新模型 ${index + 1}`}</span><span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] tabular-nums text-fg-muted">{formatTokens(Number(row.contextTokens))}</span><StatusTag label={row.image || row.video ? '多模态' : '文本'} tone="neutral" /><div className="ml-auto flex items-center gap-1"><button type="button" aria-label={`编辑模型 ${index + 1}`} aria-expanded={expanded === row.key} aria-controls={`model-fields-${row.key}`} onClick={() => setExpanded(value => value === row.key ? undefined : row.key)} className={iconButton}><Pencil aria-hidden size={13} /></button><button type="button" aria-label={`移除模型 ${index + 1}`} disabled={Boolean(service) && models.length === 1} onClick={() => setModels(rows => rows.filter(model => model.key !== row.key))} className={iconButton}><Trash2 aria-hidden size={13} /></button><Toggle label={`启用模型 ${index + 1}`} checked={row.enabled} onChange={value => patch(row.key, { enabled: value })} /></div></div>
                {expanded === row.key && <fieldset id={`model-fields-${row.key}`} className="grid grid-cols-1 gap-4 border-t border-line p-3 sm:grid-cols-2"><legend className="sr-only">模型 {index + 1} 参数</legend>
                  <div className="sm:col-span-2"><Field label="模型 ID" id={`model-id-${row.key}`}><SuggestionInput id={`model-id-${row.key}`} ariaLabel="模型 ID" items={catalog?.map(model => ({ value: model.model, label: model.name })) ?? []} required maxLength={200} disabled={submitting} value={row.model} onValueChange={model => patch(row.key, { model, ...modelPresetDraft(provider, model) })} className="h-9 w-full font-mono text-xs" /></Field></div>
                  <Field label="上下文上限（token）" id={`model-context-${row.key}`}><input id={`model-context-${row.key}`} type="number" required min={1} max={2000000} step={1} value={row.contextTokens} onChange={event => patch(row.key, { contextTokens: event.target.value })} className={`${CTL_FIELD} h-9 w-full tabular-nums`} /></Field>
                  <Field label="输出上限（token）" id={`model-output-${row.key}`}><input id={`model-output-${row.key}`} type="number" required min={1} max={Number(row.contextTokens) || 2000000} step={1} value={row.outputTokens} onChange={event => patch(row.key, { outputTokens: event.target.value })} className={`${CTL_FIELD} h-9 w-full tabular-nums`} /></Field>
                  {getAgentModelPreset(provider, row.model) && <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                    <a href={getAgentModelPreset(provider, row.model)!.documentationUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline underline-offset-4">查看官方参数</a>
                    <button type="button" onClick={() => patch(row.key, modelPresetDraft(provider, row.model)!)} className={CTL_SECONDARY}>应用官方参数</button>
                  </div>}
                  <ModelAdvancedFields row={row} onChange={values => patch(row.key, values)} />
                </fieldset>}
              </div>)}
            </div>
            {provider === 'deepseek' && <p className="text-xs text-fg-subtle">DeepSeek 使用非思考模式；获取或手动添加后，模型参数均可编辑。</p>}
            {provider === 'zhipu' && <p className="text-xs text-fg-subtle">智谱 BigModel Coding Plan 须使用套餐 API Key 与专属地址，仅支持 Chat Completions；已按官方文档带出 GLM-5.3 与 GLM-5.3-Flash，两者始终启用思考，档位 low／high／max（默认最高），可按需增删。</p>}
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            {service && <RevisionConflictNotice latest={latest} baseRevision={revision} onAccept={setRevision} />}
          </fieldset></ScrollArea>
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3"><button type="button" onClick={onClose} className={CTL_SECONDARY}>取消</button><button type="submit" disabled={submitting} className={CTL_PRIMARY}>{service ? '保存模型配置' : '创建模型配置'}</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <div><label htmlFor={id} className="mb-1.5 block text-xs text-fg-muted">{label}</label>{children}</div>
}
