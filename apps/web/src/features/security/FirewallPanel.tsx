import { TOOLTIP_CONTENT_CLASS } from '../../components/tooltipStyles'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { DataTable, type Id, type SortState } from '../../components/DataTable'
import { TableBatchActions } from '../../components/TableBatchActions'
import { TableCreateButton } from '../../components/TableCreateButton'
import { useMessageStore } from '../../stores/messageStore'
import { usePanelStore } from '../../stores/panelStore'
import { isProtectedPanelRule, portRuleGroup, portTableRows, type PortTableRow } from './securityTableLogic'
import { Badge } from '../../components/easyui/Badge'
import { RefreshButton } from '../../components/RefreshState'
import {
  PANEL_PORT,
  FIREWALL_DIRECTION_LABELS,
  FIREWALL_POLICY_LABELS,
  FIREWALL_RULE_STATUS_LABELS,
  firewallRuleScanEnabled,
  formatFirewallPort,
} from '@elysian/contracts'
import type { DockerFirewallInventory, FirewallForwardRule, FirewallIpRule, FirewallRule } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import { IconButton } from '../../components/IconButton'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { StaleDataBanner } from '../../components/states/StaleDataBanner'
import { DemoBadge } from '../../components/DemoBadge'
import { CTL_TOOLBAR } from '../../components/formControl'
import { ChipGroup } from '../../components/ChipGroup'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { formatDateTime } from '../../components/format'
import { Pencil, ShieldCheck, Trash2 } from '../../components/icons'
import { useFirewallStore, type FirewallView } from '../../stores/firewallStore'
import { FirewallForwardDialog } from './FirewallForwardDialog'
import { FirewallIpRuleDialog } from './FirewallIpRuleDialog'
import { FirewallRuleDialog } from './FirewallRuleDialog'
import { FirewallRuleRemoveDialog } from './FirewallRuleRemoveDialog'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { Button } from '../../components/Button'

/**
 * 系统防火墙面板：开关、统计、三类规则（端口/IP/转发）表格。
 * 数据来自防火墙 adapter：Docker 运行时由 HTTP adapter 真实执行容器内 ufw，
 * 宿主机本地开发是内存演示（带「演示数据」标识）；动作完成提示按运行时如实描述。
 *
 * 数据与搜索判据保持原样，表格几何、排序、分页和多选由 EasyUI 公共适配承载。
 */

const STATUS_TONES: Record<FirewallRule['status'], StatusTone> = {
  normal: 'success',
  unused: 'neutral',
}

const DOCKER_GUARD_STATUS: Record<DockerFirewallInventory['guard']['state'], [string, StatusTone]> = {
  verified: ['Docker 转发已核验', 'success'],
  degraded: ['Docker 转发接管异常', 'danger'],
  disabled: ['UFW 已停用', 'warning'],
  unsupported: ['宿主转发状态不可核验', 'neutral'],
  unknown: ['Docker 转发状态未知', 'warning'],
}
const NO_PORT_RULE = '没有独立规则可删除'

/** 策略配色：放行绿、拒绝红、限连黄——文字加颜色，不只靠颜色区分。 */
function PolicyText({ policy }: { policy: FirewallRule['policy'] }) {
  const tone = policy === 'allow' ? 'text-success' : policy === 'deny' ? 'text-danger' : 'text-warning'
  return <span className={tone}>{FIREWALL_POLICY_LABELS[policy]}</span>
}

/** 端口旁的只读标记与表单共用防扫描判据，未知状态不显示已开启。 */
function PortCell({ rule, label }: { rule: Parameters<typeof firewallRuleScanEnabled>[0]; label: string }) {
  const scan = useFirewallStore(s => s.scanProtection)
  const scanStatus = useFirewallStore(s => s.scanStatus)
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums">
    <span>{label}</span>
    {scanStatus === 'ready' && firewallRuleScanEnabled(rule, scan) && <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span role="img" aria-label="已开启防扫描" tabIndex={0} className="inline-flex shrink-0 rounded-sm text-success">
          {/* 数字字面中心略低于行盒中心，盾牌下移 1px 做视觉对齐。 */}
          <ShieldCheck aria-hidden size={14} className="translate-y-px" />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} className={TOOLTIP_CONTENT_CLASS}>
          已开启防扫描
          <Tooltip.Arrow className="fill-surface-raised" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>}
  </span>
}

/** EasyUI 中性 Badge：端口/IP/转发沿用真实计数，标签与数字紧凑呈现。 */
function StatChip({ label, count }: { label: string; count: number }) {
  return (
    <Badge variant="soft" tone="neutral" animateChanges={false} className="firewall-status-count">
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
      className={`firewall-status-control text-fg ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      {label}
      <ToggleSwitch compact label={label} checked={checked} disabled={disabled} busy={disabled} onCheckedChange={onCheckedChange} />
    </label>
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
  const { ports, guard, error: dockerError, checkedAt, loading: dockerLoading } = useFirewallStore((s) => s.dockerPorts)
  const refreshDockerPorts = useFirewallStore((s) => s.refreshDockerPorts)
  const ipRules = useFirewallStore((s) => s.ipRules)
  const forwards = useFirewallStore((s) => s.forwards)
  const view = useFirewallStore((s) => s.tab)
  const toggles = useFirewallStore((s) => s.toggles)
  const search = useFirewallStore((s) => s.search)
  const dialogRule = useFirewallStore((s) => s.dialogRule)
  const dialogIpRule = useFirewallStore((s) => s.dialogIpRule)
  const dialogForward = useFirewallStore((s) => s.dialogForward)
  const scanError = useFirewallStore((s) => s.scanError)
  const syncing = useFirewallStore((s) => s.syncing)
  const toggling = useFirewallStore((s) => s.toggling)
  const load = useFirewallStore((s) => s.load)
  const setTab = useFirewallStore((s) => s.setTab)
  const setSearch = useFirewallStore((s) => s.setSearch)
  const toggle = useFirewallStore((s) => s.toggle)
  const openCreate = useFirewallStore((s) => s.openCreate)
  const openCreateIp = useFirewallStore((s) => s.openCreateIp)
  const openCreateForward = useFirewallStore((s) => s.openCreateForward)
  const syncFromSystem = useFirewallStore((s) => s.syncFromSystem)

  useEffect(() => {
    void load(gateway)
    void usePanelStore.getState().load(gateway)
  }, [gateway, load])

  useEffect(() => {
    if (view !== 'port') return
    return subscribeWhileVisible(() => {
      const read = () => void refreshDockerPorts(gateway)
      read()
      const timer = window.setInterval(read, 10_000)
      return () => window.clearInterval(timer)
    })
  }, [gateway, refreshDockerPorts, view])

  const portRows = useMemo(() => portTableRows(rules, ports), [rules, ports])
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return { rules: portRows, ipRules, forwards }
    const match = (...parts: (string | number | null | undefined)[]) =>
      parts.some((part) => part !== null && part !== undefined && `${part}`.toLowerCase().includes(keyword))
    return {
      rules: portRows.filter((row) =>
        match(row.port, row.note, ...(row.kind === 'rule' ? [row.rule.portTo, row.rule.source] : row.addresses)),
      ),
      ipRules: ipRules.filter((rule) => match(rule.source, rule.note)),
      forwards: forwards.filter((rule) =>
        match(rule.port, rule.portTo, rule.targetHost, rule.targetPort, rule.note),
      ),
    }
  }, [portRows, ipRules, forwards, search])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载防火墙规则…" />
  }

  const portView = view === 'port'
  const retry = () => {
    void load(gateway)
    if (portView) void refreshDockerPorts(gateway)
  }
  const firewallError = status === 'error'
  const [guardLabel, guardTone] = DOCKER_GUARD_STATUS[guard?.state ?? 'unknown']
  const showGuard = portView && (guard || dockerError) && guard?.state !== 'disabled'
  const demo = !isDockerRuntime()

  const toolbar = VIEW_TOOLBAR[view]
  const tableNavigation = <div className={`${CTL_TOOLBAR} firewall-toolbar flex max-w-full`}>
    <ViewSwitch view={view} onChange={setTab} />
  </div>
  const tableToolbar = (
    <div role="group" aria-label="规则操作" className={`${CTL_TOOLBAR} firewall-toolbar flex max-w-full items-center gap-2`}>
      <TableCreateButton
        label="添加规则"
        ariaLabel={toolbar.addLabel}
        onPress={() => {
          if (view === 'port') openCreate()
          else if (view === 'ip') openCreateIp()
          else openCreateForward()
        }}
      />
      <RefreshButton
        className="dt-toolbar-control-icon"
        onPress={() => {
          void syncFromSystem(gateway).then(() => portView ? refreshDockerPorts(gateway) : undefined)
        }}
        busy={syncing || portView && dockerLoading}
        label={syncing || portView && dockerLoading ? '同步中…' : '同步规则'}
      />
    </div>
  )

  return (
    <div>
      {firewallError ? <ErrorState title="防火墙数据加载失败" description={errorMessage} onRetry={retry} />
        : errorMessage ? <StaleDataBanner className="mb-3" error={errorMessage} onRetry={retry} /> : null}
      {operationError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-3 text-xs text-danger"><p className="min-w-0 flex-1">{operationError}</p><Button variant="outline" type="button" className="rounded border border-line px-3 py-1.5 text-fg" onClick={retry}>重新读取状态</Button></div> : null}
      {scanError ? <p role="alert" className="mb-3 text-xs text-danger">防扫描：{scanError}<Button variant="link" type="button" className="ml-2 underline" onClick={() => void useFirewallStore.getState().refreshScan(gateway)}>重新读取状态</Button></p> : null}
      {!firewallError && <div className={`${CTL_TOOLBAR} firewall-toolbar firewall-status-bar mb-4 panel-surface`}>
        <div className="firewall-status-layout">
          <div role="group" aria-label="防火墙开关设置" className="firewall-status-controls">
            <ToggleRow label="防火墙开关" checked={toggles.firewallEnabled} disabled={toggling}
              onCheckedChange={(checked) => void toggle(gateway, { ...toggles, firewallEnabled: checked })} />
            <ToggleRow label="禁ping" checked={toggles.pingBlocked} disabled={toggling}
              onCheckedChange={(checked) => void toggle(gateway, { ...toggles, pingBlocked: checked })} />
          </div>
          <div role="group" aria-label="规则计数" className="firewall-status-counts">
            <StatChip label="端口规则" count={rules.length} />
            <StatChip label="IP 规则" count={ipRules.length} />
            <StatChip label="端口转发" count={forwards.length} />
          </div>
          {(showGuard || demo) && <div className="firewall-status-indicators">
            {showGuard && <StatusTag label={guardLabel} tone={guardTone} />}
            {demo && <DemoBadge className="text-fg-muted" />}
          </div>}
        </div>
      </div>}
      {portView && guard?.state === 'degraded' && <p role="status" className="mb-3 text-xs text-danger">
        {guard.kernelVerified ? 'Docker 转发规则已核验，自动同步服务异常。' : '无法核验当前生效的 Docker 转发规则。'}
      </p>}
      {portView && dockerError && <p role="alert" className="mb-3 text-xs text-danger">
        {dockerError}。{checkedAt !== undefined ? `容器信息更新于 ${formatDateTime(new Date(checkedAt).toISOString())}。` : '暂无法显示容器信息。'}
      </p>}
      {(!firewallError || portView && portRows.length > 0) && <FirewallRulesTable rows={filtered} view={view} query={search} onQueryChange={setSearch}
        toolbar={tableToolbar} toolbarNavigation={tableNavigation} dockerStale={Boolean(dockerError)}
        dockerGuard={guard} />}

      {dialogRule !== undefined ? <FirewallRuleDialog /> : null}
      {dialogIpRule !== undefined ? <FirewallIpRuleDialog /> : null}
      {dialogForward !== undefined ? <FirewallForwardDialog /> : null}
      <FirewallRuleRemoveDialog />
    </div>
  )
}

function RowActions({ kind, id, label, onEdit, editLabel = '修改', editDisabled = false }: {
  kind: FirewallView | 'published'; id: string; label: string; onEdit?: () => void; editLabel?: string; editDisabled?: boolean
}) {
  const openRemove = useFirewallStore((s) => s.openRemove)
  const removing = useFirewallStore(s => s.removingRuleIds.includes(id))
  return (
    <div className="flex items-center gap-1">
      {/* 图标按钮经统一出口出（带 tooltip 与 aria-label）；无障碍名保持「修改/删除」，与测试断言一致。 */}
      {onEdit && <IconButton label={editLabel} variant="ghost" disabled={removing || editDisabled} onPress={onEdit}>
        <Pencil aria-hidden size={14} />
      </IconButton>}
      <IconButton label="删除" variant="ghost" tone="danger-hover" disabled={removing} onPress={() => {
        if (kind === 'published') {
          useMessageStore.getState().notify({ tone: 'info', message: `${label} ${NO_PORT_RULE}，继续按现有防火墙策略判定。` })
          return
        }
        openRemove({ kind, id, label })
      }}>
        <Trash2 aria-hidden size={14} />
      </IconButton>
    </div>
  )
}

type TableQuery = { query: string; onQueryChange(value: string): void; toolbar: ReactNode; toolbarNavigation: ReactNode }
const ruleDate = (rule: { updatedAt: string | null }) => rule.updatedAt ? formatDateTime(rule.updatedAt) : '—'
const ruleNote = (rule: { note: string | null }) => <span title={rule.note || undefined}>{rule.note || '—'}</span>

function portStatus(row: PortTableRow, stale: boolean): [string, StatusTone] {
  if (row.kind === 'rule') {
    // Docker 转发端口可能没有宿主监听套接字，当前绑定也是正在使用的依据。
    const status = row.published && !stale ? 'normal' : row.rule.status
    if (status === 'normal' || !row.published) return [FIREWALL_RULE_STATUS_LABELS[status], STATUS_TONES[status]]
  }
  return stale ? ['发布待核验', 'warning'] : [FIREWALL_RULE_STATUS_LABELS.normal, STATUS_TONES.normal]
}

function publishedPolicy(guard: DockerFirewallInventory['guard'] | undefined, stale: boolean): string {
  if (stale) return '策略待核验'
  if (guard?.state === 'disabled') return '防火墙已关闭'
  return guard?.kernelVerified ? '沿用防火墙' : '策略待核验'
}

const portRowLabel = (row: PortTableRow) => `${row.protocol} ${row.kind === 'rule' ? formatFirewallPort(row.rule) : row.port}`

function FirewallBatch<T extends { id: string }>({ rows, kind, getLabel, onSucceeded, groupBy, eligible }: {
  rows: readonly T[]; kind: FirewallView; getLabel(row: T): string; onSucceeded(ids: (string | number)[]): void;
  groupBy?(row: T): string; eligible?(row: T): string | undefined;
}) {
  const gateway = useGateway()
  const removeRule = useFirewallStore(s => s.removeRule)
  const removing = useFirewallStore(s => s.removingRuleIds)
  const syncing = useFirewallStore(s => s.syncing)
  return <TableBatchActions selectedRows={rows} getRowId={row => row.id} getRowLabel={getLabel}
    onSucceeded={onSucceeded} disabled={syncing} actions={[{
      key: 'remove', label: '删除', icon: <Trash2 aria-hidden size={16} />, danger: true,
      description: kind === 'port' ? '仅删除已配置的防火墙规则。容器和端口映射会继续运行。' : '删除所选规则，保留现有系统校验与操作边界。',
      showSkippedResult: kind === 'port',
      eligible: row => removing.includes(row.id) ? '规则正在删除' : eligible?.(row),
      // 真实 UFW 以一条规范规则成对删除 IPv4／IPv6；演示 adapter 按精确 ID 删除。
      groupBy: isDockerRuntime() ? groupBy : row => row.id,
      execute: rows => removeRule(gateway, kind, rows[0]!.id),
    }]} />
}

/** Keep the official toolbar and shared-layout indicator mounted across rule views. */
function FirewallRulesTable({ rows: allRows, view, query, onQueryChange, toolbar, toolbarNavigation, dockerStale, dockerGuard }: TableQuery & {
  view: FirewallView
  rows: { rules: readonly PortTableRow[]; ipRules: readonly FirewallIpRule[]; forwards: readonly FirewallForwardRule[] }
  dockerStale: boolean
  dockerGuard?: DockerFirewallInventory['guard']
}) {
  const [selection, setSelection] = useState<{ view: FirewallView; ids: Id[] }>({ view, ids: [] })
  const [sorting, setSorting] = useState<{ view: FirewallView; value: SortState }>({ view, value: null })
  const panelPort = usePanelStore(s => s.info?.ports.frontendPort ?? PANEL_PORT)
  useEffect(() => {
    setSelection({ view, ids: [] })
    setSorting({ view, value: null })
  }, [view])
  const selected = selection.view === view ? selection.ids : []
  const setSelected = (next: Id[] | ((ids: Id[]) => Id[])) => setSelection(current => ({
    view, ids: typeof next === 'function' ? next(current.view === view ? current.ids : []) : next,
  }))
  const common = {
    className: 'firewall-data-table',
    query, onQueryChange, toolbar, toolbarNavigation, selectionKey: view,
    selected, onSelectionChange: setSelected,
    sort: sorting.view === view ? sorting.value : null,
    onSortChange: (value: SortState) => setSorting({ view, value }),
  }

  if (view === 'port') {
    const rows = allRows.rules
    const observedPolicy = publishedPolicy(dockerGuard, dockerStale)
    return <DataTable rows={rows} ariaLabel="端口规则表" {...common} filterMode="external"
      // 44px 选择列与九列最小宽度合计 1200px，空间不足时仅表体横向滚动。
      minWidth={1200}
      searchPlaceholder="搜索端口、来源或备注"
      getRowId={row => row.id} getRowLabel={portRowLabel}
      columns={[
        { key: 'port', header: '端口', primary: true, cell: row => {
          if (row.kind === 'rule') return <PortCell rule={row.rule} label={formatFirewallPort(row.rule)} />
          if (row.protocol !== 'tcp') return <span className="tabular-nums">{row.port}</span>
          return <PortCell rule={{ protocol: row.protocol, port: row.port, direction: 'inbound' }} label={String(row.port)} />
        }, width: 'minmax(176px, 13fr)' },
        { key: 'protocol', header: '协议', width: 'minmax(72px, 8fr)' },
        { key: 'status', header: '使用状态', accessor: row => portStatus(row, dockerStale)[0], cell: row => {
          const [label, tone] = portStatus(row, dockerStale)
          return <StatusTag label={label} tone={tone} />
        }, width: 'minmax(96px, 11fr)' },
        { key: 'policy', header: '策略', accessor: row => row.kind === 'rule' ? FIREWALL_POLICY_LABELS[row.rule.policy] : observedPolicy,
          cell: row => row.kind === 'rule' ? <PolicyText policy={row.rule.policy} /> : observedPolicy, width: 'minmax(72px, 8fr)' },
        { key: 'direction', header: '方向', accessor: row => FIREWALL_DIRECTION_LABELS[row.kind === 'rule' ? row.rule.direction : 'inbound'], width: 'minmax(72px, 8fr)' },
        { key: 'source', header: '来源', accessor: row => row.kind === 'rule' ? row.rule.source : null, width: 'minmax(176px, 12fr)' },
        { key: 'note', header: '备注', cell: row => row.kind === 'rule' ? ruleNote(row) :
          ruleNote({ note: `${row.note} · ${row.addresses.join('、')}` }), width: 'minmax(176px, 17fr)' },
        { key: 'updatedAt', header: '时间', accessor: row => row.kind === 'rule' ? row.rule.updatedAt : null, cell: row => row.kind === 'rule' ? ruleDate(row.rule) : '—', width: 'minmax(128px, 15fr)' },
        { key: 'actions', header: '操作', sortable: false, width: 'minmax(88px, 8fr)', cell: row => {
          if (row.kind === 'rule') return <RowActions kind="port" id={row.id} label={portRowLabel(row)} onEdit={() => useFirewallStore.getState().openEdit(row.rule)} />
          const { protocol, port, family } = row
          const edit = protocol === 'tcp' || protocol === 'udp'
            ? () => useFirewallStore.getState().openCreate({ port, protocol, family })
            : undefined
          return <RowActions kind="published" id={row.id} label={portRowLabel(row)} editDisabled={dockerStale}
            editLabel={`为 ${port}/${protocol} 配置规则`} onEdit={edit} />
        } },
      ]}
      bulkActions={ids => <FirewallBatch key={view} rows={rows.filter(row => ids.includes(row.id))} kind="port"
        groupBy={row => row.kind === 'rule' ? portRuleGroup(row.rule) : row.id} getLabel={portRowLabel}
        eligible={row => row.kind === 'published' ? NO_PORT_RULE : isProtectedPanelRule(row.rule, panelPort) ? '面板入口保底规则不允许删除' : undefined}
        onSucceeded={ids => setSelected(current => current.filter(id => !ids.includes(id)))} />}
    />
  }

  if (view === 'ip') {
    const rows = allRows.ipRules
    return <DataTable rows={rows} ariaLabel="IP 规则表" {...common} filterMode="external"
      searchPlaceholder="搜索来源或备注"
      getRowId={rule => rule.id} getRowLabel={rule => rule.source}
      columns={[
        { key: 'source', header: '来源', primary: true, accessor: rule => rule.source, width: '25%' },
        { key: 'family', header: '地址族', accessor: rule => rule.family, cell: rule => rule.family === 'ipv4' ? 'IPv4' : 'IPv6', width: '12%' },
        { key: 'policy', header: '策略', accessor: rule => FIREWALL_POLICY_LABELS[rule.policy], cell: rule => <PolicyText policy={rule.policy} />, width: '12%' },
        { key: 'note', header: '备注', accessor: rule => rule.note, cell: ruleNote, width: '25%' },
        { key: 'updatedAt', header: '时间', accessor: rule => rule.updatedAt, cell: ruleDate, width: '16%' },
        { key: 'actions', header: '操作', sortable: false, width: '10%', cell: rule => <RowActions kind="ip" id={rule.id} label={rule.source} onEdit={() => useFirewallStore.getState().openEditIp(rule)} /> },
      ]}
      bulkActions={ids => <FirewallBatch key={view} rows={rows.filter(rule => ids.includes(rule.id))} kind="ip" getLabel={rule => rule.source}
        groupBy={rule => JSON.stringify([rule.source, rule.policy])}
        onSucceeded={ids => setSelected(current => current.filter(id => !ids.includes(id)))} />}
    />
  }

  const rows = allRows.forwards
  const portLabel = (rule: FirewallForwardRule) => rule.portTo !== null ? `${rule.port}:${rule.portTo}` : `${rule.port}`
  return <DataTable rows={rows} ariaLabel="端口转发表" {...common} filterMode="external"
    searchPlaceholder="搜索端口、目标或备注"
    getRowId={rule => rule.id} getRowLabel={rule => `${rule.protocol} ${portLabel(rule)} → ${rule.targetHost}:${rule.targetPort}`}
    columns={[
      { key: 'protocol', header: '协议', accessor: rule => rule.protocol, width: '10%' },
      { key: 'port', header: '外部端口', primary: true, accessor: rule => rule.port, cell: portLabel, width: '17%' },
      { key: 'target', header: '转发目标', accessor: rule => `${rule.targetHost}:${rule.targetPort}`, width: '23%' },
      { key: 'note', header: '备注', accessor: rule => rule.note, cell: ruleNote, width: '24%' },
      { key: 'updatedAt', header: '时间', accessor: rule => rule.updatedAt, cell: ruleDate, width: '16%' },
      { key: 'actions', header: '操作', sortable: false, width: '10%', cell: rule => <RowActions kind="forward" id={rule.id} label={`${rule.protocol} ${portLabel(rule)} → ${rule.targetHost}:${rule.targetPort}`} onEdit={() => useFirewallStore.getState().openEditForward(rule)} /> },
    ]}
    bulkActions={ids => <FirewallBatch key={view} rows={rows.filter(rule => ids.includes(rule.id))} kind="forward" getLabel={rule => `${rule.protocol} ${portLabel(rule)}`}
      onSucceeded={ids => setSelected(current => current.filter(id => !ids.includes(id)))} />}
  />
}
