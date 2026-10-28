import { registryHost } from './imageReference'

/**
 * 镜像源预设清单：拉取窗口下拉的唯一权威来源。只登记实测过仍可用的源与官方源，
 * 不登记已失效或故意关闭版本枚举的源（理由见 docs/adr/0053）。
 * 速度是时点事实，不在此硬编码，由用户在窗口里按需测速。
 */
export type ImageRegistryPreset = {
  id: string
  label: string
  url: string
  note?: string
}

/** 自定义地址哨兵项：选中后展开自由输入框，不构成镜像源白名单。 */
export const CUSTOM_REGISTRY_ID = 'custom'

export const IMAGE_REGISTRY_PRESETS: readonly ImageRegistryPreset[] = [
  {
    id: 'official',
    label: '官方 Docker Hub',
    url: 'https://registry-1.docker.io',
    note: '部分网络不可达，测速会当场给出结果',
  },
  { id: 'dockerproxy', label: 'dockerproxy.net', url: 'https://dockerproxy.net' },
  {
    id: '1panel',
    label: 'docker.1panel.live',
    url: 'https://docker.1panel.live',
    note: '仅大陆网络可达',
  },
  { id: '1ms', label: 'docker.1ms.run', url: 'https://docker.1ms.run' },
]

/** 按已存或已填地址反查预设；未命中任何预设即自定义项。留空视为官方源。 */
export function matchRegistryPreset(registry: string): ImageRegistryPreset | undefined {
  const host = registryHost(registry)
  if (!host) return IMAGE_REGISTRY_PRESETS[0]
  return IMAGE_REGISTRY_PRESETS.find((preset) => registryHost(preset.url) === host)
}
