export function withBusyId(ids: readonly string[], id: string): readonly string[] | undefined {
  return ids.includes(id) ? undefined : [...ids, id]
}

export function withoutBusyId(ids: readonly string[], id: string): readonly string[] {
  return ids.filter((current) => current !== id)
}
