import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@elysian/contracts'
import { ChatSwitchNotice, chatSwitchNotice } from './ChatSwitchNotice'

function message(runConfig?: AgentMessage['runConfig'], id = 'm1'): AgentMessage {
  return { id, seq: '1', sessionId: 's', taskId: 't', runId: 'r', role: 'user', content: '内容', createdAt: '2026-10-19T00:00:00Z',
    ...(runConfig ? { runConfig } : {}) }
}

function config(overrides: Partial<NonNullable<AgentMessage['runConfig']>> = {}): NonNullable<AgentMessage['runConfig']> {
  return { modelName: 'deepseek-flash', modelService: 'DeepSeek', modelProfileId: 'profile-1', modelRevision: 1, reasoningLevel: 'high', ...overrides }
}

describe('轮次设置切换说明', () => {
  it('首轮或旧记录缺少快照时不显示', () => {
    expect(chatSwitchNotice(undefined, message(config()))).toBeNull()
    expect(chatSwitchNotice(message(), message(config()))).toBeNull()
    expect(chatSwitchNotice(message(config()), message())).toBeNull()
  })

  it('旧记录的空快照与未变化的配置都不显示', () => {
    const legacy = { modelName: '', modelProfileId: '', modelRevision: 0 }
    expect(chatSwitchNotice(message(legacy, 'previous'), message(config(), 'current'))).toBeNull()
    expect(chatSwitchNotice(message(config(), 'previous'), message(legacy, 'current'))).toBeNull()
    expect(chatSwitchNotice(message(config(), 'previous'), message(config(), 'current'))).toBeNull()
  })

  it('模型与思考等级同时变化时合并为一条说明', () => {
    const previous = message(config(), 'previous')
    const current = message(config({ modelName: 'GLM-5.3', modelService: '个人套餐', modelProfileId: 'profile-2', reasoningLevel: 'max' }), 'current')
    expect(chatSwitchNotice(previous, current)).toBe('模型已切换 deepseek-flash（DeepSeek） → GLM-5.3（个人套餐） · 思考等级已切换 高 → 最高')
  })

  it('只更新模型修订时说明配置已更新', () => {
    expect(chatSwitchNotice(message(config(), 'previous'), message(config({ modelRevision: 2 }), 'current')))
      .toBe('模型配置已更新 deepseek-flash（DeepSeek）')
  })

  it('只改思考等级时只显示等级变化', () => {
    expect(chatSwitchNotice(message(config({ reasoningLevel: 'low' }), 'previous'), message(config({ reasoningLevel: 'max' }), 'current')))
      .toBe('思考等级已切换 低 → 最高')
  })

  it('渲染为居中分隔说明', () => {
    render(<ChatSwitchNotice text="模型已切换 A → B" />)
    expect(screen.getByRole('note', { name: '对话设置变更' })).toHaveTextContent('模型已切换 A → B')
  })
})
