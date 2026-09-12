import { RISK_LEVELS, RISK_LEVEL_LABELS } from '@elysian/contracts'
import type { Skill } from '@elysian/contracts'
import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { RiskTag } from '../../components/RiskTag'
import { StatusTag } from '../../components/StatusTag'
import { ToggleChip } from '../../components/ToggleChip'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useSkillCatalogStore } from '../../stores/skillCatalogStore'
import {
  SKILL_STATES,
  SKILL_STATE_LABELS,
  hasActiveSkillFilters,
  matchesSkillQuery,
  parseSkillQuery,
  toSkillSearchParams,
  toggleValue,
} from './query'

const COLUMNS = [
  { key: 'name', header: '技能', width: '22%' },
  { key: 'responsibility', header: '职责', width: '22%' },
  { key: 'version', header: '版本', width: '76px' },
  { key: 'capabilities', header: '提供的能力', width: '26%' },
  { key: 'risk', header: '风险等级', width: '92px' },
  { key: 'enabled', header: '启用状态', width: '88px' },
  { key: 'lastUsed', header: '最近使用', width: '120px' },
  { key: 'actions', header: '操作', width: '140px' },
]

function manifestOf(skill: Skill): string {
  return JSON.stringify(
    {
      id: skill.id,
      name: skill.name,
      responsibility: skill.responsibility,
      version: skill.version,
      capabilities: skill.capabilities,
      riskLevel: skill.riskLevel,
      enabled: skill.enabled,
    },
    null,
    2,
  )
}

export function SkillCatalogPage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()
  const [detail, setDetail] = useState<Skill | undefined>(undefined)

  const queryKey = searchParams.toString()
  const query = useMemo(() => parseSkillQuery(new URLSearchParams(queryKey)), [queryKey])

  const status = useSkillCatalogStore((state) => state.status)
  const skills = useSkillCatalogStore((state) => state.skills)
  const errorMessage = useSkillCatalogStore((state) => state.errorMessage)
  const actionError = useSkillCatalogStore((state) => state.actionError)
  const lastToggleNote = useSkillCatalogStore((state) => state.lastToggleNote)
  const busySkillId = useSkillCatalogStore((state) => state.busySkillId)
  const load = useSkillCatalogStore((state) => state.load)
  const setEnabled = useSkillCatalogStore((state) => state.setEnabled)

  useEffect(() => {
    void load(gateway.skills)
  }, [gateway, load])

  const visible = useMemo(
    () => skills.filter((skill) => matchesSkillQuery(skill, query)),
    [skills, query],
  )

  const apply = (next: Parameters<typeof toSkillSearchParams>[0]) => {
    setSearchParams(toSkillSearchParams(next))
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="技能目录" description="技能清单、manifest 声明与启停状态。" />
        <ErrorState
          title="技能目录加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway.skills)}
        />
      </>
    )
  }

  if (status !== 'ready' && skills.length === 0) {
    // 首次加载完成前不渲染空态：否则会先闪一下「没有技能」，而那是假的。
    return (
      <>
        <PageHeader title="技能目录" description="技能清单、manifest 声明与启停状态。" />
        <LoadingState label="正在加载技能目录…" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="技能目录"
        description="技能的职责、版本、提供的能力与风险等级。启用与停用只改本地演示状态，不会改变任何真实环境。"
        actions={
          <>
            <span className="text-xs text-fg-muted">
              共 {skills.length} 个技能，其中启用 {skills.filter((skill) => skill.enabled).length} 个
            </span>
            <button
              type="button"
              onClick={() => void load(gateway.skills)}
              className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
            >
              刷新
            </button>
          </>
        }
      />

      <div className="mb-3 space-y-1.5">
        <div role="group" aria-labelledby="skill-risk" className="flex flex-wrap items-center gap-1.5">
          <span id="skill-risk" className="mr-1 text-xs text-fg-subtle">
            风险等级
          </span>
          {RISK_LEVELS.map((risk) => (
            <ToggleChip
              key={risk}
              label={RISK_LEVEL_LABELS[risk]}
              checked={query.risks.includes(risk)}
              onChange={() => apply({ ...query, risks: toggleValue(query.risks, risk) })}
            />
          ))}
        </div>

        <div role="group" aria-labelledby="skill-state" className="flex flex-wrap items-center gap-1.5">
          <span id="skill-state" className="mr-1 text-xs text-fg-subtle">
            启用状态
          </span>
          {SKILL_STATES.map((state) => (
            <ToggleChip
              key={state}
              label={SKILL_STATE_LABELS[state]}
              checked={query.states.includes(state)}
              onChange={() => apply({ ...query, states: toggleValue(query.states, state) })}
            />
          ))}
          {hasActiveSkillFilters(query) ? (
            <button
              type="button"
              onClick={() => apply({ risks: [], states: [] })}
              className="ml-1 rounded border border-line px-2 py-0.5 text-xs text-fg-muted"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {query.capability ? (
        <p className="mb-2 text-xs text-fg-muted">
          只看提供能力 <code className="font-mono">{query.capability}</code> 的技能，
          共 {visible.length} 个。
        </p>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
        >
          技能启停失败：{actionError}
        </p>
      ) : null}

      {lastToggleNote ? (
        <p
          role="status"
          className="mb-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning"
        >
          {lastToggleNote}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          title="当前筛选条件下没有技能"
          description={
            hasActiveSkillFilters(query)
              ? '这不是目录为空，而是筛选条件排除了全部技能。清除筛选可以看回完整目录。'
              : '技能目录里还没有任何技能。'
          }
        />
      ) : (
        <DataTable label="技能清单" columns={COLUMNS}>
          {visible.map((skill) => (
            <DataRow key={skill.id}>
              <DataCell>
                <span className="block text-sm">{skill.name}</span>
                <code className="mt-0.5 block text-xs text-fg-subtle">{skill.id}</code>
              </DataCell>
              <DataCell muted>{skill.responsibility}</DataCell>
              <DataCell muted>
                <span className="text-xs tabular-nums">{skill.version}</span>
              </DataCell>
              <DataCell muted>
                <span className="flex flex-wrap gap-1">
                  {skill.capabilities.map((capability) => (
                    <code key={capability} className="rounded border border-line px-1 text-xs">
                      {capability}
                    </code>
                  ))}
                </span>
              </DataCell>
              <DataCell>
                <RiskTag level={skill.riskLevel} />
              </DataCell>
              <DataCell>
                <StatusTag
                  label={skill.enabled ? SKILL_STATE_LABELS.enabled : SKILL_STATE_LABELS.disabled}
                  tone={skill.enabled ? 'success' : 'neutral'}
                />
              </DataCell>
              <DataCell numeric muted>
                {skill.lastUsedAt ? formatDateTime(skill.lastUsedAt) : '—'}
              </DataCell>
              <DataCell>
                <span className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    disabled={busySkillId === skill.id}
                    onClick={() => void setEnabled(gateway.skills, skill.id, !skill.enabled)}
                    className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                  >
                    {skill.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetail(skill)}
                    className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg"
                  >
                    详情
                  </button>
                </span>
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      )}

      <Dialog.Root
        open={detail !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 w-[min(38rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded border border-line bg-surface p-3"
          >
            <div className="mb-2 flex items-start justify-between gap-3 border-b border-line pb-1.5">
              <Dialog.Title className="text-sm font-semibold">
                {detail ? `${detail.name} manifest` : '技能 manifest'}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="关闭详情"
                  className="inline-flex size-6 items-center justify-center rounded text-fg-muted"
                >
                  <X aria-hidden size={14} />
                </button>
              </Dialog.Close>
            </div>

            {detail ? (
              <>
                <dl className="mb-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-xs text-fg-subtle">标识</dt>
                  <dd className="font-mono text-xs">{detail.id}</dd>
                  <dt className="text-xs text-fg-subtle">职责</dt>
                  <dd>{detail.responsibility}</dd>
                  <dt className="text-xs text-fg-subtle">版本</dt>
                  <dd className="tabular-nums">{detail.version}</dd>
                  <dt className="text-xs text-fg-subtle">风险等级</dt>
                  <dd>
                    <RiskTag level={detail.riskLevel} />
                  </dd>
                  <dt className="text-xs text-fg-subtle">启用状态</dt>
                  <dd>
                    <StatusTag
                      label={
                        detail.enabled ? SKILL_STATE_LABELS.enabled : SKILL_STATE_LABELS.disabled
                      }
                      tone={detail.enabled ? 'success' : 'neutral'}
                    />
                  </dd>
                  <dt className="text-xs text-fg-subtle">最近使用</dt>
                  <dd className="tabular-nums">
                    {detail.lastUsedAt ? formatDateTime(detail.lastUsedAt) : '—'}
                  </dd>
                </dl>
                <pre className="max-h-72 overflow-auto rounded border border-line bg-bg p-2 text-xs">
                  {manifestOf(detail)}
                </pre>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
