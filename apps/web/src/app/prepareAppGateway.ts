import { createDefaultGateway } from '../adapters/GatewayProvider'
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore'
import { useSessionStore } from '../stores/sessionStore'
import { isDockerRuntime } from '../utils/isDockerRuntime'

export async function prepareAppGateway(docker = isDockerRuntime()) {
  const gateway = createDefaultGateway(docker, reason => useAgentRuntimeStore.getState().reportUnavailable(reason))
  // 演示身份来自内存 adapter，在首屏前落位；真实会话仍交给路由闸门。
  if (!docker) await useSessionStore.getState().probe(gateway)
  return gateway
}
