import { describe, expect, it } from 'vitest'
import { discoveredModelDraft, modelPresetDraft } from './modelDraft'

describe('模型目录与预设参数', () => {
  it('DeepSeek Flash 与 Pro 的图片能力不同，输出容量取官方最大值', () => {
    const flash = discoveredModelDraft('deepseek', { model: 'deepseek-flash', name: 'Flash' })
    const pro = discoveredModelDraft('deepseek', { model: 'deepseek-v4-pro', name: 'Pro' })
    expect(flash).toMatchObject({ contextTokens: '1048576', outputTokens: '393216', image: true, webSearch: false, structuredOutput: true, reasoningLevels: ['disabled', 'low', 'high', 'max'] })
    expect(pro).toMatchObject({ contextTokens: '1048576', outputTokens: '393216', image: false })
    expect(modelPresetDraft('deepseek', 'unknown-model')).toBeUndefined()
    expect(modelPresetDraft('openai-compatible', 'deepseek-flash')).toBeUndefined()
  })
  it('不把未知服务的默认输出放大到上下文容量，明确的远端容量优先', () => {
    expect(discoveredModelDraft('openai-compatible', { model: 'custom', name: 'Custom' })).toMatchObject({ outputTokens: '4096', image: false, reasoningLevels: [] })
    expect(discoveredModelDraft('openai-compatible', { model: 'custom', name: 'Custom', contextTokens: 2048 })).toMatchObject({ outputTokens: '2048' })
    expect(discoveredModelDraft('deepseek', { model: 'deepseek-flash', name: 'Flash', contextTokens: 128000, outputTokens: 8000 })).toMatchObject({ contextTokens: '128000', outputTokens: '8000' })
  })
})
