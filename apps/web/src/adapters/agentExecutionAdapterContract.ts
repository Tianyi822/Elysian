import { describe, expect, it } from 'vitest'
import type { AgentExecutionAdapter } from '../contracts/agentExecution'
import { executionGrantInput, executionProfileInput } from '../test/agentExecutionFixtures'

/** HTTP 与 mock 共用可观察契约：修订不可变、CAS 冲突与范围完整往返。 */
export function runAgentExecutionAdapterContract(name: string, make: () => AgentExecutionAdapter) {
  describe(`${name} 执行配置与授权契约`, () => {
    it('创建、编辑和启停保留完整历史，旧修订不能覆盖新配置', async () => {
      const adapter = make()
      expect(await adapter.listProfiles()).toEqual([])
      const first = await adapter.createProfile({ ...executionProfileInput, name: '  受限 Bash  ' })
      expect(first).toMatchObject({ name: '受限 Bash', revision: 1, command: ['bash'] })
      const second = await adapter.updateProfile(first.id, { ...executionProfileInput, expectedRevision: 1, command: ['bash', '-eu'], timeoutSeconds: 120 })
      expect(second).toMatchObject({ id: first.id, revision: 2, command: ['bash', '-eu'], timeoutSeconds: 120 })
      expect(await adapter.getProfile(first.id, 1)).toEqual(first)
      await expect(adapter.updateProfile(first.id, { ...executionProfileInput, expectedRevision: 1 })).rejects.toThrow('已被修改')
      const disabled = await adapter.setProfileEnabled(first.id, 2, false)
      expect(disabled).toMatchObject({ enabled: false, revision: 3 })
      expect((await adapter.setProfileEnabled(first.id, 3, true)).revision).toBe(4)
      expect(await adapter.listProfiles()).toHaveLength(1)
    })

    it('三类授权及私网原样往返，修改和启停不丢失已有对象', async () => {
      const adapter = make()
      const first = await adapter.createGrant(executionGrantInput)
      expect(first).toMatchObject({ revision: 1, resources: executionGrantInput.resources, privateCidrs: executionGrantInput.privateCidrs })
      const second = await adapter.updateGrant(first.id, { ...executionGrantInput, expectedRevision: 1, name: '新的名称' })
      expect(second.directories).toEqual(first.directories)
      expect(second.resources).toEqual(first.resources)
      expect(await adapter.getGrant(first.id, 1)).toEqual(first)
      const disabled = await adapter.setGrantEnabled(first.id, 2, false)
      expect(disabled).toMatchObject({ revision: 3, enabled: false, network: first.network, resources: first.resources })
      await expect(adapter.setGrantEnabled(first.id, 2, true)).rejects.toThrow('已被修改')
      expect(await adapter.listGrants()).toEqual([disabled])
    })

    it('不存在的精确修订明确拒绝，不回落最新版本', async () => {
      const adapter = make()
      const profile = await adapter.createProfile(executionProfileInput)
      await expect(adapter.getProfile(profile.id, 99)).rejects.toThrow('不存在')
    })
  })
}
