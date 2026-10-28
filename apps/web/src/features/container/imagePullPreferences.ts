import { browserPreferenceStorage } from '../../app/theme/themePreferences'
import type { PreferenceStorage } from '../../app/theme/themePreferences'
import { validateRegistryUrl } from './imageReference'

export const IMAGE_PULL_PREFERENCES_KEY = 'elysian.image-pull-preferences.v1'

/** 只保存当前浏览器最近填写的有效源地址，不保存镜像引用或凭据。 */
export function readStoredImageRegistry(storage: PreferenceStorage = browserPreferenceStorage): string {
  try {
    const raw = storage.getItem(IMAGE_PULL_PREFERENCES_KEY)
    if (!raw) return ''
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('registry' in value) || typeof value.registry !== 'string' || validateRegistryUrl(value.registry)) return ''
    return value.registry.trim()
  } catch {
    return ''
  }
}

/** 清空即恢复官方源；无效输入不覆盖上次有效选择。浏览器存储故障沿用偏好回退。 */
export function writeStoredImageRegistry(raw: string, storage: PreferenceStorage = browserPreferenceStorage): void {
  const registry = raw.trim()
  if (validateRegistryUrl(registry)) return
  if (!registry) { storage.removeItem(IMAGE_PULL_PREFERENCES_KEY); return }
  const value = JSON.stringify({ version: 1, registry })
  if (storage.getItem(IMAGE_PULL_PREFERENCES_KEY) !== value) storage.setItem(IMAGE_PULL_PREFERENCES_KEY, value)
}
