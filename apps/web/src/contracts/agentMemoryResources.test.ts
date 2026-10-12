import { describe, expect, it } from 'vitest'
import {
  AGENT_MEMORY_PAGE_KINDS, AGENT_MEMORY_PAGE_KIND_LABELS,
  AGENT_MEMORY_PROPOSAL_STATUSES, AGENT_MEMORY_PROPOSAL_STATUS_LABELS,
  AGENT_RESOURCE_LEASE_STATUSES, AGENT_RESOURCE_LEASE_STATUS_LABELS,
} from '@elysian/contracts'
import type {
  AgentEmbeddingProfile, AgentEmbeddingRequest, AgentMemoryChecks, AgentMemoryExtraction, AgentMemoryIndexStatus,
  AgentMemoryPage, AgentMemoryProposal, AgentMemorySearchResult, AgentMemorySpace,
  AgentResourceLease, AgentResourceRule, AgentWorkflowDefinition,
  AgentWorkflowExecutionTree, AgentWorkflowRecoveryInput,
  AgentWorkspaceView,
} from '@elysian/contracts'
import fixture from '../../../../packages/foundation/contracts/fixtures/agent-memory-resources.json'
import workflow from '../../../../packages/foundation/contracts/fixtures/agent-workflow-v2.json'

describe('长期记忆、资源互斥和复合流程共享契约', () => {
  it('状态与页面类型都有中文标签', () => {
    expect(Object.keys(AGENT_MEMORY_PAGE_KIND_LABELS)).toEqual([...AGENT_MEMORY_PAGE_KINDS])
    expect(Object.keys(AGENT_MEMORY_PROPOSAL_STATUS_LABELS)).toEqual([...AGENT_MEMORY_PROPOSAL_STATUSES])
    expect(Object.keys(AGENT_RESOURCE_LEASE_STATUS_LABELS)).toEqual([...AGENT_RESOURCE_LEASE_STATUSES])
    for (const label of [...Object.values(AGENT_MEMORY_PAGE_KIND_LABELS), ...Object.values(AGENT_MEMORY_PROPOSAL_STATUS_LABELS), ...Object.values(AGENT_RESOURCE_LEASE_STATUS_LABELS)]) expect(label).toMatch(/[\u4e00-\u9fff]/)
  })

  it('Go共用记忆修订、候选、独立embedding配置与资源租约字段', () => {
    const space: AgentMemorySpace = { ...fixture.space, kind: 'business' }
    const page: AgentMemoryPage = { ...fixture.page, kind: 'runbook', status: 'active' }
    const proposal: AgentMemoryProposal = { ...fixture.proposal, status: 'pending', page: { ...fixture.proposal.page, kind: 'runbook' } }
    const embedding: AgentEmbeddingProfile = fixture.embedding
    const embeddingRequest: AgentEmbeddingRequest = { ...fixture.embeddingRequest, purpose: 'query', status: 'succeeded' }
    const extraction: AgentMemoryExtraction = { ...fixture.extraction, model: { ...fixture.extraction.model, provider: 'openai-compatible', apiFormat: 'chat-completions' }, kind: 'extraction', status: 'succeeded', memoryStatus: 'updated' }
    const search: AgentMemorySearchResult = { ...fixture.search, items: fixture.search.items.map((hit) => ({ ...hit, page, method: 'hybrid-rrf' })) }
    const checks: AgentMemoryChecks = fixture.checks
    const index: AgentMemoryIndexStatus = { ...fixture.index, status: 'ready' }
    const rule: AgentResourceRule = { ...fixture.rule, selector: { ...fixture.rule.selector, source: 'mcp-tool' }, mappings: [{ ...fixture.rule.mappings[0]!, access: 'write' }] }
    const lease: AgentResourceLease = { ...fixture.lease, state: 'unknown', claims: [{ ...fixture.lease.claims[0]!, access: 'write' }] }
    const probeLease: AgentResourceLease = { ...fixture.probeLease, source: 'mcp-probe', state: 'unknown', claims: [{ ...fixture.probeLease.claims[0]!, access: 'write' }] }
    const workspaceView: AgentWorkspaceView = fixture.workspaceView
    expect({ space, page, proposal, embedding, embeddingRequest, extraction, search, checks, index, rule, lease, probeLease, workspaceView }).toEqual(fixture)
    expect(page.evidence[0]?.eventSeq).toBe('9007199254740993')
    expect(embedding).not.toHaveProperty('credential')
    expect(extraction).not.toHaveProperty('input')
    expect(extraction).not.toHaveProperty('response')
    expect(extraction.usage).not.toHaveProperty('cachedTokens')
    expect(embeddingRequest.usage).not.toHaveProperty('totalTokens')
  })

  it('workflow/v2执行树保留固定子作用域与节点恢复定位', () => {
    const leaf = workflow.definition.steps[0]!.parallel.branches[0]!.body.steps[0]!
    const body = {
      entry: 'inspect', outputSchemaJson: '{}', steps: [{ ...leaf, kind: 'operation' as const,
        input: { object: {} }, finish: { step: { stepId: 'inspect', pointer: '' } } }],
    }
    const step = { ...workflow.definition.steps[0]!, kind: 'parallel' as const,
      input: { input: '' }, finish: { step: { stepId: 'parallel-check', pointer: '' } },
      parallel: { join: 'all' as const, branches: ['first', 'second'].map((id) => ({ id, input: { input: '' }, body })) },
    }
    const definition: AgentWorkflowDefinition = { ...workflow.definition, languageVersion: 'workflow/v2', steps: [step] }
    const tree: AgentWorkflowExecutionTree = {
      ...workflow.tree,
      scopes: [{ ...workflow.tree.scopes[0]!, status: 'running', body: { entry: 'parallel-check', outputSchemaJson: '{}', steps: [step] } }],
      nodes: [{ ...workflow.tree.nodes[0]!, kind: 'parallel', status: 'running', allowedActions: [] }],
    }
    const recovery: AgentWorkflowRecoveryInput = { ...workflow.recovery, action: 'retry' }
    expect({ definition, tree, recovery }).toEqual(workflow)
    expect(tree.scopes[0]?.inputJson).toBe('{"serial":9007199254740993}')
    expect(recovery.nodeId).toBe(tree.nodes[0]?.id)
  })
})
