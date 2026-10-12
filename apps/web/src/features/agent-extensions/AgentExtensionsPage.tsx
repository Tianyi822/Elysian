import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_CHIP } from '../../components/formControl'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'

/**
 * Ely 技能与 MCP 页。深链契约（模块间导航只许查询参数，不新增路由）：
 *   /agent/extensions?tab=skills|mcp（默认 skills）
 *   &importId=<导入任务 ID>（技能页签高亮该任务行）
 *   &serverId=<MCP 服务 ID>&revision=<正整数>（MCP 页签按固定修订打开详情）
 * 两页签共用本页的运行时门：内核不可用（/runtime available:false）时整页展示
 * 服务端中文 reason，六态中的其余各态由各分区内自行呈现。
 */

const TAB_VALUES = ['skills', 'mcp'] as const
export type ExtensionsTab = (typeof TAB_VALUES)[number]

function tabOf(raw: string | null): ExtensionsTab {
  return raw === 'mcp' ? 'mcp' : 'skills'
}

export function AgentExtensionsPage() {
  const gateway = useGateway()
  const status = useAgentRuntimeStore((state) => state.status)
  const info = useAgentRuntimeStore((state) => state.info)
  const errorMessage = useAgentRuntimeStore((state) => state.errorMessage)
  const load = useAgentRuntimeStore((state) => state.load)
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  const tab = tabOf(searchParams.get('tab'))
  const switchTab = (next: ExtensionsTab) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    // 换页签清掉只属于另一页签的深链参数，避免残留串台。
    if (next === 'skills') {
      params.delete('serverId')
      params.delete('revision')
    } else {
      params.delete('importId')
    }
    setSearchParams(params, { replace: true })
  }

  if (status === 'loading' || status === 'idle') return <LoadingState />
  if (status === 'error') {
    return <ErrorState description={errorMessage} onRetry={() => void load(gateway)} />
  }
  if (info !== undefined && !info.available) {
    return <AgentUnavailableState reason={info.reason} worker={info.worker} storage={info.storage} />
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="扩展页签" className="flex flex-wrap items-center gap-2">
        {TAB_VALUES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => switchTab(value)}
            className={`${CTL_CHIP} ${tab === value ? 'border-control-line-strong bg-surface-raised text-fg' : 'text-fg-muted'}`}
          >
            {value === 'skills' ? '技能' : 'MCP 服务'}
          </button>
        ))}
      </div>
      {tab === 'skills'
        ? <SkillsSection importIdParam={searchParams.get('importId')} />
        : <McpSection serverIdParam={searchParams.get('serverId')} revisionParam={searchParams.get('revision')} />}
    </div>
  )
}
