import { useId } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  SSH_DEFAULT_PORT,
  SSH_LOGIN_RESULT_LABELS,
  SSH_LOGIN_WINDOWS,
  SSH_LOGIN_WINDOW_LABELS,
  type SshLoginStats,
  type SshOverview,
} from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { formatDateTime } from '../../components/format'
import { IconButton } from '../../components/IconButton'
import { RefreshCw, TriangleAlert } from '../../components/icons'
import { useSshStore } from '../../stores/sshStore'
import { ACTION_CLASS, INPUT_CLASS, Region, SECONDARY_ACTION_CLASS, Section, SwitchRow } from './sshCardParts'
import { randomSshPort } from './sshRandom'
import { SshRefreshButton, SshRefreshError } from './SshRefresh'

export function SshServiceCard() {
  const gateway = useGateway()
  const overview = useSshStore((s) => s.overview)
  const settings = useSshStore((s) => s.settings)
  const portDraft = useSshStore((s) => s.portDraft)
  const portError = useSshStore((s) => s.portError)
  const toggling = useSshStore((s) => s.togglingService)
  const savingAuth = useSshStore((s) => s.savingAuth)
  const savingPort = useSshStore((s) => s.savingPort)
  const setServiceEnabled = useSshStore((s) => s.setServiceEnabled)
  const setAuthMethod = useSshStore((s) => s.setAuthMethod)
  const setPortDraft = useSshStore((s) => s.setPortDraft)
  const requestPortSave = useSshStore((s) => s.requestPortSave)
  const portInputId = useId()

  if (!overview || !settings) return null
  const enabled = overview.enabled

  return (
    <Section title="SSH 服务" aside={<SshRefreshButton section="service" />}>
      <SshRefreshError section="service" />
      <Region
        title="服务状态"
        aside={
          <p className="shrink-0 text-xs tabular-nums text-fg-subtle">
            上次变更：{overview.changedAt ? formatDateTime(overview.changedAt) : '—'}
          </p>
        }
      >
        {/* 三列均分、竖线隔开；容器够宽时左文右开关，窄时上文字下开关。 */}
        <div role="group" aria-label="服务开关" className="@container flex items-stretch">
          <div className="flex flex-1 items-center justify-center px-1">
            <SwitchRow
              label="SSH 服务"
              layout="responsive"
              checked={enabled}
              disabled={toggling}
              onCheckedChange={(checked) => void setServiceEnabled(gateway, checked)}
            />
          </div>
          {enabled ? <>
          <span aria-hidden data-separator="switch" className="w-px shrink-0 self-stretch bg-line" />
          <div className="flex flex-1 items-center justify-center px-1">
            <SwitchRow
              label="密码登录"
              layout="responsive"
              checked={settings.passwordAuthEnabled}
              disabled={savingAuth}
              onCheckedChange={(checked) =>
                void setAuthMethod(gateway, { passwordAuthEnabled: checked })
              }
            />
          </div>
          <span aria-hidden data-separator="switch" className="w-px shrink-0 self-stretch bg-line" />
          <div className="flex flex-1 items-center justify-center px-1">
            <SwitchRow
              label="密钥登录"
              layout="responsive"
              checked={settings.keyAuthEnabled}
              disabled={savingAuth}
              onCheckedChange={(checked) => void setAuthMethod(gateway, { keyAuthEnabled: checked })}
            />
          </div>
          </> : null}
        </div>
      </Region>
      {!enabled ? <p className="text-xs text-fg-subtle">SSH 服务已停止；重新开启后可管理登录方式、端口与密钥。</p> : null}
      <LoginStatsRegion stats={overview.stats} logInfo={overview.logInfo} />
      {enabled ? <Region title="监听端口" labelFor={portInputId}>
        <div className="flex items-center gap-2">
          <input
            id={portInputId}
            value={portDraft}
            onChange={(event) => setPortDraft(event.target.value)}
            inputMode="numeric"
            placeholder={`${SSH_DEFAULT_PORT}`}
            className={`${INPUT_CLASS} tabular-nums`}
          />
          <IconButton
            label="随机端口"
            formControl
            onPress={() => setPortDraft(`${randomSshPort()}`)}
          >
            <RefreshCw aria-hidden size={14} />
          </IconButton>
          <Button variant="primary"
            type="button"
            onClick={() => requestPortSave()}
            disabled={savingPort}
            className={ACTION_CLASS}
          >
            保存端口
          </Button>
        </div>
        <p className={`mt-3 text-xs ${portError ? 'text-danger' : 'text-fg-subtle'}`}>
          {portError ?? '当前 SSH 协议所使用的端口，默认为 22。'}
        </p>
      </Region> : null}
    </Section>
  )
}

/** 改端口确认对话里的一条后果：warning 用来单独标出会断掉既有用法的情形。 */
export type SshPortConsequence = { tone: 'info' | 'warning'; text: string }

/**
 * 改端口的后果文案：任何运行时都讲清端口切换与防火墙联动两件事；
 * Docker 运行时再追加一条——容器内 sshd 离开 22 之后，宿主机的 2222→22 端口映射不再指向 sshd，
 * 从宿主机侧联调会直接连不上容器。抽成与运行时无关的纯函数，面板只负责渲染。
 */
export function sshPortConfirmConsequences(
  port: number,
  docker: boolean,
): readonly SshPortConsequence[] {
  const consequences: SshPortConsequence[] = [
    {
      tone: 'info',
      text: '保存后 sshd 只在改后的端口接受连接：既有连接不断，新连接必须指向新端口。',
    },
    {
      tone: 'info',
      text: '防火墙启用时，先核对并添加新端口的 tcp 放行规则，再切换 SSH 监听；检查或放行失败则保留原端口。旧端口的规则保留不动，可到防火墙页清理。',
    },
  ]
  if (docker && port !== SSH_DEFAULT_PORT) {
    consequences.push({
      tone: 'warning',
      text: '容器内的 SSH 不再监听 22，宿主机 2222→22 的端口映射将失效，从宿主机侧连不进容器；联调需保持 22。',
    })
  }
  return consequences
}

/**
 * 改端口的确认对话：端口一旦改掉，旧端口不再接受连接，防火墙那边还要放行新端口，
 * 这两件事先说清再落袋——确认前不发任何请求。Esc 与「取消」都可退出，退出时端口保持原值。
 * 保存失败也不关窗：让用户能直接重试，原因由通知给出。
 */
export function SshPortConfirmDialog() {
  const gateway = useGateway()
  const docker = useSshStore((s) => s.overview?.runtimeMode === 'docker')
  const pendingPort = useSshStore((s) => s.pendingPort)
  const operationError = useSshStore((s) => s.operationError)
  const currentPort = useSshStore((s) => s.settings?.port)
  const savingPort = useSshStore((s) => s.savingPort)
  const confirmPortSave = useSshStore((s) => s.confirmPortSave)
  const cancelPortSave = useSshStore((s) => s.cancelPortSave)

  if (pendingPort === undefined || currentPort === undefined) return null
  const consequences = sshPortConfirmConsequences(pendingPort, docker)

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) cancelPortSave() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">确认修改 SSH 监听端口</Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">
            将要保存的端口：
            {currentPort === pendingPort
              ? `保持 ${pendingPort} 不变`
              : `从 ${currentPort} 改为 ${pendingPort}`}
            。
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {consequences.map((item) => (
              /* 警示带图标：只靠颜色不足以表达「这一条会断掉既有用法」。 */
              <li
                key={item.text}
                className={`flex items-start gap-1.5 text-xs ${
                  item.tone === 'warning' ? 'text-warning' : 'text-fg-muted'
                }`}
              >
                {item.tone === 'warning' ? (
                  <TriangleAlert aria-hidden size={13} className="mt-[2px] shrink-0" />
                ) : null}
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          {operationError ? <p role="alert" className="mt-3 text-xs text-danger">{operationError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline"
              type="button"
              onClick={() => cancelPortSave()}
              className={SECONDARY_ACTION_CLASS}
            >
              取消
            </Button>
            <Button variant="primary"
              type="button"
              disabled={savingPort}
              onClick={() => void confirmPortSave(gateway)}
              className={ACTION_CLASS}
            >
              确认保存
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * 登录统计区域：今日、昨日与近 7 天三个窗口的成功与失败计数，窗口与结果的文案都取契约标签表。
 * 停服保留历史统计；日志不可用时给出原因，不把读取失败当成零值。
 */
function LoginStatsRegion({ stats, logInfo }: { stats: SshLoginStats; logInfo: SshOverview['logInfo'] }) {
  return <Region title="登录统计">
    {logInfo?.status !== 'unavailable' ? <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table aria-label="SSH 登录统计表" className="w-full table-fixed text-center text-sm tabular-nums">
        <colgroup><col className="w-2/5" /><col className="w-[30%]" /><col className="w-[30%]" /></colgroup>
        <thead className="bg-surface-raised text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">时间窗口</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{SSH_LOGIN_RESULT_LABELS.succeeded}</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{SSH_LOGIN_RESULT_LABELS.failed}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line border-t border-line">
          {SSH_LOGIN_WINDOWS.map(window => <tr key={window}>
            <th scope="row" className="px-3 py-3 font-medium text-fg">{SSH_LOGIN_WINDOW_LABELS[window]}</th>
            <td className="px-3 py-3 text-fg-muted">{stats[window].succeeded}</td>
            <td className="px-3 py-3 text-danger">{stats[window].failed}</td>
          </tr>)}
        </tbody>
      </table>
    </div> : <p className="text-xs text-fg-subtle">登录日志不可用，暂时无法统计。</p>}
    {logInfo?.warning ? <p className="text-xs text-warning">{logInfo.warning}</p> : null}
  </Region>
}
