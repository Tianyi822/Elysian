import { registryHost } from './imageReference'
import type { ImageRegistryPreset } from '../../contracts/adapters'

export const CUSTOM_REGISTRY_ID = 'custom'

/** 地址独立于目录保存；目录读取失败时仍能继续使用原地址。 */
export function matchRegistryPreset(presets: readonly ImageRegistryPreset[], registry: string): ImageRegistryPreset | undefined {
  const host = registryHost(registry)
  if (!host) return presets[0]
  return presets.find((preset) => registryHost(preset.url) === host)
}
