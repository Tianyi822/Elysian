import { useEffect, useId } from 'react'
import type { DockerFirewallInventory } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import { Button } from '../../components/Button'
import { DataTable } from '../../components/DataTable'
import { RefreshButton } from '../../components/RefreshState'
import { StatusTag, type StatusTone } from '../../components/StatusTag'
import { useFirewallStore } from '../../stores/firewallStore'

const guardLabels: Record<DockerFirewallInventory['guard']['state'], [string, StatusTone]> = {
  verified: ['转发接管已核验', 'success'],
  degraded: ['转发接管异常', 'danger'],
  disabled: ['UFW 已停用', 'warning'],
  unsupported: ['宿主转发状态不可核验', 'neutral'],
  unknown: ['转发状态未知', 'warning'],
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })

export function DockerPublishedPorts() {
  const gateway = useGateway()
  const { ports, loading, error, checkedAt, guard } = useFirewallStore(s => s.dockerPorts)
  const refresh = useFirewallStore(s => s.refreshDockerPorts)
  const openCreate = useFirewallStore(s => s.openCreate)
  const titleId = useId()

  useEffect(() => subscribeWhileVisible(() => {
    const read = () => void refresh(gateway)
    read()
    const timer = window.setInterval(read, 10_000)
    return () => window.clearInterval(timer)
  }), [gateway, refresh])

  const [label, tone] = guardLabels[guard?.state ?? 'unknown']
  return (
    <section aria-labelledby={titleId} className="mb-4 min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 id={titleId} className="text-sm font-medium text-fg">Docker 发布端口</h2>
          {(guard || error) && <StatusTag label={label} tone={tone} />}
        </div>
        <RefreshButton label="刷新 Docker 发布端口" busy={loading} onPress={() => void refresh(gateway)} />
      </div>
      {guard?.state === 'degraded' && (
        <p role="status" className="mb-2 text-xs text-danger">
          {guard.kernelVerified ? '当前内核规则已核验，自动同步服务异常。' : '无法核验当前生效的 Docker 转发规则。'}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}。{checkedAt !== undefined ? `显示上次读取的绑定（${timeFormat.format(checkedAt)}）。` : '请在 Docker 恢复后刷新。'}
        </p>
      )}
      {checkedAt !== undefined && ports.length > 0
        ? <DataTable
            rows={ports}
            ariaLabel="Docker 发布端口表"
            minWidth={640}
            maxHeight={240}
            maxCardHeight={240}
            density="compact"
            selectable={false}
            searchPlaceholder="搜索容器、地址或端口"
            showRowCount={false}
            getRowId={port => JSON.stringify([port.containerId, port.hostIp, port.hostPort, port.containerPort, port.protocol])}
            columns={[
              { key: 'containerName', header: '容器', primary: true, width: 'minmax(120px, 1.5fr)' },
              { key: 'hostIp', header: '绑定地址', width: 'minmax(140px, 1.5fr)' },
              { key: 'hostPort', header: '宿主端口', width: 'minmax(85px, 1fr)' },
              { key: 'containerPort', header: '容器端口', width: 'minmax(85px, 1fr)' },
              { key: 'protocol', header: '协议', width: 'minmax(64px, .75fr)' },
              { key: 'action', header: '操作', width: 'minmax(100px, 1fr)', sortable: false, cell: port => {
                const protocol = port.protocol
                if (protocol !== 'tcp' && protocol !== 'udp') return '—'
                return (
                  <Button type="button" variant="outline" size="sm" disabled={Boolean(error)}
                    aria-label={`为 ${port.containerName} ${port.hostIp} ${port.hostPort}/${protocol} 添加规则`}
                    onClick={() => openCreate({ protocol, port: port.hostPort, family: port.hostIp.includes(':') ? 'ipv6' : 'ipv4' })}>
                    添加规则
                  </Button>
                )
              } },
            ]}
          />
        : !error && <p role="status" className="panel-surface px-4 py-3 text-xs text-fg-muted">
            {checkedAt === undefined ? '正在读取 Docker 发布端口…' : '当前没有 Docker 发布端口。'}
          </p>}
    </section>
  )
}
