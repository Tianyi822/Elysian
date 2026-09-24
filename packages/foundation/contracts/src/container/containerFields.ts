const SENSITIVE = ['PASSWORD', 'PASSWD', 'SECRET', 'TOKEN', 'CREDENTIAL', 'KEY'] as const

export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return SENSITIVE.some((word) => upper.includes(word))
}

export function classifyPortBind(
  hostIp: string | undefined,
): 'local' | 'public' | 'address' | 'unspecified' {
  if (!hostIp) return 'unspecified'
  if (hostIp === '127.0.0.1' || hostIp === '::1') return 'local'
  if (hostIp === '0.0.0.0' || hostIp === '::') return 'public'
  return 'address'
}
