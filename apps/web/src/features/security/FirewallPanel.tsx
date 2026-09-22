import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Switch from '@radix-ui/react-switch'
import {
  FIREWALL_DIRECTION_LABELS,
  FIREWALL_POLICY_LABELS,
  FIREWALL_RULE_STATUS_LABELS,
  formatFirewallPort,
} from '@elysian/contracts'
import type { FirewallForwardRule, FirewallIpRule, FirewallRule } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useNotificationStore } from '../../stores/notificationStore'
import { useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { IconButton } from '../../components/IconButton'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { formatDateTime } from '../../components/format'
import { Pencil, Search, Trash2 } from '../../components/icons'
import { FIREWALL_PAGE_SIZE, useFirewallStore, type FirewallView } from '../../stores/firewallStore'
import { FirewallExportDialog } from './FirewallExportDialog'
import { FirewallForwardDialog } from './FirewallForwardDialog'
import { FirewallIpRuleDialog } from './FirewallIpRuleDialog'
import { FirewallRuleDialog } from './FirewallRuleDialog'
import { FirewallRuleRemoveDialog } from './FirewallRuleRemoveDialog'
import { FirewallScanDialog } from './FirewallScanDialog'
import { formatFirewallImportProblems, parseFirewallRulesJson } from './firewallRuleIO'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

/**
 * 系统防火墙面板：开关、默认策略、统计、三类规则（端口/IP/转发）表格。
 * 数据来自防火墙 adapter：Docker 运行时由 HTTP adapter 真实执行容器内 ufw，
 * 宿主机本地开发是内存演示（带「演示数据」标识）；动作完成提示按运行时如实描述。
 *
 * 表格不随屏幕收窄折叠：容器横向滚动、表格定宽、端口列 sticky 钉在第一列，
 * 其余列在窄屏下滚出视口而不是换行或挤压。
 */

const STATUS_TONES: Record<FirewallRule['status'], StatusTone> = {
  normal: 'success',
  unused: 'neutral',
}

/** 策略配色：放行绿、拒绝红、限连黄——文字加颜色，不只靠颜色区分。 */
function PolicyText({ policy }: { policy: FirewallRule['policy'] }) {
  const tone = policy === 'allow' ? 'text-success' : policy === 'deny' ? 'text-danger' : 'text-warning'
  return <span className={tone}>{FIREWALL_POLICY_LABELS[policy]}</span>
}

/** 截图同款的统计短条：端口/IP/转发取真实计数，地区规则等真实能力接入。 */
function StatChip({ label, count, pending = false }: { label: string; count: number; pending?: boolean }) {
  return (
    <span
      title={pending ? '待接入' : undefined}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-muted"
    >
      {label}：<span className="font-medium tabular-nums text-accent">{count}</span>
    </span>
  )
}

function ToggleRow({
  label,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  /** 切换进行中：开关禁用，点击不再落到 store 的忙碌分支上（那是无反馈的吞掉）。 */
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 text-sm text-fg ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      {label}
      <Switch.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line bg-surface-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <Switch.Thumb className="ml-0.5 block size-3.5 rounded-full bg-fg-muted transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-white" />
      </Switch.Root>
    </label>
  )
}

/** 参照样式里的工具按钮：可用的实体动作（导入走本地文件、防扫描见弹窗）。 */
function ToolButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center whitespace-nowrap rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
    >
      {label}
    </button>
  )
}

/** 三类规则的视图切换：分段按钮，切换时清空搜索。 */
function ViewSwitch({
  view,
  onChange,
}: {
  view: FirewallView
  onChange: (view: FirewallView) => void
}) {
  const options: readonly { value: FirewallView; label: string }[] = [
    { value: 'port', label: '端口规则' },
    { value: 'ip', label: 'IP 规则' },
    { value: 'forward', label: '端口转发' },
  ]
  return (
    <div
      role="group"
      aria-label="规则类型"
      // shrink-0 是必需的：overflow 非 visible 的 flex 项自动最小尺寸为 0，
      // 空间不够时整组会被压窄，里面的标签有 whitespace-nowrap 反而被裁切。
      className="inline-flex shrink-0 overflow-hidden rounded-lg border border-line"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === view}
          onClick={() => onChange(option.value)}
          className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors ${
            index > 0 ? 'border-l border-line' : ''
          } ${
            option.value === view
              ? 'bg-surface-raised font-medium text-fg'
              : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const VIEW_TOOLBAR: Record<FirewallView, { addLabel: string; searchLabel: string }> = {
  port: { addLabel: '添加端口规则', searchLabel: '搜索端口、来源或备注' },
  ip: { addLabel: '添加 IP 规则', searchLabel: '搜索来源或备注' },
  forward: { addLabel: '添加端口转发', searchLabel: '搜索端口、目标或备注' },
}

export function FirewallPanel() {
  const gateway = useGateway()
  const status = useFirewallStore((s) => s.status)
  const errorMessage = useFirewallStore((s) => s.errorMessage)
  const rules = useFirewallStore((s) => s.rules)
  const ipRules = useFirewallStore((s) => s.ipRules)
  const forwards = useFirewallStore((s) => s.forwards)
  const view = useFirewallStore((s) => s.view)
  const toggles = useFirewallStore((s) => s.toggles)
  const search = useFirewallStore((s) => s.search)
  const page = useFirewallStore((s) => s.page)
  const dialogRule = useFirewallStore((s) => s.dialogRule)
  const dialogIpRule = useFirewallStore((s) => s.dialogIpRule)
  const dialogForward = useFirewallStore((s) => s.dialogForward)
  const scanDialogOpen = useFirewallStore((s) => s.scanDialogOpen)
  const exportDialogOpen = useFirewallStore((s) => s.exportDialogOpen)
  const syncing = useFirewallStore((s) => s.syncing)
  const toggling = useFirewallStore((s) => s.toggling)
  const load = useFirewallStore((s) => s.load)
  const setView = useFirewallStore((s) => s.setView)
  const setSearch = useFirewallStore((s) => s.setSearch)
  const setPage = useFirewallStore((s) => s.setPage)
  const toggle = useFirewallStore((s) => s.toggle)
  const openCreate = useFirewallStore((s) => s.openCreate)
  const openCreateIp = useFirewallStore((s) => s.openCreateIp)
  const openCreateForward = useFirewallStore((s) => s.openCreateForward)
  const openScan = useFirewallStore((s) => s.openScan)
  const openExport = useFirewallStore((s) => s.openExport)
  const importRules = useFirewallStore((s) => s.importRules)
  const syncFromSystem = useFirewallStore((s) => s.syncFromSystem)
  const importInputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const searchProbeRef = useRef<HTMLDivElement>(null)
  const [toolbarMetrics, setToolbarMetrics] = useState({ available: 0, gap: 0 })
  const ready = status === 'ready'
  const groupWidth = useIntrinsicWidth(probeRef, ready)
  const searchWidth = useIntrinsicWidth(searchProbeRef, ready)

  // 工具栏的可排布宽度与子项间距从计算样式读出，不和样式表里的 px 常量各写一份。
  useLayoutEffect(() => {
    if (!ready) return
    const element = toolbarRef.current
    if (!element) return
    const measure = () => {
      const style = getComputedStyle(element)
      const available =
        element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
      setToolbarMetrics({ available, gap: Number.parseFloat(style.columnGap) || 0 })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ready])

  // 同行判据：可排布宽度放得下「按钮行 + 间距 + 搜索框」就同行；差一点（两者会接触）
  // 就整块拆两行，搜索框此时拉满父容器宽度。jsdom 量不出宽度时按拆行处理，布局不会错乱。
  const toolbarInline =
    toolbarMetrics.available >= groupWidth + toolbarMetrics.gap + searchWidth && searchWidth > 0

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return { rules, ipRules, forwards }
    const match = (...parts: (string | number | null | undefined)[]) =>
      parts.some((part) => part !== null && part !== undefined && `${part}`.toLowerCase().includes(keyword))
    return {
      rules: rules.filter((rule) =>
        match(rule.port, rule.portTo, rule.source, rule.note),
      ),
      ipRules: ipRules.filter((rule) => match(rule.source, rule.note)),
      forwards: forwards.filter((rule) =>
        match(rule.port, rule.portTo, rule.targetHost, rule.targetPort, rule.note),
      ),
    }
  }, [rules, ipRules, forwards, search])

  // 分页只作用于端口规则（数据量最大）；IP 与转发通常个位数，整表呈现。
  const pageCount = Math.max(1, Math.ceil(filtered.rules.length / FIREWALL_PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.rules.slice((safePage - 1) * FIREWALL_PAGE_SIZE, safePage * FIREWALL_PAGE_SIZE)

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载防火墙规则…" />
  }

  if (status === 'error') {
    return <ErrorState title="防火墙数据加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }

  const toolbar = VIEW_TOOLBAR[view]
  const toolbarButtons =
    view === 'port'
      ? [toolbar.addLabel, '导入规则', '导出规则', '端口防扫描', '同步规则']
      : [toolbar.addLabel, '端口防扫描', '同步规则']

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3">
        {/* 防火墙动作只在容器内真实执行 ufw；宿主机本地开发是内存演示，明示出来。 */}
        {!isDockerRuntime() ? (
          <span role="status" className="text-sm text-fg-muted">
            演示数据
          </span>
        ) : null}
        <ToggleRow
          label="防火墙开关"
          checked={toggles.firewallEnabled}
          disabled={toggling}
          onCheckedChange={(checked) => void toggle(gateway, { ...toggles, firewallEnabled: checked })}
        />
        <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
        <ToggleRow
          label="禁ping"
          checked={toggles.pingBlocked}
          disabled={toggling}
          onCheckedChange={(checked) => void toggle(gateway, { ...toggles, pingBlocked: checked })}
        />
        <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
        {/* 默认策略只读呈现：改默认策略是系统级变更，由系统侧配置承担。
            ufw 未激活时整段不打印 Default 行，此时如实标注未知，不替系统编一个策略出来。 */}
        <span className="text-xs text-fg-muted" title="ufw Default 策略">
          {toggles.defaultIncoming === null || toggles.defaultOutgoing === null
            ? '默认策略：未知（防火墙未激活）'
            : `默认策略：入站${FIREWALL_POLICY_LABELS[toggles.defaultIncoming]} · 出站${FIREWALL_POLICY_LABELS[toggles.defaultOutgoing]}`}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <StatChip label="端口规则" count={rules.length} />
        <StatChip label="IP 规则" count={ipRules.length} />
        <StatChip label="端口转发" count={forwards.length} />
        <StatChip label="地区规则" count={0} pending />
      </div>

      {/* 工具区：不依赖 flex 折行的猜测——探针量出按钮行的自然宽度，外壳量出可用宽度，
          放得下（按钮行 + 间距 + 搜索框）就同行，放不下就按钮一行、搜索占满第二行。 */}
      <div
        ref={toolbarRef}
        className={`mb-4 rounded-xl border border-line bg-surface px-4 py-3 ${
          toolbarInline ? 'flex items-center gap-2' : ''
        }`}
      >
        <div
          className={
            toolbarInline ? 'flex items-center gap-2' : 'flex flex-wrap items-center gap-2'
          }
        >
          <ViewSwitch view={view} onChange={setView} />
          <ToolButton
            label={toolbar.addLabel}
            onClick={() => {
              if (view === 'port') openCreate()
              else if (view === 'ip') openCreateIp()
              else openCreateForward()
            }}
          />
          {view === 'port' ? (
            <>
              {/* 导入：读用户在本地选择的 JSON 文件（FileReader 本地解析，不经网络），逐条校验后交 adapter 落库。 */}
              <ToolButton label="导入规则" onClick={() => importInputRef.current?.click()} />
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  void file.text().then(async (text) => {
                    const parsed = parseFirewallRulesJson(text)
                    // 文件本身的问题（不是 JSON / 结构不对）属于界面层反馈，直接走通知。
                    if (!parsed) {
                      useNotificationStore.getState().notify({
                        tone: 'danger',
                        message: '导入失败：不是有效的规则 JSON',
                      })
                      return
                    }
                    // 被拒条目逐条标出（第几条、为什么），不静默丢弃；合法条目照常导入。
                    if (parsed.invalid > 0) {
                      useNotificationStore.getState().notify({
                        tone: 'danger',
                        message: `导入：${parsed.invalid} 条被拒（${formatFirewallImportProblems(parsed.problems)}）`,
                      })
                    }
                    if (parsed.rules.length === 0) {
                      // 一条合法条目都没有时不发导入请求，避免「导入完成：没有新增」把被拒说成没事发生。
                      if (parsed.invalid === 0) {
                        useNotificationStore.getState().notify({
                          tone: 'info',
                          message: '导入：文件里没有规则条目',
                        })
                      }
                      return
                    }
                    await importRules(gateway, parsed.rules)
                  })
                }}
              />
              <ToolButton label="导出规则" onClick={() => openExport()} />
            </>
          ) : null}
          <ToolButton label="端口防扫描" onClick={() => openScan(gateway)} />
          <ToolButton
            label={syncing ? '同步中…' : '同步规则'}
            disabled={syncing}
            onClick={() => void syncFromSystem(gateway)}
          />
        </div>
        <div
          className={toolbarInline ? 'relative ml-auto w-56 shrink-0' : 'relative mt-2 w-full'}
        >
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <label htmlFor="firewall-search" className="sr-only">
            {toolbar.searchLabel}
          </label>
          <input
            id="firewall-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="请输入端口/来源"
            className="w-full rounded-lg border border-line bg-surface-raised py-1.5 pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
          />
        </div>
      </div>

      {/* 固有宽度探针：脱离布局、量出「左区整组」与搜索框各自需要多宽，供折行判断使用。
          左区必须与真实行同构（视图切换 + 按钮），漏掉任何一项都会让预算偏小、误判放得下。
          外壳收成 0×0 并裁切：这行自然宽度比窄屏更宽，若参与文档滚动宽度，
          打开顶栏折叠菜单时滚动条补偿会按这份超出把整页挤窄。
          invisible（含 aria-hidden + pointer-events-none）使探针不参与无障碍树与交互。 */}
      <div aria-hidden className="pointer-events-none invisible absolute top-0 left-0 h-0 w-0 overflow-hidden">
        <div ref={probeRef} className="flex w-max gap-2">
          <ViewSwitch view={view} onChange={() => {}} />
          {toolbarButtons.map((label) => (
            <ToolButton key={label} label={label} />
          ))}
        </div>
        {/* 与同行形态的搜索框同宽（w-56），量出它的实际宽度 */}
        <div ref={searchProbeRef} className="w-56" />
      </div>

      {view === 'port' ? (
        <>
          <div role="region" aria-label="端口规则表" className="hover-scrollbar overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-left text-sm">
              {/* 每列都给显式宽度：没有指定宽度的那一列会独吞宽屏多出来的空间。
                  全部指定后，多出的空间按比例分摊到每一列。端口列要放得下最长的「40223 (ipv6)」；
                  操作列只放两个 24px 图标加间距，不留多余空位，省出的宽度匀给备注与时间。 */}
              <colgroup>
                <col className="w-32" />
                <col className="w-20" />
                <col className="w-26" />
                <col className="w-18" />
                <col className="w-18" />
                <col className="w-28" />
                <col className="w-62" />
                <col className="w-36" />
                <col className="w-20" />
              </colgroup>
              <thead>
                <tr>
                  {['端口', '协议', '使用状态', '策略', '方向', '来源', '备注', '时间'].map((label, index) => (
                    <th
                      key={label}
                      scope="col"
                      className={`border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted ${
                        index === 0 ? 'sticky left-0 z-20 border-r' : ''
                      }`}
                    >
                      {label}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted"
                  >
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="border-b border-line px-3 py-8 text-center text-sm text-fg-muted">
                      {rules.length === 0 ? '还没有端口规则' : '没有匹配的端口规则，换个关键词或清空搜索'}
                    </td>
                  </tr>
                ) : (
                  pageRows.map((rule) => <PortRow key={rule.id} rule={rule} />)
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
            <span>
              共 {filtered.rules.length} 条 · 每页 {FIREWALL_PAGE_SIZE} 条
            </span>
            <nav aria-label="分页" className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage <= 1}
                className="rounded-lg border border-line px-2 py-1 transition-colors enabled:hover:bg-surface-raised enabled:hover:text-fg disabled:opacity-50"
              >
                上一页
              </button>
              {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  aria-current={pageNumber === safePage ? 'page' : undefined}
                  onClick={() => setPage(pageNumber)}
                  className={`min-w-7 rounded-lg border px-2 py-1 tabular-nums transition-colors ${
                    pageNumber === safePage
                      ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                      : 'border-line hover:bg-surface-raised hover:text-fg'
                  }`}
                >
                  {pageNumber}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= pageCount}
                className="rounded-lg border border-line px-2 py-1 transition-colors enabled:hover:bg-surface-raised enabled:hover:text-fg disabled:opacity-50"
              >
                下一页
              </button>
            </nav>
          </div>
        </>
      ) : view === 'ip' ? (
        <div role="region" aria-label="IP 规则表" className="hover-scrollbar overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-48" />
              <col className="w-24" />
              <col className="w-24" />
              <col className="w-62" />
              <col className="w-36" />
              <col className="w-20" />
            </colgroup>
            <thead>
              <tr>
                {['来源', '地址族', '策略', '备注', '时间', '操作'].map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.ipRules.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-fg-muted">
                    {ipRules.length === 0 ? '还没有 IP 规则' : '没有匹配的 IP 规则，换个关键词或清空搜索'}
                  </td>
                </tr>
              ) : (
                filtered.ipRules.map((rule) => <IpRow key={rule.id} rule={rule} />)
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="region" aria-label="端口转发表" className="hover-scrollbar overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-20" />
              <col className="w-32" />
              <col className="w-44" />
              <col className="w-56" />
              <col className="w-36" />
              <col className="w-20" />
            </colgroup>
            <thead>
              <tr>
                {['协议', '外部端口', '转发目标', '备注', '时间', '操作'].map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.forwards.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-fg-muted">
                    {forwards.length === 0 ? '还没有端口转发' : '没有匹配的端口转发，换个关键词或清空搜索'}
                  </td>
                </tr>
              ) : (
                filtered.forwards.map((rule) => <ForwardRow key={rule.id} rule={rule} />)
              )}
            </tbody>
          </table>
        </div>
      )}

      {dialogRule !== undefined ? <FirewallRuleDialog /> : null}
      {dialogIpRule !== undefined ? <FirewallIpRuleDialog /> : null}
      {dialogForward !== undefined ? <FirewallForwardDialog /> : null}
      <FirewallRuleRemoveDialog />
      {exportDialogOpen ? <FirewallExportDialog /> : null}
      {scanDialogOpen ? <FirewallScanDialog /> : null}
    </div>
  )
}

function RowActions({ kind, id, label, onEdit }: { kind: 'port' | 'ip' | 'forward'; id: string; label: string; onEdit: () => void }) {
  const openRemove = useFirewallStore((s) => s.openRemove)
  return (
    <div className="flex items-center gap-1">
      {/* 图标按钮经统一出口出（带 tooltip 与 aria-label）；无障碍名保持「修改/删除」，与测试断言一致。 */}
      <IconButton label="修改" variant="ghost" onPress={onEdit}>
        <Pencil aria-hidden size={14} />
      </IconButton>
      <IconButton label="删除" variant="ghost" tone="danger-hover" onPress={() => openRemove({ kind, id, label })}>
        <Trash2 aria-hidden size={14} />
      </IconButton>
    </div>
  )
}

function PortRow({ rule }: { rule: FirewallRule }) {
  const openEdit = useFirewallStore((s) => s.openEdit)

  return (
    <tr className="group transition-colors hover:bg-surface-raised">
      {/* 端口列钉在左边并强制一行：地址族后缀折到第二行会把行高从 43px 撑到 61px。 */}
      <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-surface px-3 py-2.5 font-medium tabular-nums group-hover:bg-surface-raised">
        {formatFirewallPort(rule)}
      </td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">{rule.protocol}</td>
      <td className="border-b border-line px-3 py-2.5">
        <StatusTag label={FIREWALL_RULE_STATUS_LABELS[rule.status]} tone={STATUS_TONES[rule.status]} />
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <PolicyText policy={rule.policy} />
      </td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">{FIREWALL_DIRECTION_LABELS[rule.direction]}</td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">{rule.source}</td>
      {/* 备注截断显示，完整内容在悬停提示里：长备注换行会改变行高，破坏表格的密度。 */}
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">
        {rule.note ? (
          <span className="block truncate" title={rule.note}>
            {rule.note}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
        {rule.updatedAt ? formatDateTime(rule.updatedAt) : '—'}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <RowActions
          kind="port"
          id={rule.id}
          label={`${rule.protocol} ${formatFirewallPort(rule)}`}
          onEdit={() => openEdit(rule)}
        />
      </td>
    </tr>
  )
}

function IpRow({ rule }: { rule: FirewallIpRule }) {
  const openEditIp = useFirewallStore((s) => s.openEditIp)

  return (
    <tr className="group transition-colors hover:bg-surface-raised">
      <td className="border-b border-line px-3 py-2.5 font-medium tabular-nums">{rule.source}</td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">{rule.family === 'ipv4' ? 'IPv4' : 'IPv6'}</td>
      <td className="border-b border-line px-3 py-2.5">
        <PolicyText policy={rule.policy} />
      </td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">
        {rule.note ? (
          <span className="block truncate" title={rule.note}>
            {rule.note}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
        {rule.updatedAt ? formatDateTime(rule.updatedAt) : '—'}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <RowActions kind="ip" id={rule.id} label={rule.source} onEdit={() => openEditIp(rule)} />
      </td>
    </tr>
  )
}

function ForwardRow({ rule }: { rule: FirewallForwardRule }) {
  const openEditForward = useFirewallStore((s) => s.openEditForward)
  const portLabel = rule.portTo !== null ? `${rule.port}:${rule.portTo}` : `${rule.port}`

  return (
    <tr className="group transition-colors hover:bg-surface-raised">
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">{rule.protocol}</td>
      <td className="border-b border-line px-3 py-2.5 font-medium tabular-nums">{portLabel}</td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
        {rule.targetHost}:{rule.targetPort}
      </td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">
        {rule.note ? (
          <span className="block truncate" title={rule.note}>
            {rule.note}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
        {rule.updatedAt ? formatDateTime(rule.updatedAt) : '—'}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <RowActions
          kind="forward"
          id={rule.id}
          label={`${rule.protocol} ${portLabel} → ${rule.targetHost}:${rule.targetPort}`}
          onEdit={() => openEditForward(rule)}
        />
      </td>
    </tr>
  )
}
