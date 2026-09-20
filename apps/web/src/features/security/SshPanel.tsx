import { useEffect, useId } from 'react'
import {
  SSH_DEFAULT_PORT,
  SSH_LOGIN_RESULT_LABELS,
  SSH_LOGIN_WINDOWS,
  SSH_LOGIN_WINDOW_LABELS,
  SSH_PASSWORD_STRENGTH_LABELS,
  SSH_ROOT_LOGIN_POLICIES,
  SSH_ROOT_LOGIN_POLICY_LABELS,
  evaluateSshPasswordStrength,
} from '@elysian/contracts'
import type { SshLoginStats, SshPasswordStrength, SshRootLoginPolicy } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime, formatLoginTime } from '../../components/format'
import { RefreshCw, TriangleAlert } from '../../components/icons'
import { SSH_PAGE_SIZE, useSshStore } from '../../stores/sshStore'
import { ACTION_CLASS, INPUT_CLASS, Region, SECONDARY_ACTION_CLASS, Section, SwitchToggle, TablePager } from './sshCardParts'
import { SshKeyCard } from './SshKeyCard'
import { SshKeyCreateDialog } from './SshKeyCreateDialog'
import { SshKeyDialog } from './SshKeyDialog'
import { SshKeyRemoveDialog } from './SshKeyRemoveDialog'
import { SshKeyRevealDialog } from './SshKeyRevealDialog'
import { randomSshPort, randomStrongPassword } from './sshRandom'

/**
 * SSH 管理面板：四张卡排成两行，行内等高。
 * 第一行是设置卡——SSH 服务（启停、登录统计、端口、登录方式）与 Root 设置（登录策略、密码、密钥）；
 * 第二行是列表卡——SSH 密钥（搜索、创建、表格）与 SSH 登录记录。
 * 数据来自 SSH adapter：Docker 运行时由 HTTP adapter 真实操作容器内 sshd，
 * 宿主机本地开发是内存演示（工具栏带「演示数据」标识）；动作完成提示按运行时如实描述。
 * 私钥一律只在创建/生成成功后的一次性弹窗里展示，查看弹窗只给公钥、指纹与元信息。
 */

const STRENGTH_CLASSES: Record<SshPasswordStrength, string> = {
  weak: 'text-danger',
  medium: 'text-warning',
  strong: 'text-success',
}

function SwitchRow({
  label,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 text-sm text-fg ${
        disabled ? 'opacity-50' : 'cursor-pointer'
      }`}
    >
      {label}
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
  const createKeyOpen = useSshStore((s) => s.createKeyOpen)
  const viewKey = useSshStore((s) => s.viewKey)
  const closeKeyView = useSshStore((s) => s.closeKeyView)
  const revealKey = useSshStore((s) => s.revealKey)
  const closeRevealKey = useSshStore((s) => s.closeRevealKey)
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
      {/* 分两行两块网格：第一行两张设置卡等高对齐（区域会平分卡片剩余高度）；
          第二行两张表的行数、工具行与分页条各不相同，各自取内容高度即可，不必凑成一样高。 */}
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
        <div className="grid gap-4 md:grid-cols-2">
          <ServiceCard />
          <RootCard />
        </div>
        <div className="grid items-start gap-4 md:grid-cols-2">
          <SshKeyCard />
          <SshLoginRecordsCard />
        </div>
      </div>
      {createKeyOpen ? <SshKeyCreateDialog /> : null}
      <SshKeyRemoveDialog />
      {viewKey ? (
        <SshKeyDialog title={viewKey.title} material={viewKey.material} onClose={closeKeyView} />
      ) : null}
      {revealKey ? (
        <SshKeyRevealDialog
          title={revealKey.title}
          material={revealKey.material}
          onClose={closeRevealKey}
        />
      ) : null}
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
        className="grow min-w-0 overflow-x-auto"
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
              pageRows.map((record) => (
                <tr key={record.id} className="group transition-colors hover:bg-surface-raised">
                  {/* 钉住的列要自带不透明底，否则滚动时后面的内容会从它下面透出来；
                      行悬停时它也跟着步进一级，颜色与整行一致。 */}
                  <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-surface py-2.5 pr-3 tabular-nums text-fg group-hover:bg-surface-raised">
                    {record.ip}
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
              ))
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

/** SSH 服务卡：服务启停、监听端口、登录方式三个区域。 */
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
  const savePort = useSshStore((s) => s.savePort)
  const portInputId = useId()

  if (!overview || !settings) return null
  const enabled = overview.enabled

  return (
    <Section title="SSH 服务">
      <Region title="服务状态">
        {/* 开关位置即服务状态，不再并排文字徽标复述（契约 status 字段仍由接口提供）。 */}
        <SwitchRow
          label="SSH 服务"
          checked={enabled}
          disabled={toggling}
          onCheckedChange={(checked) => void setServiceEnabled(gateway, checked)}
        />
        <p className="mt-3 text-xs tabular-nums text-fg-subtle">
          上次变更：{overview.changedAt ? formatDateTime(overview.changedAt) : '—'}
        </p>
        <p className="mt-2 text-xs text-fg-subtle">
          {isDockerRuntime()
            ? '停用后本机不再接受 SSH 连接；动作在容器内真实执行。'
            : '停用后本机不再接受 SSH 连接；动作只改演示内存，不触碰任何真实主机。'}
        </p>
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
            variant="ghost"
            onPress={() => setPortDraft(`${randomSshPort()}`)}
          >
            <RefreshCw aria-hidden size={14} />
          </IconButton>
          <button
            type="button"
            onClick={() => void savePort(gateway)}
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

      <Region title="登录方式">
        <div className="flex flex-col gap-4">
          <div>
            <SwitchRow
              label="密码登录"
              checked={settings.passwordAuthEnabled}
              disabled={savingAuth}
              onCheckedChange={(checked) =>
                void setAuthMethod(gateway, { passwordAuthEnabled: checked })
              }
            />
            <p className="mt-2 text-xs text-fg-muted">允许使用密码进行 SSH 登录</p>
          </div>
          <div>
            <SwitchRow
              label="密钥登录"
              checked={settings.keyAuthEnabled}
              disabled={savingAuth}
              onCheckedChange={(checked) => void setAuthMethod(gateway, { keyAuthEnabled: checked })}
            />
            <p className="mt-2 text-xs text-fg-muted">允许使用密钥进行 SSH 登录</p>
          </div>
        </div>
      </Region>
    </Section>
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
        <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
          {/* 定宽三列：窗口名、成功、失败；计数用等宽数字，翻动时列宽不跳。 */}
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[30%]" />
            <col className="w-[30%]" />
          </colgroup>
          <thead>
            <tr>
              {['时间窗口', SSH_LOGIN_RESULT_LABELS.succeeded, SSH_LOGIN_RESULT_LABELS.failed].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={`border-b border-line pb-2 text-xs font-medium text-fg-muted ${index === 0 ? '' : 'pl-3'}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SSH_LOGIN_WINDOWS.map((window) => (
              <tr key={window}>
                <th scope="row" className="border-b border-line py-2 text-xs font-medium text-fg-muted">
                  {SSH_LOGIN_WINDOW_LABELS[window]}
                </th>
                <td className="border-b border-line py-2 pl-3 tabular-nums text-fg">
                  {stats[window].succeeded}
                </td>
                {/* 失败计数带危险色：爆破尝试是这块的重点信号，文字与颜色一起表达。 */}
                <td className="border-b border-line py-2 pl-3 tabular-nums text-danger">
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

/** Root 密码与密钥区只在对应登录方式可用的策略档出现；收起时给一句话说明原因。 */
const ROOT_POLICY_HIDDEN_HINTS: Record<SshRootLoginPolicy, string | null> = {
  yes: null,
  'prohibit-password': '当前策略只允许密钥登录：Root 密码设置已隐藏，Root 凭据走下方密钥。',
  'forced-commands-only':
    '仅允许指定命令：Root 只能用授权文件中带 command= 限制的密钥执行固定命令（常用于备份脚本等自动化场景），密码登录同样被禁用；面板生成的普通密钥无法用于这一档，密码与密钥设置已隐藏。',
  no: 'Root 登录已完全禁止：Root 密码与 Root 密钥设置已隐藏。',
}

/** Root 设置卡：登录策略、Root 密码、Root 密钥三个区域。 */
function RootCard() {
  const gateway = useGateway()
  const rootAuth = useSshStore((s) => s.rootAuth)
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

  if (!rootAuth) return null
  const strength = passwordDraft ? evaluateSshPasswordStrength(passwordDraft) : undefined
  const rootKey = rootAuth.key
  // 密码区只进「允许密码登录」档；密钥区不进「禁止登录」与「仅允许指定命令」——
  // 后者只认授权文件里带 command= 限制的密钥，面板生成的普通密钥登录不进去，展示出来会误导。
  const passwordUsable = rootAuth.policy === 'yes'
  const panelKeyUsable = rootAuth.policy === 'yes' || rootAuth.policy === 'prohibit-password'
  const hiddenHint = ROOT_POLICY_HIDDEN_HINTS[rootAuth.policy]

  return (
    <Section title="Root 设置">
      <Region title="Root 登录策略">
        {/* 四档平铺成两列：长文案在窄卡里横排会挤成一团，两列既省高度也便于横向比较。 */}
        <div role="group" aria-label="Root 登录策略" className="grid grid-cols-2 gap-2">
          {SSH_ROOT_LOGIN_POLICIES.map((policy) => (
            <button
              key={policy}
              type="button"
              aria-pressed={rootAuth.policy === policy}
              disabled={savingPolicy}
              onClick={() => void setLoginPolicy(gateway, policy)}
              className={`rounded-lg border px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-50 ${
                rootAuth.policy === policy
                  ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                  : 'border-line text-fg-muted hover:border-fg-subtle hover:text-fg'
              }`}
            >
              {SSH_ROOT_LOGIN_POLICY_LABELS[policy]}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-fg-subtle">推荐使用密钥登录并关闭密码登录，安全性更高。</p>
        {hiddenHint ? <p className="mt-1.5 text-xs text-fg-subtle">{hiddenHint}</p> : null}
      </Region>

      {passwordUsable ? (
        <Region title="Root 密码" labelFor={passwordInputId}>
        <div className="flex items-center gap-2">
          <input
            id={passwordInputId}
            type="password"
            autoComplete="new-password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            placeholder="请输入新密码"
            className={INPUT_CLASS}
          />
          <IconButton
            label="随机生成强密码"
            variant="ghost"
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
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {strength ? (
            <span className={STRENGTH_CLASSES[strength]}>
              强度：{SSH_PASSWORD_STRENGTH_LABELS[strength]}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-warning">
            <TriangleAlert aria-hidden size={12} />
            修改密码会进行弱密码检测
          </span>
        </div>
        <p className="mt-2 text-xs text-fg-subtle">
          建议使用复杂度高的密码；修改后请及时保存，刷新页面会清空密码框。
        </p>
        <p className="mt-2 text-xs tabular-nums text-fg-subtle">
          上次重置：{rootAuth.passwordResetAt ? formatDateTime(rootAuth.passwordResetAt) : '—'}
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
