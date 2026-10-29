import { parseGrant, parseProfile } from './executionParse'
import type { AgentApproval, AgentCapability, AgentRuntimeAccess } from '@elysian/contracts'
import type { AgentChatGovernance } from '../../../contracts/agentChat'
import { agentPathPart, requestAgentJson } from './agentShared'

type Row = Record<string, unknown>
const invalid = () => new Error('Agent 权限响应格式无效')
const row = (value: unknown): Row => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); return value as Row }
const text = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value }
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid(); return Number(value) }
const list = <T>(value: unknown, parse: (item: unknown) => T): T[] => { if (!Array.isArray(value)) throw invalid(); return value.map(parse) }
const ref = (value: unknown) => { const r = row(value); return { id: text(r.id), revision: integer(r.revision), ...(r.digest === undefined ? {} : { digest: text(r.digest) }) } }
const enabled = (value: unknown): boolean => { if (typeof value !== 'boolean') throw invalid(); return value }

export function parseRuntimeAccess(value: unknown): AgentRuntimeAccess {
  const r = row(value)
  if (!['platform', 'file', 'script', 'mcp'].includes(text(r.kind))) throw invalid()
  const grant = parseGrant({ ...r, id: '', revision: 0, enabled: true, name: '', createdAt: '' })
  const runtime = r.runtime === undefined ? undefined : row(r.runtime)
  return { revision: integer(r.revision), digest: text(r.digest), scopeKey: text(r.scopeKey), kind: r.kind as AgentRuntimeAccess['kind'], directories: grant.directories, network: grant.network, privateCidrs: grant.privateCidrs, resources: grant.resources,
    sessionAllowed: enabled(r.sessionAllowed), ...(r.reason === undefined ? {} : { reason: text(r.reason) }),
    ...(runtime ? { runtime: { name: text(runtime.name), image: text(runtime.image), platform: text(runtime.platform), requiresDownload: enabled(runtime.requiresDownload) } } : {}) }
}

function parseCapability(value: unknown): AgentCapability {
  const r = row(value)
  if (typeof r.parameters !== 'boolean') row(r.parameters)
  const metadata = r.metadata === undefined ? undefined : row(r.metadata)
  if (metadata) {
    for (const key of ['domain', 'action', 'effect', 'exposure', 'resourceType', 'resourceKeyArgument', 'version', 'backend', 'taskDomain', 'taskRequestArgument', 'taskIdArgument']) if (metadata[key] !== undefined) text(metadata[key])
    for (const key of ['readOnly', 'async', 'default']) if (metadata[key] !== undefined) enabled(metadata[key])
  }
  return { ...(r.originalName === undefined ? {} : { originalName: text(r.originalName) }), ...(r.catalogDigest === undefined ? {} : { catalogDigest: text(r.catalogDigest) }), name: text(r.name), description: text(r.description), parameters: r.parameters as AgentCapability['parameters'], source: text(r.source), ref: ref(r.ref), readOnly: enabled(r.readOnly), ...(metadata ? { metadata } : {}) }
}

export function parseApproval(value: unknown): AgentApproval {
  const r = row(value)
  if (!['pending', 'approved', 'denied', 'expired', 'consumed', 'revoked'].includes(text(r.status)) || r.kind === 'workflow-gate') throw invalid()
  const o = row(r.operation)
  const operation: Row = { ...o, id: text(o.id), runId: text(o.runId), taskId: text(o.taskId), argumentsJson: text(o.argumentsJson), capability: parseCapability(o.capability), workspaceRevision: integer(o.workspaceRevision) }
  if (r.runId !== operation.runId || r.operationId !== operation.id) throw invalid()
  if (o.preparation !== undefined) {
    const p = row(o.preparation)
    if (!['pulling', 'ready', 'failed', 'unknown'].includes(text(p.state))) throw invalid()
    operation.preparation = { state: p.state, ...(p.current === undefined ? {} : { current: integer(p.current) }), ...(p.total === undefined ? {} : { total: integer(p.total) }), ...(p.error === undefined ? {} : { error: text(p.error) }) }
  }
  if (o.resourceClaims !== undefined) operation.resourceClaims = list(o.resourceClaims, item => {
    const claim = row(item)
    if (claim.access !== 'read' && claim.access !== 'write') throw invalid()
    return { kind: text(claim.kind), authority: text(claim.authority), key: text(claim.key), access: claim.access, ...(claim.subtree === undefined ? {} : { subtree: enabled(claim.subtree) }) }
  })
  if (o.fileChanges !== undefined) operation.fileChanges = list(o.fileChanges, item => {
    const change = row(item)
    const content = (value: unknown) => { const v = row(value); return { ...(v.bytes === undefined ? {} : { bytes: integer(v.bytes) }), digest: text(v.digest), ...(v.text === undefined ? {} : { text: text(v.text) }) } }
    return { path: text(change.path), ...(change.before === undefined ? {} : { before: content(change.before) }), ...(change.after === undefined ? {} : { after: content(change.after) }) }
  })
  if (o.execution !== undefined) {
    const e = row(o.execution)
    operation.execution = { profile: parseProfile(e.profile), ...(e.grant ? { grant: parseGrant(e.grant) } : {}), scriptDigest: text(e.scriptDigest) }
  }
  return { ...r, id: text(r.id), runId: text(r.runId), operationId: text(r.operationId), createdAt: text(r.createdAt), expiresAt: text(r.expiresAt), operation, ...(r.access === undefined ? {} : { access: parseRuntimeAccess(r.access) }) } as AgentApproval
}

export function createAgentChatGovernance(): AgentChatGovernance {
  const path = agentPathPart
  return {
    async decideAccess(id, input) { const item = parseApproval(await requestAgentJson(`/api/agent/approvals/${path(id)}/access-decision`, { method: 'POST', body: JSON.stringify(input) })); if (item.id !== id) throw invalid(); return item },
    async approvals(runId, signal) {
      const items = list(await requestAgentJson(`/api/agent/approvals?runId=${path(runId)}`, { signal }), parseApproval)
      if (items.some(item => item.runId !== runId)) throw invalid()
      return items
    },
    async decide(id, decision) { return parseApproval(await requestAgentJson(`/api/agent/approvals/${path(id)}/decision`, { method: 'POST', body: JSON.stringify({ decision }) })) },
  }
}
