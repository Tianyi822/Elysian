export type { ParsedImageReference, ParsedImageReferenceResult } from '@elysian/contracts'
export { isOfficialImageRegistry, parseImageReference } from '@elysian/contracts'

/*
 * 拉取源：输入留空即用默认官方地址；实际拉取由当前运行时执行。
 */

export const DEFAULT_IMAGE_REGISTRY = 'https://registry-1.docker.io'

const REGISTRY_URL_PATTERN = /^(https:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9](:\d{1,5})?$/

/** 自定义镜像源地址校验：留空合法（回落官方）；非空须为主机名或 URL，协议可选。 */
export function validateRegistryUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!REGISTRY_URL_PATTERN.test(trimmed.replace(/\/+$/, ''))) {
    return '地址须为公网主机名或 HTTPS URL，如 docker.m.daocloud.io'
  }
  return undefined
}

/** 主机名显示：剥掉协议前缀与尾斜杠，用于预览与拉取中行。 */
export function registryHost(registry: string): string {
  return registry.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}
