import * as Checkbox from '@radix-ui/react-checkbox'
import type { JSX } from 'react'
import { Link } from 'react-router'
import type { WebsiteProject } from '@elysian/contracts'
import {
  WEBSITE_CATEGORY_LABELS,
  WEBSITE_PROJECT_KIND_LABELS,
  WEBSITE_RUN_STATE_LABELS,
} from '@elysian/contracts'
import { Check, Pencil, Play, Square, Trash2 } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { formatDate } from '../../components/format'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'

/*
 * 网站项目卡片：与容器区同款的网格单卡。
 * 纯展示组件，数据与回调全部由 props 注入，网格布局由面板负责。
 * 卡片整体点击打开详情；内部的选择框、链接与按钮都要阻断冒泡，避免误触发。
 */

const RUN_TONE: Record<WebsiteProject['runState'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
}

const ACTION_BUTTON =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50'

/** 选择框：与权限对话框的勾选格同款视觉，勾上用淡色底加描边表达「开」。 */
const CHECKBOX_CLASS =
  'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent/10 data-[state=unchecked]:border-line data-[state=unchecked]:bg-surface-raised data-[state=unchecked]:hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

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
  selected,
  busy,
  onToggleSelected,
  onOpenDetail,
  onToggleRunning,
  onOpenSettings,
  onOpenRemove,
}: {
  project: WebsiteProject
  selected: boolean
  busy: boolean
  onToggleSelected: () => void
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
      className={`flex h-full cursor-pointer flex-col gap-2 rounded-xl border border-line bg-surface p-4 ${
        selected ? 'border-accent/50 bg-accent/5' : ''
      }`}
    >
      {/* 不用 header 元素：测试工具链将其一律算作 banner 角色，会与顶栏 banner 冲突。 */}
      <div className="flex items-start gap-2">
        <Checkbox.Root
          checked={selected}
          onCheckedChange={() => onToggleSelected()}
          onClick={(event) => event.stopPropagation()}
          aria-label={`选择项目 ${project.name}`}
          className={CHECKBOX_CLASS}
        >
          <Checkbox.Indicator className="text-accent">
            <Check aria-hidden size={11} strokeWidth={2.5} />
          </Checkbox.Indicator>
        </Checkbox.Root>
        <div className="min-w-0 flex-1">
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
      </div>

      {/* 元信息按类型显隐：端口只有 Java 与 Node 有，PID 只在运行中存在，版本只有 Node 有。 */}
      <div className="grid grid-cols-2 gap-2">
        {project.port !== null ? <MetaCell label="端口" value={String(project.port)} numeric /> : null}
        {running && project.pid !== null ? <MetaCell label="PID" value={String(project.pid)} numeric /> : null}
        {project.kind === 'node' && project.runtimeVersion !== null ? (
          <MetaCell label="Node版本" value={project.runtimeVersion} />
        ) : null}
        <MetaCell label="到期时间" value={project.expiryAt ? formatDate(project.expiryAt) : '长期有效'} />
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
        {/* 主操作用文字表意，不靠图标；点详情已是目标动作，阻断冒泡避免双触发。 */}
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
        {/* 图标按钮组统一阻断冒泡：IconButton 不感知外层卡片的整体点击。 */}
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
