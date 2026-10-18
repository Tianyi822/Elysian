import { describe, expect, it } from 'vitest'
import type { AgentSkillImportTask } from '@elysian/contracts'
import type { AgentExtensionsAdapter } from '../contracts/adapters'

/*
 * 技能与 MCP 域适配器契约断言：mock 与 HTTP 两个实现各跑一遍同一套。
 * 套件只经 adapter 接口操作，从空库起步（调用方负责 mock 复位或 fetch 桩初始化），
 * 断言与服务端 extensions_routes.go 相同的可观察语义：
 * 导入异步闭环（读取推进 queued→running→终态）、requestId 幂等与冲突、
 * 取消与终态记录删除、启停/删除的修订 CAS、MCP 增改查、probe 与固定目录读取
 * （含 digest 不符的 404）以及凭据/环境变量只写不回显。
 */

function terminalStates(): ReadonlySet<string> {
  return new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
}

/** 轮询到终态；两个实现都在有限次读取内推进，死循环即失败。 */
async function pollTerminal(adapter: AgentExtensionsAdapter, importId: string, attempts = 12): Promise<AgentSkillImportTask> {
  let latest: AgentSkillImportTask | undefined
  for (let index = 0; index < attempts; index += 1) {
    const task = await adapter.getSkillImport(importId)
    latest = task
    if (terminalStates().has(task.state)) return task
  }
  throw new Error(`导入任务 ${importId} 在 ${attempts} 次读取后仍未终态（最后状态 ${latest?.state ?? '未知'}）`)
}

export function runAgentExtensionsAdapterContract(name: string, make: () => AgentExtensionsAdapter): void {
  describe(`${name} 技能与 MCP 适配器契约`, () => {
    it('技能导入闭环：JSON 来源创建 → 轮询到终态成功 → 技能目录出现且启停尊重提交值', async () => {
      const adapter = make()
      expect(await adapter.listSkills()).toEqual([])
      const created = await adapter.createSkillImport({
        requestId: 'contract-import-a',
        source: { kind: 'directory', path: '/opt/skills/demo-a' },
        enabled: true,
      })
      expect(created.id).toBeTruthy()
      expect(created.requestId).toBe('contract-import-a')
      expect(['queued', 'running']).toContain(created.state)
      const finished = await pollTerminal(adapter, created.id)
      expect(finished.state).toBe('succeeded')
      expect(finished.skillId).toBeTruthy()
      expect(finished.revision).toBe(1)
      const skills = await adapter.listSkills()
      const imported = skills.find((item) => item.id === finished.skillId)
      expect(imported).toBeDefined()
      expect(imported?.enabled).toBe(true)
      const detail = await adapter.getSkill(finished.skillId ?? '')
      expect(detail.id).toBe(finished.skillId)
      expect(detail.files.length).toBeGreaterThan(0)
      // 停用产生新修订，状态回读为准。
      const disabled = await adapter.setSkillEnabled(detail.id, detail.revision, false)
      expect(disabled.enabled).toBe(false)
      expect(disabled.revision).toBe(detail.revision + 1)
      const enabledAgain = await adapter.setSkillEnabled(disabled.id, disabled.revision, true)
      expect(enabledAgain.enabled).toBe(true)
      // 修订 CAS：旧修订再写被拒，错误为服务端中文文案。
      await expect(adapter.setSkillEnabled(detail.id, detail.revision, false))
        .rejects.toThrow('技能修订已变化，请重新读取')
    })

    it('ZIP 导入 multipart：创建后同样走到终态并落进技能目录', async () => {
      const adapter = make()
      const archive = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], { type: 'application/zip' })
      const created = await adapter.createSkillImport({
        requestId: 'contract-import-zip',
        source: { kind: 'zip' },
        enabled: false,
      }, archive)
      expect(created.state).toBe('queued')
      const finished = await pollTerminal(adapter, created.id)
      expect(finished.state).toBe('succeeded')
      const imported = (await adapter.listSkills()).find((item) => item.id === finished.skillId)
      // enabled 尊重提交值：导入时选择停用。
      expect(imported?.enabled).toBe(false)
    })

    it('导入幂等：同 requestId 同输入回读原任务，不同输入报 request-conflict 中文错误', async () => {
      const adapter = make()
      const input = {
        requestId: 'contract-import-idem',
        source: { kind: 'directory', path: '/opt/skills/demo-idem' } as const,
        enabled: true,
      }
      const first = await adapter.createSkillImport({ ...input })
      const duplicate = await adapter.createSkillImport({
        requestId: 'contract-import-idem',
        source: { kind: 'directory', path: '/opt/skills/demo-idem' },
        enabled: true,
      })
      expect(duplicate.id).toBe(first.id)
      await expect(adapter.createSkillImport({
        requestId: 'contract-import-idem',
        source: { kind: 'directory', path: '/opt/skills/demo-other' },
        enabled: true,
      })).rejects.toThrow('该请求标识已用于不同的技能导入')
    })

    it('导入取消与终态记录删除：排队任务可取消，仅终态记录可删', async () => {
      const adapter = make()
      const created = await adapter.createSkillImport({
        requestId: 'contract-import-cancel',
        source: { kind: 'directory', path: '/opt/skills/demo-cancel' },
        enabled: true,
      })
      const cancelled = await adapter.cancelSkillImport(created.id)
      expect(['cancelled', 'running']).toContain(cancelled.state)
      const finished = await pollTerminal(adapter, created.id)
      expect(finished.state).toBe('cancelled')
      await adapter.deleteSkillImportRecord(created.id)
      await expect(adapter.getSkillImport(created.id)).rejects.toThrow('技能导入任务不存在')
    })

    it('技能删除：按最新修订 CAS，删除后目录与详情都不再返回', async () => {
      const adapter = make()
      const created = await adapter.createSkillImport({
        requestId: 'contract-import-delete',
        source: { kind: 'directory', path: '/opt/skills/demo-delete' },
        enabled: true,
      })
      const finished = await pollTerminal(adapter, created.id)
      const skillId = finished.skillId ?? ''
      const before = await adapter.getSkill(skillId)
      await adapter.deleteSkill(skillId, before.revision)
      expect((await adapter.listSkills()).some((item) => item.id === skillId)).toBe(false)
      await expect(adapter.getSkill(skillId)).rejects.toThrow('技能不存在')
      await expect(adapter.deleteSkill(skillId, before.revision)).rejects.toThrow('技能不存在')
    })

    it('MCP HTTP 服务：新建回读、改名产生新修订、probe 与按 digest 固定目录', async () => {
      const adapter = make()
      const created = await adapter.createMcpServer({
        name: '演示检索',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        active: true,
        revoked: false,
        credential: 'demo-secret',
      })
      expect(created.transport).toBe('streamable-http')
      // 凭据只写不回显：只有 hasCredential 布尔。
      expect(created.hasCredential).toBe(true)
      expect(JSON.stringify(created)).not.toContain('demo-secret')
      const read = await adapter.getMcpServer(created.id, created.revision)
      expect(read.name).toBe('演示检索')
      const updated = await adapter.updateMcpServer(created.id, {
        name: '演示检索（改名）',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        active: true,
        revoked: false,
        expectedRevision: created.revision,
      })
      expect(updated.revision).toBe(created.revision + 1)
      await expect(adapter.updateMcpServer(created.id, {
        name: '过期修订',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        active: true,
        revoked: false,
        expectedRevision: created.revision,
      })).rejects.toThrow('MCP 配置已修改，请重新读取后重试')
      const probe = await adapter.probeMcpServer(updated.id, updated.revision)
      expect(probe.protocolVersion).toBe('2025-11-25')
      expect(probe.tools.length).toBeGreaterThan(0)
      expect(Object.keys(probe.modelAliases).length).toBe(probe.tools.length)
      const catalog = await adapter.getMcpCatalog(updated.id, updated.revision, probe.digest)
      expect(catalog.digest).toBe(probe.digest)
      // digest 不符按服务端 404 文案报错，不回落到最近目录。
      await expect(adapter.getMcpCatalog(updated.id, updated.revision, 'sha256:0000'))
        .rejects.toThrow('MCP 服务尚无匹配的已验证目录')
    })

    it('MCP stdio 服务：grant 绑定与环境变量只写不回显', async () => {
      const adapter = make()
      const created = await adapter.createMcpServer({
        name: '演示 stdio',
        transport: 'stdio',
        active: true,
        revoked: false,
        stdio: {
          image: 'registry.example.com/mcp/demo:1.0.0',
          command: ['mcp-demo', '--stdio'],
          grantId: 'grant-demo',
          grantRevision: 3,
          environment: { DEMO_TOKEN: 'secret-value' },
        },
      })
      expect(created.stdio?.image).toBe('registry.example.com/mcp/demo:1.0.0')
      expect(created.stdio?.grantId).toBe('grant-demo')
      expect(created.stdio?.grantRevision).toBe(3)
      expect(created.stdio?.hasEnvironment).toBe(true)
      // 环境变量值不回显：公开投影里只剩 hasEnvironment 布尔。
      expect(JSON.stringify(created)).not.toContain('secret-value')
      expect(JSON.stringify(created)).not.toContain('DEMO_TOKEN')
      // 更新时省略 environment 沿用旧值：hasEnvironment 保持。
      const updated = await adapter.updateMcpServer(created.id, {
        name: '演示 stdio',
        transport: 'stdio',
        active: false,
        revoked: false,
        stdio: {
          image: 'registry.example.com/mcp/demo:1.0.0',
          command: ['mcp-demo', '--stdio'],
          grantId: 'grant-demo',
          grantRevision: 3,
        },
        expectedRevision: created.revision,
      })
      expect(updated.stdio?.hasEnvironment).toBe(true)
      expect(updated.active).toBe(false)
    })
  })
}
