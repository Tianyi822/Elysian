import type { AgentEnvironment, AgentMemorySpaceSelection } from '@elysian/contracts'
import { Link } from 'react-router'
import { CTL_CHIP } from '../../components/formControl'
import type { ElysianGateway } from '../../contracts/adapters'
import type { ReferenceCatalogState } from './useReferenceCatalog'

/*
 * 会话能力环境的勾选编辑器（新建会话与编辑会话共用）与长期记忆空间选择器。
 * 目录数据经只读 gateway 方法（agentCapabilities/agentExtensions/agentMemory），
 * 勾选后由调用方本地拼 AgentEnvironment 提交。提示（prompts）不属于环境字段，
 * 在任务输入的「引用资料」区选择（AgentInput.prompts）。
 */

export type EnvironmentDraft = {
  skills: readonly string[]
  servers: readonly string[]
  tools: readonly string[]
  resources: readonly string[]
  trustedReadOnly: readonly string[]
  executionProfiles: readonly string[]
  grants: readonly string[]
  resourceRules: readonly string[]
}

export const EMPTY_ENVIRONMENT_DRAFT: EnvironmentDraft = {
  skills: [], servers: [], tools: [], resources: [], trustedReadOnly: [], executionProfiles: [], grants: [], resourceRules: [],
}

function toggle(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function CheckRow({
  checked,
  disabled,
  label,
  hint,
  onToggle,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  hint?: string
  onToggle(): void
}) {
  return (
    <label className={`flex items-start gap-2 rounded px-1 py-1 text-xs ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-raised'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle()}
        className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block break-all text-fg">{label}</span>
        {hint ? <span className="block text-fg-subtle">{hint}</span> : null}
      </span>
    </label>
  )
}

function Section({ title, children, note }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-line p-2">
      <legend className="px-1 text-xs font-medium text-fg-muted">{title}</legend>
      {note ? <p className="mb-1 text-[11px] leading-relaxed text-fg-subtle">{note}</p> : null}
      <div className="max-h-44 overflow-y-auto hover-scrollbar pr-1">{children}</div>
    </fieldset>
  )
}

export function EnvironmentFields({
  catalog,
  gateway,
  draft,
  onDraft,
  disabled,
  executionProfiles,
  grants,
  resourceRules,
}: {
  catalog: ReferenceCatalogState
  gateway: ElysianGateway
  draft: EnvironmentDraft
  onDraft(next: EnvironmentDraft): void
  disabled?: boolean
  executionProfiles: readonly { id: string; revision: number; name: string }[]
  grants: readonly { id: string; revision: number; name: string }[]
  resourceRules: readonly { id: string; revision: number; name: string }[]
}) {
  const serverOptions = catalog.servers
  const selectedServerKeys = new Set(draft.servers)
  const toolOptions = serverOptions
    .filter((server) => selectedServerKeys.has(`${server.id}:${server.revision}`) && server.catalogStatus === 'ready' && server.catalog !== undefined)
    .flatMap((server) => server.catalog!.tools.map((tool) => ({
      key: `${server.id}:${tool.name}`,
      label: `${server.label} · ${tool.title ?? tool.name}`,
      alias: server.catalog!.modelAliases[tool.name] ?? tool.name,
    })))
  const resourceOptions = serverOptions
    .filter((server) => selectedServerKeys.has(`${server.id}:${server.revision}`) && server.catalogStatus === 'ready' && server.catalog !== undefined)
    .flatMap((server) => server.catalog!.resources.map((resource) => ({
      key: `${server.id}:${resource.uri}`,
      label: `${server.label} · ${resource.name}`,
      uri: resource.uri,
    })))

  return (
    <div className="flex flex-col gap-2">
      <Section title="技能" note="勾选后随环境固定修订；技能正文只是资料，不授予执行权限。">
        {catalog.status === 'loading' ? <p className="text-xs text-fg-subtle">正在读取技能目录…</p> : null}
        {catalog.status === 'error' ? <p role="alert" className="text-xs text-danger">{catalog.error}</p> : null}
        {catalog.status === 'ready' && catalog.skills.length === 0 ? <p className="text-xs text-fg-subtle">没有已导入的技能。</p> : null}
        {catalog.skills.map((skill) => (
          <CheckRow
            key={`${skill.id}:${skill.revision}`}
            checked={draft.skills.includes(`${skill.id}:${skill.revision}`)}
            disabled={disabled}
            label={skill.label}
            hint={skill.description}
            onToggle={() => onDraft({ ...draft, skills: toggle(draft.skills, `${skill.id}:${skill.revision}`) })}
          />
        ))}
      </Section>

      <Section title="MCP 服务器" note="勾选即把该服务器固定修订选入环境；目录在勾选后按需读取。">
        {serverOptions.map((server) => (
          <CheckRow
            key={`${server.id}:${server.revision}`}
            checked={draft.servers.includes(`${server.id}:${server.revision}`)}
            disabled={disabled}
            label={server.label}
            hint={server.transport === 'stdio' ? '容器 stdio 传输' : 'Streamable HTTP 传输'}
            onToggle={() => {
              const key = `${server.id}:${server.revision}`
              const servers = toggle(draft.servers, key)
              onDraft({ ...draft, servers })
              if (servers.includes(key)) void catalog.ensureCatalog(gateway, server.id)
            }}
          />
        ))}
      </Section>

      {draft.servers.length > 0 ? (
        <>
          <Section title="MCP 工具" note="只把明确勾选的工具名固定进环境；未勾选的工具对会话不可见。">
            {toolOptions.length === 0
              ? <p className="text-xs text-fg-subtle">勾选服务器后读取目录；没有可用工具或目录暂不可用。</p>
              : toolOptions.map((tool) => (
                <CheckRow
                  key={tool.key}
                  checked={draft.tools.includes(tool.alias)}
                  disabled={disabled}
                  label={tool.label}
                  hint={`模型名称：${tool.alias}`}
                  onToggle={() => onDraft({ ...draft, tools: toggle(draft.tools, tool.alias) })}
                />
              ))}
          </Section>

          <Section title="MCP 资源">
            {resourceOptions.length === 0
              ? <p className="text-xs text-fg-subtle">该服务器目录没有资源。</p>
              : resourceOptions.map((resource) => (
                <CheckRow
                  key={resource.key}
                  checked={draft.resources.includes(resource.key)}
                  disabled={disabled}
                  label={resource.label}
                  hint={resource.uri}
                  onToggle={() => onDraft({ ...draft, resources: toggle(draft.resources, resource.key) })}
                />
              ))}
          </Section>

          <Section title="只读信任（trustedReadOnly）" note="显式本地授权：被勾选的工具跳过逐调用审批；远端 annotations 不自动授予只读权限。">
            {toolOptions.length === 0
              ? <p className="text-xs text-fg-subtle">没有可授权的工具。</p>
              : toolOptions.map((tool) => (
                <CheckRow
                  key={tool.key}
                  checked={draft.trustedReadOnly.includes(tool.alias)}
                  disabled={disabled}
                  label={tool.label}
                  hint={`授权模型名称：${tool.alias}`}
                  onToggle={() => onDraft({ ...draft, trustedReadOnly: toggle(draft.trustedReadOnly, tool.alias) })}
                />
              ))}
          </Section>
        </>
      ) : null}

      <Section title="执行配置">
        {executionProfiles.length === 0 ? <p className="text-xs text-fg-subtle">没有可用的执行配置。</p> : null}
        {executionProfiles.map((profile) => (
          <CheckRow
            key={`${profile.id}:${profile.revision}`}
            checked={draft.executionProfiles.includes(`${profile.id}:${profile.revision}`)}
            disabled={disabled}
            label={`${profile.name}（修订 ${profile.revision}）`}
            onToggle={() => onDraft({ ...draft, executionProfiles: toggle(draft.executionProfiles, `${profile.id}:${profile.revision}`) })}
          />
        ))}
      </Section>

      <Section title="目录与网络授权" note="授权只按固定修订生效；授予即允许容器执行器挂载对应目录或出网端点。">
        {grants.length === 0 ? <p className="text-xs text-fg-subtle">没有配置授权。</p> : null}
        {grants.map((grant) => (
          <CheckRow
            key={`${grant.id}:${grant.revision}`}
            checked={draft.grants.includes(`${grant.id}:${grant.revision}`)}
            disabled={disabled}
            label={`${grant.name}（修订 ${grant.revision}）`}
            onToggle={() => onDraft({ ...draft, grants: toggle(draft.grants, `${grant.id}:${grant.revision}`) })}
          />
        ))}
      </Section>

      <Section title="资源规则">
        {resourceRules.length === 0 ? <p className="text-xs text-fg-subtle">没有配置资源规则。</p> : null}
        {resourceRules.map((rule) => (
          <CheckRow
            key={`${rule.id}:${rule.revision}`}
            checked={draft.resourceRules.includes(`${rule.id}:${rule.revision}`)}
            disabled={disabled}
            label={`${rule.name}（修订 ${rule.revision}）`}
            onToggle={() => onDraft({ ...draft, resourceRules: toggle(draft.resourceRules, `${rule.id}:${rule.revision}`) })}
          />
        ))}
      </Section>

      <p className="text-[11px] leading-relaxed text-fg-subtle">
        提示（prompts）不属于环境：在任务输入的「引用资料」里按轮选取。模型在设置页维护；执行配置在
        <Link to="/agent/capabilities" className="mx-0.5 underline underline-offset-2 hover:text-fg">执行配置</Link>
        页维护。
      </p>
    </div>
  )
}

/** 由勾选草稿拼出提交用 AgentEnvironment（sessionId/revision 由调用方补齐）。 */
export function draftToEnvironment(draft: EnvironmentDraft, sessionId: string, revision: number): AgentEnvironment {
  const ref = (value: string): { id: string; revision: number } => {
    const separator = value.lastIndexOf(':')
    return { id: value.slice(0, separator), revision: Number(value.slice(separator + 1)) }
  }
  return {
    sessionId,
    revision,
    skills: draft.skills.map(ref),
    servers: draft.servers.map(ref),
    tools: [...draft.tools],
    resources: draft.resources.map((key) => {
      const separator = key.indexOf(':')
      return { serverId: key.slice(0, separator), uri: key.slice(separator + 1) }
    }),
    executionProfiles: draft.executionProfiles.map(ref),
    grants: draft.grants.map(ref),
    trustedReadOnly: [...draft.trustedReadOnly],
    ...(draft.resourceRules.length === 0 ? {} : { resourceRules: draft.resourceRules.map(ref) }),
  }
}

/** 长期记忆空间选择：{spaceId, includeGlobal}；当前值须先经 GET /sessions/{id}/memory 回显。 */
export function MemorySpacePicker({
  spaces,
  value,
  onChange,
  disabled,
  error,
}: {
  spaces: readonly { id: string; name: string; kind: string }[]
  value: AgentMemorySpaceSelection
  onChange(next: AgentMemorySpaceSelection): void
  disabled?: boolean
  error?: string
}) {
  return (
    <fieldset className="rounded-lg border border-line p-2" disabled={disabled}>
      <legend className="px-1 text-xs font-medium text-fg-muted">长期记忆空间</legend>
      <p className="mb-1 text-[11px] leading-relaxed text-fg-subtle">
        会话引用的业务空间与是否并入全局空间；页面与任务过程记忆互不影响。空间在
        <Link to="/agent/memory" className="mx-0.5 underline underline-offset-2 hover:text-fg">长期记忆</Link>
        页管理。
      </p>
      {spaces.length === 0 ? <p className="text-xs text-fg-subtle">还没有记忆空间。</p> : null}
      {spaces.map((space) => (
        <label key={space.id} className={`flex items-center gap-2 rounded px-1 py-1 text-xs ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-raised'}`}>
          <input
            type="radio"
            name="workbench-memory-space"
            checked={value.spaceId === space.id}
            disabled={disabled}
            onChange={() => onChange({ ...value, spaceId: space.id })}
            className="size-3.5 accent-[var(--color-accent)]"
          />
          <span className="text-fg">{space.name}</span>
          <span className={`${CTL_CHIP} px-1.5 py-0 text-[10px]`}>{space.kind === 'global' ? '全局' : '业务'}</span>
        </label>
      ))}
      <label className={`mt-1 flex items-center gap-2 rounded px-1 py-1 text-xs ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-raised'}`}>
        <input
          type="radio"
          name="workbench-memory-space"
          checked={value.spaceId === ''}
          disabled={disabled}
          onChange={() => onChange({ ...value, spaceId: '' })}
          className="size-3.5 accent-[var(--color-accent)]"
        />
        <span className="text-fg">不引用业务空间</span>
      </label>
      <label className={`flex items-start gap-2 rounded px-1 py-1 text-xs ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-raised'}`}>
        <input
          type="checkbox"
          checked={value.includeGlobal}
          disabled={disabled}
          onChange={() => onChange({ ...value, includeGlobal: !value.includeGlobal })}
          className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
        />
        <span className="text-fg">同时引用全局空间</span>
      </label>
      {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : null}
    </fieldset>
  )
}
