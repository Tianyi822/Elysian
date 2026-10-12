import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMCPCatalogProjection } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'

/*
 * 能力目录只读选项的加载 hook：新建会话/任务引用与环境编辑共用。
 * 数据来自 gateway.agentExtensions（技能、MCP 服务器与固定目录）——只读消费，
 * 写操作仍归属各自域模块。目录按服务器懒加载并缓存；单个服务器目录不可用
 * 只降级该节（显示中文原因），不拖垮整个选择器。
 */

export type McpServerOption = {
  id: string
  revision: number
  label: string
  transport: string
  catalog?: AgentMCPCatalogProjection
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogError?: string
}

export type ReferenceCatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  skills: readonly { id: string; revision: number; label: string; description: string }[]
  servers: readonly McpServerOption[]
  load(gateway: ElysianGateway): Promise<void>
  ensureCatalog(gateway: ElysianGateway, serverId: string): Promise<void>
}

export function useReferenceCatalog(): ReferenceCatalogState {
  const [status, setStatus] = useState<ReferenceCatalogState['status']>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [skills, setSkills] = useState<ReferenceCatalogState['skills']>([])
  const [servers, setServers] = useState<readonly McpServerOption[]>([])
  const sequenceRef = useRef(0)

  const load = useCallback(async (gateway: ElysianGateway) => {
    const sequence = ++sequenceRef.current
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'))
    try {
      const [skillList, serverList] = await Promise.all([
        gateway.agentExtensions.listSkills(),
        gateway.agentExtensions.listMcpServers(),
      ])
      if (sequence !== sequenceRef.current) return
      setSkills(skillList.map((skill) => ({
        id: skill.id,
        revision: skill.revision,
        label: `${skill.manifest.name}（修订 ${skill.revision}）`,
        description: skill.manifest.description,
      })))
      setServers(serverList
        .filter((server) => server.active && !server.revoked)
        .map((server) => ({
          id: server.id,
          revision: server.revision,
          label: `${server.name}（修订 ${server.revision}）`,
          transport: server.transport,
          catalogStatus: 'idle' as const,
        })))
      setStatus('ready')
      setError(undefined)
    } catch (cause) {
      if (sequence !== sequenceRef.current) return
      setStatus('error')
      setError(cause instanceof Error ? cause.message : '读取技能与 MCP 目录失败')
    }
  }, [])

  const ensureCatalog = useCallback(async (gateway: ElysianGateway, serverId: string) => {
    const current = servers.find((server) => server.id === serverId)
    if (current === undefined || current.catalogStatus === 'loading' || current.catalogStatus === 'ready') return
    setServers((list) => list.map((server) => server.id === serverId ? { ...server, catalogStatus: 'loading', catalogError: undefined } : server))
    try {
      const catalog = await gateway.agentExtensions.getMcpCatalog(serverId, current.revision)
      setServers((list) => list.map((server) => server.id === serverId ? { ...server, catalog, catalogStatus: 'ready' } : server))
    } catch (cause) {
      setServers((list) => list.map((server) => server.id === serverId
        ? { ...server, catalogStatus: 'error', catalogError: cause instanceof Error ? cause.message : '读取 MCP 目录失败' }
        : server))
    }
  }, [servers])

  useEffect(() => () => { sequenceRef.current += 1 }, [])

  return { status, error, skills, servers, load, ensureCatalog }
}
