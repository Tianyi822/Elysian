import { useEffect, useId, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  SSH_DEFAULT_PORT,
  SSH_LOGIN_RESULT_LABELS,
  SSH_LOGIN_WINDOWS,
  SSH_LOGIN_WINDOW_LABELS,
  evaluateSshPasswordStrength,
} from '@elysian/contracts'
import type { SshLoginStats, SshRootLoginPolicy } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime, formatLoginIp, formatLoginTime } from '../../components/format'
import { RefreshCw, TriangleAlert } from '../../components/icons'
import { SSH_PAGE_SIZE, useSshStore } from '../../stores/sshStore'
import { ACTION_CLASS, INPUT_CLASS, Region, SECONDARY_ACTION_CLASS, Section, SwitchToggle, TablePager } from './sshCardParts'
import { SshKeyCard } from './SshKeyCard'
import { SshKeyCreateDialog } from './SshKeyCreateDialog'
import { SshKeyDialog } from './SshKeyDialog'
import { SshKeyRemoveDialog } from './SshKeyRemoveDialog'
import { SshKeyRevealDialog } from './SshKeyRevealDialog'
import { PasswordStrengthBar, PasswordVisibilityButton, passwordInputClass } from './passwordFieldParts'
import { randomSshPort, randomStrongPassword } from './sshRandom'

/**
 * SSH 管理面板：四张卡排成两列瀑布，高度随内容，不互相拉平。
 * 左列是两张设置卡：SSH 服务（启停与登录方式、登录统计、端口）与 Root 设置（登录策略、密码、密钥）；
 * 右列是两张数据卡：SSH 密钥表与 SSH 登录记录表。
 * 窄屏单列时 DOM 顺序即视觉顺序：服务 → Root → 密钥 → 记录，设置挨着设置、数据挨着数据。
 * 数据来自 SSH adapter：Docker 运行时由 HTTP adapter 真实操作容器内 sshd，
 * 宿主机本地开发是内存演示（工具栏带「演示数据」标识）；动作完成提示按运行时如实描述。
 * 私钥一律只在创建/生成成功后的一次性弹窗里展示，查看弹窗只给公钥、指纹与元信息。
 */

/**
 * 密码强度的三段彩条与联动配色抽到 passwordFieldParts，与用户管理的账号密码共用同一套；
 * 这里只保留各卡自己的排布。空输入不设强度，仍走默认聚焦——键盘焦点始终可见。
 */

function SwitchRow({
  label,
  checked,
  disabled = false,
  layout = 'inline',
  onCheckedChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  /**
   * inline：始终左文右开关（Root 等单行区）。
   * responsive：容器够宽时横排，窄时上文字下开关——服务状态三列共用，避免挤叠。
   */
  layout?: 'inline' | 'responsive'
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={`inline-flex shrink-0 text-sm text-fg ${
        layout === 'responsive'
          ? 'flex-col items-center gap-1.5 @md:flex-row @md:gap-2 @md:whitespace-nowrap'
          : 'items-center gap-2 whitespace-nowrap'
      } ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <span>{label}</span>
      <SwitchToggle
        label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

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

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载 SSH 配置…" />
  }

  if (status === 'error') {
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
      {operationError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-3 text-xs text-danger"><p className="min-w-0 flex-1">{operationError}</p><button type="button" className="rounded border border-line px-3 py-1.5 text-fg" onClick={() => void load(gateway)}>重新读取状态</button></div> : null}
      {/* 两列瀑布：左设置右数据，列各自按内容堆叠、矮卡不被邻列拉平；
          Root 卡的密码/密钥区收起时左列自然变矮，不把数据表拉出卡内空白。 */}
      <div className="flex flex-col gap-4">
        {/* SSH 动作只在容器内真实执行；宿主机本地开发是内存演示，与防火墙面板同一标识明示出来。 */}
        {!isDockerRuntime() ? (
          <div
            role="status"
            className="flex items-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-fg-muted"
          >
            演示数据
          </div>
        ) : null}
        <div className="grid items-start gap-4 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <ServiceCard />
            <RootCard />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <SshKeyCard />
            <SshLoginRecordsCard />
          </div>
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

/** SSH 登录记录卡：按时间倒序列出登录事实，只读，界面不产生也不修改它。 */
function SshLoginRecordsCard() {
  const loginRecords = useSshStore((s) => s.loginRecords)
  const page = useSshStore((s) => s.recordPage)
  const setRecordPage = useSshStore((s) => s.setRecordPage)

  const pageCount = Math.max(1, Math.ceil(loginRecords.length / SSH_PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageRows = loginRecords.slice((safePage - 1) * SSH_PAGE_SIZE, safePage * SSH_PAGE_SIZE)

  return (
    <Section title="SSH 登录记录">
      <div
        role="region"
        aria-label="SSH 登录记录表"
        // 只读表格内部没有可聚焦的控件，因此这个滚动容器自己必须可聚焦：
        // 否则窄屏下键盘用户没有任何办法把后面的列滚出来。
        tabIndex={0}
        className="min-w-0 overflow-x-auto"
      >
        {/* 最小宽度加首列钉住：窄屏下整表横向滚动，来源地址始终留在左边，其余列滚出来看。
            32rem 是五列都不折行的下限，再小就在宽桌上也冒出用不上的横向滚动条。 */}
        <table className="w-full min-w-[32rem] table-fixed border-separate border-spacing-0 text-left text-sm">
          {/* 五列按内容需要分宽度：登录时间最长（精确到秒），端口、状态、用户都只有几个字符，
              平均分会让时间列折行、把行高撑起来。 */}
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[34%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
          </colgroup>
          <thead>
            <tr>
              {['IP 地址', '登录时间', '端口', '状态', '用户'].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  // 首列钉住、其内容与卡片左边齐平；其余列留出左内距，
                  // 免得「登录时间」紧贴在钉住列右侧的分割线上。
                  className={`border-b border-line pb-2 text-xs font-medium text-fg-muted ${
                    index === 0 ? 'sticky left-0 z-20 border-r bg-surface' : 'pl-3'
                  }`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loginRecords.length === 0 ? (
              <tr>
                <td colSpan={5} className="border-b border-line py-8 text-center text-sm text-fg-muted">
                  还没有登录记录
                </td>
              </tr>
            ) : (
              pageRows.map((record) => {
                // 回环来源（容器内自连）显示「本机」，原始地址放悬停提示：列里不再出现裸 ::1。
                const ipLabel = formatLoginIp(record.ip)
                return (
                <tr key={record.id} className="group transition-colors hover:bg-surface-raised">
                  {/* 钉住的列要自带不透明底，否则滚动时后面的内容会从它下面透出来；
                      行悬停时它也跟着步进一级，颜色与整行一致。 */}
                  <td
                    title={ipLabel === record.ip ? undefined : record.ip}
                    className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-surface py-2.5 pr-3 tabular-nums text-fg group-hover:bg-surface-raised"
                  >
                    {ipLabel}
                  </td>
                  <td className="border-b border-line py-2.5 pl-3 tabular-nums text-fg-muted">
                    {formatLoginTime(record.at)}
                  </td>
                  <td className="border-b border-line py-2.5 pl-3 tabular-nums text-fg-muted">{record.port}</td>
                  <td className="border-b border-line py-2.5 pl-3">
                    <StatusTag
                      label={SSH_LOGIN_RESULT_LABELS[record.result]}
                      tone={record.result === 'succeeded' ? 'success' : 'danger'}
                    />
                  </td>
                  <td className="border-b border-line py-2.5 pl-3 text-fg-muted">{record.user}</td>
                </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <TablePager
        label="登录记录分页"
        summary={`共 ${loginRecords.length} 条登录记录`}
        page={safePage}
        pageCount={pageCount}
        pageSize={SSH_PAGE_SIZE}
        onPageChange={setRecordPage}
      />
    </Section>
  )
}

/** SSH 服务卡：服务启停与登录方式、监听端口两个设置区，外加登录统计。 */
function ServiceCard() {
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
    <Section title="SSH 服务">
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
        </div>
      </Region>

      <LoginStatsRegion stats={overview.stats} enabled={enabled} />

      <Region title="监听端口" labelFor={portInputId}>
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
          <button
            type="button"
            onClick={() => requestPortSave()}
            disabled={savingPort}
            className={ACTION_CLASS}
          >
            保存端口
          </button>
        </div>
        <p className={`mt-3 text-xs ${portError ? 'text-danger' : 'text-fg-subtle'}`}>
          {portError ?? '当前 SSH 协议所使用的端口，默认为 22。'}
        </p>
      </Region>
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
      text: '防火墙处于启用状态时会为新端口自动补一条 tcp 放行规则；旧端口的规则保留不动，需要时请到防火墙页自行清理。',
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
function SshPortConfirmDialog() {
  const gateway = useGateway()
  const pendingPort = useSshStore((s) => s.pendingPort)
  const currentPort = useSshStore((s) => s.settings?.port)
  const savingPort = useSshStore((s) => s.savingPort)
  const confirmPortSave = useSshStore((s) => s.confirmPortSave)
  const cancelPortSave = useSshStore((s) => s.cancelPortSave)

  if (pendingPort === undefined || currentPort === undefined) return null
  const consequences = sshPortConfirmConsequences(pendingPort, isDockerRuntime())

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) cancelPortSave() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
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
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => cancelPortSave()}
              className={SECONDARY_ACTION_CLASS}
            >
              取消
            </button>
            <button
              type="button"
              disabled={savingPort}
              onClick={() => void confirmPortSave(gateway)}
              className={ACTION_CLASS}
            >
              确认保存
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * 登录统计区域：今日、昨日与近 7 天三个窗口的成功与失败计数，窗口与结果的文案都取契约标签表。
 * 契约约定服务未启用时界面不给统计——没有服务就没有登录记录，空态说明代替零值统计。
 */
function LoginStatsRegion({ stats, enabled }: { stats: SshLoginStats; enabled: boolean }) {
  return (
    <Region title="登录统计">
      {enabled ? (
        <table className="w-full table-fixed border-separate border-spacing-0 text-center text-sm">
          {/* 定宽三列：窗口名、成功、失败；表头与单元格全部居中，计数用等宽数字，翻动时列宽不跳。 */}
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[30%]" />
            <col className="w-[30%]" />
          </colgroup>
          <thead>
            <tr>
              {['时间窗口', SSH_LOGIN_RESULT_LABELS.succeeded, SSH_LOGIN_RESULT_LABELS.failed].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="border-b border-line pb-2 text-center text-xs font-medium text-fg-muted"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SSH_LOGIN_WINDOWS.map((window) => (
              <tr key={window}>
                <th
                  scope="row"
                  className="border-b border-line py-2 text-center text-xs font-medium text-fg-muted"
                >
                  {SSH_LOGIN_WINDOW_LABELS[window]}
                </th>
                <td className="border-b border-line py-2 text-center tabular-nums text-fg">
                  {stats[window].succeeded}
                </td>
                {/* 失败计数带危险色：爆破尝试是这块的重点信号，文字与颜色一起表达。 */}
                <td className="border-b border-line py-2 text-center tabular-nums text-danger">
                  {stats[window].failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-fg-subtle">SSH 服务未启用，没有登录记录可统计。</p>
      )}
    </Region>
  )
}

/**
 * Root 登录的收起提示：按策略与全局登录方式组合出原因。
 * 面板只写 yes/no 两档；prohibit-password 与 forced-commands-only 是外部配置（含演示种子）才有的值，
 * 读到时如实解释，重新开关一次「允许 Root 登录」即回到面板可写的两档。
 */
function rootHiddenHints(
  policy: SshRootLoginPolicy,
  settings: { passwordAuthEnabled: boolean; keyAuthEnabled: boolean },
): string[] {
  if (policy === 'no') return ['Root 登录已禁止：Root 密码与 Root 密钥设置已隐藏。']
  const hints: string[] = []
  if (policy === 'forced-commands-only') {
    hints.push(
      '仅允许指定命令：Root 只能用授权文件中带 command= 限制的密钥执行固定命令（常用于备份脚本等自动化场景）；面板生成的普通密钥无法用于此配置，密码与密钥设置已隐藏。',
    )
  }
  if (policy === 'prohibit-password') {
    hints.push(
      settings.passwordAuthEnabled
        ? '当前配置仅允许 Root 以密钥登录：Root 密码设置已隐藏。'
        : '当前配置仅允许 Root 以密钥登录：Root 密码设置已隐藏。重新开关一次「允许 Root 登录」可按全局登录方式重设。',
    )
  }
  if (!settings.keyAuthEnabled) hints.push('全局密钥登录已关闭：Root 密钥设置已隐藏。')
  if (policy === 'yes' && !settings.passwordAuthEnabled) {
    hints.push('全局密码登录已关闭：Root 密码设置已隐藏。')
  }
  return hints
}

/** Root 设置卡：Root 登录开关、Root 密码、Root 密钥三个区域；登录方式由全局开关唯一决定。 */
function RootCard() {
  const gateway = useGateway()
  const rootAuth = useSshStore((s) => s.rootAuth)
  const settings = useSshStore((s) => s.settings)
  const passwordDraft = useSshStore((s) => s.passwordDraft)
  const resetting = useSshStore((s) => s.resettingPassword)
  const savingPolicy = useSshStore((s) => s.savingPolicy)
  const generatingRootKey = useSshStore((s) => s.generatingRootKey)
  const setLoginPolicy = useSshStore((s) => s.setLoginPolicy)
  const setPasswordDraft = useSshStore((s) => s.setPasswordDraft)
  const resetPassword = useSshStore((s) => s.resetPassword)
  const createRootKey = useSshStore((s) => s.createRootKey)
  const openKeyView = useSshStore((s) => s.openKeyView)
  const passwordInputId = useId()
  const [passwordVisible, setPasswordVisible] = useState(false)

  if (!rootAuth || !settings) return null
  const strength = passwordDraft ? evaluateSshPasswordStrength(passwordDraft) : undefined
  const rootKey = rootAuth.key
  // 密码区要策略为 yes 且全局密码登录开；密钥区要非禁止档且全局密钥登录开——
  // 登录方式唯一由 SSH 服务卡的全局开关决定，这里只决定 root 这个账号可不可登。
  const rootAllowed = rootAuth.policy !== 'no'
  const passwordUsable = rootAuth.policy === 'yes' && settings.passwordAuthEnabled
  const panelKeyUsable =
    rootAuth.policy !== 'no' && rootAuth.policy !== 'forced-commands-only' && settings.keyAuthEnabled
  const hiddenHints = rootHiddenHints(rootAuth.policy, settings)

  return (
    <Section title="Root 设置">
      <Region title="Root 登录">
        <SwitchRow
          label="允许 Root 登录"
          checked={rootAllowed}
          disabled={savingPolicy}
          onCheckedChange={(checked) => void setLoginPolicy(gateway, checked ? 'yes' : 'no')}
        />
        <p className="mt-3 text-xs text-fg-subtle">推荐使用密钥登录并关闭密码登录，安全性更高。</p>
        {hiddenHints.map((hint) => (
          <p key={hint} className="mt-1.5 text-xs text-fg-subtle">
            {hint}
          </p>
        ))}
        {/* 外部档 prohibit-password 且全局密码已开：重设只差一步，按钮直接到位，
            不再要求用户「先关再开」开关仪式。 */}
        {rootAuth.policy === 'prohibit-password' && settings.passwordAuthEnabled ? (
          <button
            type="button"
            onClick={() => void setLoginPolicy(gateway, 'yes')}
            disabled={savingPolicy}
            className={`${SECONDARY_ACTION_CLASS} mt-3`}
          >
            按全局登录方式重设
          </button>
        ) : null}
      </Region>

      {passwordUsable ? (
        <Region
          title="Root 密码"
          labelFor={passwordInputId}
          aside={
            <p className="shrink-0 text-xs tabular-nums text-fg-subtle">
              上次重置：{rootAuth.passwordResetAt ? formatDateTime(rootAuth.passwordResetAt) : '—'}
            </p>
          }
        >
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                id={passwordInputId}
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                placeholder="请输入新密码"
                className={passwordInputClass(strength)}
              />
              <PasswordVisibilityButton
                visible={passwordVisible}
                onToggle={setPasswordVisible}
              />
            </div>
            <IconButton
              label="随机生成强密码"
              formControl
              onPress={() => setPasswordDraft(randomStrongPassword())}
            >
              <RefreshCw aria-hidden size={14} />
            </IconButton>
            <button
              type="button"
              onClick={() => void resetPassword(gateway)}
              disabled={resetting}
              className={ACTION_CLASS}
            >
              重置密码
            </button>
          </div>
          {strength ? (
            /* 强度内联在输入框正下：三段彩条（红黄绿逐段点亮）+ 条旁等级字，不单独占一行说明。 */
            <div className="mt-2">
              <PasswordStrengthBar strength={strength} />
            </div>
          ) : null}
          <p className="mt-2 text-xs text-fg-subtle">
            建议使用复杂度高的密码；修改后请及时保存，刷新页面会清空密码框。
          </p>
        </Region>
      ) : null}

      {panelKeyUsable ? (
        <Region title="Root 密钥">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            {/* 生成/重新生成同一动作：已存在时按一次，新公钥替换旧公钥，私钥只在随后的弹窗里出现一次。 */}
            <button
              type="button"
              onClick={() => void createRootKey(gateway)}
              disabled={generatingRootKey}
              className={ACTION_CLASS}
            >
              {rootKey ? '重新生成' : '生成密钥'}
            </button>
            {rootKey ? (
              <button
                type="button"
                onClick={() => openKeyView('查看 Root 密钥', rootKey)}
                className={SECONDARY_ACTION_CLASS}
              >
                查看密钥
              </button>
            ) : null}
          </div>
          <p className="text-xs text-fg-subtle">
            {isDockerRuntime()
              ? '重新生成会替换 root 授权文件首行的公钥，旧私钥随之作废。'
              : '演示密钥 · 不对应任何真实主机'}
          </p>
        </div>
        {/* 密钥的元数据与公钥按标签取值两列排：公钥单行很长，卡内截断、全文在弹窗里给。 */}
        {rootKey ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-fg-muted">算法</dt>
            <dd className="truncate text-fg">{rootKey.algorithm}</dd>
            <dt className="text-fg-muted">指纹</dt>
            <dd className="truncate font-mono text-fg" title={rootKey.fingerprint}>
              {rootKey.fingerprint}
            </dd>
            <dt className="text-fg-muted">生成于</dt>
            <dd className="tabular-nums text-fg">{formatDateTime(rootKey.createdAt)}</dd>
            <dt className="text-fg-muted">公钥</dt>
            <dd className="truncate font-mono text-fg" title={rootKey.publicKey}>
              {rootKey.publicKey}
            </dd>
          </dl>
        ) : (
          /* root 的 authorized_keys 为空：如实呈现尚未生成，不编造密钥材料。 */
          <p className="mt-3 text-xs text-fg-subtle">尚未生成：root 账号的授权文件里还没有任何公钥。</p>
        )}
        <p className="mt-2 text-xs text-fg-subtle">
          生成后私钥只在弹窗里展示这一次，请当场下载保存。
        </p>
      </Region>
      ) : null}
    </Section>
  )
}

/**
 * Root 密码重置成功的提醒弹窗：改密影响的是下一次 SSH 登录，值得比一条通知更强的停顿，
 * 用户确认「知道了」后关闭。
 */
function PasswordResetNoticeDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-bg p-4 shadow-2xl"
        >
          <Dialog.Title className="text-sm font-medium text-fg">Root 密码已重置</Dialog.Title>
          <p className="mt-2 text-xs text-fg-muted">下一次 SSH 登录需要使用新密码。</p>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={onClose} className={ACTION_CLASS}>
              知道了
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
