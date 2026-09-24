const CONTAINER_ID_HEX_64 = /[0-9a-fA-F]{64}/g

export function resolveSelfContainerId(cgroupText: string, ids: readonly string[]): string | null {
  const matches = cgroupText.match(CONTAINER_ID_HEX_64)
  if (!matches) {
    return null
  }

  const idByLower = new Map<string, string>()
  for (const id of ids) {
    if (id.length === 64) {
      idByLower.set(id.toLowerCase(), id)
    }
  }

  for (const match of matches) {
    const resolved = idByLower.get(match.toLowerCase())
    if (resolved !== undefined) {
      return resolved
    }
  }

  return null
}
