import { describe, expect, it } from 'vitest'
import { discoveredModelDraft, modelPresetDraft } from './modelDraft'

describe('模型目录与预设参数', () => {
  it('DeepSeek Flash 与 Pro 的图片能力不同，输出容量取官方最大值', () => {
    const flash = discoveredModelDraft('deepseek', { model: 'deepseek-flash', name: 'Flash' })
    const pro = discoveredModelDraft('deepseek', { model: 'deepseek-v4-pro', name: 'Pro' })
    expect(flash).toMatchObject({ contextTokens: '1048576', outputTokens: '393216', image: true, webSearch: false, structuredOutput: true, reasoningLevels: ['disabled', 'low', 'high', 'max'], defaultReasoningLevel: 'high' })
    expect(pro).toMatchObject({ contextTokens: '1048576', outputTokens: '393216', image: false })
    expect(modelPresetDraft('deepseek', 'unknown-model')).toBeUndefined()
    expect(modelPresetDraft('openai-compatible', 'deepseek-flash')).toBeUndefined()
  })
  it('智谱 GLM-5.3 与 GLM-5.3-Flash：1M 上下文、128K 输出、思考档位 low/high/max，模型 ID 大小写不敏感', () => {
    const glm = discoveredModelDraft('zhipu', { model: 'glm-5.3', name: 'GLM-5.3' })
    const flash = discoveredModelDraft('zhipu', { model: 'glm-5.3-flash', name: 'GLM-5.3-Flash' })
    expect(glm).toMatchObject({ contextTokens: '1048576', outputTokens: '131072', image: false, video: false, tools: true, structuredOutput: true, systemMessages: true, reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'max', source: '智谱 BigModel 官方文档（2026-10-15）' })
    expect(flash).toMatchObject({ contextTokens: '1048576', outputTokens: '131072', image: true, video: true, reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'max' })
    expect(modelPresetDraft('zhipu', 'GLM-5.3')).toMatchObject({ contextTokens: '1048576' })
    expect(modelPresetDraft('zhipu', 'glm-4.6')).toBeUndefined()
    expect(modelPresetDraft('deepseek', 'glm-5.3')).toBeUndefined()
  })
  it('不把未知服务的默认输出放大到上下文容量，明确的远端容量优先', () => {
    expect(discoveredModelDraft('openai-compatible', { model: 'custom', name: 'Custom' })).toMatchObject({ outputTokens: '4096', image: false, tools: true, structuredOutput: true, systemMessages: true, webSearch: false, reasoningLevels: [], source: '模型服务目录与默认配置' })
    expect(discoveredModelDraft('openai-compatible', { model: 'custom', name: 'Custom', contextTokens: 2048 })).toMatchObject({ outputTokens: '2048' })
    expect(discoveredModelDraft('deepseek', { model: 'deepseek-flash', name: 'Flash', contextTokens: 128000, outputTokens: 8000 })).toMatchObject({ contextTokens: '128000', outputTokens: '8000' })
  })
})
