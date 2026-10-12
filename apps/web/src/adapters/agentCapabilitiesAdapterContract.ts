import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentExecutionGrantInput,
  AgentExecutionProfileInput,
  AgentModelProfileInput,
  AgentResourceRuleInput,
} from '@elysian/contracts'
import type { AgentCapabilitiesAdapter } from '../contracts/adapters'

/*
 * 模型与执行配置域 adapter 契约断言集：对 mock 与 HTTP 两个实现各跑一遍，
 * 这就是「mock 可替换」的验证方式。断言覆盖验收语义：
 * - 模型闭环：新建（凭据只写不回显）→列表回显 hasCredential→更新（省略沿用/
 *   空串清除）产生新修订→expectedRevision 冲突抛服务端中文文案并携带 code；
 * - 执行配置/授权：新建禁止自带编号、路径与编号不一致拒绝、启停回读、
 *   历史修订可读、限额超界拒绝；
 * - 资源规则：digest/revision 随更新变化、历史修订可读、CAS 冲突；
 * - 执行器运行时：列表为只读数组（条目形状由共享 parse 保证）。
 */

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined
}

async function rejectsWith(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      code: errorCode(error),
    }
  }
  throw new Error('预期抛错，但请求成功了')
}

const MODEL_INPUT: AgentModelProfileInput = {
  name: '契约模型',
  baseUrl: 'https://api.example.com/v1',
  model: 'contract-test-model',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 64000,
  outputTokens: 4096,
  capabilities: { text: true, tools: true, source: '契约测试' },
  active: true,
}

function executionInput(overrides: Partial<AgentExecutionProfileInput> = {}): AgentExecutionProfileInput {
  return {
    enabled: true,
    name: '契约执行配置',
    image: 'registry.example.com/elysian/contract@sha256:' + 'ab12cd34'.repeat(8),
    runtime: 'python',
    command: ['python3', '-'],
    timeoutSeconds: 60,
    cpuMillis: 500,
    memoryBytes: 268435456,
    pids: 64,
    expectedRevision: 0,
    ...overrides,
  }
}

function grantInput(overrides: Partial<AgentExecutionGrantInput> = {}): AgentExecutionGrantInput {
  return {
    enabled: true,
    name: '契约授权',
    directories: [{ path: '/srv/projects/demo', access: 'ro' }],
    network: [{ scheme: 'https', host: 'registry.example.com', port: 443 }],
    privateCidrs: [],
    expectedRevision: 0,
    ...overrides,
  }
}

function ruleInput(overrides: Partial<AgentResourceRuleInput> = {}): AgentResourceRuleInput {
  return {
    name: '契约资源规则',
    enabled: true,
    complete: true,
    selector: {
      source: 'mcp-tool',
      ref: { id: 'mcp-server-contract', revision: 2, digest: 'd'.repeat(16) },
      originalName: 'contract_lookup',
      catalogDigest: 'c'.repeat(16),
    },
    mappings: [{ kind: 'registry-entry', authority: 'mcp', access: 'read', literal: 'registry/entries' }],
    ...overrides,
  }
}

export function runAgentCapabilitiesAdapterContract(
  name: string,
  make: () => AgentCapabilitiesAdapter | Promise<AgentCapabilitiesAdapter>,
): void {
  describe(`AgentCapabilitiesAdapter 契约断言：${name}`, () => {
    let adapter: AgentCapabilitiesAdapter

    beforeEach(async () => {
      adapter = await make()
    })

    describe('模型配置闭环', () => {
      it('新建提交凭据后列表回显 hasCredential=true，凭据不回显', async () => {
        const created = await adapter.createModelProfile({ ...MODEL_INPUT, credential: 'contract-secret' })
        expect(created.revision).toBe(1)
        expect(created.hasCredential).toBe(true)
        expect(Object.hasOwn(created as unknown as Record<string, unknown>, 'credential')).toBe(false)
        const listed = await adapter.listModelProfiles()
        const hit = listed.find((item) => item.id === created.id)
        expect(hit?.hasCredential).toBe(true)
        expect(hit && Object.hasOwn(hit as unknown as Record<string, unknown>, 'credential')).toBe(false)
      })

      it('更新省略凭据沿用旧值，空串清除；两者都产生新修订', async () => {
        const created = await adapter.createModelProfile({ ...MODEL_INPUT, credential: 'keep-me' })
        const kept = await adapter.updateModelProfile(created.id, { ...MODEL_INPUT, expectedRevision: created.revision })
        expect(kept.revision).toBe(created.revision + 1)
        expect(kept.hasCredential).toBe(true)
        const cleared = await adapter.updateModelProfile(created.id, { ...MODEL_INPUT, expectedRevision: kept.revision, credential: '' })
        expect(cleared.revision).toBe(kept.revision + 1)
        expect(cleared.hasCredential).toBe(false)
      })

      it('expectedRevision 不匹配时抛服务端冲突文案并携带 revision-conflict code', async () => {
        const created = await adapter.createModelProfile({ ...MODEL_INPUT, credential: 'x' })
        await adapter.updateModelProfile(created.id, { ...MODEL_INPUT, expectedRevision: created.revision })
        const failure = await rejectsWith(adapter.updateModelProfile(created.id, { ...MODEL_INPUT, expectedRevision: created.revision }))
        expect(failure.message).toContain('请重新读取后重试')
        expect(failure.code).toBe('revision-conflict')
      })

      it('更新不存在的模型配置按 404 文案拒绝', async () => {
        const failure = await rejectsWith(adapter.updateModelProfile('mp-missing', { ...MODEL_INPUT, expectedRevision: 1 }))
        expect(failure.message).toContain('模型配置不存在')
      })
    })

    describe('执行配置闭环', () => {
      it('新建（无 id、预期修订零）回 revision 1，启停回读状态并递增修订', async () => {
        const created = await adapter.createExecutionProfile(executionInput())
        expect(created.revision).toBe(1)
        expect(created.enabled).toBe(true)
        const disabled = await adapter.setExecutionProfileEnabled(created.id, created.revision, false)
        expect(disabled.enabled).toBe(false)
        expect(disabled.revision).toBe(created.revision + 1)
        const enabled = await adapter.setExecutionProfileEnabled(created.id, disabled.revision, true)
        expect(enabled.enabled).toBe(true)
      })

      it('历史修订可按 revision 读取', async () => {
        const created = await adapter.createExecutionProfile(executionInput())
        const updated = await adapter.updateExecutionProfile(created.id, executionInput({
          expectedRevision: created.revision, name: '契约执行配置（改）',
        }))
        expect(updated.revision).toBe(2)
        const historical = await adapter.getExecutionProfile(created.id, 1)
        expect(historical.revision).toBe(1)
        expect(historical.name).toBe('契约执行配置')
        const latest = await adapter.getExecutionProfile(created.id)
        expect(latest.revision).toBe(2)
      })

      it('新建自带编号、路径与编号不一致、启停修订不匹配分别拒绝', async () => {
        const withId = await rejectsWith(adapter.createExecutionProfile(executionInput({ id: 'ep-self' })))
        expect(withId.message).toContain('新建执行配置不能指定编号')
        const created = await adapter.createExecutionProfile(executionInput())
        const mismatch = await rejectsWith(adapter.updateExecutionProfile(created.id, executionInput({
          id: 'ep-other', expectedRevision: created.revision,
        })))
        expect(mismatch.message).toContain('执行配置编号与路径不一致')
        const conflictFailure = await rejectsWith(adapter.setExecutionProfileEnabled(created.id, created.revision + 5, false))
        expect(conflictFailure.message).toContain('请重新读取后重试')
        expect(conflictFailure.code).toBe('execution_revision_conflict')
      })

      it('越界限额（超 300 秒 / 1000 毫秒 / 512 MiB / 128 PID）被拒绝并说明上限', async () => {
        const timeout = await rejectsWith(adapter.createExecutionProfile(executionInput({ timeoutSeconds: 301 })))
        expect(timeout.message).toContain('512 MiB')
        const cpu = await rejectsWith(adapter.createExecutionProfile(executionInput({ cpuMillis: 1001 })))
        expect(cpu.message).toContain('1 CPU')
        const memory = await rejectsWith(adapter.createExecutionProfile(executionInput({ memoryBytes: 512 * 1024 * 1024 + 1 })))
        expect(memory.message).toContain('512 MiB')
        const pids = await rejectsWith(adapter.createExecutionProfile(executionInput({ pids: 129 })))
        expect(pids.message).toContain('128')
      })
    })

    describe('目录与网络授权闭环', () => {
      it('新建、启停与历史修订回读', async () => {
        const created = await adapter.createGrant(grantInput())
        expect(created.revision).toBe(1)
        const disabled = await adapter.setGrantEnabled(created.id, created.revision, false)
        expect(disabled.enabled).toBe(false)
        const updated = await adapter.updateGrant(created.id, grantInput({
          expectedRevision: disabled.revision, name: '契约授权（改）',
          directories: [{ path: '/srv/projects/demo', access: 'rw' }],
        }))
        expect(updated.revision).toBe(disabled.revision + 1)
        const historical = await adapter.getGrant(created.id, created.revision)
        expect(historical.directories[0]?.access).toBe('ro')
        const latest = await adapter.getGrant(created.id)
        expect(latest.directories[0]?.access).toBe('rw')
      })

      it('新建自带编号与路径编号不一致分别拒绝，冲突携带 execution_revision_conflict', async () => {
        const withId = await rejectsWith(adapter.createGrant(grantInput({ id: 'eg-self' })))
        expect(withId.message).toContain('新建执行授权不能指定编号')
        const created = await adapter.createGrant(grantInput())
        const mismatch = await rejectsWith(adapter.updateGrant(created.id, grantInput({ id: 'eg-other', expectedRevision: created.revision })))
        expect(mismatch.message).toContain('执行授权编号与路径不一致')
        const conflictFailure = await rejectsWith(adapter.setGrantEnabled(created.id, created.revision + 3, true))
        expect(conflictFailure.code).toBe('execution_revision_conflict')
      })
    })

    describe('资源规则闭环', () => {
      it('编辑后 digest 与 revision 更新，历史修订可读', async () => {
        const created = await adapter.createResourceRule(ruleInput())
        expect(created.revision).toBe(1)
        expect(created.digest).not.toBe('')
        const updated = await adapter.updateResourceRule(created.id, {
          ...ruleInput({ name: '契约资源规则（改）' }),
          expectedRevision: created.revision,
        })
        expect(updated.revision).toBe(2)
        expect(updated.digest).not.toBe(created.digest)
        const historical = await adapter.getResourceRule(created.id, 1)
        expect(historical.name).toBe('契约资源规则')
        const latest = await adapter.getResourceRule(created.id)
        expect(latest.name).toBe('契约资源规则（改）')
      })

      it('CAS 冲突抛服务端文案并携带 revision-conflict code', async () => {
        const created = await adapter.createResourceRule(ruleInput())
        const failure = await rejectsWith(adapter.updateResourceRule(created.id, {
          ...ruleInput(),
          expectedRevision: created.revision + 9,
        }))
        expect(failure.message).toContain('资源规则修订已变化')
        expect(failure.code).toBe('revision-conflict')
      })
    })

    describe('执行器运行时', () => {
      it('列表返回只读数组（未就绪时为空数组）', async () => {
        const runtimes = await adapter.listExecutionRuntimes()
        expect(Array.isArray(runtimes)).toBe(true)
        for (const runtime of runtimes) {
          expect(typeof runtime.id).toBe('string')
          expect(typeof runtime.containerId).toBe('string')
          expect(typeof runtime.state).toBe('string')
        }
      })
    })
  })
}
