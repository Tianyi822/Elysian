import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { WebsiteCategory, WebsiteProjectKind } from '@elysian/contracts'
import { ELYSIAN_CONFIG_DIR } from '../shared/elysianPaths.ts'

/*
 * 网站项目登记：站点的事实来源——站点目录、容器身份、绑定域名与部署命令都固化在
 * 这里，Caddy 路由配置每次由登记全量重新推导（无第二份需要同步的状态）。读写纪律
 * 照 databaseRegistry 先例：O_NOFOLLOW 读 + 权限/属主/大小校验，0600 临时文件 +
 * fsync + rename 原子写，串行队列防交错；登记不含凭据。
 */

export type WebsiteRecord = {
  id: string
  kind: WebsiteProjectKind
  /** 项目名：跨类型全局唯一，站点目录路径段的唯一来源。 */
  name: string
  port: number
  runtimeVersion: string | null
  /** 站点目录绝对路径（创建时经 realpath 复核后固化）。 */
  rootDir: string
  /** 绑定域名：创建后不可改；null 表示未绑定，不生成反向代理路由。 */
  domain: string | null
  /** 容器名（服务端生成的 elysian-site-<hex>）；HTML 为 null。 */
  containerName: string | null
  /** 容器 64 位 ID；容器被外部删除后保留登记值如实显示；HTML 为 null。 */
  containerId: string | null
  /** 创建时由 websiteRuntimeImageRef 推导并固化的镜像引用（删除五重核对用）；HTML 为 null。 */
  imageRef: string | null
  /** 面板为站点容器配置的启动命令（websiteDefaultDeployCommand 生成）；HTML 为 null。 */
  deployCommand: string | null
  /** HTML 的托管开关（开即 running）；非 HTML 的运行事实来自容器，不用本字段。 */
  enabled: boolean
  category: WebsiteCategory
  expiryAt: string | null
  note: string | null
  gitUrl: string | null
  createdAt: string
}

export interface WebsiteRegistry {
  list(): Promise<readonly WebsiteRecord[]>
  put(record: WebsiteRecord): Promise<void>
  remove(id: string): Promise<void>
}

const REGISTRY_PATH = join(ELYSIAN_CONFIG_DIR, 'websites.json')

/** 站点登记同一笔原子替换；文件只允许本机服务进程读取。 */
export function createFileWebsiteRegistry(path = REGISTRY_PATH): WebsiteRegistry {
  let tail: Promise<unknown> = Promise.resolve()

  async function read(): Promise<WebsiteRecord[]> {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('网站登记文件权限或内容无效')
      const value: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
      if (!Array.isArray(value)) throw new Error('网站登记文件无效')
      // 文件是本进程写出的私有数据；不向浏览器透传其原始内容。
      return value as WebsiteRecord[]
    } finally {
      await handle.close()
    }
  }

  async function write(records: readonly WebsiteRecord[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(records))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  function update(change: (rows: WebsiteRecord[]) => WebsiteRecord[]): Promise<void> {
    const run = tail.then(async () => write(change(await read())))
    tail = run.catch(() => undefined)
    return run
  }

  return {
    list: () => tail.then(read),
    put: (record) => update((rows) => [...rows.filter((row) => row.id !== record.id), record]),
    remove: (id) => update((rows) => rows.filter((row) => row.id !== id)),
  }
}

export function createMemoryWebsiteRegistry(seed: readonly WebsiteRecord[] = []): WebsiteRegistry {
  let rows = [...seed]
  return {
    async list() { return rows.map((row) => ({ ...row })) },
    async put(record) { rows = [...rows.filter((row) => row.id !== record.id), { ...record }] },
    async remove(id) { rows = rows.filter((row) => row.id !== id) },
  }
}
