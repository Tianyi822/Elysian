import { describe, expect, it } from 'vitest'
import {
  createDockerExecSessions,
  DOCKER_EXEC_SERVICE_IDLE_MS,
} from './dockerExecSessions.ts'

function createOptions(nowMs: () => number) {
  return {
    createExecRunner: () => {
      throw new Error('测试不应创建 exec 会话')
    },
    identityForContainer: () => ({ user: 'root', hostLabel: 'test', homeDir: '/' }),
    listDir: async () => [] as readonly string[],
    listCommands: async () => [] as readonly string[],
    now: nowMs,
  }
}

describe('createDockerExecSessions', () => {
  it('activeCount 为 0 且空闲达到阈值后，按容器驻留的 service 被回收', () => {
    let nowMs = 1_000_000
    const sessions = createDockerExecSessions(createOptions(() => nowMs))

    sessions.createWsEvents('a')
    sessions.createWsEvents('b')
    expect(sessions.managedCount()).toBe(2)
    expect(sessions.activeCount()).toBe(0)

    nowMs += DOCKER_EXEC_SERVICE_IDLE_MS - 1
    sessions.activeCount()
    expect(sessions.managedCount()).toBe(2)

    nowMs += 1
    sessions.createWsEvents('c')
    expect(sessions.managedCount()).toBe(1)
  })

  it('阈值内再次 createWsEvents 刷新最后使用时间，service 不被回收', () => {
    let nowMs = 0
    const sessions = createDockerExecSessions(createOptions(() => nowMs))

    sessions.createWsEvents('a')
    nowMs += DOCKER_EXEC_SERVICE_IDLE_MS - 1
    sessions.createWsEvents('a')
    nowMs += DOCKER_EXEC_SERVICE_IDLE_MS - 1
    expect(sessions.managedCount()).toBe(1)
  })
})
