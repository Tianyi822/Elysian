import { useEffect, useMemo } from 'react'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { Pagination } from '../../components/Pagination'
import { Badge } from '../../components/easyui/Badge'
import { SearchInput } from '../../components/SearchInput'
import { RefreshButton } from '../../components/RefreshState'
import {
  FIREWALL_DIRECTION_LABELS,
  FIREWALL_POLICY_LABELS,
  FIREWALL_RULE_STATUS_LABELS,
  formatFirewallPort,
} from '@elysian/contracts'
import type { FirewallForwardRule, FirewallIpRule, FirewallRule } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_TOOLBAR } from '../../components/formControl'
import { ChipGroup } from '../../components/ChipGroup'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { formatDateTime } from '../../components/format'
import { Pencil, Trash2 } from '../../components/icons'
import { FIREWALL_PAGE_SIZE, useFirewallStore, type FirewallView } from '../../stores/firewallStore'
import { FirewallForwardDialog } from './FirewallForwardDialog'
import { FirewallIpRuleDialog } from './FirewallIpRuleDialog'
import { FirewallRuleDialog } from './FirewallRuleDialog'
import { FirewallRuleRemoveDialog } from './FirewallRuleRemoveDialog'
import { FirewallScanDialog } from './FirewallScanDialog'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { Button } from '../../components/Button'

/**
 * 系统防火墙面板：开关、统计、三类规则（端口/IP/转发）表格。
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

/** EasyUI 中性 Badge：端口/IP/转发沿用真实计数，标签与数字紧凑呈现。 */
function StatChip({ label, count }: { label: string; count: number }) {
  return (
    <Badge variant="soft" tone="neutral" animateChanges={false}>
      <span>{label}</span>
      <span className="tabular-nums text-fg">{count}</span>
    </Badge>
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
      className={`inline-flex h-8 items-center gap-2 text-sm text-fg ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      {label}
      <ToggleSwitch label={label} checked={checked} disabled={disabled} busy={disabled} onCheckedChange={onCheckedChange} />
    </label>
  )
}

/** EasyUI PressButton 保留官网圆角和压缩回弹，高度与本栏页签共用令牌。 */
function ToolButton({
  label,
  onClick,
  disabled = false,
  primary = false,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <Button type="button"
      variant={primary ? 'primary' : 'outline'}
      onClick={onClick}
      disabled={disabled}
      className="h-[var(--ctl-height)] shrink-0 whitespace-nowrap"
    >
      {label}
    </Button>
  )
}

/** 三类规则的视图切换：分段按钮，切换时清空搜索。选中态是滑动的底色块。 */
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
  // shrink-0 是必需的：overflow 非 visible 的 flex 项自动最小尺寸为 0，
  // 空间不够时整组会被压窄，里面的标签有 whitespace-nowrap 反而被裁切。
  return (
    <ChipGroup ariaLabel="规则类型" items={options} value={view} onSelect={onChange} className="shrink-0" />
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
  const operationError = useFirewallStore((s) => s.operationError)
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
  const syncFromSystem = useFirewallStore((s) => s.syncFromSystem)

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

  return (
    <div>
      {errorMessage ? <p role="alert" className="mb-3 text-xs text-danger">刷新失败：{errorMessage}。已保留上次读取结果。<Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway)}>重试</Button></p> : null}
      {operationError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-3 text-xs text-danger"><p className="min-w-0 flex-1">{operationError}</p><Button variant="outline" type="button" className="rounded border border-line px-3 py-1.5 text-fg" onClick={() => void load(gateway)}>重新读取状态</Button></div> : null}
      <div className={`${CTL_TOOLBAR} firewall-toolbar mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 panel-surface px-4 py-1`}>
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
        {/* 三类规则的条数并进开关这条：它们是同一份防火墙状态读数，不该自己占一行。 */}
        <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
        <StatChip label="端口规则" count={rules.length} />
        <StatChip label="IP 规则" count={ipRules.length} />
        <StatChip label="端口转发" count={forwards.length} />
      </div>
      {/* 工具区按官方控件的自然尺寸排布；窄屏重排容器，不压缩组件。 */}
      <div
        className={`${CTL_TOOLBAR} firewall-toolbar mb-4 flex flex-wrap items-center gap-3 panel-surface px-3 py-2`}
      >
        <div className="shrink-0">
          <ViewSwitch view={view} onChange={setView} />
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <ToolButton
            label={toolbar.addLabel}
            primary
            onClick={() => {
              if (view === 'port') openCreate()
              else if (view === 'ip') openCreateIp()
              else openCreateForward()
            }}
          />
          <ToolButton label="端口防扫描" onClick={() => openScan(gateway)} />
          <RefreshButton
            onPress={() => void syncFromSystem(gateway)}
            busy={syncing}
            label={syncing ? '同步中…' : '同步规则'}
          />
        </div>
        <SearchInput
          // 搜索槽从 220px 起使用剩余空间，最多 340px；内部聚焦动画只在
          // 槽位内伸展。三个分组放不下时才自然换行，不强制页签独占一行。
          className="ml-auto w-auto min-w-[min(220px,100%)] max-w-[min(340px,100%)] flex-[1_1_220px] sm:justify-end"
          id="firewall-search"
          label={toolbar.searchLabel}
          value={search}
          onChange={setSearch}
          placeholder={toolbar.searchLabel}
        />
      </div>
      {view === 'port' ? (
        <>
          <div role="region" aria-label="端口规则表" className="hover-scrollbar overflow-x-auto panel-surface">
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
          <Pagination className="mt-3" summary={`共 ${filtered.rules.length} 条`}
            pageSize={FIREWALL_PAGE_SIZE} pageCount={pageCount} page={safePage}
            onPageChange={setPage} showControls={false} />
        </>
      ) : view === 'ip' ? (
        <div role="region" aria-label="IP 规则表" className="hover-scrollbar overflow-x-auto panel-surface">
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
        <div role="region" aria-label="端口转发表" className="hover-scrollbar overflow-x-auto panel-surface">
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
    <tr className="group transition-none hover:bg-surface-raised">
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
