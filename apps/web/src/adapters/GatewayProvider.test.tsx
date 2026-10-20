import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ElysianGateway } from '../contracts/adapters'
import { GatewayProvider, useGateway } from './GatewayProvider'
import { AgentExtensionsMockAdapter } from './mock/agent/agentExtensionsMockAdapter'

// Docker 运行时（compose 注入 ELYSIAN_DOCKER=1）里技能与 MCP 配置必须走同源 HTTP，
// 本地无后端时回落内存 mock；两者经同一 GatewayProvider 注入点切换，组件不感知。
const runtime = vi.hoisted(() => ({ docker: true }))
vi.mock('../app/runtime/isDockerRuntime', () => ({ isDockerRuntime: () => runtime.docker }))

function Probe({ onGateway }: { onGateway: (gateway: ElysianGateway) => void }) {
  onGateway(useGateway())
  return null
}

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
