import { WEBSITE_RUNTIME_CATALOG, type WebsiteRuntimeKind } from '../packages/foundation/contracts/src/websites/websites.ts'

/** 维护者运行：检查目录形态，并向 Docker 官方镜像库核实精确标签存在。部署时不调用。 */
const offline = process.argv.includes('--offline')
const kinds: readonly WebsiteRuntimeKind[] = ['java', 'node', 'go', 'python']
let checked = 0
for (const kind of kinds) {
  const seen = new Set<string>()
  for (const entry of WEBSITE_RUNTIME_CATALOG[kind]) {
    if (seen.has(entry.version)) throw new Error(`${kind} ${entry.version} 重复`)
    seen.add(entry.version)
    if (/alpha|beta|rc|nightly|latest|snapshot|tip/i.test(`${entry.version} ${entry.image}`)) throw new Error(`${kind} ${entry.version} 不是正式版`)
    if (!/^\d+$/.test(entry.version) && !/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error(`${kind} ${entry.version} 版本格式无效`)
    if (kind === 'java' && !/^eclipse-temurin:\d/.test(entry.image)) throw new Error('Java 镜像必须使用 Docker 官方 eclipse-temurin')
    if (kind === 'node' && !/^node:\d/.test(entry.image)) throw new Error('Node 镜像必须使用 Docker 官方 node')
    if (kind === 'go' && !/^golang:1\./.test(entry.image)) throw new Error('Go 镜像必须使用 Docker 官方 golang')
    if (kind === 'python' && !/^python:3\./.test(entry.image)) throw new Error('Python 镜像必须使用 Docker 官方 python')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.checkedAt)) throw new Error('核对日期无效')
    if (!offline) {
      const [repository, tag] = entry.image.split(':')
      const response = await fetch(`https://hub.docker.com/v2/repositories/library/${repository}/tags/${encodeURIComponent(tag!)}`)
      if (!response.ok) throw new Error(`${entry.image} 未在 Docker 官方镜像库找到（HTTP ${response.status}）`)
      const payload = await response.json() as { images?: { os?: string; architecture?: string }[] }
      if (!payload.images?.some((image) => image.os === 'linux' && image.architecture === 'amd64')) throw new Error(`${entry.image} 缺少 Linux amd64 镜像`)
    }
    checked += 1
  }
}
console.log(`已核对 ${checked} 个正式版镜像标签${offline ? '（仅本地格式）' : '（含 Docker 官方镜像库）'}`)
