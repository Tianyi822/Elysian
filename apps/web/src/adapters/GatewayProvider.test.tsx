import { render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ElysianGateway } from '../contracts/adapters'
import { platformMemorySample } from '../test/platformMemorySample'
import { GatewayProvider, useGateway } from './GatewayProvider'
import { AgentExtensionsMockAdapter } from './mock/agent/agentExtensionsMockAdapter'
import { createGateway } from './mock/gateway'

// Docker 运行时（compose 注入 ELYSIAN_DOCKER=1）里技能与 MCP 配置必须走同源 HTTP，
// 本地无后端时回落内存 mock；两者经同一 GatewayProvider 注入点切换，组件不感知。
const runtime = vi.hoisted(() => ({ docker: true }))
vi.mock('../utils/isDockerRuntime', () => ({ isDockerRuntime: () => runtime.docker }))

function Probe({ onGateway }: { onGateway: (gateway: ElysianGateway) => void }) {
  onGateway(useGateway())
  return null
}

afterEach(() => vi.unstubAllGlobals())

it('Docker 运行时的扩展配置走 HTTP adapter，本地演示走内存 mock', () => {
  let gateway: ElysianGateway | undefined
  runtime.docker = true
  const docker = render(<GatewayProvider><Probe onGateway={(value) => { gateway = value }} /></GatewayProvider>)
  expect(gateway?.agentExtensions).toBeDefined()
  expect(gateway?.agentExtensions).not.toBeInstanceOf(AgentExtensionsMockAdapter)
  docker.unmount()

  runtime.docker = false
  const local = render(<GatewayProvider><Probe onGateway={(value) => { gateway = value }} /></GatewayProvider>)
  expect(gateway?.agentExtensions).toBeInstanceOf(AgentExtensionsMockAdapter)
  local.unmount()
})

it.each([true, false])('默认网关读取同源进程内存（正式运行时：%s）', async docker => {
  runtime.docker = docker
  const sample = platformMemorySample()
  const fetch = vi.fn(async () => new Response(JSON.stringify(sample)))
  vi.stubGlobal('fetch', fetch)
  let gateway!: ElysianGateway
  render(<GatewayProvider><Probe onGateway={value => { gateway = value }} /></GatewayProvider>)

  await expect(gateway.platformMemory.read()).resolves.toEqual(sample)
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/platform/memory', { cache: 'no-store', signal: expect.any(AbortSignal) })
})

it('使用显式注入的进程内存适配器', async () => {
  const sample = platformMemorySample({ rssMb: 120 })
  const read = vi.fn(async () => sample)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const injected = { ...createGateway({ eventStream: 'memory' }), platformMemory: { read } }
  let gateway!: ElysianGateway
  render(<GatewayProvider gateway={injected}><Probe onGateway={value => { gateway = value }} /></GatewayProvider>)

  await expect(gateway.platformMemory.read()).resolves.toEqual(sample)
  expect(read).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
})
