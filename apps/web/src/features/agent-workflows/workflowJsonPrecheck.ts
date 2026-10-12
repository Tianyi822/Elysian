import type { AgentCreateWorkflowDefinitionInput, AgentWorkflowStepDefinition } from '@elysian/contracts'

/*
 * 模板与 JSON 输入的前端预检：>1 MiB、重复 JSON 键、未知字段与绑定五选一都在
 * 提交前拦截；服务端仍是权威（409/400 中文错误透传），这里只是尽力早失败。
 * JSON 原文（literalJson、*SchemaJson、inputJson/outputJson）只透传字符串，
 * 绝不 JSON.parse 后重新序列化来决定提交内容。
 */

export const WORKFLOW_EDITOR_MAX_BYTES = 1_048_576

const DEFINITION_FIELDS = new Set([
  'languageVersion', 'id', 'revision', 'name', 'enabled', 'goal', 'inputSchemaJson', 'outputSchemaJson', 'entry', 'steps', 'createdAt',
])

const STEP_FIELDS = new Set([
  'id', 'kind', 'instruction', 'capability', 'input', 'outputSchemaJson', 'next', 'condition', 'then', 'else', 'finish', 'selection', 'parallel', 'foreach', 'subworkflow',
])

const BINDING_FIELDS = new Set(['literalJson', 'input', 'step', 'object', 'array'])
const STEP_KINDS = new Set(['agent', 'operation', 'approval', 'condition', 'parallel', 'foreach', 'subworkflow'])
const LANGUAGE_VERSIONS = new Set(['v1', 'workflow/v1', 'workflow/v2'])

export type WorkflowEditorPrecheck =
  | { ok: true; value: AgentCreateWorkflowDefinitionInput }
  | { ok: false; message: string }

function readKeyBefore(text: string, colonIndex: number): string | null {
  let end = colonIndex - 1
  while (end >= 0 && /\s/.test(text[end] ?? '')) end -= 1
  if (text[end] !== '"') return null
  let start = end - 1
  let escaped = false
  while (start >= 0) {
    const char = text[start]
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
    else if (char === '"') break
    start -= 1
  }
  if (start < 0) return null
  return text.slice(start + 1, end)
}

/** 重复 JSON 键探测：JSON.parse 会静默取后者，服务端 jsonvalue.Object 直接拒绝。 */
export function findDuplicateJsonKeys(text: string): string[] {
  const duplicates: string[] = []
  let inString = false
  let escaped = false
  let index = 0
  const objectKeys: string[][] = []
  while (index < text.length) {
    const char = text[index]
    index += 1
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      objectKeys.push([])
      continue
    }
    if (char === '}') {
      objectKeys.pop()
      continue
    }
    if (char === ':') {
      const key = readKeyBefore(text, index - 1)
      const bucket = objectKeys[objectKeys.length - 1]
      if (key !== null && bucket !== undefined) {
        if (bucket.includes(key) && !duplicates.includes(key)) duplicates.push(key)
        bucket.push(key)
      }
    }
  }
  return duplicates
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownFields(row: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(row).filter((key) => !allowed.has(key))
}

/** 递归校验绑定五选一；返回中文错误或 null。 */
function checkBinding(value: unknown, label: string): string | null {
  if (!isPlainObject(value)) return `${label} 必须是绑定对象`
  const present = Object.keys(value).filter((key) => BINDING_FIELDS.has(key))
  const unknown = unknownFields(value, BINDING_FIELDS)
  if (unknown.length > 0) return `${label} 含未知字段：${unknown.join('、')}`
  if (present.length !== 1) return `${label} 必须且只能选择 literalJson/input/step/object/array 之一`
  const key = present[0]
  if (key === undefined) return `${label} 必须且只能选择 literalJson/input/step/object/array 之一`
  if (key === 'literalJson' || key === 'input') {
    return typeof value[key] === 'string' ? null : `${label}.${key} 必须是字符串`
  }
  if (key === 'step') {
    const step = value.step
    if (!isPlainObject(step) || typeof step.stepId !== 'string' || typeof step.pointer !== 'string' || unknownFields(step, new Set(['stepId', 'pointer'])).length > 0) {
      return `${label}.step 必须是 {stepId, pointer}`
    }
    return null
  }
  if (key === 'object') {
    const entries = value.object
    if (!isPlainObject(entries)) return `${label}.object 必须是对象`
    for (const child of Object.values(entries)) {
      const issue = checkBinding(child, `${label}.object`)
      if (issue !== null) return issue
    }
    return null
  }
  if (!Array.isArray(value.array)) return `${label}.array 必须是数组`
  for (const child of value.array) {
    const issue = checkBinding(child, `${label}.array`)
    if (issue !== null) return issue
  }
  return null
}

function checkBodySteps(steps: unknown, label: string): string | null {
  if (!Array.isArray(steps)) return `${label} 必须是数组`
  for (const [index, raw] of steps.entries()) {
    const stepLabel = `${label}[${index}]`
    if (!isPlainObject(raw)) return `${stepLabel} 必须是对象`
    const unknown = unknownFields(raw, STEP_FIELDS)
    if (unknown.length > 0) return `${stepLabel} 含未知字段：${unknown.join('、')}`
    if (typeof raw.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.id)) {
      return `${stepLabel}.id 必须以字母开头且只含字母、数字、下划线或连字符，最长 64 字符`
    }
    if (typeof raw.kind !== 'string' || !STEP_KINDS.has(raw.kind)) return `${stepLabel}.kind 不受支持`
    if (typeof raw.outputSchemaJson !== 'string') return `${stepLabel}.outputSchemaJson 必须是字符串`
    const bindingIssue = checkBinding(raw.input, `${stepLabel}.input`)
    if (bindingIssue !== null) return bindingIssue
    if (raw.finish !== undefined) {
      const finishIssue = checkBinding(raw.finish, `${stepLabel}.finish`)
      if (finishIssue !== null) return finishIssue
    }
    if (raw.parallel !== undefined) {
      const parallel = raw.parallel
      if (!isPlainObject(parallel) || unknownFields(parallel, new Set(['join', 'branches'])).length > 0) return `${stepLabel}.parallel 字段无效`
      if (parallel.join !== 'all') return `${stepLabel}.parallel.join 目前只支持 all`
      if (!Array.isArray(parallel.branches)) return `${stepLabel}.parallel.branches 必须是数组`
      for (const [branchIndex, branch] of parallel.branches.entries()) {
        if (!isPlainObject(branch) || unknownFields(branch, new Set(['id', 'input', 'body'])).length > 0) return `${stepLabel}.parallel.branches[${branchIndex}] 字段无效`
        const branchIssue = checkBinding(branch.input, `${stepLabel}.parallel.branches[${branchIndex}].input`)
        if (branchIssue !== null) return branchIssue
        const bodyIssue = checkBody(branch.body, `${stepLabel}.parallel.branches[${branchIndex}].body`)
        if (bodyIssue !== null) return bodyIssue
      }
    }
    if (raw.foreach !== undefined) {
      const foreach = raw.foreach
      if (!isPlainObject(foreach) || unknownFields(foreach, new Set(['items', 'body'])).length > 0) return `${stepLabel}.foreach 字段无效`
      const itemsIssue = checkBinding(foreach.items, `${stepLabel}.foreach.items`)
      if (itemsIssue !== null) return itemsIssue
      const bodyIssue = checkBody(foreach.body, `${stepLabel}.foreach.body`)
      if (bodyIssue !== null) return bodyIssue
    }
    if (raw.subworkflow !== undefined) {
      const sub = raw.subworkflow
      if (!isPlainObject(sub) || unknownFields(sub, new Set(['definitionId', 'definitionRevision'])).length > 0 || typeof sub.definitionId !== 'string' || typeof sub.definitionRevision !== 'number') {
        return `${stepLabel}.subworkflow 字段无效`
      }
    }
  }
  return null
}

function checkBody(body: unknown, label: string): string | null {
  if (!isPlainObject(body) || unknownFields(body, new Set(['entry', 'steps', 'outputSchemaJson'])).length > 0) {
    return `${label} 只允许 entry/steps/outputSchemaJson`
  }
  if (typeof body.entry !== 'string' || typeof body.outputSchemaJson !== 'string') return `${label} 字段类型无效`
  return checkBodySteps(body.steps, `${label}.steps`)
}

/**
 * 模板编辑器预检：体积、重复键、未知字段、绑定五选一与 v1 复合字段限制。
 * 通过时返回可直接提交的输入对象（字符串字段原样透传，不重序列化）。
 */
export function precheckDefinitionText(text: string): WorkflowEditorPrecheck {
  if (new TextEncoder().encode(text).length > WORKFLOW_EDITOR_MAX_BYTES) {
    return { ok: false, message: `模板内容超过 1 MiB 上限（当前 ${new TextEncoder().encode(text).length} 字节）` }
  }
  const duplicates = findDuplicateJsonKeys(text)
  if (duplicates.length > 0) {
    return { ok: false, message: `模板 JSON 存在重复键：${duplicates.join('、')}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: '模板内容不是有效 JSON' }
  }
  if (!isPlainObject(parsed)) return { ok: false, message: '模板内容必须是 JSON 对象' }
  const unknown = unknownFields(parsed, DEFINITION_FIELDS)
  if (unknown.length > 0) return { ok: false, message: `模板含未知字段：${unknown.join('、')}` }
  const language = parsed.languageVersion === undefined ? 'v1' : parsed.languageVersion
  if (typeof language !== 'string' || !LANGUAGE_VERSIONS.has(language)) return { ok: false, message: '不支持的工作流 languageVersion（只允许 v1 / workflow/v2）' }
  if (typeof parsed.name !== 'string' || !parsed.name.trim() || parsed.name.length > 120) return { ok: false, message: '模板名称不能为空且不超过 120 字符' }
  if (typeof parsed.goal !== 'string' || !parsed.goal.trim()) return { ok: false, message: '模板目标不能为空' }
  if (typeof parsed.enabled !== 'boolean') return { ok: false, message: 'enabled 必须是布尔值' }
  if (typeof parsed.entry !== 'string' || parsed.entry === '') return { ok: false, message: '必须提供入口步骤 entry' }
  for (const field of ['inputSchemaJson', 'outputSchemaJson'] as const) {
    if (typeof parsed[field] !== 'string') return { ok: false, message: `${field} 必须是字符串` }
    try {
      JSON.parse(parsed[field] as string)
    } catch {
      return { ok: false, message: `${field} 不是有效 JSON` }
    }
  }
  const stepsIssue = checkBodySteps(parsed.steps, 'steps')
  if (stepsIssue !== null) return { ok: false, message: stepsIssue }
  if (language !== 'workflow/v2') {
    const hasCompound = Array.isArray(parsed.steps) && parsed.steps.some((step) => {
      if (!isPlainObject(step)) return false
      return step.parallel !== undefined || step.foreach !== undefined || step.subworkflow !== undefined
    })
    if (hasCompound) return { ok: false, message: 'workflow/v1 不能包含复合步骤字段（parallel/foreach/subworkflow 只有 workflow/v2 支持）' }
  }
  const stepIds = new Set<string>()
  for (const step of parsed.steps as unknown[]) {
    if (isPlainObject(step) && typeof step.id === 'string') stepIds.add(step.id)
  }
  if (!stepIds.has(parsed.entry)) return { ok: false, message: '工作流入口步骤不存在' }
  // 'workflow/v1' 是服务端输入别名（语义与 v1 相同），提交时归一为 v1；
  // 'v1' 省略不送（与服务端 omitempty 口径一致）。
  const normalizedLanguage: 'v1' | 'workflow/v2' = language === 'workflow/v2' ? 'workflow/v2' : 'v1'
  const input: AgentCreateWorkflowDefinitionInput = {
    ...(normalizedLanguage === 'v1' ? {} : { languageVersion: normalizedLanguage }),
    name: parsed.name as string,
    enabled: parsed.enabled as boolean,
    goal: parsed.goal as string,
    inputSchemaJson: parsed.inputSchemaJson as string,
    outputSchemaJson: parsed.outputSchemaJson as string,
    entry: parsed.entry as string,
    steps: parsed.steps as AgentWorkflowStepDefinition[],
  }
  return { ok: true, value: input }
}

/** 实例输入 JSON 预检：重复键、对象形状与 32 KiB 上限。 */
export function precheckInstanceInputText(text: string): string | null {
  if (new TextEncoder().encode(text).length > 32_768) return '工作流输入不得超过 32 KiB'
  const duplicates = findDuplicateJsonKeys(text)
  if (duplicates.length > 0) return `输入 JSON 存在重复键：${duplicates.join('、')}`
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) return '工作流输入必须是 JSON 对象'
  } catch {
    return '输入内容不是有效 JSON'
  }
  return null
}

/**
 * Schema 尽力校验（根级 type/required/properties/additionalProperties:false 子集）。
 * 只用于提交前提示；服务端校验才是权威。
 */
export function checkJsonAgainstSchemaLite(valueJson: string, schemaJson: string): string | null {
  let value: unknown
  let schema: unknown
  try {
    value = JSON.parse(valueJson)
  } catch {
    return '内容不是有效 JSON'
  }
  try {
    schema = JSON.parse(schemaJson)
  } catch {
    return null
  }
  if (!isPlainObject(schema)) return null
  const type = schema['type']
  if (typeof type === 'string') {
    const matches =
      (type === 'object' && isPlainObject(value)) ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'string' && typeof value === 'string') ||
      (type === 'number' && typeof value === 'number') ||
      (type === 'boolean' && typeof value === 'boolean')
    if (!matches) return `根类型应为 ${type}`
  }
  if (type === 'object' && isPlainObject(value)) {
    const required = schema['required']
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && value[key] === undefined) return `缺少必填字段 ${key}`
      }
    }
    if (schema['additionalProperties'] === false && isPlainObject(schema['properties'])) {
      const allowed = new Set(Object.keys(schema['properties']))
      const extra = Object.keys(value).filter((key) => !allowed.has(key))
      if (extra.length > 0) return `含 Schema 未声明的字段：${extra.join('、')}`
    }
  }
  return null
}
