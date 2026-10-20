import type { AgentExecutionGrant, AgentExecutionProfile } from '@elysian/contracts'

const invalid = () => new Error('Agent 执行配置响应格式无效')
const row = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); return value as Record<string, unknown> }
const text = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value }
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid(); return Number(value) }
const enabled = (value: unknown): boolean => { if (typeof value !== 'boolean') throw invalid(); return value }
const list = <T>(value: unknown, parse: (item: unknown) => T): T[] => { if (!Array.isArray(value)) throw invalid(); return value.map(parse) }

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

export function parseExecutionList<T>(value: unknown, parse: (item: unknown) => T): T[] { return list(value, parse) }
