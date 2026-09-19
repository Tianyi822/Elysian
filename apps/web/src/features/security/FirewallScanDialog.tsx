import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { useState } from 'react'
import { SCAN_HIT_COUNT, SCAN_MONITOR_PORTS, SCAN_WINDOW_SECONDS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { Search, X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'

/**
 * 端口防扫描弹窗：开关、四项统计与当前封锁的 IP 列表（每行可解封）。
 * Docker 运行时为真实实现（内核 xt_recent 封锁 + iptables 计数），
 * 宿主机本地开发是演示样例：历史累计很大、当前封锁为空。
 */
export function FirewallScanDialog() {
  const gateway = useGateway()
  const status = useFirewallStore((s) => s.scanStatus)
  const scan = useFirewallStore((s) => s.scanProtection)
  const closeScan = useFirewallStore((s) => s.closeScan)
  const toggleScanProtection = useFirewallStore((s) => s.toggleScanProtection)
  const unblockIp = useFirewallStore((s) => s.unblockIp)

  const stats = scan?.stats
  const [ipSearch, setIpSearch] = useState('')

  // 搜索框只接受 IP 地址格式字符（数字与点号，IPv4 最长 15 位）；匹配按子串模糊过滤。
  const onIpSearchChange = (value: string) => {
    setIpSearch(value.replace(/[^0-9.]/g, '').slice(0, 15))
  }
  const keyword = ipSearch.trim()
  const visibleBlocked = (scan?.blocked ?? []).filter((entry) => entry.ip.includes(keyword))

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeScan() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
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
              <Switch.Root
                checked={scan?.enabled ?? false}
                onCheckedChange={(checked) => void toggleScanProtection(gateway, checked)}
                disabled={status !== 'ready' || !scan}
                aria-label="防扫描开关"
                className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line bg-surface-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[disabled]:opacity-50"
              >
                <Switch.Thumb className="ml-0.5 block size-3.5 rounded-full bg-fg-muted transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-white" />
              </Switch.Root>
            </label>
            {/* 防扫描的真实判定口径：哪些端口被监控、多久内多少次新连接触发封锁。 */}
            <p className="-mt-2 text-xs text-fg-subtle">
              监控端口 {SCAN_MONITOR_PORTS.split(',').join(' · ')}：{SCAN_WINDOW_SECONDS}{' '}
              秒内新连接超过 {SCAN_HIT_COUNT} 次即封锁该 IP，解除开关后自动恢复放行。
            </p>

            {status === 'loading' || status === 'idle' || !scan ? (
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
                                className="w-full rounded border border-line bg-surface-raised py-0.5 pl-6 pr-1.5 text-xs font-normal text-fg transition-colors hover:border-fg-subtle"
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
                                className="rounded px-1.5 py-0.5 text-xs text-accent transition-colors hover:bg-accent/10"
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
