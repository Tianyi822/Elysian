import type { AgentWorkspaceFile, AgentSkillSource, AgentSkill, AgentMCPServer } from '@elysian/contracts'

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function boolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

function nonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(message)
  return value
}

function strings(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(message)
  return value as readonly string[]
}

function parseWorkspaceFile(value: unknown, label: string): AgentWorkspaceFile {
  const row = object(value, `Agent ${label}文件无效`)
  return {
    path: string(row.path, `Agent ${label}文件无效`),
    size: nonNegativeInteger(row.size, `Agent ${label}文件无效`),
    digest: string(row.digest, `Agent ${label}文件无效`),
  }
}

function parseSkillSource(value: unknown): AgentSkillSource {
  const row = object(value, 'Agent 技能来源无效')
  if (row.kind !== 'directory' && row.kind !== 'zip' && row.kind !== 'git') {
    throw new Error('Agent 技能来源无效')
  }
  return {
    kind: row.kind,
    ...row.path === undefined ? {} : { path: string(row.path, 'Agent 技能来源无效') },
    ...row.url === undefined ? {} : { url: string(row.url, 'Agent 技能来源无效') },
    ...row.ref === undefined ? {} : { ref: string(row.ref, 'Agent 技能来源无效') },
    ...row.subdirectory === undefined ? {} : { subdirectory: string(row.subdirectory, 'Agent 技能来源无效') },
    /** 服务端解析的完整提交；导入请求不接受预填。 */
    ...row.commit === undefined ? {} : { commit: string(row.commit, 'Agent 技能来源无效') },
  }
}

/** 技能条目：不可变内容包摘要加文件清单；manifest 自述不能替代授权。 */
export function parseAgentSkill(value: unknown): AgentSkill {
  const row = object(value, 'Agent 技能响应无效')
  const manifestRow = object(row.manifest, 'Agent 技能清单无效')
  let metadata: Readonly<Record<string, string>> | undefined
  if (manifestRow.metadata !== undefined) {
    const raw = object(manifestRow.metadata, 'Agent 技能清单无效')
    for (const entryValue of Object.values(raw)) {
      if (typeof entryValue !== 'string') throw new Error('Agent 技能清单无效')
    }
    metadata = raw as Readonly<Record<string, string>>
  }
  return {
    id: string(row.id, 'Agent 技能响应无效'),
    revision: positiveInteger(row.revision, 'Agent 技能响应无效'),
    createdAt: string(row.createdAt, 'Agent 技能响应无效'),
    enabled: boolean(row.enabled, 'Agent 技能响应无效'),
    source: parseSkillSource(row.source),
    manifest: {
      name: string(manifestRow.name, 'Agent 技能清单无效'),
      description: string(manifestRow.description, 'Agent 技能清单无效'),
      ...manifestRow.license === undefined ? {} : { license: string(manifestRow.license, 'Agent 技能清单无效') },
      ...manifestRow.compatibility === undefined ? {} : { compatibility: string(manifestRow.compatibility, 'Agent 技能清单无效') },
      ...(metadata === undefined ? {} : { metadata }),
      ...manifestRow.allowedTools === undefined ? {} : { allowedTools: string(manifestRow.allowedTools, 'Agent 技能清单无效') },
    },
    digest: string(row.digest, 'Agent 技能响应无效'),
    bytes: nonNegativeInteger(row.bytes, 'Agent 技能响应无效'),
    files: Array.isArray(row.files) ? row.files.map((item) => parseWorkspaceFile(item, '技能')) : [],
  }
}

/** 公开 MCP 服务投影：不含 credential 与容器 environment。 */
export function parseAgentMCPServer(value: unknown): AgentMCPServer {
  const row = object(value, 'Agent MCP 服务响应无效')
  if (row.transport !== 'streamable-http' && row.transport !== 'stdio') {
    throw new Error('Agent MCP 服务响应无效')
  }
  let stdio: AgentMCPServer['stdio']
  if (row.stdio !== undefined) {
    const spec = object(row.stdio, 'Agent MCP 容器规格无效')
    stdio = {
      image: string(spec.image, 'Agent MCP 容器规格无效'),
      command: strings(spec.command, 'Agent MCP 容器规格无效'),
      hasEnvironment: boolean(spec.hasEnvironment, 'Agent MCP 容器规格无效'),
      ...spec.grantId === undefined ? {} : { grantId: string(spec.grantId, 'Agent MCP 容器规格无效') },
      ...spec.grantRevision === undefined ? {} : { grantRevision: positiveInteger(spec.grantRevision, 'Agent MCP 容器规格无效') },
    }
  }
  return {
    id: string(row.id, 'Agent MCP 服务响应无效'),
    revision: positiveInteger(row.revision, 'Agent MCP 服务响应无效'),
    name: string(row.name, 'Agent MCP 服务响应无效'),
    transport: row.transport,
    ...row.url === undefined ? {} : { url: string(row.url, 'Agent MCP 服务响应无效') },
    ...(stdio === undefined ? {} : { stdio }),
    active: boolean(row.active, 'Agent MCP 服务响应无效'),
    revoked: boolean(row.revoked, 'Agent MCP 服务响应无效'),
    hasCredential: boolean(row.hasCredential, 'Agent MCP 服务响应无效'),
  }
}

