import type { AgentExecutionGrantInput, AgentExecutionProfileInput } from '@elysian/contracts'

export const executionProfileInput: AgentExecutionProfileInput = {
  name: '受限 Bash', expectedRevision: 0, enabled: true, runtime: 'bash', image: `library/bash@sha256:${'a'.repeat(64)}`,
  command: ['bash'], timeoutSeconds: 60, cpuMillis: 500, memoryBytes: 256 * 1048576, pids: 64,
}
export const executionGrantInput: AgentExecutionGrantInput = {
  name: '网站维护', expectedRevision: 0, enabled: true, directories: [{ path: '/srv/elysian/shop', access: 'ro' }],
  network: [{ scheme: 'https', host: 'api.example.com', port: 443 }], privateCidrs: ['10.0.0.0/8'], resources: [{ domain: 'website', id: 'shop', access: 'write' }],
}
