import { request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP } from 'node:net'
import type { ValidatedRegistryTarget } from './registryPolicy.ts'

export const IMAGE_SEARCH_LIMIT = 10
export const CATALOG_TIMEOUT_MS = 4_000
export const CATALOG_MAX_BYTES = 128 * 1024
const CATALOG_PAGE_SIZE = 100
export const TAGS_MAX_BYTES = 512 * 1024
export const IMAGE_TAG_LIMIT = 40
const TOKEN_MAX_BYTES = 16 * 1024

export type CatalogResponse = { status: number; json: unknown }
export type CatalogFetcher = (target: ValidatedRegistryTarget, path: string) => Promise<CatalogResponse>
export type RegistryRequestTarget = { host: string; addresses?: readonly string[] }
export type TagsFetcher = (target: RegistryRequestTarget, path: string, token?: string) => Promise<CatalogResponse>

/** 自定义源以已校验 IP 建连并用主机名校验 TLS；官方固定主机名直接解析。 */
function requestRegistryJson(
  target: RegistryRequestTarget, path: string, maxBytes: number, token?: string, subject = '目录',
): Promise<CatalogResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://${target.host}${path}`)
    const address = target.addresses?.[0]
    let timer: ReturnType<typeof setTimeout>
    const options: RequestOptions = {
      method: 'GET',
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      timeout: CATALOG_TIMEOUT_MS,
    }
    if (address) {
      options.lookup = (_hostname, lookupOptions, callback) => {
        const family = isIP(address) as 4 | 6
        if (lookupOptions.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      }
    }
    const request = httpsRequest(url, options, (response) => {
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          request.destroy(new Error(`镜像源${subject}响应超过大小上限`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(timer)
        if (response.statusCode !== 200) {
          resolve({ status: response.statusCode ?? 0, json: null })
          return
        }
        try {
          resolve({ status: 200, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          reject(new Error(`镜像源${subject}响应格式无效`))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`镜像源${subject}查询超时`)))
    request.on('error', (error) => { clearTimeout(timer); reject(error) })
    timer = setTimeout(() => request.destroy(new Error(`镜像源${subject}查询超时`)), CATALOG_TIMEOUT_MS)
    request.end()
  })
}

export const requestRegistryCatalog: CatalogFetcher = (target, path) =>
  requestRegistryJson(target, path, CATALOG_MAX_BYTES)

export const requestRegistryTags: TagsFetcher = (target, path, token) =>
  requestRegistryJson(target, path, TAGS_MAX_BYTES, token, '标签')

export async function requestDockerHubToken(repository: string): Promise<string> {
  const path = `/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`
  const response = await requestRegistryJson({ host: 'auth.docker.io' }, path, TOKEN_MAX_BYTES, undefined, '令牌')
  const json = response.json
  const token = json && typeof json === 'object' && !Array.isArray(json)
    ? (json as { token?: unknown; access_token?: unknown }).token ?? (json as { access_token?: unknown }).access_token
    : undefined
  if (response.status !== 200 || typeof token !== 'string' || token.length === 0 || token.length > 12_000) {
    throw new Error('无法取得 Docker Hub 公开镜像访问令牌')
  }
  return token
}

const TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/
const tagCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function tagRank(tag: string): number {
  if (tag === 'latest') return 0
  // 日期快照往往很多，优先展示可辨认的版本号。
  if (/^(?:19|20)\d{6}$/.test(tag)) return 3
  if (/^\d+(?:\.\d+)*(?:[-_][a-zA-Z0-9_.-]+)?$/.test(tag)) return 1
  return 2
}

export async function listRegistryTags(
  target: RegistryRequestTarget, repository: string, fetchTags: TagsFetcher, token?: string,
): Promise<{ tags: string[]; searchable: boolean }> {
  const path = `/v2/${repository.split('/').map(encodeURIComponent).join('/')}/tags/list`
  try {
    const response = await fetchTags(target, path, token)
    if (response.status !== 200 || !response.json || typeof response.json !== 'object') {
      return { tags: [], searchable: false }
    }
    const tags = (response.json as { tags?: unknown }).tags
    if (!Array.isArray(tags)) return { tags: [], searchable: false }
    return {
      tags: [...new Set(tags.filter((tag): tag is string =>
        typeof tag === 'string' && tag.length <= 128 && TAG_PATTERN.test(tag),
      ))].sort((a, b) => tagRank(a) - tagRank(b) || tagCollator.compare(b, a)).slice(0, IMAGE_TAG_LIMIT),
      searchable: true,
    }
  } catch {
    return { tags: [], searchable: false }
  }
}

function catalogStart(term: string): string {
  const last = term.charCodeAt(term.length - 1)
  return `${term.slice(0, -1)}${String.fromCharCode(last - 1)}`
}

export async function searchCatalog(
  target: ValidatedRegistryTarget,
  term: string,
  fetchCatalog: CatalogFetcher,
): Promise<{ names: string[]; searchable: boolean }> {
  // Distribution 目录是字典序；last 为前缀的直接前驱，可同时包含完全相同的仓库名。
  const path = `/v2/_catalog?n=${CATALOG_PAGE_SIZE}&last=${encodeURIComponent(catalogStart(term))}`
  try {
    const response = await fetchCatalog(target, path)
    if (response.status !== 200 || !response.json || typeof response.json !== 'object') {
      return { names: [], searchable: false }
    }
    const repositories = (response.json as { repositories?: unknown }).repositories
    if (!Array.isArray(repositories)) return { names: [], searchable: false }
    return {
      names: [...new Set(repositories.filter((name): name is string =>
        typeof name === 'string' && name.startsWith(term) && /^[a-z0-9._/-]+$/.test(name),
      ))].slice(0, IMAGE_SEARCH_LIMIT),
      searchable: true,
    }
  } catch {
    return { names: [], searchable: false }
  }
}
