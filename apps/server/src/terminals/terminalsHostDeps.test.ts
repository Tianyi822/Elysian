import { describe, expect, it } from 'vitest'
import { resolveTerminalsAvailability, createTerminalsHostDeps } from './terminalsHostDeps.ts'
import type { TerminalsHostDeps } from './terminalsService.ts'

/*
 * 终端接线的容器双闸门锚定：环境变量声明 Docker 编排（ELYSIAN_DOCKER=1）与
 * /.dockerenv 实存缺一不可；不可用产出 available=false（路由整片 503 的来源），
 * 宿主机上绝不 spawn PTY。可用分支用注入的 fake deps 走通装配，不 spawn 任何进程。
 */

/** 环境变量名以代码与 compose 为准（ELYSIAN_DOCKER，见 shared/isDockerEnv.ts）。 */
const DOCKER_ENV: NodeJS.ProcessEnv = { ELYSIAN_DOCKER: '1' }

function createFakeDeps(): TerminalsHostDeps {
  return {
    available: true,
    identity: () => ({ user: 'root', hostLabel: 'elysian-web-1', homeDir: '/root' }),
    spawnPtyShell: () => {
      throw new Error('fake 接线不应被 spawn')
    },
    listDir: async () => [],
    listCommands: async () => [],
    now: () => 0,
  }
}

describe('resolveTerminalsAvailability', () => {
  it('两条件齐备才可用', () => {
    expect(resolveTerminalsAvailability(DOCKER_ENV, true)).toBe(true)
  })

  it('缺环境变量声明即不可用', () => {
    expect(resolveTerminalsAvailability({}, true)).toBe(false)
    expect(resolveTerminalsAvailability({ ELYSIAN_DOCKER: '0' }, true)).toBe(false)
  })

  it('缺 /.dockerenv 实存即不可用（环境变量谎报也拦住）', () => {
    expect(resolveTerminalsAvailability(DOCKER_ENV, false)).toBe(false)
  })
})

describe('createTerminalsHostDeps', () => {
  it('不可用时产出 available=false 且无 service', async () => {
    const deps = await createTerminalsHostDeps({ env: DOCKER_ENV, dockerenvExists: false })
    expect(deps).toEqual({ available: false })
  })

  it('宿主机缺省探测（无 ELYSIAN_DOCKER）同样不可用', async () => {
    const deps = await createTerminalsHostDeps({ env: {}, dockerenvExists: true })
    expect(deps.available).toBe(false)
  })

  it('两闸门齐备且注入 fake deps 时装配可用服务，不触 spawn', async () => {
    const deps = await createTerminalsHostDeps({ env: DOCKER_ENV, dockerenvExists: true, deps: createFakeDeps() })
    expect(deps.available).toBe(true)
    expect(deps.service).toBeDefined()
  })
})
