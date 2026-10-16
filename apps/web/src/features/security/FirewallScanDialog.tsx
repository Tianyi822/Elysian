import { usePanelStore } from '../../stores/panelStore'
import * as Dialog from '@radix-ui/react-dialog'
import { SwitchToggle } from './sshCardParts'
import { PANEL_PORT } from '@elysian/contracts'
import { useEffect, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { Search, X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'
import { FIREWALL_INPUT_CLASS } from './firewallFormParts'

/** 弹窗打开期间的轮询节奏：新封锁的 IP 由此进入通知。 */
const SCAN_POLL_MS = 5000

/*
 * 面板端口由 PanelAdapter 提供，演示时使用契约默认值，服务端同步保护实际配置：
 * 把它加进监控会把正常访问面板的连接也计入封禁判据，人先被锁在外面。
 * 客户端与服务端同规则拒绝，两侧文案一致。
 */
/**
 * 端口防扫描弹窗：开关、可编辑配置（端口/窗口/阈值/封禁时长）、四项统计与当前封锁的 IP 列表。
 * Docker 运行时为真实实现（内核 xt_recent 双名单 jail + iptables 计数），
 * 宿主机本地开发是演示样例。列表带 IP 模糊搜索；打开期间轮询刷新并通知新封锁。
 */

type ConfigDraft = {
  ports: string
  windowSeconds: string
  hitCount: string
  banSeconds: string
}

function draftFromConfig(config: { ports: readonly number[]; windowSeconds: number; hitCount: number; banSeconds: number }): ConfigDraft {
  return {
    ports: config.ports.join(','),
    windowSeconds: `${config.windowSeconds}`,
    hitCount: `${config.hitCount}`,
    banSeconds: `${config.banSeconds}`,
  }
}

export function FirewallScanDialog() {
 const panelGateway = useGateway()
 useEffect(() => { void usePanelStore.getState().load(panelGateway) }, [panelGateway])
  const gateway = useGateway()
  const status = useFirewallStore((s) => s.scanStatus)
  const scanError = useFirewallStore((s) => s.scanError)
  const openScan = useFirewallStore((s) => s.openScan)
  const scan = useFirewallStore((s) => s.scanProtection)
  const closeScan = useFirewallStore((s) => s.closeScan)
  const refreshScan = useFirewallStore((s) => s.refreshScan)
  const toggleScanProtection = useFirewallStore((s) => s.toggleScanProtection)
  const setScanConfig = useFirewallStore((s) => s.setScanConfig)
  const unblockIp = useFirewallStore((s) => s.unblockIp)
  const [ipSearch, setIpSearch] = useState('')
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFromConfig(scan.config))
  const [configError, setConfigError] = useState<string | undefined>(undefined)

  // 打开期间轮询：真实封锁由内核异步发生，界面借此跟进并通知新封锁的 IP。
  useEffect(() => {
    const timer = setInterval(() => void refreshScan(gateway), SCAN_POLL_MS)
    return () => clearInterval(timer)
  }, [gateway, refreshScan])

  // 配置弹层跟随最新数据重置：只有未编辑过的草稿才跟随，正在编辑的不被轮询覆盖。
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) setDraft(draftFromConfig(scan.config))
  }, [scan.config, dirty])

  const stats = scan?.stats

  // 搜索框只接受 IP 地址格式字符（数字与点号，IPv4 最长 15 位）；匹配按子串模糊过滤。
  const onIpSearchChange = (value: string) => {
    setIpSearch(value.replace(/[^0-9.]/g, '').slice(0, 15))
  }
  const keyword = ipSearch.trim()
  const visibleBlocked = (scan?.blocked ?? []).filter((entry) => entry.ip.includes(keyword))

  const submitConfig = () => {
    const ports = draft.ports
      .split(/[，,]/)
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((port) => Number.isFinite(port))
    const windowSeconds = Number(draft.windowSeconds)
    const hitCount = Number(draft.hitCount)
    const banSeconds = Number(draft.banSeconds)
    if (ports.length === 0 || ports.some((port) => port < 1 || port > 65535)) {
      setConfigError('监控端口需为逗号分隔的 1–65535 端口列表')
      return
    }
    if (ports.includes(usePanelStore.getState().info?.ports.frontendPort ?? PANEL_PORT) || ports.includes(usePanelStore.getState().info?.ports.backendPort ?? 48101)) {
      setConfigError('面板端口不允许加入防扫描监控')
      return
    }
    if (!Number.isInteger(windowSeconds) || windowSeconds < 10 || windowSeconds > 3600) {
      setConfigError('判定窗口需为 10–3600 秒')
      return
    }
    if (!Number.isInteger(hitCount) || hitCount < 3 || hitCount > 1000) {
      setConfigError('阈值需为 3–1000 次')
      return
    }
    if (!Number.isInteger(banSeconds) || banSeconds < 60 || banSeconds > 86400) {
      setConfigError('封禁时长需为 60–86400 秒')
      return
    }
    setConfigError(undefined)
    setDirty(false)
    void setScanConfig(gateway, { ports, windowSeconds, hitCount, banSeconds })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeScan() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(44rem,calc(100vh-3rem))] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">端口防扫描</Dialog.Title>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {!isDockerRuntime() ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              ) : null}
              <span className="text-sm font-medium text-fg">端口防扫描</span>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭弹窗"
                className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
              >
                <X aria-hidden size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-fg">
              防扫描开关
              <SwitchToggle
                label="防扫描开关"
                checked={scan?.enabled ?? false}
                disabled={status !== 'ready' || !scan}
                onCheckedChange={(checked) => void toggleScanProtection(gateway, checked)}
              />
            </label>

            {/* 判定口径可配置并持久化在规则文本里；只有防扫描开启时可保存。 */}
            <div className="rounded-lg border border-line bg-surface px-3 py-3">
              <p className="mb-2 text-xs font-medium text-fg-muted">判定口径</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="col-span-2">
                  <label htmlFor="scan-config-ports" className="mb-1 block text-xs text-fg-muted">
                    监控端口（逗号分隔）
                  </label>
                  <input
                    id="scan-config-ports"
                    value={draft.ports}
                    onChange={(event) => {
                      setDirty(true)
                      setDraft((current) => ({ ...current, ports: event.target.value }))
                    }}
                    className={FIREWALL_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label htmlFor="scan-config-window" className="mb-1 block text-xs text-fg-muted">
                    窗口（秒）
                  </label>
                  <input
                    id="scan-config-window"
                    value={draft.windowSeconds}
                    onChange={(event) => {
                      setDirty(true)
                      setDraft((current) => ({ ...current, windowSeconds: event.target.value }))
                    }}
                    inputMode="numeric"
                    className={FIREWALL_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label htmlFor="scan-config-hit" className="mb-1 block text-xs text-fg-muted">
                    阈值（次）
                  </label>
                  <input
                    id="scan-config-hit"
                    value={draft.hitCount}
                    onChange={(event) => {
                      setDirty(true)
                      setDraft((current) => ({ ...current, hitCount: event.target.value }))
                    }}
                    inputMode="numeric"
                    className={FIREWALL_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label htmlFor="scan-config-ban" className="mb-1 block text-xs text-fg-muted">
                    封禁时长（秒）
                  </label>
                  <input
                    id="scan-config-ban"
                    value={draft.banSeconds}
                    onChange={(event) => {
                      setDirty(true)
                      setDraft((current) => ({ ...current, banSeconds: event.target.value }))
                    }}
                    inputMode="numeric"
                    className={FIREWALL_INPUT_CLASS}
                  />
                </div>
              </div>
              {configError ? <p className="mt-2 text-xs text-danger">{configError}</p> : null}
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs text-fg-subtle">
                  窗口内新连接超过阈值即封锁该 IP {Math.round((scan?.config.banSeconds ?? 0) / 60)} 分钟。
                </p>
                <button
                  type="button"
                  onClick={submitConfig}
                  disabled={!scan?.enabled}
                  className="shrink-0 rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
                >
                  保存配置
                </button>
              </div>
            </div>

            {status === 'error' ? (
              <ErrorState title="防扫描数据加载失败" description={scanError} onRetry={() => openScan(gateway)} notify={false} />
            ) : status === 'loading' || status === 'idle' || !scan ? (
              <LoadingState label="正在加载防扫描数据…" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
                  {[
                    { label: '封锁的IP总数', value: stats!.totalBlockedIps },
                    { label: '连接失败总数', value: stats!.totalFailedConnections },
                    { label: '当前封锁IP数', value: stats!.currentBlockedIps },
                    { label: '当前连接失败次数', value: stats!.currentFailedConnections },
                  ].map((item) => (
                    <div key={item.label} className="bg-surface px-3 py-3 text-center">
                      <p className="text-xs text-fg-muted">{item.label}</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-fg">{item.value}</p>
                    </div>
                  ))}
                </div>

                {/* 表格区域高度恒定：空态与有数据不再互相撑跳；行多时表体内滚动、表头钉住。 */}
                <div className="hover-scrollbar h-72 overflow-y-auto overflow-x-hidden rounded-lg border border-line">
                  <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted">
                          <div className="flex items-center gap-2">
                            IP
                            <label htmlFor="scan-ip-search" className="sr-only">
                              搜索 IP
                            </label>
                            <span className="relative inline-flex w-32 items-center">
                              <Search
                                aria-hidden
                                className="pointer-events-none absolute left-1.5 size-3 -translate-y-1/2 text-fg-subtle top-1/2"
                              />
                              <input
                                id="scan-ip-search"
                                value={ipSearch}
                                onChange={(event) => onIpSearchChange(event.target.value)}
                                className="w-full rounded border border-control-line bg-surface-raised py-0.5 pl-6 pr-1.5 text-xs font-normal text-fg transition-colors hover:border-fg-subtle"
                              />
                            </span>
                          </div>
                        </th>
                        <th scope="col" className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted">
                          封锁时间
                        </th>
                        <th scope="col" className="sticky top-0 z-10 w-24 border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.blocked.length === 0 ? (
                        <tr>
                          {/* 空态行撑满固定表体，文本垂直居中，与有数据时高度一致。 */}
                          <td colSpan={3} className="h-[15rem] text-center text-sm text-fg-muted">
                            暂无数据
                          </td>
                        </tr>
                      ) : visibleBlocked.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="h-[15rem] text-center text-sm text-fg-muted">
                            没有匹配的 IP，换个关键字试试
                          </td>
                        </tr>
                      ) : (
                        visibleBlocked.map((entry) => (
                          <tr key={entry.ip}>
                            <td className="border-b border-line px-3 py-2 tabular-nums">{entry.ip}</td>
                            <td className="border-b border-line px-3 py-2 tabular-nums text-fg-muted">
                              {formatDateTime(entry.blockedAt)}
                            </td>
                            <td className="border-b border-line px-3 py-2">
                              <button
                                type="button"
                                onClick={() => void unblockIp(gateway, entry.ip)}
                                className="rounded px-1.5 py-0.5 text-xs text-accent-fg transition-colors hover:bg-accent/10"
                              >
                                解封
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
