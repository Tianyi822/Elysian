import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { DemoBadge } from '../../components/DemoBadge'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useSilentPolling } from '../../components/useSilentPolling'
import { useSshStore } from '../../stores/sshStore'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { SshDataCard } from './SshDataCard'
import { SshKeyCreateDialog } from './SshKeyCreateDialog'
import { SshKeyDialog } from './SshKeyDialog'
import { SshKeyRemoveDialog } from './SshKeyRemoveDialog'
import { SshKeyRevealDialog } from './SshKeyRevealDialog'
import { PasswordResetNoticeDialog, SshRootCard } from './SshRootCard'
import { SshPortConfirmDialog, SshServiceCard } from './SshServiceCard'

/**
 * SSH 管理面板：设置与数据排成两列，高度随内容，不互相拉平。
 * 左列是两张设置卡：SSH 服务（启停与登录方式、登录统计、端口）与 Root 设置（登录策略、密码、密钥）；
 * 右列通过共享胶囊页签切换 SSH 密钥表与 SSH 登录记录表，两表保留各自数据与交互状态。
 * 窄屏单列时 DOM 顺序即视觉顺序：服务 → Root → 当前数据表。
 * 数据来自 SSH adapter：Docker 运行时由 HTTP adapter 真实操作容器内 sshd，
 * 宿主机本地开发是内存演示（工具栏带「演示数据」标识）；动作完成提示按运行时如实描述。
 * 私钥一律只在创建/生成成功后的一次性弹窗里展示，查看弹窗只给公钥、指纹与元信息。
 */
export function SshPanel() {
  const gateway = useGateway()
  const status = useSshStore((s) => s.status)
  const errorMessage = useSshStore((s) => s.errorMessage)
  const operationError = useSshStore((s) => s.operationError)
  const createKeyOpen = useSshStore((s) => s.createKeyOpen)
  const viewKey = useSshStore((s) => s.viewKey)
  const closeKeyView = useSshStore((s) => s.closeKeyView)
  const revealKey = useSshStore((s) => s.revealKey)
  const closeRevealKey = useSshStore((s) => s.closeRevealKey)
  const passwordResetNotice = useSshStore((s) => s.passwordResetNotice)
  const closePasswordResetNotice = useSshStore((s) => s.closePasswordResetNotice)
  const load = useSshStore((s) => s.load)
  const refresh = useSshStore((s) => s.refresh)
  const overview = useSshStore((s) => s.overview)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])
  useSilentPolling(() => refresh(gateway), { intervalMs: 5_000, onFocus: () => load(gateway) })

  if (!overview && (status === 'loading' || status === 'idle')) {
    return <LoadingState label="正在加载 SSH 配置…" />
  }

  if (!overview && status === 'error') {
    return (
      <ErrorState
        title="SSH 数据加载失败"
        description={errorMessage}
        onRetry={() => void load(gateway)}
      />
    )
  }

  return (
    <>
      {operationError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-3 text-xs text-danger"><p className="min-w-0 flex-1">{operationError}</p><Button variant="outline" type="button" className="rounded border border-line px-3 py-1.5 text-fg" onClick={() => void load(gateway)}>重新读取状态</Button></div> : null}
      {/* 两列瀑布：左设置右数据，列各自按内容堆叠、矮卡不被邻列拉平；
          Root 卡的密码/密钥区收起时左列自然变矮，不把数据表拉出卡内空白。 */}
      <div className="@container flex flex-col gap-4">
        {/* SSH 动作只在容器内真实执行；宿主机本地开发是内存演示，与防火墙面板同一标识明示出来。 */}
        {!isDockerRuntime() ? (
          <DemoBadge as="div" className="flex items-center panel-surface px-4 py-2.5 text-sm text-fg-muted" />
        ) : null}
        <div className="relative grid items-start gap-4 @min-[44rem]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <SshServiceCard />
            {overview?.enabled ? <SshRootCard /> : null}
          </div>
          <SshDataCard enabled={overview?.enabled ?? false} />
        </div>
      </div>
      {createKeyOpen ? <SshKeyCreateDialog /> : null}
      <SshKeyRemoveDialog />
      <SshPortConfirmDialog />
      {viewKey ? (
        <SshKeyDialog title={viewKey.title} material={viewKey.material} onClose={closeKeyView} />
      ) : null}
      {revealKey ? (
        <SshKeyRevealDialog
          title={revealKey.title}
          account={revealKey.account}
          keyName={revealKey.keyName}
          material={revealKey.material}
          onClose={closeRevealKey}
        />
      ) : null}
      {passwordResetNotice ? <PasswordResetNoticeDialog onClose={closePasswordResetNotice} /> : null}
    </>
  )
}
