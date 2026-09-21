import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  createSshHostDeps,
  readTextTailFromFile,
  resolveSshAvailability,
  resolveVerifiedSshdPid,
  type SshdPidProbe,
} from './sshHostDeps'
import type { SshHostDeps } from './sshService'
import { createSshApp } from './sshRoutes'

/*
 * 容器硬边界的测试锚定：可用性的推导（ELYSIAN_DOCKER=1 且 /.dockerenv 存在）与
 * 装配接线在这里钉住——改坏判定会让用例变红，而不是静默漏到宿主机执行真实命令。
 * 全部用注入的环境与 fake deps 驱动，不依赖宿主机状态、不执行任何真实命令、不建目录。
 */

/**
 * 只够 overview() 读通的最小 fake：任何真实执行被调用即抛错。
 * 若硬边界被改坏，503 用例会变成 500/200 而立刻失败。
 */
function createThrowingDeps(): SshHostDeps {
  const fail = (name: string) => () => {
    throw new Error(`测试内不得执行真实命令：${name}`)
  }
  return {
    runSshKeygen: fail('ssh-keygen'),
    runSshd: fail('sshd'),
    startSshd: fail('startSshd'),
    stopSshd: fail('stopSshd'),
    reloadSshd: fail('reloadSshd'),
    runChpasswd: fail('chpasswd'),
    runGetent: fail('getent'),
    delay: fail('delay'),
    readText: fail('readText'),
    readTextTail: fail('readTextTail'),
    readDir: async () => [],
    writeText: fail('writeText'),
    exists: async () => false,
    rename: fail('rename'),
    chmod: fail('chmod'),
    chown: fail('chown'),
    mkdir: fail('mkdir'),
    remove: fail('remove'),
    nowIso: () => '2026-09-18T12:00:00.000Z',
  }
}

/** 按装配产物直接挂路由并请求：硬边界用例经真实守卫链走到 503/200 分支。 */
async function requestOverview(deps: ReturnType<typeof createSshHostDeps>): Promise<{ statusCode: number; body: unknown }> {
  const res = await createSshApp(deps).request('/overview')
  return { statusCode: res.status, body: await res.json() }
}

describe('resolveSshAvailability', () => {
  it('两项条件同时满足才可用：环境声明 Docker 编排 + /.dockerenv 证明真的在容器内', () => {
    expect(resolveSshAvailability({ ELSYIAN_DOCKER: '1' }, true)).toBe(true)
    expect(resolveSshAvailability({ ELSYIAN_DOCKER: '1' }, false)).toBe(false)
    expect(resolveSshAvailability({ ELSYIAN_DOCKER: '0' }, true)).toBe(false)
    expect(resolveSshAvailability({}, true)).toBe(false)
  })
})

describe('resolveVerifiedSshdPid（停止/重载信号的 pid 身份核实）', () => {
  /** pidfile 内容与 /proc/<pid>/comm 内容的组合注入；comm 为 null 表示读不到。 */
  function probeOf(pidFile: string | null, comm: string | null): SshdPidProbe {
    return {
      readPidFile: async () => pidFile,
      readProcComm: async () => comm,
    }
  }

  it('pidfile 可解析且 /proc/<pid>/comm 是 sshd 才返回 pid（核实过身份才允许发信号）', async () => {
    expect(await resolveVerifiedSshdPid(probeOf('123\n', 'sshd\n'))).toBe(123)
    expect(await resolveVerifiedSshdPid(probeOf('123', 'sshd'))).toBe(123)
  })

  it('comm 不是 sshd（pid 被无关进程复用）或读不到（进程已退）都返回 null', async () => {
    expect(await resolveVerifiedSshdPid(probeOf('123\n', 'bash\n'))).toBeNull()
    expect(await resolveVerifiedSshdPid(probeOf('123\n', 'cron\n'))).toBeNull()
    expect(await resolveVerifiedSshdPid(probeOf('123\n', null))).toBeNull()
  })

  it('pidfile 读不到（未在跑）或内容非法时返回 null', async () => {
    expect(await resolveVerifiedSshdPid(probeOf(null, 'sshd\n'))).toBeNull()
    expect(await resolveVerifiedSshdPid(probeOf('', 'sshd\n'))).toBeNull()
    expect(await resolveVerifiedSshdPid(probeOf('not-a-pid\n', 'sshd\n'))).toBeNull()
  })
})

describe('readTextTailFromFile（登录日志按字节取尾的真实语义）', () => {
  /** 只读夹具：拿本测试文件自身当样本（数 KB，够跨过小预算），不写任何宿主文件。 */
  const SAMPLE = fileURLToPath(import.meta.url)

  it('预算不小于文件大小时返回全文，不丢首行', async () => {
    const whole = await readFile(SAMPLE, 'utf8')
    const text = await readTextTailFromFile(SAMPLE, Buffer.byteLength(whole) + 1)
    expect(text).toBe(whole)
  })

  it('预算小于文件大小时只返回尾部：丢弃不完整首行，且结果仍是全文的后缀', async () => {
    const whole = await readFile(SAMPLE, 'utf8')
    const text = await readTextTailFromFile(SAMPLE, 300)
    // 截尾发生在读取层：结果不超过预算，也严格短于全文。
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300)
    expect(text.length).toBeLessThan(whole.length)
    expect(text.length).toBeGreaterThan(0)
    // 从行中截断的余烬被丢弃：返回文本起于整行边界，且是全文的后缀（只丢不完整首行）。
    expect(whole.charAt(whole.length - text.length - 1)).toBe('\n')
    expect(whole.endsWith(text)).toBe(true)
  })
})

describe('createSshHostDeps 硬边界', () => {
  it('环境未声明 Docker（即使 /.dockerenv 存在，如在容器里手动起 server）：装配不可用，路由一律 503，不触达真实命令', async () => {
    const deps = createSshHostDeps({ env: {}, dockerenvExists: true, deps: createThrowingDeps() })
    expect(deps.available).toBe(false)
    const app = createSshApp(deps)
    for (const [method, url] of [
      ['GET', '/overview'],
      ['PUT', '/port'],
      ['POST', '/root-password'],
      ['DELETE', '/keys/sshkey-0000abcd'],
    ] as const) {
      const res = await app.request(url, { method })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实 SSH 管理仅在 Docker 容器内可用' })
    }
  })

  it('声明了 Docker 但进程不在容器内（/.dockerenv 缺失，宿主机运行）：装配不可用，路由 503', async () => {
    const deps = createSshHostDeps({
      env: { ELSYIAN_DOCKER: '1' },
      dockerenvExists: false,
      deps: createThrowingDeps(),
    })
    expect(deps.available).toBe(false)
    const { statusCode, body } = await requestOverview(deps)
    expect(statusCode).toBe(503)
    expect(body).toEqual({ error: '真实 SSH 管理仅在 Docker 容器内可用' })
  })

  it('两项条件满足时装配真实服务：请求经同源守卫到达 service（注入 fake deps，宿主机零副作用）', async () => {
    const deps = createSshHostDeps({
      env: { ELSYIAN_DOCKER: '1' },
      dockerenvExists: true,
      deps: createThrowingDeps(),
    })
    expect(deps.available).toBe(true)
    expect(deps.service).toBeDefined()
    const { statusCode, body } = await requestOverview(deps)
    expect(statusCode).toBe(200)
    expect(body).toMatchObject({ enabled: false, status: 'stopped' })
  })
})
