/**
 * 镜像引用解析：把 "redis:8-alpine" 这样的输入拆成名称与标签。
 * 名称统一转小写（registry:port 的冒号属于名称，按最后一个冒号拆分），
 * 缺标签默认 latest；解析失败给出中文原因。
 */

export type ParsedImageReference = { name: string; tag: string }

export type ParsedImageReferenceResult =
  | { ok: true; reference: ParsedImageReference }
  | { ok: false; error: string }

const NAME_PATTERN = /^[a-z0-9][a-z0-9:_.\-/]*$/
const TAG_PATTERN = /^[a-zA-Z0-9_.\-]+$/

export function parseImageReference(raw: string): ParsedImageReferenceResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '请输入镜像引用，例如 redis:8-alpine' }

  // 最后一个冒号之后若还有路径分隔符，它就是 registry:port 的端口冒号而非标签分隔。
  const lastColon = trimmed.lastIndexOf(':')
  const afterColon = lastColon === -1 ? '' : trimmed.slice(lastColon + 1)
  const colonIsTagSeparator = lastColon !== -1 && !afterColon.includes('/')
  const name = (colonIsTagSeparator ? trimmed.slice(0, lastColon) : trimmed).trim().toLowerCase()
  const tag = colonIsTagSeparator ? afterColon.trim() || 'latest' : 'latest'

  if (!name) return { ok: false, error: '镜像名称不能为空' }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: '名称仅限小写字母、数字与 : _ . / -，且以字母或数字开头' }
  }
  if (!TAG_PATTERN.test(tag)) {
    return { ok: false, error: '标签仅限字母、数字与 _ . -' }
  }
  return { ok: true, reference: { name, tag } }
}

/*
 * 拉取源：演示只记录地址、不产生真实数据流；输入留空即用默认官方地址。
 */

export const DEFAULT_IMAGE_REGISTRY = 'https://registry-1.docker.io'

const REGISTRY_URL_PATTERN = /^(https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9](:\d{1,5})?$/

/** 自定义镜像源地址校验：留空合法（回落官方）；非空须为主机名或 URL，协议可选。 */
export function validateRegistryUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!REGISTRY_URL_PATTERN.test(trimmed)) {
    return '地址须为主机名或 URL，如 docker.m.daocloud.io，协议可选'
  }
  return undefined
}

/** 主机名显示：剥掉协议前缀，用于预览与拉取中行。 */
export function registryHost(registry: string): string {
  return registry.trim().replace(/^https?:\/\//, '')
}
