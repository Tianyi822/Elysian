import { runAgentExecutionAdapterContract } from '../../agentExecutionAdapterContract'
import { AgentExecutionMockAdapter } from './agentExecutionMockAdapter'

runAgentExecutionAdapterContract('mock', () => new AgentExecutionMockAdapter())
