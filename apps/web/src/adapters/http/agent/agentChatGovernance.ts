import type { AgentApproval, AgentCapability, AgentEnvironment, AgentExecutionGrant, AgentExecutionProfile } from '@elysian/contracts'
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

export function parseEnvironment(value: unknown): AgentEnvironment {
  const r = row(value)
  return { sessionId: text(r.sessionId), revision: integer(r.revision), skills: list(r.skills, ref), servers: list(r.servers, ref), tools: list(r.tools, text),
    resources: list(r.resources, item => { const v = row(item); return { serverId: text(v.serverId), uri: text(v.uri) } }),
    executionProfiles: list(r.executionProfiles, ref), grants: list(r.grants, ref), trustedReadOnly: list(r.trustedReadOnly, text),
    ...(r.resourceRules === undefined ? {} : { resourceRules: list(r.resourceRules, ref) }) }
}

export function parseProfile(value: unknown): AgentExecutionProfile {
  const r = row(value)
  if (!['python', 'node', 'bash'].includes(text(r.runtime))) throw invalid()
  return { id: text(r.id), revision: integer(r.revision), enabled: enabled(r.enabled), name: text(r.name), image: text(r.image), runtime: r.runtime as AgentExecutionProfile['runtime'],
    command: list(r.command, text), timeoutSeconds: integer(r.timeoutSeconds), cpuMillis: integer(r.cpuMillis), memoryBytes: integer(r.memoryBytes), pids: integer(r.pids), createdAt: text(r.createdAt) }
}

export function parseGrant(value: unknown): AgentExecutionGrant {
  const r = row(value)
  return { id: text(r.id), revision: integer(r.revision), enabled: enabled(r.enabled), name: text(r.name), createdAt: text(r.createdAt),
    directories: list(r.directories ?? [], item => { const v = row(item); if (v.access !== 'ro' && v.access !== 'rw') throw invalid(); return { path: text(v.path), access: v.access } }),
    network: list(r.network ?? [], item => { const v = row(item); if (v.scheme !== 'http' && v.scheme !== 'https') throw invalid(); return { scheme: v.scheme, host: text(v.host), port: integer(v.port) } }),
    privateCidrs: list(r.privateCidrs ?? [], text),
    resources: list(r.resources ?? [], item => { const v = row(item); if (v.access !== 'read' && v.access !== 'write') throw invalid(); return { domain: text(v.domain), id: text(v.id), access: v.access } }) }
}

export function parseCapability(value: unknown): AgentCapability {
  const r = row(value)
  if (typeof r.parameters !== 'boolean') row(r.parameters)
  const metadata = r.metadata === undefined ? undefined : row(r.metadata)
  if (metadata) {
    for (const key of ['domain', 'action', 'effect', 'exposure', 'resourceType', 'resourceKeyArgument', 'version', 'backend', 'taskDomain', 'taskRequestArgument', 'taskIdArgument']) if (metadata[key] !== undefined) text(metadata[key])
    for (const key of ['readOnly', 'async', 'default']) if (metadata[key] !== undefined) enabled(metadata[key])
  }
  return { name: text(r.name), description: text(r.description), parameters: r.parameters as AgentCapability['parameters'], source: text(r.source), ref: ref(r.ref), readOnly: enabled(r.readOnly), ...(metadata ? { metadata } : {}) }
}

export function parseApproval(value: unknown): AgentApproval {
  const r = row(value)
  if (!['pending', 'approved', 'denied', 'expired', 'consumed', 'revoked'].includes(text(r.status)) || r.kind === 'workflow-gate') throw invalid()
  const o = row(r.operation)
  const operation: Row = { ...o, id: text(o.id), runId: text(o.runId), taskId: text(o.taskId), argumentsJson: text(o.argumentsJson), capability: parseCapability(o.capability), workspaceRevision: integer(o.workspaceRevision) }
  if (r.runId !== operation.runId || r.operationId !== operation.id) throw invalid()
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
  return { ...r, id: text(r.id), runId: text(r.runId), operationId: text(r.operationId), createdAt: text(r.createdAt), expiresAt: text(r.expiresAt), operation } as AgentApproval
}

export function createAgentChatGovernance(): AgentChatGovernance {
  const path = agentPathPart
  return {
    async approvals(runId, signal) {
      const items = list(await requestAgentJson(`/api/agent/approvals?runId=${path(runId)}`, { signal }), parseApproval)
      if (items.some(item => item.runId !== runId)) throw invalid()
      return items
    },
    async decide(id, decision) { return parseApproval(await requestAgentJson(`/api/agent/approvals/${path(id)}/decision`, { method: 'POST', body: JSON.stringify({ decision }) })) },
    async environment(id, signal) { const env = parseEnvironment(await requestAgentJson(`/api/agent/sessions/${path(id)}/environment`, { signal })); if (env.sessionId !== id) throw invalid(); return env },
    async updateEnvironment(id, expectedRevision, environment) { const env = parseEnvironment(await requestAgentJson(`/api/agent/sessions/${path(id)}/environment`, { method: 'PUT', body: JSON.stringify({ expectedRevision, environment }) })); if (env.sessionId !== id) throw invalid(); return env },
    async profiles(signal) { return list(await requestAgentJson('/api/agent/execution-profiles', { signal }), parseProfile) },
    async grants(signal) { return list(await requestAgentJson('/api/agent/grants', { signal }), parseGrant) },
    async tools(id, signal) {
      const value = await requestAgentJson(`/api/agent/tools?sessionId=${path(id)}`, { signal })
      return list(Array.isArray(value) ? value : row(value).items, parseCapability)
    },
  }
}
