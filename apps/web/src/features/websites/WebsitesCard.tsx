import type { JSX } from 'react'
import { Link } from 'react-router'
import type { WebsiteProject, WebsiteProjectKind } from '@elysian/contracts'
import {
  WEBSITE_CATEGORY_LABELS,
  WEBSITE_RUN_STATE_LABELS,
} from '@elysian/contracts'
import { Pencil, Play, Square, Trash2 } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'

/*
 * 网站项目卡片：瀑布列表里的单卡，高度随内容伸缩。
 * 纯展示组件，数据与回调全部由 props 注入，列布局由面板负责。
 * 卡片整体点击打开详情；内部的链接与按钮都要阻断冒泡，避免误触发。
 */

const RUN_TONE: Record<WebsiteProject['runState'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
}

/** 运行时短名：写入「运行时版本」格，不再单独用类型标签。 */
const RUNTIME_SHORT: Record<WebsiteProjectKind, string> = {
  java: 'Java',
  node: 'Node',
  go: 'Go',
  python: 'Python',
  html: 'HTML',
}

const ACTION_BUTTON =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50'

/** 元信息格：标签在上、值在下，密度与容器卡片的指标格一致。 */
function MetaCell({ label, value, numeric = false }: { label: string; value: string; numeric?: boolean }) {
  return (
    <p className="rounded-lg bg-surface-raised px-3 py-2">
      <span className="block text-xs text-fg-subtle">{label}</span>
      <span className={`mt-0.5 block truncate text-xs font-medium text-fg ${numeric ? 'tabular-nums' : ''}`}>
        {value}
      </span>
    </p>
  )
}

/** 运行时版本格文案：有版本时「Java 17」，HTML 等无版本时只写短名。 */
function runtimeVersionLabel(project: WebsiteProject): string {
  if (project.deploymentTarget === 'static') return 'Nginx'
  const short = RUNTIME_SHORT[project.kind]
  return project.runtimeVersion ? `${short} ${project.runtimeVersion}` : short
}

export function WebsitesCard({
  project,
  busy,
  onOpenDetail,
  onToggleRunning,
  onOpenSettings,
  onOpenRemove,
  onRedeploy,
  onRollback,
}: {
  project: WebsiteProject
  busy: boolean
  onOpenDetail: () => void
  onToggleRunning: () => void
  onOpenSettings: () => void
  onOpenRemove: () => void
  onRedeploy?: () => void
  onRollback?: () => void
}): JSX.Element {
  const running = project.runState === 'running'

  return (
    <article
      aria-label={project.name}
      onClick={onOpenDetail}
      className="flex cursor-pointer flex-col gap-2 rounded-xl border border-line bg-surface p-4"
    >
      {/* 不用 header 元素：测试工具链将其一律算作 banner 角色，会与顶栏 banner 冲突。 */}
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={project.name}>
          {project.name}
        </h3>
        <StatusTag label={WEBSITE_RUN_STATE_LABELS[project.runState]} tone={RUN_TONE[project.runState]} />
      </div>

      {/* 元信息：端口、环境、运行时（含类型短名）；PID 仅运行中且有进程号。 */}
      <div className="grid grid-cols-2 gap-2">
        <MetaCell label="端口" value={String(project.port)} numeric />
        <MetaCell label="环境" value={WEBSITE_CATEGORY_LABELS[project.category]} />
        {running && project.pid !== null ? <MetaCell label="PID" value={String(project.pid)} numeric /> : null}
        <MetaCell label="运行时版本" value={runtimeVersionLabel(project)} />
        {project.buildRuntimeVersion && <MetaCell label="构建版本" value={`${RUNTIME_SHORT[project.kind]} ${project.buildRuntimeVersion}`} />}
      </div>

      <p className="rounded-lg bg-surface-raised px-3 py-2">
        <span className="block text-xs text-fg-subtle">根目录</span>
        <Link
          to={`/files${project.rootDir}`}
          title={project.rootDir}
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 block truncate text-xs font-medium text-fg transition-colors hover:text-accent"
        >
          {project.rootDir}
        </Link>
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ACTION_BUTTON}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onOpenDetail()
          }}
        >
          详情
        </button>
        {onRedeploy && <button type="button" className={ACTION_BUTTON} disabled={busy} onClick={(event) => { event.stopPropagation(); onRedeploy() }}>重新部署</button>}
        {onRollback && <button type="button" className={ACTION_BUTTON} disabled={busy} onClick={(event) => { event.stopPropagation(); onRollback() }}>回滚</button>}
        <div className="ml-auto flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          <IconButton
            label={running ? '停止' : '启动'}
            onPress={onToggleRunning}
            disabled={busy}
          >
            {running ? <Square aria-hidden size={14} /> : <Play aria-hidden size={14} />}
          </IconButton>
          <IconButton label="设置" onPress={onOpenSettings} disabled={busy}>
            <Pencil aria-hidden size={14} />
          </IconButton>
          <IconButton label="删除" tone="danger-hover" onPress={onOpenRemove} disabled={busy}>
            <Trash2 aria-hidden size={14} />
          </IconButton>
        </div>
      </div>
    </article>
  )
}
