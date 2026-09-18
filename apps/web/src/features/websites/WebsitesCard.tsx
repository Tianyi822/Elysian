import type { JSX } from 'react'
import { Link } from 'react-router'
import type { WebsiteProject } from '@elysian/contracts'
import {
  WEBSITE_CATEGORY_LABELS,
  WEBSITE_PROJECT_KIND_LABELS,
  WEBSITE_RUN_STATE_LABELS,
} from '@elysian/contracts'
import { Pencil, Play, Square, Trash2 } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'

/*
 * 网站项目卡片：与容器区同款的网格单卡。
 * 纯展示组件，数据与回调全部由 props 注入，网格布局由面板负责。
 * 卡片整体点击打开详情；内部的链接与按钮都要阻断冒泡，避免误触发。
 */

const RUN_TONE: Record<WebsiteProject['runState'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
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

export function WebsitesCard({
  project,
  busy,
  onOpenDetail,
  onToggleRunning,
  onOpenSettings,
  onOpenRemove,
}: {
  project: WebsiteProject
  busy: boolean
  onOpenDetail: () => void
  onToggleRunning: () => void
  onOpenSettings: () => void
  onOpenRemove: () => void
}): JSX.Element {
  const running = project.runState === 'running'

  return (
    <article
      aria-label={project.name}
      onClick={onOpenDetail}
      className="flex h-full cursor-pointer flex-col gap-2 rounded-xl border border-line bg-surface p-4"
    >
      {/* 不用 header 元素：测试工具链将其一律算作 banner 角色，会与顶栏 banner 冲突。 */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={project.name}>
            {project.name}
          </h3>
          <StatusTag label={WEBSITE_RUN_STATE_LABELS[project.runState]} tone={RUN_TONE[project.runState]} />
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <StatusTag label={WEBSITE_PROJECT_KIND_LABELS[project.kind]} />
          <StatusTag label={WEBSITE_CATEGORY_LABELS[project.category]} />
        </div>
      </div>

      {/* 元信息：端口全类型必有；运行时版本仅语言类；PID 仅运行中且有进程号。 */}
      <div className="grid grid-cols-2 gap-2">
        <MetaCell label="端口" value={String(project.port)} numeric />
        {running && project.pid !== null ? <MetaCell label="PID" value={String(project.pid)} numeric /> : null}
        {project.runtimeVersion !== null ? (
          <MetaCell label="运行时版本" value={project.runtimeVersion} />
        ) : null}
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

      <div className="mt-auto flex items-center gap-2">
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
