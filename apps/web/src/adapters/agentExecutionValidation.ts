import type { AgentExecutionGrantInput, AgentExecutionProfileInput } from '@elysian/contracts'

export const EXECUTION_IMAGE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/
export const EXECUTION_RESOURCE_DOMAINS = [
  { value: 'docker-container', label: '容器' }, { value: 'docker-image', label: '镜像' }, { value: 'website', label: '网站' },
  { value: 'container-app', label: '容器应用' }, { value: 'database', label: '数据库' }, { value: 'firewall', label: '防火墙目标' },
  { value: 'system-user', label: '系统用户' }, { value: 'panel', label: '面板' }, { value: 'platform', label: '平台' },
] as const
export type ExecutionFieldErrors = Record<string, string>
const bytes = (text: string) => new TextEncoder().encode(text).length
const validText = (text: string, max: number) => text.length > 0 && bytes(text) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(text)
const positive = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max

export function validateExecutionProfile(input: AgentExecutionProfileInput): ExecutionFieldErrors {
  const errors: ExecutionFieldErrors = {}
  if (!validText(input.name.trim(), 120)) errors.name = '名称必填，不能超过 120 字节或包含控制字符。'
  if (!EXECUTION_IMAGE_PATTERN.test(input.image) || bytes(input.image) > 512) errors.image = '请填写仓库名与完整的 SHA-256 摘要，不能使用标签或镜像 ID。'
  if (!['bash', 'python', 'node'].includes(input.runtime)) errors.runtime = '请选择 Bash、Python 或 Node。'
  if (input.command.length < 1 || input.command.length > 64 || input.command.some((arg, i) => bytes(arg) > 4096 || arg.includes('\0') || (i === 0 && !arg)) || input.command.reduce((n, arg) => n + bytes(arg), 0) > 16384) errors.command = '命令需要 1–64 个参数，首项不能为空，每项最多 4096 字节，总计最多 16 KiB。'
  if (!positive(input.timeoutSeconds, 300)) errors.timeoutSeconds = '超时须为 1–300 秒的整数。'
  if (!positive(input.cpuMillis, 1000)) errors.cpuMillis = 'CPU 须大于 0 且不超过 1 核，精确到 0.001 核。'
  if (!positive(input.memoryBytes, 512 * 1048576)) errors.memoryBytes = '内存须大于 0 且不超过 512 MiB。'
  if (!positive(input.pids, 128)) errors.pids = '进程数须为 1–128 的整数。'
  return errors
}

export function validateExecutionGrant(input: AgentExecutionGrantInput, mountRoot?: string): ExecutionFieldErrors {
  const errors: ExecutionFieldErrors = {}
  if (!validText(input.name.trim(), 120)) errors.name = '名称必填，不能超过 120 字节或包含控制字符。'
  if (!input.directories.length && !input.network.length && !input.resources?.length) errors.scope = '请至少添加一项目录、网络或平台对象授权。'
  if (input.directories.length > 32 || input.network.length > 64 || input.privateCidrs.length > 32 || (input.resources?.length ?? 0) > 128) errors.scope = '最多 32 个目录、64 个网络目标、32 个私网网段及 128 个平台对象。'
  const seen = new Set<string>()
  input.directories.forEach((directory, i) => {
    const key = `directories.${i}`
    if (!validText(directory.path, 4096) || !directory.path.startsWith('/') || directory.path === '/' || /\/{2}|\/$/.test(directory.path) || directory.path.split('/').some(part => part === '.' || part === '..') || (mountRoot && !directory.path.startsWith(`${mountRoot.replace(/\/$/, '')}/`))) errors[key] = '填写业务挂载根下规范的真实绝对子目录。'
    if (directory.access !== 'ro' && directory.access !== 'rw') errors[key] = '目录权限只能为只读或读写。'
    if (seen.has(`directory:${directory.path}`)) errors[key] = '目录重复。'
    seen.add(`directory:${directory.path}`)
  })
  input.network.forEach((endpoint, i) => {
    const key = `network.${i}`
    const host = endpoint.host.toLowerCase()
    if (!['http', 'https'].includes(endpoint.scheme) || !positive(endpoint.port, 65535) || host.length > 253 || !host.includes('.') || /^\d+(\.\d+){3}$/.test(host) || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) errors[key] = '填写精确域名和 1–65535 的整数端口，不接受 IP、通配符或 URL 路径。'
    if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') errors[key] = '回环和元数据地址不能授权。'
    const identity = `network:${endpoint.scheme}:${host}:${endpoint.port}`
    if (seen.has(identity)) errors[key] = '网络目标重复。'
    seen.add(identity)
  })
  ;(input.resources ?? []).forEach((resource, i) => {
    const key = `resources.${i}`
    if (!EXECUTION_RESOURCE_DOMAINS.some(domain => domain.value === resource.domain) || !validText(resource.id, 256) || resource.id.trim() !== resource.id || /[*?\\]/.test(resource.id) || !['read', 'write'].includes(resource.access)) errors[key] = '选择有效资源类型，填写不含通配符的精确标识和读写权限。'
    const identity = `resource:${resource.domain}:${resource.id}`
    if (seen.has(identity)) errors[key] = '平台对象重复，请在同一行选择所需权限。'
    seen.add(identity)
  })
  input.privateCidrs.forEach((cidr, i) => {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(cidr)) errors[`privateCidrs.${i}`] = '填写规范的私有地址 CIDR 网段；具体范围由服务端校验。'
    if (seen.has(cidr)) errors[`privateCidrs.${i}`] = '私网网段重复。'
    seen.add(cidr)
  })
  return errors
}
