import { useCallback, useEffect, useMemo, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { ShieldCheck } from '../../components/icons'
import { LoadingState } from '../../components/states/StateViews'
import { useNotificationStore } from '../../stores/notificationStore'
import type { AgentRevocationKind } from '../../stores/agentApprovalsStore'
import { collectApprovalReferencedIds, useAgentApprovalsStore } from '../../stores/agentApprovalsStore'
import { byteLength } from './approvalsFormat'
import { DialogShell } from './ApprovalListSection'

/*
 * 能力撤销面板（三个页签共用，随页常驻）：四类（技能/MCP/执行配置/授权）统一表单
 * {revision,reason}，从条目行发起。条目列表经 gateway 跨模块只读读取
 * （agentExtensions.listSkills/listMcpServers 与 agentCapabilities.listExecutionProfiles/
 * listGrants）；写操作只走本域 agentApprovals 的四个 revoke 端点，无 requestId。
 * 「已撤销」标注来自本会话撤销事实＋MCP 配置自身的 revoked 位——服务端列表端点
 * 不回传撤销记录；「审批引用中」按当前审批列表引用的能力标识标注。
 */

type RevokeEntry = {
  kind: AgentRevocationKind
  id: string
  revision: number
  name: string
  /** MCP 配置自身携带的 revoked 位（区别于 harness 的撤销记录）。 */
  serverRevoked: boolean
}

type CategoryState = {
  status: 'loading' | 'ready' | 'error'
  entries: readonly RevokeEntry[]
  error?: string
}

const KIND_LABELS: Record<AgentRevocationKind, string> = {
  skill: '技能',
  mcp: 'MCP 服务',
  'execution-profile': '执行配置',
  grant: '授权',
}

const EMPTY_CATEGORY: CategoryState = { status: 'loading', entries: [] }

export function CapabilityRevokePanel() {
  const gateway = useGateway()
  const revocations = useAgentApprovalsStore((state) => state.revocations)
  const approvals = useAgentApprovalsStore((state) => state.approvals)
  const [categories, setCategories] = useState<Record<AgentRevocationKind, CategoryState>>({
    skill: EMPTY_CATEGORY, mcp: EMPTY_CATEGORY, 'execution-profile': EMPTY_CATEGORY, grant: EMPTY_CATEGORY,
  })
  const [target, setTarget] = useState<RevokeEntry | undefined>(undefined)
  const referencedIds = useMemo(() => collectApprovalReferencedIds(approvals), [approvals])

  const loadCategory = useCallback(async (kind: AgentRevocationKind) => {
    setCategories((state) => ({ ...state, [kind]: { ...state[kind], status: 'loading', error: undefined } }))
    try {
      const entries =
        kind === 'skill'
          ? (await gateway.agentExtensions.listSkills()).map((skill) => ({
            kind, id: skill.id, revision: skill.revision, name: skill.manifest.name, serverRevoked: false,
          }))
          : kind === 'mcp'
            ? (await gateway.agentExtensions.listMcpServers()).map((server) => ({
              kind, id: server.id, revision: server.revision, name: server.name, serverRevoked: server.revoked,
            }))
            : kind === 'execution-profile'
              ? (await gateway.agentCapabilities.listExecutionProfiles()).map((profile) => ({
                kind, id: profile.id, revision: profile.revision, name: profile.name, serverRevoked: false,
              }))
              : (await gateway.agentCapabilities.listGrants()).map((grant) => ({
                kind, id: grant.id, revision: grant.revision, name: grant.name, serverRevoked: false,
              }))
      setCategories((state) => ({ ...state, [kind]: { status: 'ready', entries } }))
    } catch (error) {
      setCategories((state) => ({
        ...state,
        [kind]: { status: 'error', entries: [], error: error instanceof Error && error.message !== '' ? error.message : '读取失败' },
      }))
    }
  }, [gateway])

  useEffect(() => {
    void loadCategory('skill')
    void loadCategory('mcp')
    void loadCategory('execution-profile')
    void loadCategory('grant')
  }, [loadCategory])

  const allEntries = useMemo(
    () => (['skill', 'mcp', 'execution-profile', 'grant'] as const).flatMap((kind) => categories[kind].entries),
    [categories],
  )
  const revokedKeys = useMemo(
    () => new Set(revocations.map((fact) => `${fact.kind}:${fact.id}:${fact.revision}`)),
    [revocations],
  )
  const loading = (Object.values(categories) as CategoryState[]).some((category) => category.status === 'loading')
  const failed = (Object.values(categories) as CategoryState[]).filter((category) => category.status === 'error')

  return (
    <section aria-label="能力撤销" className="panel-surface flex flex-col gap-3 p-4">
      <header className="flex items-start gap-2">
        <ShieldCheck aria-hidden size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
        <div>
          <h2 className="text-sm font-semibold">能力撤销</h2>
          <p className="mt-1 text-xs text-fg-muted">
            四类能力（技能 / MCP 服务 / 执行配置 / 授权）统一按 {`{revision, reason}`} 撤销：
            撤销立即生效，旧快照与旧审批不能再继续执行，恢复须新建修订。
            「已撤销」按本会话撤销事实标注，「审批引用中」按当前审批列表引用的能力标注。
          </p>
        </div>
      </header>

      {failed.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-2 text-xs text-fg-muted">
          <p>{failed.length} 个目录暂时读取失败：{failed.map((category) => category.error).join('；')}</p>
          <div className="flex gap-2">
            {(['skill', 'mcp', 'execution-profile', 'grant'] as const)
              .filter((kind) => categories[kind].status === 'error')
              .map((kind) => (
                <button key={kind} type="button" className={CTL_SECONDARY} onClick={() => void loadCategory(kind)}>
                  重试{KIND_LABELS[kind]}目录
                </button>
              ))}
          </div>
        </div>
      ) : null}

      {loading && allEntries.length === 0 ? (
        <LoadingState label="正在读取可撤销的能力目录…" />
      ) : allEntries.length === 0 && failed.length === 4 ? (
        <p className="text-xs text-fg-subtle">暂无可撤销条目。</p>
      ) : (
        <div role="region" aria-label="可撤销能力列表" className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[13%]" />
              <col className="w-[24%]" />
              <col className="w-[33%]" />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
            </colgroup>
            <thead>
              <tr>
                {['类别', '名称', '标识 / 修订', '标注', '操作'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allEntries.map((entry) => {
                const revoked = revokedKeys.has(`${entry.kind}:${entry.id}:${entry.revision}`)
                const referenced = referencedIds.has(entry.id)
                return (
                  <tr key={`${entry.kind}:${entry.id}`} className="transition-colors hover:bg-surface-raised">
                    <td className="border-b border-line px-3 py-2 text-xs text-fg-muted">{KIND_LABELS[entry.kind]}</td>
                    <td className="border-b border-line px-3 py-2 text-xs font-medium text-fg">{entry.name}</td>
                    <td className="border-b border-line px-3 py-2 font-mono text-xs break-all text-fg-muted">
                      {entry.id} @ {entry.revision}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs">
                      {revoked ? <span className="mr-2 rounded bg-danger/10 px-1.5 py-0.5 text-danger">已撤销</span> : null}
                      {entry.serverRevoked ? <span className="mr-2 rounded bg-danger/10 px-1.5 py-0.5 text-danger">已撤销（配置）</span> : null}
                      {referenced ? <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning" title="当前审批列表中仍有条目引用该能力">审批引用中</span> : null}
                      {!revoked && !entry.serverRevoked && !referenced ? <span className="text-fg-subtle">—</span> : null}
                    </td>
                    <td className="border-b border-line px-3 py-2">
                      <button type="button" className={CTL_SECONDARY} disabled={revoked || entry.serverRevoked} onClick={() => setTarget(entry)}>
                        {revoked || entry.serverRevoked ? '已撤销' : '撤销…'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {target !== undefined ? (
        <RevokeDialog entry={target} onClose={() => setTarget(undefined)} />
      ) : null}
    </section>
  )
}

/** 统一撤销表单：{revision, reason}，无 requestId；reason 空值在前端拦截。 */
function RevokeDialog({ entry, onClose }: { entry: RevokeEntry; onClose(): void }) {
  const gateway = useGateway()
  const revoke = useAgentApprovalsStore((state) => state.revokeCapability)
  const revoking = useAgentApprovalsStore((state) => state.revokingKeys.includes(`${entry.kind}:${entry.id}`))
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [revisionText, setRevisionText] = useState(String(entry.revision))
  const [reason, setReason] = useState('')
  const [validation, setValidation] = useState<string | undefined>(undefined)
  const reasonId = useMemo(() => `revoke-reason-${entry.kind}-${entry.id}`, [entry])

  const submit = () => {
    const revision = Number(revisionText)
    if (!Number.isSafeInteger(revision) || revision < 0 || String(revision) !== revisionText.trim()) {
      setValidation('修订必须是非负整数')
      return
    }
    const bytes = byteLength(reason)
    if (bytes < 1 || bytes > 2048) {
      setValidation('撤销原因必须为 1 到 2048 字节')
      return
    }
    setValidation(undefined)
    void inFlightOnly(async () => {
      try {
        const result = await revoke(gateway, entry.kind, entry.id, revision, reason)
        if (result === undefined) return
        notify({ tone: 'success', message: `已撤销${KIND_LABELS[entry.kind]}「${entry.name}」；引用它的旧审批与环境不能再继续执行` })
        onClose()
      } catch (error) {
        notify({ tone: 'danger', message: error instanceof Error && error.message !== '' ? error.message : '撤销失败' })
      }
    })
  }

  return (
    <DialogShell title={`撤销${KIND_LABELS[entry.kind]} · ${entry.name}`} onClose={onClose}>
      <p className="text-xs text-fg-muted">
        撤销按修订生效并立即持久化；已被引用的环境在派发前会被阻断。此动作不可恢复，
        需要再用时须新建修订。
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${reasonId}-revision`} className="text-xs font-medium text-fg-muted">目标修订（非负整数）</label>
        <input
          id={`${reasonId}-revision`}
          value={revisionText}
          onChange={(event) => setRevisionText(event.target.value)}
          inputMode="numeric"
          className={`${CTL_FIELD} tabular-nums`}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={reasonId} className="text-xs font-medium text-fg-muted">
          撤销原因（必填，{byteLength(reason)}/2048 字节）
        </label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          className={`${CTL_FIELD} text-xs`}
          placeholder="例：内容过期且不再可信，撤销后禁止继续执行。"
        />
        {validation !== undefined ? (
          <p role="alert" className="text-xs text-danger">{validation}</p>
        ) : null}
      </div>
      <div className="mt-auto flex justify-end gap-2 pt-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
        <button type="button" className={CTL_PRIMARY} disabled={submitting || revoking} onClick={submit}>
          确认撤销
        </button>
      </div>
    </DialogShell>
  )
}
