import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_WORKFLOW_CONDITION_OPERATORS,
  AGENT_WORKFLOW_STEP_KINDS,
  AGENT_WORKFLOW_STEP_KIND_LABELS,
} from '@elysian/contracts'
import type { AgentWorkflowConditionOperator, AgentWorkflowStepKind } from '@elysian/contracts'
import { CTL_CARD_ACTION, CTL_FIELD } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'

type JsonObject = Record<string, unknown>
type BindingKind = 'literalJson' | 'input' | 'step' | 'object' | 'array'

const FIELD = `${CTL_FIELD} w-full text-xs`
const TEXTAREA = 'w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg'

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function writeText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function bindingKind(value: unknown): BindingKind {
  const row = record(value)
  const present = (['literalJson', 'input', 'step', 'object', 'array'] as const).filter((key) => Object.hasOwn(row, key))
  return present.length === 1 ? present[0]! : 'literalJson'
}

function defaultBinding(kind: BindingKind): unknown {
  if (kind === 'input') return { input: '' }
  if (kind === 'step') return { step: { stepId: '', pointer: '' } }
  if (kind === 'object') return { object: {} }
  if (kind === 'array') return { array: [] }
  return { literalJson: '{}' }
}

function defaultStep(kind: AgentWorkflowStepKind, index: number): JsonObject {
  return {
    id: `step_${index + 1}`,
    kind,
    input: { literalJson: '{}' },
    outputSchemaJson: '{"type":"object"}',
    ...(kind === 'agent' ? { instruction: '' } : {}),
    ...(kind === 'operation' ? { capability: '' } : {}),
    ...(kind === 'condition'
      ? { condition: { op: 'eq', left: { input: '' }, right: { literalJson: 'null' } }, then: '', else: '' }
      : {}),
    ...(kind === 'parallel' ? { parallel: { join: 'all', branches: [] } } : {}),
    ...(kind === 'foreach' ? { foreach: { items: { array: [] }, body: emptyBody() } } : {}),
    ...(kind === 'subworkflow' ? { subworkflow: { definitionId: '', definitionRevision: 1 } } : {}),
  }
}

function emptyBody(): JsonObject {
  return { entry: '', steps: [], outputSchemaJson: '{"type":"object"}' }
}

function updateObject(row: JsonObject, key: string, value: unknown): JsonObject {
  return { ...row, [key]: value }
}

export function WorkflowFormEditor({ text: source, onChange }: { text: string; onChange(value: string): void }) {
  const parsed = useMemo(() => {
    try {
      const value: unknown = JSON.parse(source)
      return isObject(value) ? value : undefined
    } catch {
      return undefined
    }
  }, [source])

  if (parsed === undefined) {
    return (
      <div className="flex min-h-[18rem] flex-col items-start justify-center gap-2 rounded border border-warning/40 bg-warning/5 p-4 text-xs text-fg-muted">
        <p className="font-medium text-warning">当前 JSON 无法解析，表单模式暂不可用。</p>
        <p>切到高级 JSON 修正语法后，表单会读取同一份草稿。</p>
      </div>
    )
  }

  const steps = Array.isArray(parsed.steps) ? parsed.steps : []
  const writeRoot = (next: JsonObject) => onChange(writeText(next))
  const setRootField = (key: string, value: unknown) => writeRoot(updateObject(parsed, key, value))
  return (
    <div className="flex min-h-[18rem] flex-col gap-3 overflow-y-auto pr-1">
      <section className="grid gap-2 rounded border border-line p-3 sm:grid-cols-2">
        <Field label="模板名称" value={text(parsed.name)} onChange={(value) => setRootField('name', value)} />
        <Field label="语言版本" value={text(parsed.languageVersion, 'workflow/v1')} onChange={(value) => setRootField('languageVersion', value)} />
        <Field label="入口步骤 ID" value={text(parsed.entry)} onChange={(value) => setRootField('entry', value)} />
        <label className="flex items-center gap-2 self-end pb-1 text-xs text-fg-muted">
          <input type="checkbox" checked={parsed.enabled !== false} onChange={(event) => setRootField('enabled', event.target.checked)} />
          启用模板
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-xs text-fg-muted">工作目标</span>
          <textarea rows={2} className={TEXTAREA} value={text(parsed.goal)} onChange={(event) => setRootField('goal', event.target.value)} />
        </label>
        <JsonStringField label="输入 Schema 原文" value={text(parsed.inputSchemaJson)} onChange={(value) => setRootField('inputSchemaJson', value)} />
        <JsonStringField label="输出 Schema 原文" value={text(parsed.outputSchemaJson)} onChange={(value) => setRootField('outputSchemaJson', value)} />
      </section>

      <StepList
        title="顶层步骤"
        steps={steps}
        entry={text(parsed.entry)}
        onEntryChange={(value) => setRootField('entry', value)}
        onChange={(next) => setRootField('steps', next)}
      />
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange(value: string): void; type?: string }) {
  return (
    <label>
      <span className="mb-1 block text-xs text-fg-muted">{label}</span>
      <input type={type} className={FIELD} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function JsonStringField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return (
    <label>
      <span className="mb-1 block text-xs text-fg-muted">{label}</span>
      <textarea rows={3} className={TEXTAREA} spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function StepList({
  title,
  steps,
  entry,
  onEntryChange,
  onChange,
}: {
  title: string
  steps: unknown[]
  entry: string
  onEntryChange(value: string): void
  onChange(steps: JsonObject[]): void
}) {
  const [newKind, setNewKind] = useState<AgentWorkflowStepKind>('agent')
  const rows = steps.map((step) => record(step))
  return (
    <section className="flex flex-col gap-2 rounded border border-line p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">{title}（{rows.length}）</h3>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted">
          入口
          <SelectDropdown ariaLabel={`${title}入口`} className="h-8 min-w-28" value={entry} onSelect={onEntryChange}
            items={[{ value: '', label: '选择入口' }, ...rows.map((step, index) => ({ value: text(step.id), label: text(step.id, `步骤 ${index + 1}`) }))]} />
        </label>
      </header>
      {rows.map((step, index) => (
        <StepEditor
          key={`${text(step.id, `step-${index}`)}-${index}`}
          step={step}
          index={index}
          onChange={(next) => {
            const copy = [...rows]
            copy[index] = next
            onChange(copy)
          }}
          onRemove={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
          onMove={(direction) => {
            const target = index + direction
            if (target < 0 || target >= rows.length) return
            const copy = [...rows]
            ;[copy[index], copy[target]] = [copy[target]!, copy[index]!]
            onChange(copy)
          }}
          canMoveUp={index > 0}
          canMoveDown={index < rows.length - 1}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <SelectDropdown ariaLabel={`${title}新增步骤类型`} className="h-8 min-w-36" value={newKind} onSelect={setNewKind}
          items={AGENT_WORKFLOW_STEP_KINDS.map((kind) => ({ value: kind, label: AGENT_WORKFLOW_STEP_KIND_LABELS[kind] }))} />
        <button type="button" className={CTL_CARD_ACTION} onClick={() => onChange([...rows, defaultStep(newKind, rows.length)])}>添加步骤</button>
      </div>
    </section>
  )
}

function StepEditor({
  step,
  index,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  step: JsonObject
  index: number
  onChange(step: JsonObject): void
  onRemove(): void
  onMove(direction: -1 | 1): void
  canMoveUp: boolean
  canMoveDown: boolean
}) {
  const kind = AGENT_WORKFLOW_STEP_KINDS.includes(step.kind as AgentWorkflowStepKind) ? step.kind as AgentWorkflowStepKind : 'agent'
  const set = (key: string, value: unknown) => onChange(updateObject(step, key, value))
  const label = AGENT_WORKFLOW_STEP_KIND_LABELS[kind]
  const parallel = record(step.parallel)
  const branches = Array.isArray(parallel.branches) ? parallel.branches.map(record) : []
  const foreach = record(step.foreach)
  const subworkflow = record(step.subworkflow)

  return (
    <details open className="rounded border border-line bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <span className="font-medium text-fg">{text(step.id, `步骤 ${index + 1}`)}</span>
        <span className="text-fg-subtle">{label}</span>
        <span className="ml-auto flex gap-1" onClick={(event) => event.preventDefault()}>
          <button type="button" className={CTL_CARD_ACTION} disabled={!canMoveUp} onClick={() => onMove(-1)}>上移</button>
          <button type="button" className={CTL_CARD_ACTION} disabled={!canMoveDown} onClick={() => onMove(1)}>下移</button>
          <button type="button" className={CTL_CARD_ACTION} onClick={onRemove}>删除</button>
        </span>
      </summary>
      <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-2">
        <Field label="步骤 ID" value={text(step.id)} onChange={(value) => set('id', value)} />
        <label>
          <span className="mb-1 block text-xs text-fg-muted">步骤类型</span>
          <SelectDropdown ariaLabel={`步骤 ${index + 1} 类型`} fullWidth value={kind} onSelect={(nextKind) => {
            const { id, input, outputSchemaJson, next } = step
            onChange({ ...defaultStep(nextKind, index), id, input, outputSchemaJson, next })
          }} items={AGENT_WORKFLOW_STEP_KINDS.map((value) => ({ value, label: AGENT_WORKFLOW_STEP_KIND_LABELS[value] }))} />
        </label>
        <div className="sm:col-span-2">
          <BindingEditor label="输入绑定" value={step.input} onChange={(value) => set('input', value)} />
        </div>
        <JsonStringField label="输出 Schema 原文" value={text(step.outputSchemaJson)} onChange={(value) => set('outputSchemaJson', value)} />
        <Field label="下一步骤 ID（可选）" value={text(step.next)} onChange={(value) => set('next', value || undefined)} />

        {kind === 'agent' ? (
          <>
            <label className="sm:col-span-2">
              <span className="mb-1 block text-xs text-fg-muted">Agent 指令</span>
              <textarea rows={3} className={TEXTAREA} value={text(step.instruction)} onChange={(event) => set('instruction', event.target.value)} />
            </label>
            <JsonObjectTextField label="资料选择（AgentInput JSON，可含 skills/resources/prompts）" value={step.selection} onChange={(value) => set('selection', value)} />
            <div className="sm:col-span-2"><BindingEditor label="完成输出绑定（可选）" value={step.finish} onChange={(value) => set('finish', value)} optional /></div>
          </>
        ) : null}
        {kind === 'operation' ? <Field label="能力名" value={text(step.capability)} onChange={(value) => set('capability', value)} /> : null}
        {kind === 'approval' ? <p className="sm:col-span-2 text-xs text-fg-subtle">人工确认步骤使用输入绑定作为审批上下文；审批结果按 output Schema 校验。</p> : null}
        {kind === 'condition' ? (
          <>
            <div className="sm:col-span-2"><ConditionEditor value={step.condition} onChange={(value) => set('condition', value)} /></div>
            <Field label="条件为真时跳转 ID" value={text(step.then)} onChange={(value) => set('then', value)} />
            <Field label="条件为假时跳转 ID" value={text(step.else)} onChange={(value) => set('else', value)} />
          </>
        ) : null}
        {kind === 'parallel' ? (
          <div className="sm:col-span-2 flex flex-col gap-2 rounded border border-line p-3">
            <div className="flex items-center gap-2 text-xs"><strong>并行分支</strong><span className="text-fg-subtle">汇合策略固定为 all</span></div>
            {branches.map((branch, branchIndex) => (
              <div key={`${text(branch.id, branchIndex.toString())}-${branchIndex}`} className="flex flex-col gap-2 rounded border border-line p-2">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1"><Field label="分支 ID" value={text(branch.id)} onChange={(value) => setBranches(parallel, branches, branchIndex, { ...branch, id: value }, set)} /></div>
                  <button type="button" className={CTL_CARD_ACTION} onClick={() => set('parallel', { ...parallel, branches: branches.filter((_, i) => i !== branchIndex) })}>删除分支</button>
                </div>
                <BindingEditor label="分支输入绑定" value={branch.input} onChange={(value) => setBranches(parallel, branches, branchIndex, { ...branch, input: value }, set)} />
                <BodyEditor title={`分支 ${text(branch.id, `${branchIndex + 1}`)} 主体`} value={branch.body} onChange={(body) => setBranches(parallel, branches, branchIndex, { ...branch, body }, set)} />
              </div>
            ))}
            <button type="button" className={CTL_CARD_ACTION} onClick={() => set('parallel', { join: 'all', branches: [...branches, { id: `branch_${branches.length + 1}`, input: { literalJson: '{}' }, body: emptyBody() }] })}>添加分支</button>
          </div>
        ) : null}
        {kind === 'foreach' ? (
          <div className="sm:col-span-2 flex flex-col gap-2 rounded border border-line p-3">
            <BindingEditor label="遍历项绑定（需为数组）" value={foreach.items} onChange={(value) => set('foreach', { ...foreach, items: value, body: foreach.body ?? emptyBody() })} />
            <BodyEditor title="遍历项主体" value={foreach.body} onChange={(body) => set('foreach', { ...foreach, items: foreach.items ?? { array: [] }, body })} />
          </div>
        ) : null}
        {kind === 'subworkflow' ? (
          <>
            <Field label="固定子流程模板 ID" value={text(subworkflow.definitionId)} onChange={(value) => set('subworkflow', { ...subworkflow, definitionId: value })} />
            <Field label="固定模板修订" type="number" value={String(subworkflow.definitionRevision ?? 1)} onChange={(value) => set('subworkflow', { ...subworkflow, definitionRevision: Number(value) })} />
          </>
        ) : null}
      </div>
    </details>
  )
}

function setBranches(
  parallel: JsonObject,
  branches: JsonObject[],
  index: number,
  branch: JsonObject,
  set: (key: string, value: unknown) => void,
) {
  const copy = [...branches]
  copy[index] = branch
  set('parallel', { ...parallel, join: 'all', branches: copy })
}

function JsonObjectTextField({ label, value, onChange }: { label: string; value: unknown; onChange(value: unknown): void }) {
  const canonical = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [source, setSource] = useState(canonical)
  const [error, setError] = useState<string>()
  const lastEmitted = useRef(canonical)
  useEffect(() => {
    if (canonical === lastEmitted.current) return
    lastEmitted.current = canonical
    setSource(canonical)
    setError(undefined)
  }, [canonical])
  return (
    <label>
      <span className="mb-1 block text-xs text-fg-muted">{label}</span>
      <textarea
        rows={3}
        className={TEXTAREA}
        spellCheck={false}
        value={source}
        onChange={(event) => {
          const next = event.target.value
          setSource(next)
          if (next.trim() === '') { setError(undefined); lastEmitted.current = ''; onChange(undefined); return }
          try { const parsed: unknown = JSON.parse(next); if (!isObject(parsed)) throw new Error('必须是 JSON 对象'); setError(undefined); lastEmitted.current = JSON.stringify(parsed, null, 2); onChange(parsed) }
          catch (issue) { setError(issue instanceof Error ? issue.message : 'JSON 无效') }
        }}
      />
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : <span className="mt-1 block text-xs text-fg-subtle">保留 requestId、content 以及 skills/resources/prompts 选择。</span>}
    </label>
  )
}

function BindingEditor({ label, value, onChange, optional = false }: { label: string; value: unknown; onChange(value: unknown): void; optional?: boolean }) {
  const kind = bindingKind(value)
  const row = record(value)
  const chosen = row[kind]
  const changeKind = (next: BindingKind) => onChange(defaultBinding(next))
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-line p-2">
      <legend className="px-1 text-xs text-fg-muted">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {optional ? <button type="button" className={CTL_CARD_ACTION} onClick={() => onChange(undefined)}>清除绑定</button> : null}
        <SelectDropdown ariaLabel={`${label}类型`} className="h-8 min-w-36" value={kind} onSelect={changeKind}
          items={[{ value: 'literalJson', label: '固定 JSON 原文' }, { value: 'input', label: '实例输入路径' }, { value: 'step', label: '前序步骤输出' }, { value: 'object', label: '组合对象' }, { value: 'array', label: '组合数组' }]} />
      </div>
      {kind === 'literalJson' ? <textarea aria-label={`${label}固定 JSON 原文`} rows={2} className={TEXTAREA} spellCheck={false} value={text(chosen, '{}')} onChange={(event) => onChange({ literalJson: event.target.value })} /> : null}
      {kind === 'input' ? <Field label="JSON Pointer（实例输入）" value={text(chosen)} onChange={(next) => onChange({ input: next })} /> : null}
      {kind === 'step' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="前序步骤 ID" value={text(record(chosen).stepId)} onChange={(next) => onChange({ step: { ...record(chosen), stepId: next } })} />
          <Field label="输出 JSON Pointer" value={text(record(chosen).pointer)} onChange={(next) => onChange({ step: { ...record(chosen), pointer: next } })} />
        </div>
      ) : null}
      {kind === 'object' ? <ObjectBindingFields value={chosen} onChange={(next) => onChange({ object: next })} /> : null}
      {kind === 'array' ? <ArrayBindingFields value={chosen} onChange={(next) => onChange({ array: next })} /> : null}
    </fieldset>
  )
}

function ObjectBindingFields({ value, onChange }: { value: unknown; onChange(value: JsonObject): void }) {
  const [newKey, setNewKey] = useState('')
  const object = record(value)
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(object).map(([key, child]) => (
        <div key={key} className="flex flex-col gap-1 rounded border border-line p-2">
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs">{key}</span><button type="button" className={CTL_CARD_ACTION} onClick={() => { const next = { ...object }; delete next[key]; onChange(next) }}>移除字段</button></div>
          <BindingEditor label={`字段 ${key}`} value={child} onChange={(next) => onChange({ ...object, [key]: next })} />
        </div>
      ))}
      <div className="flex gap-2">
        <input className={`${FIELD} min-w-0 flex-1`} aria-label="新对象字段名" value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder="字段名" />
        <button type="button" className={CTL_CARD_ACTION} disabled={newKey.trim() === '' || Object.hasOwn(object, newKey.trim())} onClick={() => { const key = newKey.trim(); onChange({ ...object, [key]: defaultBinding('literalJson') }); setNewKey('') }}>添加字段</button>
      </div>
    </div>
  )
}

function ArrayBindingFields({ value, onChange }: { value: unknown; onChange(value: unknown[]): void }) {
  const array = Array.isArray(value) ? value : []
  return (
    <div className="flex flex-col gap-2">
      {array.map((child, index) => (
        <div key={index} className="flex items-start gap-2"><span className="pt-2 font-mono text-xs text-fg-subtle">[{index}]</span><div className="min-w-0 flex-1"><BindingEditor label={`数组项 ${index + 1}`} value={child} onChange={(next) => { const copy = [...array]; copy[index] = next; onChange(copy) }} /></div><button type="button" className={CTL_CARD_ACTION} onClick={() => onChange(array.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div>
      ))}
      <button type="button" className={CTL_CARD_ACTION} onClick={() => onChange([...array, defaultBinding('literalJson')])}>添加数组项</button>
    </div>
  )
}

function ConditionEditor({ value, onChange }: { value: unknown; onChange(value: unknown): void }) {
  const row = record(value)
  const operator = AGENT_WORKFLOW_CONDITION_OPERATORS.includes(row.op as AgentWorkflowConditionOperator) ? row.op as AgentWorkflowConditionOperator : 'eq'
  const children = Array.isArray(row.children) ? row.children : []
  const compound = operator === 'and' || operator === 'or' || operator === 'not'
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-line p-2">
      <legend className="px-1 text-xs text-fg-muted">有限条件表达式</legend>
      <label>
        <span className="mb-1 block text-xs text-fg-muted">运算符</span>
        <SelectDropdown ariaLabel="条件运算符" fullWidth value={operator} onSelect={(next) => {
          onChange(next === 'and' || next === 'or' || next === 'not' ? { op: next, children: [] } : { op: next, left: { input: '' }, ...(next === 'exists' ? {} : { right: { literalJson: 'null' } }) })
        }} items={AGENT_WORKFLOW_CONDITION_OPERATORS.map((value) => ({ value, label: value }))} />
      </label>
      {compound ? (
        <div className="flex flex-col gap-2">
          {children.map((child, index) => <div key={index} className="flex items-start gap-2"><div className="min-w-0 flex-1"><ConditionEditor value={child} onChange={(next) => { const copy = [...children]; copy[index] = next; onChange({ ...row, op: operator, children: copy }) }} /></div><button type="button" className={CTL_CARD_ACTION} onClick={() => onChange({ ...row, children: children.filter((_, itemIndex) => itemIndex !== index) })}>移除</button></div>)}
          {operator !== 'not' || children.length === 0 ? <button type="button" className={CTL_CARD_ACTION} onClick={() => onChange({ ...row, children: [...children, { op: 'eq', left: { input: '' }, right: { literalJson: 'null' } }] })}>添加子条件</button> : null}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <BindingEditor label="左值" value={row.left ?? { input: '' }} onChange={(left) => onChange({ ...row, op: operator, left })} />
          {operator !== 'exists' ? <BindingEditor label="右值" value={row.right ?? { literalJson: 'null' }} onChange={(right) => onChange({ ...row, op: operator, right })} /> : null}
        </div>
      )}
    </fieldset>
  )
}

function BodyEditor({ title, value, onChange }: { title: string; value: unknown; onChange(value: JsonObject): void }) {
  const body = record(value)
  const steps = Array.isArray(body.steps) ? body.steps : []
  const set = (key: string, next: unknown) => onChange({ ...body, [key]: next })
  return (
    <div className="flex flex-col gap-2 rounded border border-dashed border-line p-2">
      <h4 className="text-xs font-semibold">{title}</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="主体入口步骤 ID" value={text(body.entry)} onChange={(next) => set('entry', next)} />
        <JsonStringField label="主体输出 Schema 原文" value={text(body.outputSchemaJson)} onChange={(next) => set('outputSchemaJson', next)} />
      </div>
      <StepList title="嵌套步骤" steps={steps} entry={text(body.entry)} onEntryChange={(next) => set('entry', next)} onChange={(next) => set('steps', next)} />
    </div>
  )
}
