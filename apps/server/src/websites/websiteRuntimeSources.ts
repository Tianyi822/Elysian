import type { WebsiteRuntimeCatalog, WebsiteRuntimeCatalogEntry, WebsiteRuntimeKind } from '@elysian/contracts'
import { normalizeWebsiteJavaReleaseVersion } from '@elysian/contracts'

/** 只从语言官方正式发布记录与 Docker 官方精确标签构建目录，不维护固定版本表。 */
export async function fetchWebsiteRuntimeCatalog(fetcher: typeof globalThis.fetch = globalThis.fetch, asOf = new Date().toISOString().slice(0, 10)): Promise<WebsiteRuntimeCatalog> {
  const fetch = fetcher
  const repositories = { java: 'eclipse-temurin', node: 'node', go: 'golang', python: 'python' } as const
  const kinds = Object.keys(repositories) as WebsiteRuntimeKind[]
  const catalog: Record<WebsiteRuntimeKind, WebsiteRuntimeCatalogEntry[]> = { java: [], node: [], go: [], python: [] }

  async function request(url: string, headers?: Record<string, string>): Promise<Response> {
    try { return await fetch(url, { headers, signal: AbortSignal.timeout(30_000) }) }
    catch { throw new Error(`无法连接官方版本来源：${new URL(url).hostname}`) }
  }
  async function readJson<T>(url: string, headers?: Record<string, string>): Promise<{ data: T; response: Response }> {
    const response = await request(url, headers)
    if (!response.ok) throw new Error(`官方版本目录读取失败：${new URL(url).hostname}（HTTP ${response.status}）`)
    try { return { data: await response.json() as T, response } }
    catch { throw new Error(`官方版本目录不是有效 JSON：${new URL(url).hostname}`) }
  }

  async function readDockerTags(repository: string): Promise<Set<string>> {
    const { data: auth } = await readJson<{ token: string }>(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${repository}:pull`,
    )
    if (typeof auth.token !== 'string' || !auth.token) throw new Error('官方镜像库凭据响应无效')
    const tags = new Set<string>()
    const pages = new Set<string>()
    let url: string | undefined = `https://registry-1.docker.io/v2/library/${repository}/tags/list?n=10000`
    while (url) {
      if (pages.has(url) || pages.size >= 128) throw new Error('官方镜像库分页无效或超过上限')
      pages.add(url)
      const { data, response }: { data: { tags: string[] }; response: Response } = await readJson(url, { Authorization: `Bearer ${auth.token}` })
      if (!Array.isArray(data.tags) || !data.tags.every((tag) => typeof tag === 'string')) throw new Error('官方镜像标签响应无效')
      data.tags.forEach((tag) => tags.add(tag))
      const next: string | undefined = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
      url = next ? new URL(next, url).href : undefined
      if (url && new URL(url).origin !== 'https://registry-1.docker.io') throw new Error('官方镜像库分页地址无效')
    }
    return tags
  }

  async function readJavaReleases(): Promise<string[]> {
    const releases: string[] = []
    for (let page = 0; ; page += 1) {
      if (page >= 128) throw new Error('Java 正式发布目录页数超过上限')
      const response = await request(
        `https://api.adoptium.net/v3/info/release_names?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=linux&page=${page}&page_size=20&release_type=ga&sort_order=DESC`,
      )
      // Adoptium 超出最后一页时以 404 表示空结果。
      if (response.status === 404 && releases.length > 0) break
      if (!response.ok) throw new Error(`Java 正式发布目录读取失败（HTTP ${response.status}）`)
      const data = await response.json().catch(() => { throw new Error('Java 正式发布目录不是有效 JSON') }) as { releases: string[] }
      if (!Array.isArray(data.releases) || !data.releases.every((release) => typeof release === 'string')) throw new Error('Java 正式发布目录响应无效')
      if (data.releases.length === 0) break
      if (releases.includes(data.releases[0]!)) throw new Error('Java 正式发布目录分页重复')
      releases.push(...data.releases)
    }
    return releases
  }

  const [tagSets, node, nodeSchedule, go, python, java, javaInfo] = await Promise.all([
    Promise.all(kinds.map(async (kind) => [kind, await readDockerTags(repositories[kind])] as const)),
    readJson<{ version: string; date: string }[]>('https://nodejs.org/dist/index.json'),
    readJson<Record<string, { start: string; end: string }>>('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'),
    readJson<{ version: string; stable: boolean }[]>('https://go.dev/dl/?mode=json&include=all'),
    readJson<{ name: string; pre_release: boolean; release_date: string; is_published: boolean }[]>(
      'https://www.python.org/api/v2/downloads/release/?is_published=true&limit=1000',
    ),
    readJavaReleases(),
    readJson<{ available_lts_releases: number[]; most_recent_feature_release: number }>('https://api.adoptium.net/v3/info/available_releases'),
  ])
  const tags = Object.fromEntries(tagSets) as Record<WebsiteRuntimeKind, Set<string>>

  function add(kind: WebsiteRuntimeKind, version: string, tag: string): void {
    if (!tags[kind].has(tag)) return
    if (catalog[kind].some((entry) => entry.version === version)) return
    catalog[kind].push({ version, image: `${repositories[kind]}:${tag}`, maintenance: 'legacy', checkedAt: asOf })
  }

  // 全部历史正式版本按发布记录与镜像可用性筛选，版本范围随官方发布自动扩展。
  for (const release of node.data) {
    const match = /^v(\d+\.\d+\.\d+)$/.exec(release.version)
    if (match && release.date <= asOf) add('node', match[1]!, match[1]!)
  }
  for (const release of go.data) {
    const match = /^go(\d+)\.(\d+)(?:\.(\d+))?$/.exec(release.version)
    if (!release.stable || !match) continue
    const version = `${match[1]}.${match[2]}.${match[3] ?? '0'}`
    add('go', version, version)
  }
  for (const release of python.data) {
    // 网站 Python 启动命令使用 python3，Python 2 不属于此运行时。
    const match = /^Python (3\.\d+\.\d+)$/.exec(release.name)
    if (release.pre_release || !release.is_published || !match || release.release_date.slice(0, 10) > asOf) continue
    add('python', match[1]!, `${match[1]}-slim`)
  }
  for (const release of java) {
    const version = release.replace(/^jdk-?/, '')
    if (!/^(8u\d+-b\d+|\d+(?:\.\d+){0,3}\+\d+)$/.test(version)) continue
    const baseTag = version.replace('+', '_')
    // 部分早期 GA 只发布 JDK 镜像，JDK 同样包含运行时；优先用更小的 JRE。
    const tag = [`${baseTag}-jre`, `${baseTag}-jdk`].find((candidate) => tags.java.has(candidate))
    if (tag) add('java', normalizeWebsiteJavaReleaseVersion(version), tag)
  }

  function versionParts(version: string): number[] {
    const java = /^(\d+(?:\.\d+){0,3})\+(\d+)$/.exec(version)
    if (java) {
      const parts = java[1]!.split('.').map(Number)
      while (parts.length < 4) parts.push(0)
      return [...parts, Number(java[2])]
    }
    return (version.match(/\d+/g) ?? []).map(Number)
  }
  function compareVersions(a: string, b: string): number {
    const left = versionParts(a)
    const right = versionParts(b)
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (right[index] ?? 0) - (left[index] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  function versionLine(kind: WebsiteRuntimeKind, version: string): string {
    return versionParts(version).slice(0, kind === 'node' || kind === 'java' ? 1 : 2).join('.')
  }

  const supportedJava = new Set([...javaInfo.data.available_lts_releases, javaInfo.data.most_recent_feature_release].map(String))
  const goLines = [...new Set(catalog.go.map((entry) => versionLine('go', entry.version)))].sort(compareVersions).slice(0, 2)
  const pythonFirstRelease = new Map<string, string>()
  for (const release of python.data) {
    const match = /^Python (3\.\d+)\.0$/.exec(release.name)
    if (match && !release.pre_release && release.is_published) pythonFirstRelease.set(match[1]!, release.release_date.slice(0, 10))
  }
  const pythonMaintained = (line: string): boolean => {
    const first = pythonFirstRelease.get(line)
    if (!first) return false
    const end = new Date(`${first}T00:00:00Z`)
    // Python 官方维护周期约五年，结束于首次发布月份的月底。
    end.setUTCFullYear(end.getUTCFullYear() + 5, end.getUTCMonth() + 1, 0)
    return end.toISOString().slice(0, 10) >= asOf
  }
  for (const kind of kinds) {
    const lines = new Set<string>()
    catalog[kind].sort((a, b) => compareVersions(a.version, b.version))
    for (const entry of catalog[kind]) {
      const line = versionLine(kind, entry.version)
      const schedule = nodeSchedule.data[`v${line}`]
      const supported = kind === 'java' ? supportedJava.has(line)
        : kind === 'node' ? Boolean(schedule && schedule.start <= asOf && schedule.end >= asOf)
          : kind === 'go' ? goLines.includes(line) : pythonMaintained(line)
      if (supported && !lines.has(line)) entry.maintenance = 'maintained'
      lines.add(line)
    }
    catalog[kind].sort((a, b) => (a.maintenance === b.maintenance ? compareVersions(a.version, b.version) : a.maintenance === 'maintained' ? -1 : 1))
    if (catalog[kind].length === 0) throw new Error(`${kind} 正式版本目录为空，拒绝覆盖`)
  }

  return catalog
}
