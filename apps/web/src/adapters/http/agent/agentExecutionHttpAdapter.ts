import type { AgentExecutionAdapter } from '../../../contracts/agentExecution'
import { agentPathPart, requestAgentJson } from './agentShared'
import { parseExecutionList, parseGrant, parseProfile } from './executionParse'

export function createHttpAgentExecutionAdapter(): AgentExecutionAdapter {
  const base = '/api/agent'
  const path = (kind: string, id: string, revision?: number) => `${base}/${kind}/${agentPathPart(id)}${revision === undefined ? '' : `?revision=${revision}`}`
  const write = (url: string, method: string, input: unknown) => requestAgentJson(url, { method, body: JSON.stringify(input) })
  const detail = async <T>(url: string, id: string, revision: number | undefined, parse: (value: unknown) => T & { id: string; revision: number }, signal?: AbortSignal) => {
    const item = parse(await requestAgentJson(url, { signal }))
    if (item.id !== id || (revision !== undefined && item.revision !== revision)) throw new Error('Agent 执行配置修订响应不匹配')
    return item
  }
  return {
    async listProfiles(signal) { return parseExecutionList(await requestAgentJson(`${base}/execution-profiles`, { signal }), parseProfile) },
    getProfile(id, revision, signal) { return detail(path('execution-profiles', id, revision), id, revision, parseProfile, signal) },
    async createProfile(input) { const { id: _id, ...body } = input; return parseProfile(await write(`${base}/execution-profiles`, 'POST', body)) },
    async updateProfile(id, input) { return parseProfile(await write(path('execution-profiles', id), 'PUT', { ...input, id })) },
    async setProfileEnabled(id, expectedRevision, enabled) { return parseProfile(await write(`${path('execution-profiles', id)}/enabled`, 'PUT', { expectedRevision, enabled })) },
    async listGrants(signal) { return parseExecutionList(await requestAgentJson(`${base}/grants`, { signal }), parseGrant) },
    getGrant(id, revision, signal) { return detail(path('grants', id, revision), id, revision, parseGrant, signal) },
    async createGrant(input) { const { id: _id, ...body } = input; return parseGrant(await write(`${base}/grants`, 'POST', body)) },
    async updateGrant(id, input) { return parseGrant(await write(path('grants', id), 'PUT', { ...input, id })) },
    async setGrantEnabled(id, expectedRevision, enabled) { return parseGrant(await write(`${path('grants', id)}/enabled`, 'PUT', { expectedRevision, enabled })) },
  }
}
