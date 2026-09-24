import { BlockList, isIP } from 'node:net'

export type RegistryResolver = (hostname: string) => Promise<readonly string[]>

const RESOLVE_PUBLIC_ERROR = '镜像源无法解析为公网地址'
const HTTP_NOT_ALLOWED = '镜像源须使用 https 协议或省略协议'
const DISALLOWED_HOST = '镜像源主机名不合法'

const PRIVATE_IPV4_RANGES: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const PRIVATE_IPV6_RANGES: ReadonlyArray<[string, number]> = [
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fe80::', 10],
  ['fc00::', 7],
]

const privateIpv4BlockList = new BlockList()
for (const [network, prefix] of PRIVATE_IPV4_RANGES) {
  privateIpv4BlockList.addSubnet(network, prefix, 'ipv4')
}

const privateIpv6BlockList = new BlockList()
for (const [network, prefix] of PRIVATE_IPV6_RANGES) {
  privateIpv6BlockList.addSubnet(network, prefix, 'ipv6')
}

function normalizeIpForCheck(ip: string): string {
  const trimmed = ip.trim()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed)
  if (mapped && isIP(mapped[1]) === 4) {
    return mapped[1]
  }
  return trimmed
}

export function isPublicAddress(ip: string): boolean {
  const normalized = normalizeIpForCheck(ip)
  const version = isIP(normalized)
  if (version === 4) {
    return !privateIpv4BlockList.check(normalized, 'ipv4')
  }
  if (version === 6) {
    return !privateIpv6BlockList.check(normalized, 'ipv6')
  }
  return false
}

function splitHostPort(hostWithOptionalPort: string): { hostname: string; display: string } {
  const lastColon = hostWithOptionalPort.lastIndexOf(':')
  if (lastColon === -1) {
    return { hostname: hostWithOptionalPort, display: hostWithOptionalPort }
  }
  const maybePort = hostWithOptionalPort.slice(lastColon + 1)
  if (/^\d{1,5}$/.test(maybePort)) {
    return {
      hostname: hostWithOptionalPort.slice(0, lastColon),
      display: hostWithOptionalPort,
    }
  }
  return { hostname: hostWithOptionalPort, display: hostWithOptionalPort }
}

function assertResolvableHostname(hostname: string): void {
  if (isIP(hostname) !== 0) {
    throw new Error(DISALLOWED_HOST)
  }
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower === 'registry' || lower.endsWith('.local')) {
    throw new Error(DISALLOWED_HOST)
  }
}

function parseRegistryInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(DISALLOWED_HOST)
  }
  if (trimmed.startsWith('http://')) {
    throw new Error(HTTP_NOT_ALLOWED)
  }
  let rest = trimmed
  if (rest.startsWith('https://')) {
    rest = rest.slice('https://'.length)
  }
  rest = rest.replace(/\/+$/, '')
  if (!rest) {
    throw new Error(DISALLOWED_HOST)
  }
  const { hostname } = splitHostPort(rest)
  assertResolvableHostname(hostname)
  return rest
}

async function assertResolvesToPublic(hostname: string, resolve: RegistryResolver): Promise<void> {
  let addresses: readonly string[]
  try {
    addresses = await resolve(hostname)
  } catch {
    throw new Error(RESOLVE_PUBLIC_ERROR)
  }
  if (addresses.length === 0) {
    throw new Error(RESOLVE_PUBLIC_ERROR)
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new Error(RESOLVE_PUBLIC_ERROR)
    }
  }
}

export async function validateRegistry(raw: string, resolve: RegistryResolver): Promise<string> {
  const host = parseRegistryInput(raw)
  const { hostname } = splitHostPort(host)
  await assertResolvesToPublic(hostname, resolve)
  return host
}
