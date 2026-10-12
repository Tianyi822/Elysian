import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentResourceMapping, AgentResourceRule, AgentResourceSelector } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { History, Pencil, Plus, Split, Trash2, X } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { useAgentCapabilitiesStore } from '../../stores/agentCapabilitiesStore'
import { CapabilitiesEmptyState, CapabilitiesSearchInput } from './AgentCapabilitiesPage'
import { RevisionDetailDialog } from './RevisionDetailDialog'
import { RevisionConflictNotice } from '../../components/agent/RevisionConflictNotice'

/*
 * 资源规则面板：selector（能力来源＋固定修订引用）与 mappings（资源身份＋值来源）
 * 的增改；每条映射的固定值（literal）与 JSON Pointer（pointer）互斥，编辑保存后
 * digest 与 revision 随服务端固化更新；历史修订经 GET /resource-rules/{id}?revision=。
 */

const SELECTOR_SOURCE_LABELS: Record<AgentResourceSelector['source'], string> = {
  'mcp-tool': 'MCP 工具',
  'mcp-resource': 'MCP 资源',
  'mcp-prompt': 'MCP 提示',
  script: '技能脚本',
}

export function ResourceRulesPanel() {
  const gateway = useGateway()
  const rules = useAgentCapabilitiesStore((state) => state.resourceRules)
  const search = useAgentCapabilitiesStore((state) => state.search)
  const setSearch = useAgentCapabilitiesStore((state) => state.setSearch)
  const loadRevisionDetail = useAgentCapabilitiesStore((state) => state.loadRevisionDetail)
  const [editing, setEditing] = useState<AgentResourceRule | 'new' | undefined>(undefined)
  const [detailId, setDetailId] = useState<string | undefined>(undefined)

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (keyword === '') return rules
    return rules.filter((item) =>
      item.name.toLowerCase().includes(keyword) ||
      item.selector.ref.id.toLowerCase().includes(keyword) ||
      item.selector.originalName?.toLowerCase().includes(keyword) === true)
  }, [rules, search])

  const detailTarget = detailId === undefined ? undefined : rules.find((item) => item.id === detailId)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setEditing('new')} className={CTL_PRIMARY}>
          <span className="inline-flex items-center gap-1.5">
            <Plus aria-hidden size={14} />
            新建资源规则
          </span>
        </button>
        <CapabilitiesSearchInput
          id="agent-rules-search"
          label="搜索名称、引用或原始能力名"
          value={search}
          onChange={setSearch}
        />
      </div>
      {filtered.length === 0 ? (
        <CapabilitiesEmptyState
          title={search.trim() === '' ? '还没有资源规则' : '没有匹配的资源规则'}
          description={search.trim() === ''
            ? '资源规则把能力调用的资源身份映射为互斥声明（literal 或 JSON Pointer 二选一），供会话环境按固定修订选择。'
            : '换个关键词，或清空过滤查看全部资源规则。'}
        />
      ) : (
        <div role="region" aria-label="资源规则列表" className="overflow-x-auto panel-surface">
          <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[16%]" />
              <col className="w-[22%]" />
              <col className="w-[30%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead>
              <tr>
                {['名称', '选择器', '资源映射', '完整性', '状态', '操作'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={`${item.id}@${item.revision}`} className="transition-colors hover:bg-surface-raised/50">
                  <td className="border-b border-line px-3 py-2.5">
                    <span className="block truncate font-medium" title={item.name}>{item.name}</span>
                    <p className="truncate text-xs text-fg-subtle tabular-nums" title={`${item.id} · 修订 ${item.revision}`}>{item.id} · 修订 {item.revision}</p>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs">
                    <span className="block truncate" title={SELECTOR_SOURCE_LABELS[item.selector.source]}>
                      {SELECTOR_SOURCE_LABELS[item.selector.source]}
                    </span>
                    <span className="block truncate text-fg-subtle" title={`${item.selector.ref.id}@${item.selector.ref.revision}`}>
                      {item.selector.ref.id}@{item.selector.ref.revision}
                    </span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs">
                    {item.mappings.map((mapping, index) => (
                      <span key={index} className="block truncate" title={`${mapping.kind}/${mapping.authority}/${mapping.access} → ${mapping.literal ?? mapping.pointer}`}>
                        {mapping.kind}/{mapping.authority}/{mapping.access === 'read' ? '读' : '写'} → {mapping.literal !== undefined ? `字面值 ${mapping.literal}` : `指针 ${mapping.pointer}`}
                      </span>
                    ))}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    {item.complete ? <StatusTag label="完整" tone="success" /> : <StatusTag label="不完整" tone="warning" />}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    {item.enabled ? <StatusTag label="已启用" tone="success" /> : <StatusTag label="已停用" tone="neutral" />}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(item)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                      >
                        <Pencil aria-hidden size={13} />
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailId(item.id)
                          void loadRevisionDetail(gateway, 'rule', item.id)
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                      >
                        <History aria-hidden size={13} />
                        修订
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined ? <ResourceRuleDialog rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} /> : null}
      {detailTarget !== undefined ? <RevisionDetailDialog latestRevision={detailTarget.revision} /> : null}
    </div>
  )
}

type MappingRow = {
  kind: string
  authority: string
  access: AgentResourceMapping['access']
  mode: 'literal' | 'pointer'
  value: string
  subtree: boolean
}

type SelectorRow = {
  source: AgentResourceSelector['source']
  refId: string
  refRevision: string
  digest: string
  originalName: string
  catalogDigest: string
}

function mappingToRow(mapping: AgentResourceMapping): MappingRow {
  return {
    kind: mapping.kind,
    authority: mapping.authority,
    access: mapping.access,
    mode: mapping.literal !== undefined ? 'literal' : 'pointer',
    value: mapping.literal ?? mapping.pointer ?? '',
    subtree: mapping.subtree === true,
  }
}

function ResourceRuleDialog({ rule, onClose }: { rule?: AgentResourceRule; onClose(): void }) {
  const gateway = useGateway()
  const saveResourceRule = useAgentCapabilitiesStore((state) => state.saveResourceRule)
  const latest = useAgentCapabilitiesStore((state) => state.resourceRules.find((item) => item.id === rule?.id))
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [baseRevision, setBaseRevision] = useState(rule?.revision ?? 0)
  const [name, setName] = useState(rule?.name ?? '')
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [complete, setComplete] = useState(rule?.complete ?? true)
  const [selector, setSelector] = useState<SelectorRow>({
    source: rule?.selector.source ?? 'script',
    refId: rule?.selector.ref.id ?? '',
    refRevision: rule ? String(rule.selector.ref.revision) : '1',
    digest: rule?.selector.ref.digest ?? '',
    originalName: rule?.selector.originalName ?? '',
    catalogDigest: rule?.selector.catalogDigest ?? '',
  })
  const [mappings, setMappings] = useState<MappingRow[]>(rule ? rule.mappings.map(mappingToRow) : [{ kind: '', authority: '', access: 'read', mode: 'literal', value: '', subtree: false }])
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    if (rule === undefined) return
    setName(rule.name)
    setBaseRevision(rule.revision)
    setEnabled(rule.enabled)
    setComplete(rule.complete)
    setSelector({
      source: rule.selector.source,
      refId: rule.selector.ref.id,
      refRevision: String(rule.selector.ref.revision),
      digest: rule.selector.ref.digest ?? '',
      originalName: rule.selector.originalName ?? '',
      catalogDigest: rule.selector.catalogDigest ?? '',
    })
    setMappings(rule.mappings.map(mappingToRow))
    setErrorMessage(undefined)
  }, [rule])

  const submit = async () => {
    const refRevision = Number.parseInt(selector.refRevision, 10)
    if (!Number.isSafeInteger(refRevision) || refRevision < 1) {
      setErrorMessage('选择器引用修订必须是正整数')
      return
    }
    const isMcp = selector.source !== 'script'
    const ok = await inFlightOnly(() => saveResourceRule(gateway, {
      name, enabled, complete,
      selector: {
        source: selector.source,
        ref: {
          id: selector.refId,
          revision: refRevision,
          ...(selector.digest === '' ? {} : { digest: selector.digest }),
        },
        ...(isMcp
          ? { originalName: selector.originalName, catalogDigest: selector.catalogDigest }
          : {}),
      },
      mappings: mappings.map((row) => ({
        kind: row.kind,
        authority: row.authority,
        access: row.access,
        ...(row.subtree ? { subtree: true } : {}),
        ...(row.mode === 'literal' ? { literal: row.value } : { pointer: row.value }),
      })),
    }, rule === undefined ? undefined : { id: rule.id, revision: baseRevision }))
    if (ok) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">
              {rule === undefined ? '新建资源规则' : `编辑「${rule.name}」（修订 ${rule.revision}）`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭资源规则表单" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
                <X aria-hidden size={14} />
              </button>
            </Dialog.Close>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
          >
            <div>
              <label htmlFor="agent-rule-name" className="block text-xs text-fg-muted">名称</label>
              <input id="agent-rule-name" value={name} onChange={(event) => setName(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full`} />
            </div>
            <fieldset className="rounded-lg border border-line p-2.5">
              <legend className="px-1 text-xs text-fg-muted">选择器（固定能力来源与修订）</legend>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="agent-rule-source" className="block text-xs text-fg-muted">能力来源</label>
                  <SelectDropdown
                    id="agent-rule-source"
                    ariaLabel="能力来源"
                    value={selector.source}
                    onSelect={(source) => setSelector((row) => ({ ...row, source }))}
                    items={[{ value: 'script', label: '技能脚本' }, { value: 'mcp-tool', label: 'MCP 工具' }, { value: 'mcp-resource', label: 'MCP 资源' }, { value: 'mcp-prompt', label: 'MCP 提示' }]}
                    fullWidth className="mt-1"
                  />
                </div>
                <div>
                  <label htmlFor="agent-rule-refid" className="block text-xs text-fg-muted">引用编号</label>
                  <input id="agent-rule-refid" value={selector.refId} onChange={(event) => setSelector((row) => ({ ...row, refId: event.target.value }))} required className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                </div>
                <div>
                  <label htmlFor="agent-rule-refrevision" className="block text-xs text-fg-muted">引用修订</label>
                  <input id="agent-rule-refrevision" type="number" min={1} step={1} value={selector.refRevision} onChange={(event) => setSelector((row) => ({ ...row, refRevision: event.target.value }))} required className={`${CTL_FIELD} mt-1 h-9 w-full tabular-nums`} />
                </div>
                <div>
                  <label htmlFor="agent-rule-refdigest" className="block text-xs text-fg-muted">内容摘要（可选）</label>
                  <input id="agent-rule-refdigest" value={selector.digest} onChange={(event) => setSelector((row) => ({ ...row, digest: event.target.value }))} className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                </div>
              </div>
              {selector.source !== 'script' ? (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="agent-rule-originalname" className="block text-xs text-fg-muted">原始能力名（MCP 来源必填）</label>
                    <input id="agent-rule-originalname" value={selector.originalName} onChange={(event) => setSelector((row) => ({ ...row, originalName: event.target.value }))} className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                  </div>
                  <div>
                    <label htmlFor="agent-rule-catalogdigest" className="block text-xs text-fg-muted">目录摘要（MCP 来源必填）</label>
                    <input id="agent-rule-catalogdigest" value={selector.catalogDigest} onChange={(event) => setSelector((row) => ({ ...row, catalogDigest: event.target.value }))} className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                  </div>
                </div>
              ) : null}
            </fieldset>
            <fieldset className="rounded-lg border border-line p-2.5">
              <legend className="px-1 text-xs text-fg-muted">资源映射（1 至 32 条；固定值与 JSON Pointer 互斥）</legend>
              <div className="flex flex-col gap-2">
                {mappings.map((row, index) => (
                  <div key={index} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2">
                    <div className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`agent-rule-mapping-kind-${index}`}>资源类型 {index + 1}</label>
                      <input
                        id={`agent-rule-mapping-kind-${index}`}
                        value={row.kind}
                        onChange={(event) => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, kind: event.target.value } : item))}
                        placeholder="registry-entry"
                        className={`${CTL_FIELD} h-9 flex-1 font-mono text-xs`}
                      />
                      <label className="sr-only" htmlFor={`agent-rule-mapping-authority-${index}`}>来源 {index + 1}</label>
                      <input
                        id={`agent-rule-mapping-authority-${index}`}
                        value={row.authority}
                        onChange={(event) => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, authority: event.target.value } : item))}
                        placeholder="mcp"
                        className={`${CTL_FIELD} h-9 w-28 font-mono text-xs`}
                      />
                      <label className="sr-only" htmlFor={`agent-rule-mapping-access-${index}`}>读写 {index + 1}</label>
                      <SelectDropdown
                        id={`agent-rule-mapping-access-${index}`}
                        ariaLabel={`读写 ${index + 1}`}
                        value={row.access}
                        onSelect={(access) => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, access } : item))}
                        items={[{ value: 'read', label: '读' }, { value: 'write', label: '写' }]}
                        className="w-20"
                      />
                      <button
                        type="button"
                        aria-label={`删除资源映射 ${index + 1}`}
                        onClick={() => setMappings((rows) => rows.filter((_, at) => at !== index))}
                        className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-danger"
                      >
                        <Trash2 aria-hidden size={14} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <div role="radiogroup" aria-label={`值来源 ${index + 1}：固定值或 JSON Pointer`} className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={row.mode === 'literal'}
                          onClick={() => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, mode: 'literal' } : item))}
                          className={`${CTL_SECONDARY} px-2 text-xs${row.mode === 'literal' ? ' border-fg text-fg' : ''}`}
                        >
                          literal
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={row.mode === 'pointer'}
                          onClick={() => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, mode: 'pointer' } : item))}
                          className={`${CTL_SECONDARY} px-2 text-xs${row.mode === 'pointer' ? ' border-fg text-fg' : ''}`}
                        >
                          pointer
                        </button>
                      </div>
                      <label className="sr-only" htmlFor={`agent-rule-mapping-value-${index}`}>值 {index + 1}</label>
                      <input
                        id={`agent-rule-mapping-value-${index}`}
                        value={row.value}
                        onChange={(event) => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, value: event.target.value } : item))}
                        placeholder={row.mode === 'literal' ? 'registry/entries' : '/results/0'}
                        className={`${CTL_FIELD} h-9 flex-1 font-mono text-xs`}
                      />
                      <label className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
                        <input
                          type="checkbox"
                          checked={row.subtree}
                          onChange={(event) => setMappings((rows) => rows.map((item, at) => at === index ? { ...item, subtree: event.target.checked } : item))}
                          className="size-4"
                        />
                        子树
                      </label>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setMappings((rows) => [...rows, { kind: '', authority: '', access: 'read', mode: 'literal', value: '', subtree: false }])}
                className={`${CTL_SECONDARY} mt-2 px-2`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Split aria-hidden size={13} />
                  添加映射
                </span>
              </button>
              <p className="mt-1.5 text-xs text-fg-subtle">固定值（literal）直接声明资源身份；JSON Pointer（pointer）从调用结果按指针取值。两者互斥，只能选一个。</p>
            </fieldset>
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4" />
                启用
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={complete} onChange={(event) => setComplete(event.target.checked)} className="size-4" />
                映射完整（complete）
              </label>
            </div>
            {errorMessage ? <p role="alert" className="text-xs text-danger">{errorMessage}</p> : null}
            {rule !== undefined ? <RevisionConflictNotice latest={latest} baseRevision={baseRevision} onAccept={setBaseRevision} /> : null}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={CTL_SECONDARY}>取消</button>
              <button type="submit" disabled={submitting} className={CTL_PRIMARY}>
                {rule === undefined ? '创建资源规则' : '保存资源规则'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
