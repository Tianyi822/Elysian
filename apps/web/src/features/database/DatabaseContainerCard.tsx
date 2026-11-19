import { DATABASE_CONTAINER_STATUS_LABELS, type DatabaseContainerInstance, type DatabaseContainerStatus, type DatabasePortMapping } from '@elysian/contracts'
import { Cable, ChevronRight, Container, KeyRound, MemoryStick } from '../../components/icons'
import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useClipboardCopy } from '../../components/CopyButton'
import { formatDateTime } from '../../components/format'
import { StatusTag, type StatusTone } from '../../components/StatusTag'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useMessageStore } from '../../stores/messageStore'
import { captureAuthGeneration } from '../../utils/authGeneration'
import { messageOf } from '../../utils/errorMessage'
import { DatabaseMark, FileStat } from './databaseCardParts'
import type { DatabaseCardView } from './projectDatabaseCard'

const CONTAINER_STATUS_TONE: Record<DatabaseContainerStatus, StatusTone> = {
  running: 'success',
  stopped: 'danger',
  missing: 'warning',
}

/** 数据库容器卡：连接地址、端口、网络、卷、凭据状态与容器内存全部来自 Docker 事实。 */
export function DatabaseContainerCard({
  row,
  view,
  removing,
  refreshing = false,
  onJump,
  onRemove,
}: {
  row: DatabaseContainerInstance
  view: DatabaseCardView
  removing: boolean
  /** 列表刷新在途：保留卡片内容并标记可访问的忙碌状态。 */
  refreshing?: boolean
  onJump(): void
  onRemove(): void
}) {
  const gateway = useGateway()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [actionError, setActionError] = useState('')
  const [powerBusy, setPowerBusy] = useState(false)
  useFeedbackMessage(actionError)
  const { copy: copyCredential } = useClipboardCopy()

  const performAction = async (action: () => Promise<unknown>, message: string) => {
    const auth = captureAuthGeneration()
    setActionError('')
    try {
      await action()
      if (auth !== captureAuthGeneration()) return
      useMessageStore.getState().notify({ tone: 'success', message })
      await useDatabaseStore.getState().refreshAfterMutation(gateway, 'container')
    } catch (error) {
      if (auth === captureAuthGeneration()) setActionError(messageOf(error, '数据库操作失败'))
    }
  }

  const revealAndCopy = async (field: 'username' | 'password') => {
    const auth = captureAuthGeneration()
    try {
      const secret = await gateway.databases.reveal(row.id)
      if (auth !== captureAuthGeneration()) return
      await copyCredential(secret[field], field === 'username' ? '管理员用户名' : '管理员密码')
      if (auth === captureAuthGeneration()) setActionError('')
    } catch (error) {
      if (auth === captureAuthGeneration()) setActionError(messageOf(error, '读取管理员凭据失败'))
    }
  }

  const powerAction: 'start' | 'stop' = row.status === 'running' ? 'stop' : 'start'
  const togglePower = async () => {
    const auth = captureAuthGeneration()
    setActionError('')
    setPowerBusy(true)
    try {
      await gateway.containers.requestAction(row.containerId, powerAction)
      if (auth !== captureAuthGeneration()) return
      useMessageStore.getState().notify({ tone: 'success', message: powerAction === 'stop' ? `已停止容器 ${row.name}` : `已启动容器 ${row.name}` })
      await useDatabaseStore.getState().refreshAfterMutation(gateway, 'container')
    } catch (error) {
      if (auth === captureAuthGeneration()) setActionError(messageOf(error, '容器操作失败'))
    } finally {
      if (auth === captureAuthGeneration()) setPowerBusy(false)
    }
  }

  const address = row.address ? `${row.address.host}:${row.address.port}` : undefined
  const missing = row.status === 'missing'
  const hasManagedVolume = row.source === 'managed' && Boolean(row.volumeName)
  const removeLabel = missing ? (hasManagedVolume ? '删除专属卷及登记' : '清理登记') : '删除容器及数据'

  return (
    <article
      aria-label={`${row.engine} 数据库容器 ${row.name}`}
      aria-busy={refreshing}
      className="@container flex h-full flex-col gap-3 panel-surface p-4 md:p-5"
    >
      {/* 头部是两行网格：图标跨两行；第一行容器名对状态标签，第二行版本对更新时间——左右同行同基线。 */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <div className="row-span-2 flex items-center">
          <DatabaseMark engine={row.engine} />
        </div>
        <h3 className="truncate text-sm font-semibold">{row.name}</h3>
        <StatusTag label={DATABASE_CONTAINER_STATUS_LABELS[row.status]} tone={CONTAINER_STATUS_TONE[row.status]} />
        <p className="truncate text-xs text-fg-muted">
          {row.engine} · {row.version}
        </p>
        <time dateTime={row.updatedAt} className="whitespace-nowrap text-xs text-fg-subtle">
          更新于 {formatDateTime(row.updatedAt)}
        </time>
      </div>
      {missing ? (
        <p className="text-xs text-warning">
          {hasManagedVolume ? `可清理残留的专属卷 ${row.volumeName} 及登记。` : '容器已从 Docker 移除，可清理面板登记。'}
        </p>
      ) : (
        <>
          {/* 镜像行：完整引用取行自带的 Docker 事实；点击就地打开容器详情（端口与卷详情的载体）。 */}
          <Button unstyled
            type="button"
            onClick={onJump}
            disabled={view.kind !== 'container' || view.missingContainer}
            title={view.kind === 'container' && !view.missingContainer ? `打开容器 ${row.name} 的详情` : '容器详情不可用'}
            className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Container aria-hidden size={14} className="shrink-0 text-fg-subtle" />
            <span className="hidden shrink-0 @sm:inline">镜像</span>
            {view.kind === 'container' && view.missingContainer ? (
              <span className="min-w-0 flex-1 truncate text-fg-subtle">容器详情不可用</span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-fg" title={view.kind === 'container' ? view.imageLabel : undefined}>
                  {view.kind === 'container' ? view.imageLabel : ''}
                </span>
                <ChevronRight aria-hidden size={14} className="shrink-0 text-fg-subtle" />
              </>
            )}
          </Button>

          {/* 指标格随卡片实际宽度分栏：三列布局下卡片窄、指标竖排，宽卡才三格横排（容器查询而非视口断点）。 */}
          <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
            <FileStat icon={<Cable aria-hidden size={14} />} label="连接地址" value={address ?? '不可用'} />
            <FileStat icon={<MemoryStick aria-hidden size={14} />} label="容器内存" value={row.memory ? `${(row.memory.usedGb * 1024).toFixed(1)} MB` : '不可用'} />
            <FileStat
              icon={<KeyRound aria-hidden size={14} />}
              label="管理员凭据"
              value={row.credentialsVerified ? row.credentialUsername || '已核验' : '未核验'}
            />
          </div>
          {/* 端口、网络与卷直接取 Docker inspect 事实；每行单值截断，完整内容放 title。 */}
          <dl className="space-y-1 text-xs">
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-fg-subtle">端口</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-fg" title={formatPorts(row.ports)}>
                {formatPorts(row.ports)}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-fg-subtle">网络</dt>
              <dd className="min-w-0 flex-1 truncate text-fg" title={row.networks.join('、')}>
                {row.networks.join('、') || '—'}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-fg-subtle">卷</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-fg" title={row.volumeName ?? ''}>
                {row.volumeName ?? '未挂载专属卷'}
              </dd>
            </div>
          </dl>
          {row.needsAttention ? <div className="rounded-lg border border-warning/40 p-2 text-xs text-warning"><p>容器尚未核对完成。修复容器后可重新核对；不再使用时可删除容器及数据。</p><div className="mt-2 flex gap-2"><Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.reconcile(row.id), `数据库容器 ${row.name} 已重新核对`)} className="rounded border border-line px-2 py-1">重新核对</Button></div></div> : null}
        </>
      )}

      {/* 动作行沉底：卡片因同列内容高度不齐被拉伸时，操作区贴住卡底。 */}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {/* 管理员凭据只在用户点击复制时经 reveal 端点按需读取；未登记容器标「未核验」，不摆复制按钮。 */}
        {row.credentialsVerified ? (
          <>
            <Button variant="outline" type="button" onClick={() => void revealAndCopy('username')} title="从服务端读取并复制管理员用户名" className="rounded border border-line px-2 py-1 text-xs">复制用户名</Button>
            <Button variant="outline" type="button" onClick={() => void revealAndCopy('password')} title="从服务端读取并复制管理员密码" className="rounded border border-line px-2 py-1 text-xs">复制密码</Button>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!missing ? <Button variant="outline"
            type="button"
            onClick={() => void togglePower()}
            disabled={powerBusy || removing}
            className="action-button shrink-0 gap-1.5 border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {powerAction === 'stop' ? '停止' : '启动'}
          </Button> : null}
          {missing || hasManagedVolume ? <Button variant="destructive" type="button" onClick={() => setConfirmRemove(true)} disabled={removing} className="rounded-lg border border-danger/40 px-2 py-1.5 text-xs text-danger">{removeLabel}</Button> : null}
        </div>
      </div>
      {confirmRemove ? (
        <ConfirmDialog
          title={missing ? `${removeLabel}？` : '删除容器及全部数据？'}
          description={
            <p className="mt-2 text-xs text-danger">
              {missing ? (hasManagedVolume ? `将删除 ${row.name} 的残留专属卷及面板登记。卷内数据无法恢复。` : `将清理 ${row.name} 的面板登记。`) : `将删除数据库容器 ${row.name} 及其专属持久卷，全部数据无法恢复。此操作无法撤销。`}
            </p>
          }
          danger confirmLabel={`确认${removeLabel}`}
          cancelClassName="rounded border border-line px-3 py-1.5 text-xs"
          confirmClassName="rounded border border-danger px-3 py-1.5 text-xs text-danger"
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => { setConfirmRemove(false); onRemove() }}
        />
      ) : null}
    </article>
  )
}

/** 端口映射列表：宿主 IP + 宿主端口 → 容器端口/协议，全部缺省时只报容器端口。 */
function formatPorts(ports: readonly DatabasePortMapping[]): string {
  if (ports.length === 0) return '未发布端口'
  return ports.map((port) => {
    const host = port.hostPort === undefined
      ? undefined
      : port.hostIp ? `${port.hostIp}:${port.hostPort}` : `${port.hostPort}`
    return host ? `${host}→${port.containerPort}/${port.protocol}` : `${port.containerPort}/${port.protocol}`
  }).join('、')
}
