import { AgentHttpError } from '../contracts/agentHttpError'
import { messageOf } from './errorMessage'

/** Web-only execution receipt; never changes a domain wire contract. */
export type TableBatchOutcome = { status: 'succeeded' | 'failed' | 'unknown'; error?: string }

export function tableBatchFailure(error: unknown): TableBatchOutcome {
  const detail = messageOf(error)
  const rejected = error instanceof AgentHttpError && typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408
  return { status: rejected ? 'failed' : 'unknown', error: detail }
}
