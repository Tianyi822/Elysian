import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { AGENT_MODEL_API_FORMATS, getAgentModelPreset, type AgentDiscoveredModel, type AgentModelAPIFormat, type AgentModelProvider, type AgentModelService, type AgentModelServiceInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from './useInFlightSubmit'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { CircleCheck, CircleMinus, Download, Eye, EyeOff, FileText, Image, Pencil, Plus, Trash2, X, type IconComponent } from '../../components/icons'
import { LoadingOrb } from '../../components/LoadingOrb'
import { SearchInput } from '../../components/SearchInput'
import { StatusTag } from '../../components/StatusTag'
import { useModelSettingsStore, validateModelInput, isRevisionConflict } from '../../stores/modelSettingsStore'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { TableBatchActions } from '../../components/TableBatchActions'
import { RevisionConflictNotice } from './RevisionConflictNotice'
import { SelectDropdown } from '../../components/SelectDropdown'
import { SuggestionInput } from '../../components/SuggestionInput'
import { ScrollArea } from '../../components/ScrollArea'
import { RefreshButton } from '../../components/RefreshState'
import { useImeEnterGuard } from '../../components/useImeEnterGuard'
import { ModelAdvancedFields } from './ModelAdvancedFields'
import { blankModel, discoveredModelDraft, modelPresetDraft, savedModelDraft, type DraftModel } from './modelDraft'
import { Button } from '../../components/Button'
import { messageOf } from '../../utils/errorMessage'

const formatTokens = (value: number) => value >= 1024 * 1024 ? `${Number((value / (1024 * 1024)).toFixed(2))}M` : value >= 1024 ? `${Math.round(value / 1024)}k` : String(value)
const iconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40'
type ModelTableRow = { service: AgentModelService; model: AgentModelService['models'][number] }

const capabilityLabel = (model: ModelTableRow['model']) => model.capabilities.image || model.capabilities.video ? '多模态' : '文本'

const modelTagColors = {
  info: 'text-info',
  success: 'text-success',
  neutral: 'text-fg-muted',
}

function ModelTableTag({ label, tone, icon: Icon }: { label: string; tone: keyof typeof modelTagColors; icon: IconComponent }) {
  // At 70rem the two padded 1fr columns have room for the full labels.
  return <>
    <span role="img" aria-label={label} title={label} className={`inline-flex h-6 items-center align-middle @min-[70rem]/model-table:hidden ${modelTagColors[tone]}`}>
      <Icon size={16} aria-hidden />
    </span>
    <span className="hidden @min-[70rem]/model-table:inline-flex"><StatusTag label={label} tone={tone} /></span>
  </>
}

/** 服务共享地址、协议与凭据，模型保留各自修订；整个服务的修改以一次 CAS 提交。 */
export function ModelProfilesPanel({ active = true, refreshing = false, onRefresh }: { active?: boolean; refreshing?: boolean; onRefresh?: () => void }) {
  const gateway = useGateway()
  const services = useModelSettingsStore(state => state.services)
  const search = useModelSettingsStore(state => state.search)
  const setSearch = useModelSettingsStore(state => state.setSearch)
  const saving = useModelSettingsStore(state => state.saving)
  const [selected, setSelected] = useState<(string | number)[]>([])
  const [editing, setEditing] = useState<AgentModelService | 'new'>()
  const allRows = useMemo(() => services.flatMap(service => service.models.map(model => ({ service, model }))), [services])
  const rows = allRows.filter(({ service, model }) => [service.name, model.model, service.baseUrl].some(value => value.toLowerCase().includes(search.trim().toLowerCase())))
  const columns: DataTableColumn<ModelTableRow>[] = [
    { key: 'model', header: '模型 ID', primary: true, width: 'minmax(0,3fr)', accessor: ({ model }) => model.model, cell: ({ service, model }) => {
      const details = `${service.name} · ${AGENT_MODEL_API_FORMATS.find(format => format.value === service.apiFormat)?.label.split(' (')[0]} · 修订 ${model.revision}`
      return <><span className="block truncate font-mono text-xs font-medium" title={model.model}>{model.model}</span><span className="block truncate text-xs text-fg-subtle" title={details}>{details}</span></>
    } },
    { key: 'address', header: '服务地址', width: 'minmax(0,2.8fr)', accessor: ({ service }) => service.baseUrl, cell: ({ service }) => <><span className="block truncate font-mono text-xs" title={service.baseUrl}>{service.baseUrl}</span><span className="text-xs text-fg-subtle">{service.hasCredential ? '已配置 API Key' : '未配置 API Key'}</span></> },
    { key: 'context', header: '上下文', accessor: ({ model }) => model.contextTokens, cell: ({ model }) => <span className="tabular-nums text-fg-muted">{formatTokens(model.contextTokens)}</span> },
    { key: 'output', header: '输出', accessor: ({ model }) => model.outputTokens, cell: ({ model }) => <span className="tabular-nums text-fg-muted">{formatTokens(model.outputTokens)}</span> },
    { key: 'capabilities', header: '能力', accessor: ({ model }) => capabilityLabel(model), cell: ({ model }) => {
      const label = capabilityLabel(model)
      return <ModelTableTag label={label} tone="info" icon={label === '多模态' ? Image : FileText} />
    } },
    { key: 'status', header: '状态', accessor: ({ model }) => model.active, cell: ({ model }) => <ModelTableTag label={model.active ? '已启用' : '已停用'} tone={model.active ? 'success' : 'neutral'} icon={model.active ? CircleCheck : CircleMinus} /> },
    { key: 'actions', header: '操作', sortable: false, cell: ({ service, model }) => <Button variant="ghost" size="icon" type="button" disabled={saving} onClick={() => setEditing(service)} aria-label={`编辑 ${model.model}`} className={iconButton}><Pencil aria-hidden size={14} /></Button> },
  ]
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" type="button" onClick={() => setEditing('new')} className={CTL_PRIMARY}><span className="inline-flex items-center gap-1.5"><Plus aria-hidden size={14} />新建模型配置</span></Button>
      {onRefresh ? <RefreshButton label="刷新模型配置" busy={refreshing} onPress={onRefresh} /> : null}
    </div>
    <DataTable className="@container/model-table" active={active} rows={rows} columns={columns} getRowId={row => row.model.id} getRowLabel={row => row.model.model}
      ariaLabel="模型配置列表" query={search} onQueryChange={setSearch} filterMode="external" searchPlaceholder="搜索模型 ID、服务或地址"
      selected={selected} onSelectionChange={setSelected} selectionKey="settings-models" busy={saving}
      bulkActions={() => <TableBatchActions selectedRows={allRows.filter(row => selected.includes(row.model.id))} getRowId={row => row.model.id} getRowLabel={row => row.model.model} disabled={saving}
        onSucceeded={ids => setSelected(current => current.filter(id => !ids.includes(id)))} actions={[true, false].map(enabled => ({ key: enabled ? 'enable' : 'disable', label: enabled ? '批量启用' : '批量停用', groupBy: (row: ModelTableRow) => row.service.id,
          eligible: ({ service, model }: ModelTableRow) => enabled && !service.active ? '所属服务已停用，请先编辑并启用服务' : model.enabled === enabled ? `模型已${enabled ? '启用' : '停用'}` : undefined,
          execute: (items: readonly ModelTableRow[]) => useModelSettingsStore.getState().setModelsEnabled(gateway, items[0]!.service, items.map(row => row.model.id), enabled),
        }))} />} />
    {editing !== undefined && <ModelServiceDialog visible={active} service={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
  </div>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <ToggleSwitch label={label} checked={checked} onCheckedChange={onChange} />
}

function ModelServiceDialog({ service, visible, onClose }: { service?: AgentModelService; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const saveService = useModelSettingsStore(state => state.saveService)
  const [catalogNotice, setCatalogNotice] = useState<string>()
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
  const [fetchingModels, setFetchingModels] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const discoveryRequest = useRef<AbortController | undefined>(undefined)
  const reportError = (message: string) => { setError(message) }
  useEffect(() => {
    setCatalog(undefined); setCatalogSearch(''); setSelectedModels([]); setFetchingModels(false)
    return () => { discoveryRequest.current?.abort(); discoveryRequest.current = undefined }
  }, [provider, apiFormat, baseUrl, credential, revision])
  const discoverModels = async () => {
    if (discoveryRequest.current) return
    if (!baseUrl.trim()) { setError('请先填写 Base URL'); return }
    if (!(credential.trim() || service?.hasCredential)) { setError('获取模型前请先配置 API Key'); return }
    const controller = new AbortController()
    discoveryRequest.current = controller
    setFetchingModels(true); setCatalog(undefined)
    try {
      const rows = await gateway.modelSettings.discoverModels({ provider, apiFormat, baseUrl, ...(credential ? { credential } : {}), ...(service ? { serviceId: service.id, expectedRevision: revision } : {}) }, controller.signal)
      if (discoveryRequest.current === controller) {
        setCatalog(rows); setSelectedModels([])
        setCatalogNotice(rows.length ? `已获取 ${rows.length} 个模型，请选择后添加。` : '服务没有返回可用模型，可以手动添加。')
      }
    } catch (error) {
      if (discoveryRequest.current === controller && !controller.signal.aborted) {
        setError(messageOf(error, '获取模型失败，请重试或手动添加'))
        if (isRevisionConflict(error)) await useModelSettingsStore.getState().load(gateway)
      }
    } finally {
      if (discoveryRequest.current === controller) { discoveryRequest.current = undefined; setFetchingModels(false) }
    }
  }
  const appendDraftModels = (createRows: () => DraftModel[], expandFirst = false) => {
    try {
      const rows = createRows()
      setModels(current => [...current, ...rows]); setExpanded(expandFirst ? rows[0]?.key : undefined); setError(undefined)
      setCatalogNotice(`已添加 ${rows.length} 个模型到配置草稿，保存后生效。`)
      return true
    } catch {
      reportError('添加模型失败，请重试。')
      return false
    }
  }
  const selected = catalog?.filter(row => selectedModels.includes(row.model) && !models.some(model => model.model.trim() === row.model)) ?? []
  const addSelectedModels = () => {
    if (selected.length === 0 || models.length + selected.length > 64) return
    if (appendDraftModels(() => selected.map(model => discoveredModelDraft(provider, model)))) setSelectedModels([])
  }
  const patch = (key: string, values: Partial<DraftModel>) => setModels(rows => rows.map(row => row.key === key ? { ...row, ...values } : row))
  const selectFormat = (next: AgentModelAPIFormat) => {
    setAPIFormat(next)
    if (provider === 'deepseek' && ['https://api.deepseek.com', 'https://api.deepseek.com/anthropic'].includes(baseUrl.replace(/\/+$/, ''))) setBaseUrl(next === 'anthropic-messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com')
  }
  const { guardProps, isImeKey } = useImeEnterGuard()
  const submit = async () => {
    if (models.length === 0) { reportError('请先添加至少一个模型'); return }
    if (!name.trim()) { reportError('请填写服务名称'); return }
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
    if (!(credential.trim() || service?.hasCredential)) { reportError('请配置 API Key'); return }
    for (const row of input.models) { const invalid = validateModelInput({ ...input, ...row, active: input.active && row.enabled }, service?.hasCredential); if (invalid) { reportError(invalid); return } }
    if (new Set(input.models.map(row => row.model.trim())).size !== models.length) { reportError('同一服务不能重复配置相同模型 ID'); return }
    setError(undefined)
    const ok = await inFlightOnly(() => saveService(gateway, input, service ? { id: service.id, revision } : undefined))
    if (ok) onClose()
    else setError(useModelSettingsStore.getState().errorMessage ?? '保存模型服务失败，请重试。')
  }
  return <Dialog.Root open={visible} onOpenChange={next => !next && onClose()}>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
      <Dialog.Content aria-describedby="model-service-description" className="fixed left-1/2 top-1/2 z-[61] flex max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3"><Dialog.Title className="text-sm font-semibold">{service ? '编辑模型配置' : '新建模型配置'}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" type="button" aria-label="关闭模型配置表单" className={iconButton}><X aria-hidden size={16} /></Button></Dialog.Close></div>
        <form noValidate {...guardProps} onSubmit={event => { event.preventDefault(); if (!isImeKey()) void submit() }} className="flex min-h-0 flex-col">
          <ScrollArea label="模型配置表单"><fieldset disabled={submitting} className="flex min-w-0 flex-col gap-4 px-5 py-4">
            <Dialog.Description id="model-service-description" className="text-xs leading-relaxed text-fg-subtle">同一服务下的模型共用地址、API 格式与凭据，保存后统一生效。</Dialog.Description>
            {!service && <Field label="提供商" id="model-provider"><SelectDropdown id="model-provider" ariaLabel="提供商" value={provider} onSelect={next => { setProvider(next); setName(next === 'deepseek' ? 'DeepSeek' : next === 'zhipu' ? '智谱 BigModel' : ''); setError(undefined); if (next === 'deepseek') setBaseUrl(apiFormat === 'anthropic-messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com'); if (next === 'zhipu') { setAPIFormat('chat-completions'); setBaseUrl('https://open.bigmodel.cn/api/coding/paas/v4'); if (models.length === 0) appendDraftModels(() => [discoveredModelDraft('zhipu', { model: 'glm-5.3', name: 'GLM-5.3' }), discoveredModelDraft('zhipu', { model: 'glm-5.3-flash', name: 'GLM-5.3-Flash' })]) } }} fullWidth disabled={submitting} items={[{ value: 'openai-compatible', label: '自定义（兼容 API）' }, { value: 'deepseek', label: 'DeepSeek' }, { value: 'zhipu', label: '智谱 BigModel Coding Plan（国内）' }]} /></Field>}
            {provider === 'openai-compatible' && <div><label htmlFor="agent-service-name" className="sr-only">名称</label><input id="agent-service-name" required maxLength={120} placeholder="服务名称" value={name} onChange={event => setName(event.target.value)} className={`${CTL_FIELD} h-9 w-full font-semibold`} /></div>}
            <Field label="Base URL" id="agent-model-baseurl"><input id="agent-model-baseurl" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className={`${CTL_FIELD} h-9 w-full font-mono text-xs`} /></Field>
            <Field label="API 格式" id="agent-api-format"><SelectDropdown id="agent-api-format" ariaLabel="API 格式" value={apiFormat} onSelect={selectFormat} fullWidth disabled={submitting} items={AGENT_MODEL_API_FORMATS} /></Field>
            <Field label="API Key" id="agent-model-credential"><div className="relative"><input id="agent-model-credential" type={showCredential ? 'text' : 'password'} value={credential} onChange={event => setCredential(event.target.value)} autoComplete="new-password" placeholder={service?.hasCredential ? '留空沿用现有 API Key' : '输入 API Key'} className={`${CTL_FIELD} h-9 w-full pr-10 font-mono text-xs`} /><Button variant="ghost" size="icon" type="button" aria-label={showCredential ? '隐藏 API Key' : '显示输入的 API Key'} onClick={() => setShowCredential(value => !value)} className={`${iconButton} absolute right-1 top-0.5`}>{showCredential ? <EyeOff aria-hidden size={14} /> : <Eye aria-hidden size={14} />}</Button></div>
              <div className="mt-1.5 text-xs text-fg-subtle">{service?.hasCredential ? '必填；留空沿用现有 API Key，输入新值则替换，已有凭据不回显。' : '必填；保存后只写入不回显。'}</div>
            </Field>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-fg-muted">模型列表 <span className="text-fg-subtle">({models.length})</span></span><div className="flex flex-wrap items-center gap-2"><Button variant="outline" type="button" disabled={fetchingModels} onClick={() => void discoverModels()} className={CTL_SECONDARY}><span className="inline-flex items-center gap-1">{fetchingModels ? <LoadingOrb size={13} /> : <Download aria-hidden size={13} />}{fetchingModels ? '获取中…' : '获取模型'}</span></Button><Button variant="outline" type="button" disabled={models.length >= 64} onClick={() => appendDraftModels(() => [blankModel()], true)} className={CTL_SECONDARY}><span className="inline-flex items-center gap-1"><Plus aria-hidden size={13} />添加模型</span></Button></div></div>
              {fetchingModels && <p role="status" className="text-xs text-fg-subtle">正在读取服务提供的模型列表…</p>}
              {catalog !== undefined && <div role="region" aria-label="可选模型" className="flex flex-col gap-2 border-y border-line py-3">
                <div className="flex items-center justify-between gap-2"><span className="text-xs text-fg-muted">可选模型（{catalog.length}）</span><Button variant="ghost" size="icon" type="button" aria-label="收起可选模型" onClick={() => setCatalog(undefined)} className={iconButton}><X aria-hidden size={14} /></Button></div>
                {catalog.length > 0 && <>
                  <SearchInput id="model-catalog-search" label="搜索可选模型" value={catalogSearch}
                    onChange={setCatalogSearch} placeholder="搜索模型名称或 ID" expandOnFocus={false} className="w-full" />
                  <ul aria-label="模型目录" className="table-scrollbar m-0 max-h-48 list-none space-y-1 overflow-y-auto p-0">{catalog.filter(row => [row.name, row.model].some(value => value.toLowerCase().includes(catalogSearch.trim().toLowerCase()))).map(row => {
                    const added = models.some(model => model.model.trim() === row.model)
                    const isSelected = selectedModels.includes(row.model)
                    return <li key={row.model}>
                      <Button unstyled
                        type="button"
                        disabled={added}
                        aria-label={`选择 ${row.model}`}
                        aria-pressed={added || isSelected}
                        onClick={() => setSelectedModels(current => current.includes(row.model) ? current.filter(model => model !== row.model) : [...current, row.model])}
                        className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default ${isSelected && !added ? 'bg-accent/15 text-accent' : 'text-fg enabled:hover:bg-surface-raised'}`}
                      >
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={row.name}>{row.name}</span><span className="block truncate font-mono text-fg-subtle" title={row.model}>{row.model}</span></span>
                        {row.contextTokens && <span className="shrink-0 tabular-nums text-fg-muted">{formatTokens(row.contextTokens)}</span>}
                        {added && <span className="shrink-0 text-fg-subtle">已添加</span>}
                      </Button>
                    </li>
                  })}{catalogSearch.trim() && !catalog.some(row => [row.name, row.model].some(value => value.toLowerCase().includes(catalogSearch.trim().toLowerCase()))) && <li className="py-2 text-xs text-fg-subtle">没有匹配的模型。</li>}</ul>
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-fg-subtle">{models.length + selected.length > 64 ? '每个服务最多配置 64 个模型。' : '选择后添加，参数仍可编辑。'}</span><Button variant="outline" type="button" disabled={selected.length === 0 || models.length + selected.length > 64} onClick={addSelectedModels} className={CTL_SECONDARY}>添加选中模型{selected.length > 0 ? `（${selected.length}）` : ''}</Button></div>
                </>}
              </div>}
              {models.length === 0 && <p className="py-3 text-xs text-fg-subtle">尚未添加模型，可获取模型或手动添加。</p>}
              {models.map((row, index) => <div key={row.key} className="rounded-lg border border-line">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"><span className="min-w-0 basis-full truncate font-mono text-sm sm:flex-1 sm:basis-auto" title={row.model}>{row.model || `新模型 ${index + 1}`}</span><span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] tabular-nums text-fg-muted">{formatTokens(Number(row.contextTokens))}</span><StatusTag label={row.image || row.video ? '多模态' : '文本'} tone="neutral" /><div className="ml-auto flex items-center gap-1"><Button variant="ghost" size="icon" type="button" aria-label={`编辑模型 ${index + 1}`} aria-expanded={expanded === row.key} aria-controls={`model-fields-${row.key}`} onClick={() => setExpanded(value => value === row.key ? undefined : row.key)} className={iconButton}><Pencil aria-hidden size={13} /></Button><Button variant="ghost" size="icon" type="button" aria-label={`移除模型 ${index + 1}`} disabled={Boolean(service) && models.length === 1} onClick={() => setModels(rows => rows.filter(model => model.key !== row.key))} className={iconButton}><Trash2 aria-hidden size={13} /></Button><Toggle label={`启用模型 ${index + 1}`} checked={row.enabled} onChange={value => patch(row.key, { enabled: value })} /></div></div>
                {expanded === row.key && <fieldset id={`model-fields-${row.key}`} className="grid grid-cols-1 gap-4 border-t border-line p-3 sm:grid-cols-2"><legend className="sr-only">模型 {index + 1} 参数</legend>
                  <div className="sm:col-span-2"><Field label="模型 ID" id={`model-id-${row.key}`}><SuggestionInput id={`model-id-${row.key}`} ariaLabel="模型 ID" items={catalog?.map(model => ({ value: model.model, label: model.name })) ?? []} required maxLength={200} disabled={submitting} value={row.model} onValueChange={model => patch(row.key, { model, ...modelPresetDraft(provider, model) })} className="h-9 w-full font-mono text-xs" /></Field></div>
                  <Field label="上下文上限（token）" id={`model-context-${row.key}`}><input id={`model-context-${row.key}`} type="number" required min={1} max={2000000} step={1} value={row.contextTokens} onChange={event => patch(row.key, { contextTokens: event.target.value })} className={`${CTL_FIELD} h-9 w-full tabular-nums`} /></Field>
                  <Field label="输出上限（token）" id={`model-output-${row.key}`}><input id={`model-output-${row.key}`} type="number" required min={1} max={Number(row.contextTokens) || 2000000} step={1} value={row.outputTokens} onChange={event => patch(row.key, { outputTokens: event.target.value })} className={`${CTL_FIELD} h-9 w-full tabular-nums`} /></Field>
                  {getAgentModelPreset(provider, row.model) && <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                    <a href={getAgentModelPreset(provider, row.model)!.documentationUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline underline-offset-4">查看官方参数</a>
                    <Button variant="outline" type="button" onClick={() => patch(row.key, modelPresetDraft(provider, row.model)!)} className={CTL_SECONDARY}>应用官方参数</Button>
                  </div>}
                  <ModelAdvancedFields row={row} onChange={values => patch(row.key, values)} />
                </fieldset>}
              </div>)}
            </div>
            {provider === 'deepseek' && <p className="text-xs text-fg-subtle">DeepSeek 使用非思考模式；获取或手动添加后，模型参数均可编辑。</p>}
            {provider === 'zhipu' && <p className="text-xs text-fg-subtle">智谱 BigModel Coding Plan 须使用套餐 API Key 与专属地址，仅支持 Chat Completions；已按官方文档带出 GLM-5.3 与 GLM-5.3-Flash，两者始终启用思考，档位 low／high／max（默认最高），可按需增删。</p>}
            {catalogNotice && <p role="status" className="text-xs text-fg-muted">{catalogNotice}</p>}
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            {service && <RevisionConflictNotice latest={latest} baseRevision={revision} onAccept={setRevision} />}
          </fieldset></ScrollArea>
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3"><Button variant="outline" type="button" onClick={onClose} className={CTL_SECONDARY}>取消</Button><Button variant="primary" type="submit" disabled={submitting} className={CTL_PRIMARY}>{service ? '保存模型配置' : '创建模型配置'}</Button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <div><label htmlFor={id} className="mb-1.5 block text-xs text-fg-muted">{label}</label>{children}</div>
}
