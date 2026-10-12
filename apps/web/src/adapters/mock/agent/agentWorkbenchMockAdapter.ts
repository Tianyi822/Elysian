import type {
  AgentCreateSessionInput,
  AgentEnvironment,
  AgentInput,
  AgentMemorySpaceSelection,
  AgentModelRequestRecord,
  AgentSession,
  AgentSwitchModelInput,
  AgentMessage,
  AgentWorkingMemory,
  AgentWorkspaceVersion,
  AgentWorkspaceView,
  RuntimePage,
  RuntimeRun,
  RuntimeTask,
} from '@elysian/contracts'
import type { AgentMessageQuery, AgentPageQuery, AgentWorkbenchAdapter } from '../../../contracts/adapters'
import { workbenchInternals } from './agentWorkbenchData'

/*
 * Ely 工作台域 mock 适配器：全部语义落在 agentWorkbenchData 的确定性状态机里，
 * 本类只是 AgentWorkbenchAdapter 接口的薄转发。演示模式刷新即回种子；
 * resetAgentWorkbenchData 同时是测试复位出口（agentTestUtils 聚合引用）。
 * Run 状态推进、requestId 幂等、session-busy/model-changed/revision-conflict 的
 * 中文文案与取消语义均见 agentWorkbenchData 头注。
 */

export { resetAgentWorkbenchData } from './agentWorkbenchData'

export class AgentWorkbenchMockAdapter implements AgentWorkbenchAdapter {
  async listSessions(query?: AgentPageQuery, signal?: AbortSignal): Promise<RuntimePage<AgentSession>> {
    void signal
    return workbenchInternals.listSessionsPage(query)
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<AgentSession> {
    void signal
    return workbenchInternals.getSession(sessionId)
  }

  async createSession(input: AgentCreateSessionInput): Promise<AgentSession> {
    return workbenchInternals.createSession(input)
  }

  async switchModel(sessionId: string, input: AgentSwitchModelInput): Promise<AgentSession> {
    return workbenchInternals.switchModel(sessionId, input)
  }

  async listMessages(sessionId: string, query?: AgentMessageQuery, signal?: AbortSignal): Promise<RuntimePage<AgentMessage>> {
    void signal
    return workbenchInternals.listMessagesPage(sessionId, query)
  }

  async listTasks(sessionId: string, query?: AgentPageQuery, signal?: AbortSignal): Promise<RuntimePage<RuntimeTask>> {
    void signal
    return workbenchInternals.listTasksPage(sessionId, query)
  }

  async createTask(sessionId: string, input: AgentInput): Promise<RuntimeRun> {
    return workbenchInternals.createTask(sessionId, input)
  }

  async continueRun(taskId: string, input: AgentInput): Promise<RuntimeRun> {
    return workbenchInternals.continueRun(taskId, input)
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<RuntimeTask> {
    void signal
    return workbenchInternals.getTask(taskId)
  }

  async getTaskWorkingMemory(taskId: string, revision?: number, signal?: AbortSignal): Promise<AgentWorkingMemory> {
    void signal
    void revision
    return workbenchInternals.getWorkingMemory(taskId)
  }

  async readSessionMemorySelection(sessionId: string, signal?: AbortSignal): Promise<AgentMemorySpaceSelection> {
    void signal
    return workbenchInternals.readMemorySelection(sessionId)
  }

  async writeSessionMemorySelection(sessionId: string, selection: AgentMemorySpaceSelection): Promise<AgentMemorySpaceSelection> {
    return workbenchInternals.writeMemorySelection(sessionId, selection)
  }

  async listModelRequests(runId: string, query?: AgentPageQuery, signal?: AbortSignal): Promise<RuntimePage<AgentModelRequestRecord>> {
    void signal
    return workbenchInternals.listModelRequestsPage(runId, query)
  }

  async getSessionEnvironment(sessionId: string, signal?: AbortSignal): Promise<AgentEnvironment> {
    void signal
    return workbenchInternals.getEnvironment(sessionId)
  }

  async updateSessionEnvironment(sessionId: string, expectedRevision: number, environment: AgentEnvironment): Promise<AgentEnvironment> {
    return workbenchInternals.updateEnvironment(sessionId, expectedRevision, environment)
  }

  async listWorkspace(taskId: string, signal?: AbortSignal): Promise<AgentWorkspaceView> {
    void signal
    return workbenchInternals.listWorkspace(taskId)
  }

  async readWorkspaceFile(taskId: string, path: string, signal?: AbortSignal): Promise<AgentWorkspaceView> {
    void signal
    return workbenchInternals.readWorkspaceFile(taskId, path)
  }

  async writeWorkspaceFile(taskId: string, path: string, expectedRevision: number, bytes: Uint8Array): Promise<AgentWorkspaceVersion> {
    return workbenchInternals.writeWorkspaceFile(taskId, path, expectedRevision, bytes)
  }

  async deleteWorkspaceFile(taskId: string, path: string, expectedRevision: number): Promise<AgentWorkspaceVersion> {
    return workbenchInternals.deleteWorkspaceFile(taskId, path, expectedRevision)
  }
}
