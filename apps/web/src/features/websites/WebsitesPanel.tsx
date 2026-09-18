import type { WebsiteCategory } from '@elysian/contracts'
import { WEBSITE_CATEGORIES, WEBSITE_CATEGORY_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { RefreshCw, Search } from '../../components/icons'
import { EmptyState } from '../../components/states/StateViews'
import { useWebsitesStore } from '../../stores/websitesStore'
import { SelectDropdown } from './SelectDropdown'
import { WebsiteDetailSheet } from './WebsiteDetailSheet'
import { WebsitesCard } from './WebsitesCard'
import { WebsitesCreateDialog } from './WebsitesCreateDialog'
import { WebsitesRemoveDialog } from './WebsitesRemoveDialog'
import { WebsitesSettingsDialog } from './WebsitesSettingsDialog'
import { filterWebsiteProjects } from './websitesListing'

/**
 * 网站项目面板：工具栏（添加项目 + 分类/搜索/刷新）、Docker 区同款卡片网格、
 * 详情抽屉。五种运行时类型共用一张列表，类型在创建时选择、
 * 在卡片与详情抽屉上以标签呈现。
 *
 * 瀑布列布局：卡片高度随内容伸缩，不强制对齐。
 */

const TOOL_BUTTON_CLASS =
  'inline-flex items-center rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

export function WebsitesPanel() {
  const gateway = useGateway()
  const projects = useWebsitesStore((s) => s.projects)
  const search = useWebsitesStore((s) => s.search)
  const category = useWebsitesStore((s) => s.category)
  const refreshing = useWebsitesStore((s) => s.refreshing)
  const createDialogOpen = useWebsitesStore((s) => s.createDialogOpen)
  // 渲染期要用的状态必须走订阅选择器：getState() 读到的是不触发重渲染的瞬时值，
  // busy 与 settingsTarget 若不订阅，卡片的禁用与弹窗的预填都会静默失效。
  const busyIds = useWebsitesStore((s) => s.busyProjectIds)
  const settingsTarget = useWebsitesStore((s) => s.settingsTarget)
  const setSearch = useWebsitesStore((s) => s.setSearch)
  const setCategory = useWebsitesStore((s) => s.setCategory)
  const openCreate = useWebsitesStore((s) => s.openCreate)
  const refresh = useWebsitesStore((s) => s.refresh)

  const filtered = filterWebsiteProjects(projects, { category, search })

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <button type="button" onClick={openCreate} className={TOOL_BUTTON_CLASS}>
          添加项目
        </button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SelectDropdown
            ariaLabel="项目分类"
            items={[
              { value: 'all', label: '全部分类' },
              ...WEBSITE_CATEGORIES.map((value: WebsiteCategory) => ({
                value,
                label: WEBSITE_CATEGORY_LABELS[value],
              })),
            ]}
            value={category}
            onSelect={setCategory}
          />
          <div className="relative w-56">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            />
            <label htmlFor="website-search" className="sr-only">
              搜索项目名称或备注
            </label>
            <input
              id="website-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="请输入项目名称或备注"
              className="w-full rounded-lg border border-line bg-surface-raised py-1.5 pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
          </div>
          <IconButton label="刷新" onPress={() => void refresh(gateway)}>
            <RefreshCw aria-hidden size={13} className={refreshing ? 'animate-spin' : undefined} />
          </IconButton>
        </div>
      </div>

      {filtered.length === 0 ? (
        projects.length === 0 ? (
          <EmptyState
            title="您的列表为空"
            description="添加一个项目，从这里统一查看各运行时的网站与部署信息。"
            action={
              <button type="button" onClick={openCreate} className={TOOL_BUTTON_CLASS}>
                添加一个项目
              </button>
            }
          />
        ) : (
          <EmptyState title="没有匹配的项目" description="换个关键词，或清空搜索与分类筛选。" />
        )
      ) : (
        <ul
          aria-label="网站项目列表"
          className="columns-1 gap-4 md:columns-2 xl:columns-3"
        >
          {filtered.map((project) => (
            <li key={project.id} className="mb-4 break-inside-avoid">
              <WebsitesCard
                project={project}
                busy={busyIds.includes(project.id)}
                onOpenDetail={() => useWebsitesStore.getState().openDetail(gateway, project)}
                onToggleRunning={() =>
                  void useWebsitesStore
                    .getState()
                    .setRunning(gateway, project, project.runState !== 'running')
                }
                onOpenSettings={() => useWebsitesStore.getState().openSettings(project)}
                onOpenRemove={() => useWebsitesStore.getState().openRemove(project)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span className="ml-auto tabular-nums">共 {projects.length} 个项目</span>
      </div>

      {createDialogOpen ? <WebsitesCreateDialog /> : null}
      {/* 设置弹窗的表单初始值取自 settingsTarget，必须条件挂载：
          常驻挂载时 useState 惰性初始化只跑一次（目标是 undefined），预填会永久失效。 */}
      {settingsTarget ? <WebsitesSettingsDialog key={settingsTarget.id} /> : null}
      <WebsitesRemoveDialog />
      <WebsiteDetailSheet />
    </div>
  )
}
