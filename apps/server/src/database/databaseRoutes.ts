import { Hono } from 'hono'
import { ALLOWED_HOSTNAMES, endpointErrorHandler, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { InvalidRequestError } from '../shared/errors.ts'
import type { DatabaseService } from './databaseService.ts'
import { validateDatabaseCreateRequest } from './databaseService.ts'
import type { WsConn } from '../terminals/terminalConnection.ts'
import { recordPanelOperation, type OperationAuditLogs } from '../logs/operationAudit.ts'
import type { SqliteService } from './sqliteService.ts'

export type DatabaseAppDeps = { available: boolean; service?: DatabaseService; sqlite?: SqliteService; logs?: OperationAuditLogs }

function wsOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (!origin || !host) return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase() &&
      ALLOWED_HOSTNAMES.includes(new URL(`http://${host}`).hostname.toLowerCase())
  } catch { return false }
}

const MAX_SESSIONS = 5
const MAX_FRAME_BYTES = 64 * 1024
const IDLE_TIMEOUT = 10 * 60_000

export function createDatabaseApp(deps: DatabaseAppDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)
  if (!deps.available || (!deps.service && !deps.sqlite)) {
    app.all('*', () => sendJson(503, { error: '真实数据库仅在 Docker 环境可用' }))
    return app
  }
  const service = () => {
    if (!deps.service) throw new InvalidRequestError(503, '容器数据库服务不可用')
    return deps.service
  }
  app.use('*', sameOriginGuard())
  app.get('/', async (c) => c.json([...(deps.service ? await service().list() : []), ...(deps.sqlite ? await deps.sqlite.list() : [])]))
  app.post('/sqlite', async (c) => {
    if (!deps.sqlite) throw new InvalidRequestError(503, 'SQLite 服务不可用')
    const body = await readJsonBody(c.req.raw) as { name?: unknown }
    return c.json(await deps.sqlite.create(body.name as string), 201)
  })
  app.post('/sqlite/import', async (c) => {
    if (!deps.sqlite) throw new InvalidRequestError(503, 'SQLite 服务不可用')
    return c.json(await deps.sqlite.importFile(c.req.query('name') ?? '', c.req.raw), 201)
  })
  app.get('/sqlite/:id/download', async (c) => {
    if (!deps.sqlite) throw new InvalidRequestError(503, 'SQLite 服务不可用')
    const snapshot = await deps.sqlite.download(c.req.param('id').replace(/^sqlite-/, ''))
    const { file } = await import('bun')
    const reader = file(snapshot.path).stream().getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read()
          if (part.done) { controller.close(); await snapshot.cleanup() }
          else controller.enqueue(part.value)
        } catch (error) { controller.error(error); await snapshot.cleanup() }
      },
      async cancel() { await reader.cancel(); await snapshot.cleanup() },
    })
    return new Response(body, { headers: {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Length': String(snapshot.bytes),
      'Content-Disposition': `attachment; filename="${snapshot.name}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } })
  })
  app.delete('/sqlite/:id', async (c) => {
    if (!deps.sqlite) throw new InvalidRequestError(503, 'SQLite 服务不可用')
    const body = await readJsonBody(c.req.raw) as { confirm?: unknown }
    if (body.confirm !== 'DELETE_SQLITE_FILE') throw new InvalidRequestError(400, '必须确认删除 SQLite 文件')
    await deps.sqlite.remove(c.req.param('id').replace(/^sqlite-/, ''))
    return c.json({ ok: true })
  })
  app.post('/sqlite/:id/reconcile', async (c) => {
    if (!deps.sqlite) throw new InvalidRequestError(503, 'SQLite 服务不可用')
    return c.json(await deps.sqlite.reconcile(c.req.param('id').replace(/^sqlite-/, '')))
  })
  app.delete('/sqlite/:id/registration', async (c) => {
    if (!deps.sqlite) throw new InvalidRequestError(503, 'SQLite 服务不可用')
    await deps.sqlite.forget(c.req.param('id').replace(/^sqlite-/, ''))
    return c.json({ ok: true })
  })
  app.get('/discover', async (c) => {
    const engine = c.req.query('engine')
    const versionTag = c.req.query('versionTag')
    if (engine !== 'MariaDB' && engine !== 'MySQL' && engine !== 'Redis') throw new InvalidRequestError(400, '数据库引擎无效')
    return c.json(await service().discover(engine, versionTag))
  })
  app.post('/', async (c) => c.json(await service().create(validateDatabaseCreateRequest(await readJsonBody(c.req.raw))), 201))
  app.post('/:id/reveal', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json(await service().reveal(c.req.param('id')))
  })
  app.delete('/:id', async (c) => {
    await service().remove(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.delete('/:id/container', async (c) => {
    const body = await readJsonBody(c.req.raw) as { confirm?: unknown }
    if (body?.confirm !== 'DELETE_CONTAINER_AND_DATA') throw new InvalidRequestError(400, '必须确认删除容器及全部数据')
    await service().removeContainer(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/:id/reconcile', async (c) => c.json(await service().reconcile(c.req.param('id'))))
  app.delete('/:id/registration', async (c) => {
    await service().forget(c.req.param('id'))
    return c.json({ ok: true })
  })

  let active = 0
  const sessions = new WeakMap<object, { close(): Promise<void>; timer: ReturnType<typeof setTimeout>; busy: boolean }>()
  const key = (conn: WsConn) => (conn.raw as object | undefined) ?? conn
  app.get('/:id/terminal', async (c) => {
    if (!wsOriginAllowed(c.req.raw)) return sendJson(403, { error: '请求来源不允许' })
    const id = c.req.param('id')
    if (id.startsWith('sqlite-') ? !deps.sqlite : !deps.service) return sendJson(503, { error: '数据库终端服务不可用' })
    if (deps.logs) {
      await recordPanelOperation(deps.logs, {
        category: 'database', action: '发起数据库协议终端连接', target: id,
        result: 'success', method: 'GET', path: `/api/databases/${id}/terminal`, httpStatus: 200,
      })
    }
    const { bunWebSocket } = await import('../terminals/bunWebSocket.ts')
    return bunWebSocket.upgradeWebSocket(c, {
      onOpen(_event, conn) {
        if (active >= MAX_SESSIONS) { conn.close(1008, '数据库终端会话已达上限'); return }
        active += 1
        void (id.startsWith('sqlite-') && deps.sqlite ? deps.sqlite.openSession(id.slice(7)) : service().openSession(id)).then((session) => {
          if (conn.readyState !== 1) { active -= 1; return session.close() }
          const timer = setTimeout(() => conn.close(1000, '数据库终端空闲超时'), IDLE_TIMEOUT)
          sessions.set(key(conn), { close: session.close, timer, busy: false })
          conn.send(JSON.stringify({ type: 'ready' }))
          // 结果由单会话闭包发回，语句正文不进入操作日志。
          executors.set(key(conn), session.execute)
        }).catch((error: unknown) => {
          active -= 1
          conn.send(JSON.stringify({ type: 'error', text: error instanceof Error ? error.message : '连接失败' }))
          conn.close(1011, '数据库连接失败')
        })
      },
      onMessage(event, conn) {
        const state = sessions.get(key(conn))
        if (!state) return
        const raw = typeof event.data === 'string' ? event.data : ''
        if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) { conn.close(1008, '输入超过 64 KiB'); return }
        let frame: { type?: string; text?: string }
        try { frame = JSON.parse(raw) as typeof frame } catch { conn.close(1008, '终端消息无效'); return }
        if (frame.type === 'interrupt') { conn.close(1000, '执行已中断'); return }
        if (frame.type !== 'execute' || typeof frame.text !== 'string') { conn.close(1008, '终端消息无效'); return }
        if (state.busy) { conn.send(JSON.stringify({ type: 'error', text: '上一条命令仍在执行' })); return }
        clearTimeout(state.timer)
        state.busy = true
        const execute = executors.get(key(conn))
        if (!execute) return
        void execute(frame.text).then((lines) => {
          if (conn.readyState === 1 && ((conn.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0) < 1024 * 1024) {
            conn.send(JSON.stringify({ type: 'output', lines }))
          } else conn.close(1008, '输出缓冲超限')
        }).catch((error: unknown) => {
          if (conn.readyState === 1) conn.send(JSON.stringify({ type: 'error', text: error instanceof Error ? error.message : '执行失败' }))
        }).finally(() => {
          state.busy = false
          state.timer = setTimeout(() => conn.close(1000, '数据库终端空闲超时'), IDLE_TIMEOUT)
        })
      },
      onClose(_event, conn) {
        const state = sessions.get(key(conn))
        if (!state) return
        clearTimeout(state.timer)
        sessions.delete(key(conn))
        executors.delete(key(conn))
        active -= 1
        void state.close().catch(() => undefined)
      },
    })
  })
  const executors = new WeakMap<object, (input: string) => Promise<string[]>>()
  return app
}
