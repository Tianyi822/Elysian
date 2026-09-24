import { Hono } from 'hono'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import { endpointErrorHandler, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { invalidRequest } from '../shared/errors.ts'
import { FILES_MOUNT } from '../shared/apiMounts.ts'
import type { FilePermissionInput } from './filesService.ts'

/*
 * 文件管理路由（/api/files/*）：只做路由分发、守卫调用、query/body 形状解析与 service
 * 调用，业务校验（路径判据、目录存在性、写禁区、规模上限）留在服务层。真实接线
 * （cp/mv/tar/fs 原语）经 filesHostDeps 注入；路由测试用 fake service 驱动，不执行
 * 任何真实命令。守卫链顺序与安全区三片逐字一致：不可用整片 503「真实文件管理仅在
 * Docker 容器内可用」→ 同源 403「请求来源不允许」→ 读体（415/413/400）→ 端点 →
 * 未知路径 404「未知文件管理端点：METHOD path」。
 *
 * GET 的 path/keyword 对整个字符串做一次 encodeURIComponent 放进 query（Hono
 * c.req.query() 对编码值完美往返，裸 `+` 会被按 URLSearchParams 语义解码成空格，
 * 前端契约绝不发送裸 `+`）；POST 的路径只随 JSON body 走，无编码问题。
 */

/** 挂载路径：定义在 shared/apiMounts.ts，此处 re-export 保持既有 import 路径。 */
export { FILES_MOUNT }

/**
 * 文件管理服务的调用形状：与 web 侧 contracts 的 FilesAdapter（apps/web/src/contracts/
 * adapters.ts）方法签名结构一致——该接口尚未上提 @elysian/contracts，server 侧先以
 * 同形接口对齐，靠 TypeScript 结构化类型保持兼容，上提后直接替换引用。
 */
export type FilesService = {
  list(dirPath: string): Promise<readonly FileEntry[]>
  size(dirPath: string): Promise<number>
  copyEntry(srcPath: string, destDirPath: string): Promise<FileEntry>
  moveEntry(srcPath: string, destDirPath: string): Promise<FileEntry>
  renameEntry(path: string, newName: string): Promise<FileEntry>
  compressEntry(path: string): Promise<FileEntry>
  chmod(path: string, input: FilePermissionInput): Promise<void>
  search(keyword: string): Promise<readonly FileSearchResult[]>
}

/** 路由装配入参：available=false 时整片 503；service 缺失同样 503（有可用性没服务也不许答）。 */
export type FilesAppDeps = {
  available: boolean
  service?: FilesService
}

/** query 的 path 参数：缺失或不是字符串是形状错误；内容合法性（相对路径、`..` 段等）由服务层判据负责。 */
function requireQueryPath(value: string | undefined): string {
  if (typeof value !== 'string') throw invalidRequest('缺少路径参数')
  return value
}

/** 请求体里必须是非空字符串的字段：形状错误在路由层拦，语义错误（非法路径/名称）由服务层报。 */
function requireStringField(body: Record<string, unknown>, field: string, message: string): string {
  const value = body[field]
  if (typeof value !== 'string') throw invalidRequest(message)
  return value
}

/** 文件管理子应用工厂：app.ts 挂到 FILES_MOUNT；测试直接 request 驱动。 */
export function createFilesApp(deps: FilesAppDeps): Hono {
  const app = new Hono()
  // 错误映射：EndpointGuardError/InvalidRequestError 按自带 status 回 4xx，系统侧一律 500。
  app.onError(endpointErrorHandler)

  if (!deps.available || !deps.service) {
    // 不可用整片换 503 分支：任意方法、含未知路径，与容器外的强制保护一致。
    app.all('*', () => sendJson(503, { error: '真实文件管理仅在 Docker 容器内可用' }))
    return app
  }
  const service = deps.service

  // 同源守卫先于读体与路由分发：跨源写请求在解析任何请求体之前就被拒绝（未知路径同样先 403 后 404）。
  app.use('*', sameOriginGuard())

  app.get('/entries', async (c) => sendJson(200, { entries: await service.list(requireQueryPath(c.req.query('path'))) }))
  app.get('/size', async (c) => sendJson(200, { totalBytes: await service.size(requireQueryPath(c.req.query('path'))) }))
  // 空或缺省关键词也接受，返回空数组（对齐 mock；前端对空关键词本就不发请求）。
  app.get('/search', async (c) => sendJson(200, { results: await service.search(c.req.query('keyword') ?? '') }))

  app.post('/copy', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    return sendJson(200, {
      entry: await service.copyEntry(
        requireStringField(body, 'srcPath', '源路径请求体无效'),
        requireStringField(body, 'destDirPath', '目标目录请求体无效'),
      ),
    })
  })

  app.post('/move', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    return sendJson(200, {
      entry: await service.moveEntry(
        requireStringField(body, 'srcPath', '源路径请求体无效'),
        requireStringField(body, 'destDirPath', '目标目录请求体无效'),
      ),
    })
  })

  app.post('/rename', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    return sendJson(200, {
      entry: await service.renameEntry(
        requireStringField(body, 'path', '路径请求体无效'),
        requireStringField(body, 'newName', '新名称请求体无效'),
      ),
    })
  })

  app.post('/compress', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    return sendJson(200, { entry: await service.compressEntry(requireStringField(body, 'path', '路径请求体无效')) })
  })

  app.post('/chmod', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    const recursive = body.recursive
    if (typeof recursive !== 'boolean') throw invalidRequest('递归标记需为布尔值')
    const input: FilePermissionInput = {
      mode: requireStringField(body, 'mode', '权限位请求体无效'),
      owner: requireStringField(body, 'owner', '所有者请求体无效'),
      recursive,
    }
    await service.chmod(requireStringField(body, 'path', '路径请求体无效'), input)
    return sendJson(200, { ok: true })
  })

  // 未知端点兜底：剥掉挂载前缀后的相对路径进文案，与安全区三片的文案格式逐字一致。
  app.all('*', (c) => {
    const path = c.req.path.slice(FILES_MOUNT.length) || '/'
    return sendJson(404, { error: `未知文件管理端点：${c.req.method} ${path}` })
  })
  return app
}
