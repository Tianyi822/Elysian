const CONTAINER_ID_HEX_64 = /[0-9a-fA-F]{64}/g
/** Docker 默认把容器 ID 前 12 位设为容器 hostname，hostname 通道只认这个形态。 */
const HOSTNAME_SHORT_ID = /^[0-9a-f]{12}$/

/**
 * 自我容器识别双通道：优先从 cgroup 文本提取 64 位完整 ID（cgroup v1 / cgroupfs
 * 驱动下有效）；cgroup v2 私有命名空间下文本只有 `0::/`，此时回落 hostname 通道——
 * 在引擎容器表里找以 hostname 为前缀的完整 ID。hostname 通道只有在唯一命中时才返回，
 * 多命中返回 null：保守方向是宁可不自我保护，也绝不把别的容器当成面板自己。
 */
export function resolveSelfContainerId(
  cgroupText: string,
  ids: readonly string[],
  hostname?: string,
): string | null {
  const idByLower = new Map<string, string>()
  for (const id of ids) {
    if (id.length === 64) {
      idByLower.set(id.toLowerCase(), id)
    }
  }

  const matches = cgroupText.match(CONTAINER_ID_HEX_64)
  if (matches) {
    for (const match of matches) {
      const resolved = idByLower.get(match.toLowerCase())
      if (resolved !== undefined) {
        return resolved
      }
    }
  }

  if (hostname === undefined || !HOSTNAME_SHORT_ID.test(hostname)) {
    return null
  }
  const prefix = hostname.toLowerCase()
  let uniqueHit: string | null = null
  for (const [lowerId, id] of idByLower) {
    if (!lowerId.startsWith(prefix)) continue
    if (uniqueHit !== null) {
      return null
    }
    uniqueHit = id
  }
  return uniqueHit
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 引擎 inspect 解析后的自容器判定：URL 参数可以是完整 ID、12 位前缀或容器名——
 * 引擎对一切寻址形态接受名字寻址，任何参数经 inspect 都归一到完整 Id，再与自容器
 * Id 比对。自我保护必须以解析后的 Id 为准，直接比对原始参数会被容器名绕过。
 */
export function isSelfContainerInspect(
  inspect: unknown,
  selfContainerId: string | null | undefined,
): boolean {
  if (selfContainerId === null || selfContainerId === undefined || selfContainerId.length === 0) {
    return false
  }
  if (!isRecord(inspect)) {
    return false
  }
  const id = inspect.Id
  if (typeof id !== 'string' || id.length === 0) {
    return false
  }
  return id === selfContainerId || selfContainerId.startsWith(id)
}
