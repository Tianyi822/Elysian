import { deploymentTaskSummary } from './deploymentTaskSummary'
import { formatDateTime } from '../../components/format'
import { useWebsiteDeploymentsStore } from '../../stores/websiteDeploymentsStore'
import type { WebsiteCategory, WebsiteProject, WebsiteDeploymentTask } from '@elysian/contracts'
import { useState, useEffect } from 'react'
import { WEBSITE_CATEGORIES, WEBSITE_CATEGORY_LABELS, websiteDeploymentIsActive } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { RefreshCw, Search } from '../../components/icons'
import { EmptyState } from '../../components/states/StateViews'
import { RefreshButton } from '../../components/RefreshState'
import { useWebsitesStore } from '../../stores/websitesStore'
import { accessConfigEntryVisible, useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { CTL_FIELD, CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { WebsiteDetailSheet } from './WebsiteDetailSheet'
import { WebsitesCard } from './WebsitesCard'
import { WebsitesCreateDialog } from './WebsitesCreateDialog'
import { WebsitesRemoveDialog } from './WebsitesRemoveDialog'
import { WebsitesSettingsDialog } from './WebsitesSettingsDialog'
import { CaddyConfigDialog } from './CaddyConfigDialog'
import { filterWebsiteProjects } from './websitesListing'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useNotificationStore } from '../../stores/notificationStore'

/**
 * 网站项目面板：工具栏（添加项目 + 分类/搜索/刷新）、代理通道横幅、Docker 区
 * 同款卡片网格、详情抽屉。五种运行时类型共用一张列表，类型在创建时选择、
 * 在卡片与详情抽屉上以标签呈现。横幅是域级状态：通道不可用或配置漂移时如实
 * 呈现，不影响四状态判定。
 *
 * 瀑布列布局：卡片高度随内容伸缩，不强制对齐。
 */

const TOOL_BUTTON_CLASS = CTL_PRIMARY

/** 反向代理通道横幅：unavailable 为降级说明，active 且有 detail 为漂移说明附对账按钮。 */
function ProxyStatusBanner({
  detail,
  unavailable,
  reconciling,
  onReconcile,
}: {
  detail: string | null
  unavailable: boolean
  reconciling: boolean
  onReconcile: () => void
}) {
  useFeedbackNotification(unavailable
    ? `反向代理通道不可用${detail ? `：${detail}` : ''}。当前无法核对域名路由或证书状态。`
    : `反向代理配置未完全生效：${detail ?? '请重新下发配置'}`, 'warning')
  if (unavailable) {
    return (
      <p
        role="status"
        className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning"
      >
        反向代理通道不可用{detail ? `：${detail}` : ''}。站点容器照常运行；当前无法核对域名路由或证书状态。
      </p>
    )
  }
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning"
    >
      <p className="min-w-0 flex-1">反向代理配置未完全生效：{detail}。</p>
      <button
        type="button"
        onClick={onReconcile}
        disabled={reconciling}
        className="action-button gap-1.5 border border-warning/50 px-3 py-1.5 font-medium text-warning transition-colors hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw aria-hidden size={12} className={reconciling ? 'animate-spin' : undefined} />
        {reconciling ? '正在重新下发…' : '重新下发反向代理配置'}
      </button>
    </div>
  )
}

export function WebsitesPanel() {
  const [caddyConfigOpen, setCaddyConfigOpen] = useState(false)
  const gateway = useGateway()
  const [redeployTarget, setRedeployTarget] = useState<WebsiteProject>()
  const [selectedTask, setSelectedTask] = useState<WebsiteDeploymentTask>()
  const [taskListOpen, setTaskListOpen] = useState(false)
  const tasks = useWebsiteDeploymentsStore((s) => s.tasks)
  const taskError = useWebsiteDeploymentsStore((s) => s.error)
  const [operationError, setOperationError] = useState<string>()
  useFeedbackNotification(operationError)
  useFeedbackNotification(taskError)
  const [rollbackIds, setRollbackIds] = useState<readonly string[]>([])
  const hasActiveTask = tasks.some((task) => websiteDeploymentIsActive(task.state))
  useEffect(() => { void useWebsiteDeploymentsStore.getState().refresh(gateway) }, [gateway])
  useEffect(() => {
    if (!taskListOpen && !hasActiveTask) return
    const timer = window.setInterval(() => void useWebsiteDeploymentsStore.getState().refresh(gateway), 2000)
    return () => window.clearInterval(timer)
  }, [gateway, taskListOpen, hasActiveTask])
  const projects = useWebsitesStore((s) => s.projects)
  const proxyStatus = useWebsitesStore((s) => s.proxyStatus)
  const search = useWebsitesStore((s) => s.search)
  const category = useWebsitesStore((s) => s.category)
  const refreshing = useWebsitesStore((s) => s.refreshing)
  const reconciling = useWebsitesStore((s) => s.reconciling)
  const createDialogOpen = useWebsitesStore((s) => s.createDialogOpen)
  // 渲染期要用的状态必须走订阅选择器：getState() 读到的是不触发重渲染的瞬时值，
  // busy 与 settingsTarget 若不订阅，卡片的禁用与弹窗的预填都会静默失效。
  const busyIds = useWebsitesStore((s) => s.busyProjectIds)
  const settingsTarget = useWebsitesStore((s) => s.settingsTarget)
  const setSearch = useWebsitesStore((s) => s.setSearch)
  const setCategory = useWebsitesStore((s) => s.setCategory)
  const openCreate = useWebsitesStore((s) => s.openCreate)
  const refresh = useWebsitesStore((s) => s.refresh)
  const reconcileProxy = useWebsitesStore((s) => s.reconcileProxy)
  // 「访问配置」入口由探测报告驱动：Docker 与 Caddy 都就绪才出现，缺 Caddy 时不显示入口。
  const dependencyReport = useDependencyProbeStore((s) => s.report)
  const dependencyStatus = useDependencyProbeStore((s) => s.status)
  const rechecking = useDependencyProbeStore((s) => s.rechecking)
  const recheck = useDependencyProbeStore((s) => s.recheck)

  const filtered = filterWebsiteProjects(projects, { category, search })

  return (
    <div>
      <div className={`${CTL_TOOLBAR} rect-toolbar mb-4 flex flex-wrap items-center gap-2 panel-surface px-4 py-3`}>
        <button type="button" onClick={openCreate} className={TOOL_BUTTON_CLASS}>
          添加项目
        </button>
        <button type="button" className={TOOL_BUTTON_CLASS} aria-expanded={taskListOpen} onClick={() => setTaskListOpen((value) => !value)}>部署任务{tasks.some((task) => websiteDeploymentIsActive(task.state) || task.state === 'awaiting-config') ? `（${tasks.filter((task) => websiteDeploymentIsActive(task.state) || task.state === 'awaiting-config').length}）` : ''}</button>
        {accessConfigEntryVisible(dependencyReport, dependencyStatus) ? (
          <button type="button" onClick={() => setCaddyConfigOpen(true)} className={TOOL_BUTTON_CLASS}>
            访问配置
          </button>
        ) : null}

        <div className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
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
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
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
              className={`${CTL_FIELD} pl-8`}
            />
          </div>
          <RefreshButton onPress={() => { void Promise.all([refresh(gateway), recheck(gateway)]) }} busy={refreshing || rechecking} formControl />
        </div>
      </div>

      {taskListOpen && <div className="mb-4 space-y-2 panel-surface p-4" aria-label="部署任务列表">
        {taskError ? <p role="alert" className="text-xs text-danger">{taskError}</p> : tasks.length === 0 ? <p className="text-xs text-fg-muted">暂无部署任务</p> : tasks.map((task) => <button type="button" key={task.id} onClick={() => setSelectedTask(task)} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-left text-xs hover:bg-surface-raised"><span className="min-w-0 break-all">{task.name}</span><span className="flex flex-col gap-1 text-right"><span>{deploymentTaskSummary(task)}</span>{!websiteDeploymentIsActive(task.state) && task.state !== 'awaiting-config' ? <time dateTime={task.updatedAt} className="text-fg-muted">完成于 {formatDateTime(task.updatedAt)}</time> : null}</span></button>)}
      </div>}
      {projects.some((project) => project.accessMode === 'domain') && (proxyStatus.state === 'unavailable' || proxyStatus.detail !== null) ? (
        <ProxyStatusBanner
          detail={proxyStatus.detail}
          unavailable={proxyStatus.state === 'unavailable'}
          reconciling={reconciling}
          onReconcile={() => void reconcileProxy(gateway)}
        />
      ) : null}

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
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] items-start gap-4"
        >
          {filtered.map((project) => (
            <li key={project.id} className="min-w-0">
              <WebsitesCard
                project={project}
                busy={busyIds.includes(project.id) || rollbackIds.includes(project.id) || tasks.some((task) => task.projectId === project.id && (websiteDeploymentIsActive(task.state) || task.state === 'awaiting-config'))}
                refreshing={refreshing}
                onOpenDetail={() => useWebsitesStore.getState().openDetail(gateway, project)}
                onToggleRunning={() =>
                  void useWebsitesStore
                    .getState()
                    .setRunning(gateway, project, project.runState !== 'running')
                }
                onRedeploy={() => setRedeployTarget(project)}
                onRollback={project.previousRelease ? () => { setOperationError(undefined); setRollbackIds((ids) => [...ids, project.id]); void gateway.websites.deployment?.rollback(project.id).then((task) => { useWebsiteDeploymentsStore.getState().put(task); setSelectedTask(task); useNotificationStore.getState().notify({ tone: 'info', message: `已提交项目 ${project.name} 的回滚任务` }) }).catch((error: unknown) => setOperationError(error instanceof Error ? error.message : '回滚提交失败')).finally(() => setRollbackIds((ids) => ids.filter((id) => id !== project.id))) } : undefined}
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
      {redeployTarget ? <WebsitesCreateDialog project={redeployTarget} onClose={() => setRedeployTarget(undefined)} /> : null}
      {selectedTask ? <WebsitesCreateDialog existingTask={selectedTask} project={projects.find((project) => project.id === selectedTask.projectId)} onClose={() => setSelectedTask(undefined)} /> : null}
      {caddyConfigOpen ? (
        <CaddyConfigDialog
          onClose={() => setCaddyConfigOpen(false)}
          onAddProject={() => { setCaddyConfigOpen(false); openCreate() }}
        />
      ) : null}
      {/* 设置弹窗的表单初始值取自 settingsTarget，必须条件挂载：
          常驻挂载时 useState 惰性初始化只跑一次（目标是 undefined），预填会永久失效。 */}
      {settingsTarget ? <WebsitesSettingsDialog key={settingsTarget.id} /> : null}
      <WebsitesRemoveDialog />
      <WebsiteDetailSheet />
    </div>
  )
}
