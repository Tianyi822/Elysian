import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createUsersHostDeps,
  resolveUsersAvailability,
  runChpasswdViaStdin,
  runGetentViaExecFile,
  type ChpasswdChildLike,
  type ExecFileLike,
  type SpawnChpasswdLike,
  type UsersHostDepsOptions,
} from './usersHostDeps'
import { createUsersApp } from './usersRoutes'
import type { UsersHostDeps } from './usersService'

/*
 * 容器硬边界的测试锚定：可用性的推导（ELYSIAN_DOCKER=1 且 /.dockerenv 存在）与
 * 接线装配在这里钉住——改坏判定会让用例变红，而不是静默漏到宿主机执行
 * useradd/usermod/userdel/gpasswd/chpasswd 这类系统修改命令。
 * 全部用注入的环境与 fake deps 驱动，不依赖宿主机状态、不执行任何真实命令。
 */

/**
 * 只够 list() 读通的最小 fake：getent 走内存数据，任何写命令被调用即抛错。
 * 若硬边界被改坏，503 用例会变成 500 而立刻失败。
 */
function createListOnlyDeps(): UsersHostDeps {
  const fail = (name: string) => () => {
    throw new Error(`测试内不得执行真实命令：${name}`)
  }
  return {
    runGetent: async (args) => {
      if (args[0] === 'passwd') return 'ubuntu:x:1000:1000:Ubuntu User:/home/ubuntu:/bin/bash\n'
      if (args[0] === 'shadow') return 'ubuntu:$6$hash:20000:0:99999:7:::\n'
      if (args[0] === 'group' && args[1] === 'sudo') return 'sudo:x:27:ubuntu\n'
      throw new Error(`测试内不支持的 getent 调用：${args.join(' ')}`)
    },
    runUseradd: fail('useradd'),
    runUsermod: fail('usermod'),
    runUserdel: fail('userdel'),
    runGpasswd: fail('gpasswd'),
    runChpasswd: fail('chpasswd'),
    readText: fail('readText'),
    exists: async () => false,
    remove: fail('remove'),
    nowIso: () => '2026-09-20T12:00:00.000Z',
  }
}

/** 由注入的装配选项直接建起可请求的路由应用：断言只关心状态码与响应体，不依赖驱动时序。 */
function appFrom(options: UsersHostDepsOptions) {
  return createUsersApp(createUsersHostDeps(options))
}

/** 同源合法头的请求桩：带体时声明 JSON 与真实长度。 */
function fakeReq(method: string, url: string, body?: unknown): Request {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Request(`http://localhost:5173${url}`, {
    method,
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      ...(payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
    },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

async function readResponse(
  app: ReturnType<typeof appFrom>,
  req: Request,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.request(req)
  return { statusCode: res.status, body: await res.json() }
}

describe('runGetentViaExecFile 的退出码语义（容器联调回归：getent 查无此键以退出码 2 结束）', () => {
  /** 造一个 reject 出 execFile 形状错误的 fake exec：code 为退出码，stderr 为命令 stderr。 */
  function execRejectingWith(code: number | string, stderr = ''): ExecFileLike {
    return async () => {
      throw Object.assign(new Error(`Command failed: getent passwd ghost`), { code, stderr })
    }
  }

  it('退出码 2（所查键不存在）归一为空输出：创建查重与删除回读按「无此账号」继续，不再恒失败', async () => {
    await expect(runGetentViaExecFile(execRejectingWith(2), ['passwd', 'ghost'])).resolves.toBe('')
  })

  it('其余退出码仍是执行失败，错误信息带 stderr 详情', async () => {
    await expect(runGetentViaExecFile(execRejectingWith(1, 'Unknown database'), ['bogus'])).rejects.toThrow(
      'Unknown database',
    )
  })

  it('无 stderr 详情时回退到错误消息本身，不混入未归一的原样信息', async () => {
    await expect(runGetentViaExecFile(execRejectingWith(3, ''), ['shadow'])).rejects.toThrow(
      'Command failed: getent passwd ghost',
    )
  })

  it('退出码为字符串（信号终止等）不归一为空输出，照常抛错', async () => {
    await expect(runGetentViaExecFile(execRejectingWith('ENOENT', ''), ['passwd'])).rejects.toThrow()
  })

  it('命令成功时原样返回 stdout', async () => {
    const exec: ExecFileLike = async () => ({ stdout: 'ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n', stderr: '' })
    await expect(runGetentViaExecFile(exec, ['passwd', 'ubuntu'])).resolves.toContain('ubuntu:x:1000')
  })
})

describe('runChpasswdViaStdin 的 stdin 流错误（chpasswd 早退）', () => {
  /**
   * 最小 fake 子进程，模拟「在读 stdin 前退出」的真实管道语义：进程退出后写端再写入，
   * 错误以 EPIPE 异步送达（真实流不在 write 调用栈里同步抛错）；close 事件也晚于写入
   * 才到（真实子进程退出至少跨一个事件循环）。
   */
  function createExitedBeforeReadingStdinChild(exitCode = 1): { spawn: SpawnChpasswdLike; writes: string[] } {
    const writes: string[] = []
    const stdin = Object.assign(new EventEmitter(), {
      write(chunk: string) {
        writes.push(chunk)
        queueMicrotask(() => {
          stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        })
        return true
      },
      end() {},
    })
    const child: ChpasswdChildLike = {
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on(event, listener) {
        if (event === 'close') setTimeout(() => listener(exitCode), 0)
        return child
      },
    }
    return { spawn: () => child, writes }
  }

  it('chpasswd 在读 stdin 前退出：stdin 的 EPIPE 纳入 reject，而不是未处理异常崩掉进程', async () => {
    const { spawn, writes } = createExitedBeforeReadingStdinChild()
    await expect(runChpasswdViaStdin(spawn, 'ubuntu:Elysian#2026Strong')).rejects.toThrow('EPIPE')
    // 凭据确实写进了 stdin：写入本身完成，错误在其后异步送达。
    expect(writes).toEqual(['ubuntu:Elysian#2026Strong'])
  })

  it('正常路径：凭据写进 stdin 并 end，退出码 0 resolve 空输出', async () => {
    const writes: string[] = []
    let ended = false
    const child: ChpasswdChildLike = {
      stdin: Object.assign(new EventEmitter(), {
        write(chunk: string) {
          writes.push(chunk)
          return true
        },
        end() {
          ended = true
        },
      }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on(event, listener) {
        if (event === 'close') queueMicrotask(() => listener(0))
        return child
      },
    }
    await expect(runChpasswdViaStdin(() => child, 'ubuntu:Elysian#2026Strong')).resolves.toBe('')
    expect(writes).toEqual(['ubuntu:Elysian#2026Strong'])
    expect(ended).toBe(true)
  })

  it('退出码非零且有 stderr：错误信息带 stderr 详情；无 stderr 时回退退出码文案', async () => {
    const stderrPipe = new EventEmitter()
    const stderrChild: ChpasswdChildLike = {
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      stdout: new EventEmitter(),
      stderr: stderrPipe,
      on(event, listener) {
        if (event === 'close') queueMicrotask(() => listener(1))
        return stderrChild
      },
    }
    const pendingStderr = runChpasswdViaStdin(() => stderrChild, 'ubuntu:Elysian#2026Strong')
    stderrPipe.emit('data', Buffer.from('chpasswd: 密码强度不足\n'))
    await expect(pendingStderr).rejects.toThrow('密码强度不足')

    // 静默失败（无 stderr）：兜底文案交给退出码描述。
    const child: ChpasswdChildLike = {
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on(event, listener) {
        if (event === 'close') queueMicrotask(() => listener(1))
        return child
      },
    }
    await expect(runChpasswdViaStdin(() => child, 'ubuntu:x')).rejects.toThrow('chpasswd 退出码 1')
  })

  it('子进程本身 spawn 失败（如 ENOENT）：error 事件纳入同一 reject 路径', async () => {
    const child: ChpasswdChildLike = {
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on(event, listener) {
        if (event === 'error') queueMicrotask(() => listener(new Error('spawn chpasswd ENOENT')))
        return child
      },
    }
    await expect(runChpasswdViaStdin(() => child, 'ubuntu:x')).rejects.toThrow('ENOENT')
  })

  it('标准管道未建立（stdio 非 pipe 配置）：中文 reject，不触碰任何流', async () => {
    const child: ChpasswdChildLike = { stdin: null, stdout: null, stderr: null, on: () => undefined }
    await expect(runChpasswdViaStdin(() => child, 'ubuntu:x')).rejects.toThrow('标准管道未建立')
  })
})

describe('resolveUsersAvailability', () => {
  it('两项条件同时满足才可用：环境声明 Docker 编排 + /.dockerenv 证明真的在容器内', () => {
    expect(resolveUsersAvailability({ ELYSIAN_DOCKER: '1' }, true)).toBe(true)
    expect(resolveUsersAvailability({ ELYSIAN_DOCKER: '1' }, false)).toBe(false)
    expect(resolveUsersAvailability({ ELYSIAN_DOCKER: '0' }, true)).toBe(false)
    expect(resolveUsersAvailability({}, true)).toBe(false)
  })
})

describe('createUsersHostDeps 硬边界', () => {
  it('环境未声明 Docker（即使 /.dockerenv 存在，如在容器里手动起 dev）：一律 503，不触达真实命令', async () => {
    const app = appFrom({ env: {}, dockerenvExists: true, deps: createListOnlyDeps() })
    for (const [method, url] of [
      ['GET', '/'],
      ['POST', '/'],
      ['PUT', '/ubuntu'],
      ['DELETE', '/ubuntu'],
      ['POST', '/sync'],
    ] as const) {
      const body =
        method === 'POST' && url === '/'
          ? { name: 'x', loginMethod: 'key', status: 'active', isAdmin: false, note: null }
          : method === 'PUT'
            ? { loginMethod: 'key', status: 'active', isAdmin: false, note: null }
            : method === 'POST'
              ? {}
              : undefined
      const { statusCode, body: responseBody } = await readResponse(app, fakeReq(method, url, body))
      expect(statusCode).toBe(503)
      expect(responseBody).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
    }
  })

  it('声明了 Docker 但进程不在容器内（/.dockerenv 缺失，宿主机 dev/preview）：一律 503', async () => {
    const app = appFrom({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: false,
      deps: createListOnlyDeps(),
    })
    const { statusCode, body } = await readResponse(app, fakeReq('GET', '/'))
    expect(statusCode).toBe(503)
    expect(body).toEqual({ error: '真实用户管理仅在 Docker 容器内可用' })
  })

  it('两项条件满足时挂真实 handler：请求经同源守卫到达 service（注入 fake deps，宿主机零副作用）', async () => {
    const app = appFrom({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      deps: createListOnlyDeps(),
    })
    const { statusCode, body } = await readResponse(app, fakeReq('GET', '/'))
    expect(statusCode).toBe(200)
    expect(body).toMatchObject({
      users: [{ id: 'ubuntu', name: 'ubuntu', isAdmin: true, loginMethod: 'password', createdAt: null }],
    })
  })
})
