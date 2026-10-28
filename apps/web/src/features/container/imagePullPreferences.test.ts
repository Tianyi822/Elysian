import { describe, expect, it, vi } from 'vitest'
import { resilientPreferenceStorage } from '../../utils/preferenceStorage'
import { IMAGE_PULL_PREFERENCES_KEY, readStoredImageRegistry, writeStoredImageRegistry } from './imagePullPreferences'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('拉取镜像的浏览器源偏好', () => {
  it('保存带版本的源地址，去掉首尾空白；清空后回到官方默认', () => {
    const port = storage()
    writeStoredImageRegistry(' https://docker.1ms.run/ ', port)
    expect(JSON.parse(port.getItem(IMAGE_PULL_PREFERENCES_KEY)!)).toEqual({ version: 1, registry: 'https://docker.1ms.run/' })
    expect(readStoredImageRegistry(port)).toBe('https://docker.1ms.run/')
    writeStoredImageRegistry('', port)
    expect(port.getItem(IMAGE_PULL_PREFERENCES_KEY)).toBeNull()
    expect(readStoredImageRegistry(port)).toBe('')
  })

  it('无效地址不覆盖上次有效偏好，也不保存凭据', () => {
    const port = storage()
    writeStoredImageRegistry('docker.1ms.run', port)
    writeStoredImageRegistry('https://user:password@docker.1ms.run', port)
    expect(readStoredImageRegistry(port)).toBe('docker.1ms.run')
    expect(port.getItem(IMAGE_PULL_PREFERENCES_KEY)).not.toContain('password')
  })

  it.each(['not-json', '{}', '{"version":2,"registry":"docker.1ms.run"}', '{"version":1,"registry":"http://docker.io"}'])('忽略损坏或未知格式 %s', (value) => {
    const port = storage()
    port.setItem(IMAGE_PULL_PREFERENCES_KEY, value)
    expect(readStoredImageRegistry(port)).toBe('')
  })

  it('浏览器禁止存储时仍可在当前页面恢复偏好，并提示一次', () => {
    const warning = vi.fn()
    const port = resilientPreferenceStorage(() => { throw new Error('存储不可用') }, warning)
    writeStoredImageRegistry('docker.1ms.run', port)
    writeStoredImageRegistry('https://docker.1ms.run', port)
    expect(readStoredImageRegistry(port)).toBe('https://docker.1ms.run')
    expect(warning).toHaveBeenCalledTimes(1)
  })
})
