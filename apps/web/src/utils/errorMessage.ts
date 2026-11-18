export function messageOf(error: unknown, fallback = '未知错误'): string {
  return error instanceof Error ? error.message : fallback
}
